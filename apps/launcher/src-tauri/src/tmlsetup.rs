//! Guided TMLoader setup for Forever mods. TM Horizon never bundles or mirrors TMLoader: it reads the
//! current installer link from Tomashu's official page (tomashu.dev/software/tmloader/), downloads
//! it over https from Tomashu's hosts only, checks that it is a Windows program, and starts it after
//! the user said yes. The installer shows its own steps (the official page documents no silent
//! options, so none are used). Refused when a real TMLoader already exists in the default folder.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub const PAGE: &str = "https://tomashu.dev/software/tmloader/";
/// Tomashu's site and the Cloudflare Pages host its download button points to.
const HOSTS: [&str; 2] = ["tomashu.dev", "tomashu.pages.dev"];
const MAX_INSTALLER: u64 = 150 << 20;

/// https on one of Tomashu's hosts (no userinfo, default port).
pub fn allowed_url(u: &str) -> bool {
    let Ok(x) = url::Url::parse(u) else { return false };
    x.scheme() == "https" && x.username().is_empty() && x.port().is_none() && x.host_str().is_some_and(|h| HOSTS.contains(&h.to_ascii_lowercase().as_str()))
}

/// The installer link of the official page ("TMLoader-latest.exe" or a versioned "TMLoader-x.y.z-win32.exe").
pub fn find_installer_link(html: &str) -> Option<String> {
    let mut rest = html;
    while let Some(i) = rest.find("href=") {
        rest = &rest[i + 5..];
        let (quote, body) = match rest.chars().next() {
            Some(q @ ('"' | '\'')) => (Some(q), &rest[1..]),
            _ => (None, rest),
        };
        let end = body.find(|c: char| quote.map_or(c.is_whitespace() || c == '>', |q| c == q)).unwrap_or(body.len());
        let link = body[..end].trim().replace("&amp;", "&");
        let name = link.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
        if name.starts_with("tmloader") && name.ends_with(".exe") {
            let abs = url::Url::parse(PAGE).ok()?.join(&link).ok()?.to_string();
            if allowed_url(&abs) {
                return Some(abs);
            }
        }
    }
    None
}

/// A Windows program (MZ + PE header), not an HTML error page.
pub fn looks_like_installer(b: &[u8]) -> bool {
    if b.len() < 64 * 1024 || &b[..2] != b"MZ" {
        return false;
    }
    let pe = u32::from_le_bytes([b[0x3c], b[0x3d], b[0x3e], b[0x3f]]) as usize;
    b.len() > pe + 4 && &b[pe..pe + 4] == b"PE\0\0"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub path: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

/// `fetch(url) -> (bytes, final url after redirects)`; tests pass a fake.
pub fn download_with(dest: &Path, fetch: impl Fn(&str, u64) -> Result<(Vec<u8>, String), String>) -> Result<Download, String> {
    let (page, _) = fetch(PAGE, 2 << 20)?;
    let link = find_installer_link(&String::from_utf8_lossy(&page)).ok_or("No installer link on tomashu.dev/software/tmloader/")?;
    let (bytes, final_url) = fetch(&link, MAX_INSTALLER)?;
    if !allowed_url(&final_url) {
        return Err(format!("The download ended up on {final_url}, which is not Tomashu's site; stopped"));
    }
    if !looks_like_installer(&bytes) {
        return Err("The download is not a Windows installer; stopped".into());
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let name = final_url.rsplit('/').next().filter(|n| n.to_ascii_lowercase().ends_with(".exe") && !n.contains(['\\', ':'])).unwrap_or("TMLoader-setup.exe");
    let path = dest.join(name);
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(Download { path: path.to_string_lossy().into(), url: final_url, size: bytes.len() as u64, sha256: hex::encode(Sha256::digest(&bytes)) })
}

fn setup_dir(st: &AppState) -> PathBuf {
    st.cache_dir.join("tmloader-setup")
}

/// A real TMLoader in the default folder (also when the app points at a sandbox): never reinstall.
fn real_tmloader_present() -> bool {
    crate::tmloader::default_root().is_some_and(|r| r.join("config.yaml").is_file())
}

#[tauri::command]
pub async fn tmloader_setup_download(app: tauri::AppHandle) -> Result<Download, String> {
    crate::bg::run(move || -> Result<Download, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if real_tmloader_present() {
            return Err("TMLoader is already installed on this PC".into());
        }
        download_with(&setup_dir(&st), |u, max| crate::net::get_bytes_final(u, max))
    })
    .await
}

/// Starts the downloaded installer (its own window; Windows may ask for permission) and reports
/// `tmloader-setup-done` when it closes.
#[tauri::command]
pub async fn tmloader_setup_run(app: AppHandle, path: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = app.state::<AppState>();
        if real_tmloader_present() {
            return Err("TMLoader is already installed on this PC".into());
        }
        let p = PathBuf::from(&path);
        let dir = setup_dir(&st);
        if !crate::fsx::is_inside(&p, &dir) || !p.is_file() || !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            return Err("Only the installer TM Horizon downloaded can be started".into());
        }
        let mut child = spawn_visible(&p)?;
        let a = app.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            let st = a.state::<AppState>();
            let snap = crate::commands::refresh_tmloader(&st);
            let _ = a.emit("tmloader-setup-done", serde_json::json!({ "installed": snap.tmloader.installed, "code": code }));
        });
        Ok(())
    })
    .await
}

#[cfg(windows)]
fn spawn_visible(p: &Path) -> Result<std::process::Child, String> {
    match std::process::Command::new(p).current_dir(p.parent().unwrap_or(p)).spawn() {
        Ok(c) => Ok(c),
        // ERROR_ELEVATION_REQUIRED: let Windows show its permission prompt, and wait for that.
        Err(e) if e.raw_os_error() == Some(740) => std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Start-Process", "-Wait", "-Verb", "RunAs", "-FilePath"])
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(windows))]
fn spawn_visible(_p: &Path) -> Result<std::process::Child, String> {
    Err("On Linux, run the TMLoader installer inside the game's Wine/Proton prefix (see Settings > Linux).".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE_HTML: &str = r#"<p><a href=https://nadeo-download.cdn.ubi.com/trackmaniaforever/tmnationsforever_setup.exe>TMNF</a>
        <a href=https://tomashu.pages.dev/modloader/modloader/TMLoader-latest.exe><em><strong>Download</strong></em></a> ModLoader installer</p>"#;

    fn fake_exe() -> Vec<u8> {
        let mut b = vec![0u8; 70 * 1024];
        b[0..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        b[0x80..0x84].copy_from_slice(b"PE\0\0");
        b
    }

    #[test]
    fn link_from_the_official_page_only_on_tomashus_hosts() {
        assert_eq!(find_installer_link(PAGE_HTML).as_deref(), Some("https://tomashu.pages.dev/modloader/modloader/TMLoader-latest.exe"));
        assert_eq!(find_installer_link(r#"<a href="/files/TMLoader-1.0.1-win32.exe">x</a>"#).as_deref(), Some("https://tomashu.dev/files/TMLoader-1.0.1-win32.exe"));
        assert_eq!(find_installer_link(r#"<a href="https://evil.example/TMLoader-latest.exe">x</a>"#), None);
        assert_eq!(find_installer_link(r#"<a href="http://tomashu.pages.dev/TMLoader-latest.exe">x</a>"#), None);
        assert!(!allowed_url("https://tomashu.dev.evil.example/x.exe"));
        assert!(!allowed_url("https://user@tomashu.dev/x.exe"));
        assert!(allowed_url("https://TOMASHU.dev/software/tmloader/"));
    }

    #[test]
    fn mocked_download_into_a_sandbox() {
        let dir = std::env::temp_dir().join(format!("tmh-tmlsetup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let fetch = |u: &str, _max: u64| -> Result<(Vec<u8>, String), String> {
            if u == PAGE { Ok((PAGE_HTML.as_bytes().to_vec(), u.to_string())) }
            else { Ok((fake_exe(), "https://tomashu.pages.dev/modloader/modloader/TMLoader-1.0.1-win32.exe".into())) }
        };
        let d = download_with(&dir, fetch).unwrap();
        assert!(d.path.ends_with("TMLoader-1.0.1-win32.exe"));
        assert_eq!(d.size, 70 * 1024);
        assert!(Path::new(&d.path).is_file());

        // Redirected off Tomashu's hosts, or an HTML page instead of a program: nothing is kept.
        let off = |u: &str, _m: u64| -> Result<(Vec<u8>, String), String> {
            if u == PAGE { Ok((PAGE_HTML.as_bytes().to_vec(), u.into())) } else { Ok((fake_exe(), "https://mirror.example/TMLoader.exe".into())) }
        };
        assert!(download_with(&dir.join("b"), off).unwrap_err().contains("not Tomashu"));
        let html = |u: &str, _m: u64| -> Result<(Vec<u8>, String), String> {
            if u == PAGE { Ok((PAGE_HTML.as_bytes().to_vec(), u.into())) } else { Ok((b"<html>404</html>".to_vec(), "https://tomashu.pages.dev/x.exe".into())) }
        };
        assert!(download_with(&dir.join("c"), html).unwrap_err().contains("not a Windows installer"));
        assert!(!dir.join("b").exists() && !dir.join("c").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
