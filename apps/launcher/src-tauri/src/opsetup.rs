//! Openplanet for Trackmania (2020), ManiaPlanet 4 and Trackmania Turbo: detection, version, update
//! hint and a guided install with the official installer. TM Horizon never bundles or mirrors
//! Openplanet: it reads the current download link from openplanet.dev/download, downloads over https
//! from openplanet.dev / cdn.openplanet.dev only, checks that it is a Windows program and starts it
//! visibly after the user said yes (the installer asks for the game folder itself; TM Horizon only
//! fills it in with NSIS's `/D=`).
//!
//! What the official installer writes (listed from OpenplanetNext_1.29.14.exe / OpenplanetV4_1.29.14.exe
//! with 7-Zip, and openplanet.dev/docs): into the game folder next to Trackmania.exe / ManiaPlanet.exe /
//! TrackManiaTurbo.exe `Openplanet.dll`, `dinput8.dll` (the loader), the folder `Openplanet\`, the
//! uninstaller `OpenplanetUninstall.exe` (V4 also `d3dcompiler_47.dll`); at runtime `OpenplanetHook.log`
//! in the game folder and the user folder `%USERPROFILE%\OpenplanetNext` | `Openplanet4` |
//! `OpenplanetTurbo` (Plugins, Scripts, Openplanet.log). The version is the text
//! "Openplanet 1.29.14 (next, Public, ...)" inside Openplanet.dll (the DLL has no version resource).
//!
//! Read only here: Openplanet.dll and the user folder. dinput8.dll is never opened (house rule).
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub const PAGE: &str = "https://openplanet.dev/download";
const HOSTS: [&str; 2] = ["openplanet.dev", "cdn.openplanet.dev"];
const MAX_INSTALLER: u64 = 64 << 20;
const MAX_DLL: u64 = 48 << 20;

/// Openplanet build per game: the heading on openplanet.dev/download, the user folder, the game exe.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Build {
    pub key: &'static str,
    pub heading: &'static str,
    pub user_folder: &'static str,
    pub exe: &'static str,
}

const NEXT: Build = Build { key: "next", heading: "Trackmania", user_folder: "OpenplanetNext", exe: "Trackmania.exe" };
const V4: Build = Build { key: "v4", heading: "Maniaplanet 4", user_folder: "Openplanet4", exe: "ManiaPlanet.exe" };
const TURBO: Build = Build { key: "turbo", heading: "Trackmania Turbo", user_folder: "OpenplanetTurbo", exe: "TrackManiaTurbo.exe" };

pub fn build_for(game: &str) -> Option<Build> {
    match game {
        "tm2020" => Some(NEXT),
        "tm-turbo" | "turbo" => Some(TURBO),
        g if g == "maniaplanet" || g.starts_with("tm2-") || g == "sm-storm" => Some(V4),
        _ => None,
    }
}

/// https on openplanet.dev or cdn.openplanet.dev (no userinfo, default port).
pub fn allowed_url(u: &str) -> bool {
    let Ok(x) = url::Url::parse(u) else { return false };
    x.scheme() == "https" && x.username().is_empty() && x.port().is_none() && x.host_str().is_some_and(|h| HOSTS.contains(&h.to_ascii_lowercase().as_str()))
}

/// One game's entry on openplanet.dev/download: the download link and its version.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub url: String,
    pub version: String,
}

/// The download page: `<h1 class="title">Trackmania</h1> ... <a href="https://openplanet.dev/download/get?id=330" ...> ... Download 1.29.14`.
pub fn parse_download_page(html: &str, b: Build) -> Option<Latest> {
    let mut rest = html;
    loop {
        let i = rest.find("<h1")?;
        rest = &rest[i..];
        let open_end = rest.find('>')?;
        let close = rest.find("</h1>")?;
        let title = rest[open_end + 1..close].trim();
        rest = &rest[close..];
        if title.eq_ignore_ascii_case(b.heading) {
            // The section ends at the next heading.
            let end = rest[5..].find("<h1").map(|e| e + 5).unwrap_or(rest.len());
            let sec = &rest[..end];
            let h = sec.find("download/get?id=")?;
            let start = sec[..h].rfind('"')? + 1;
            let stop = h + sec[h..].find('"')?;
            let link = url::Url::parse(PAGE).ok()?.join(&sec[start..stop].replace("&amp;", "&")).ok()?.to_string();
            let after = &sec[stop..];
            let d = after.find("Download ")?;
            let version: String = after[d + 9..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if !allowed_url(&link) || version.is_empty() {
                return None;
            }
            return Some(Latest { url: link, version });
        }
    }
}

/// "Openplanet 1.29.14 (next, Public, 6fd4200f)" inside Openplanet.dll -> ("1.29.14", Some("next")).
pub fn version_in(bytes: &[u8]) -> Option<(String, Option<String>)> {
    let needle = b"Openplanet ";
    let mut best: Option<(String, Option<String>)> = None;
    let mut i = 0;
    while let Some(p) = bytes[i..].windows(needle.len()).position(|w| w == needle) {
        let s = i + p + needle.len();
        let v: String = bytes[s..].iter().take(16).take_while(|c| c.is_ascii_digit() || **c == b'.').map(|&c| c as char).collect();
        if v.split('.').count() >= 3 && v.split('.').all(|x| !x.is_empty()) {
            let tail = &bytes[s + v.len()..bytes.len().min(s + v.len() + 48)];
            let branch = (tail.first() == Some(&b' ') && tail.get(1) == Some(&b'('))
                .then(|| tail[2..].iter().take_while(|c| c.is_ascii_alphanumeric()).map(|&c| c as char).collect::<String>())
                .filter(|b| !b.is_empty());
            if branch.is_some() {
                return Some((v, branch));
            }
            best.get_or_insert((v, None));
        }
        i = s;
    }
    best
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpStatus {
    /// Openplanet.dll next to the game's exe (or, when the game folder is unknown, the user folder exists).
    pub installed: bool,
    pub version: Option<String>,
    /// "next", "beta", "edge" ... as the DLL says.
    pub branch: Option<String>,
    pub game_dir: Option<String>,
    pub user_dir: String,
    pub user_dir_found: bool,
    pub dll_found: bool,
}

/// Read-only detection for one game. `game_dir`: the folder with the game's exe, if known.
pub fn detect(game_dir: Option<&Path>, home: &Path, b: Build) -> OpStatus {
    let user = home.join(b.user_folder);
    let dll = game_dir.map(|d| d.join("Openplanet.dll")).filter(|p| crate::fsx::is_file(p) && !crate::fsx::blocked(p));
    let (version, branch) = dll
        .as_deref()
        .and_then(|p| std::fs::metadata(p).ok().filter(|m| m.len() <= MAX_DLL).and_then(|_| std::fs::read(p).ok()))
        .and_then(|b| version_in(&b))
        .or_else(|| {
            // Fallback: the first lines of the log in the user folder.
            let log = std::fs::read(user.join("Openplanet.log")).ok()?;
            version_in(&log[..log.len().min(64 * 1024)])
        })
        .map(|(v, b)| (Some(v), b))
        .unwrap_or((None, None));
    let user_found = crate::fsx::is_dir(&user);
    OpStatus {
        installed: dll.is_some() || (game_dir.is_none() && user_found),
        version,
        branch,
        game_dir: game_dir.map(|d| d.to_string_lossy().into()),
        user_dir: user.to_string_lossy().into(),
        user_dir_found: user_found,
        dll_found: dll.is_some(),
    }
}

/// A Windows program (MZ + PE header), not an HTML error page.
pub fn looks_like_installer(b: &[u8]) -> bool {
    crate::tmlsetup::looks_like_installer(b)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub path: String,
    pub url: String,
    pub version: String,
    pub size: u64,
    pub sha256: String,
}

/// `fetch(url, max, referer) -> (bytes, final url)`; tests pass a fake.
pub fn download_with(dest: &Path, b: Build, fetch: impl Fn(&str, u64, Option<&str>) -> Result<(Vec<u8>, String), String>) -> Result<Download, String> {
    let (page, _) = fetch(PAGE, 2 << 20, None)?;
    let latest = parse_download_page(&String::from_utf8_lossy(&page), b).ok_or("No Openplanet download link on openplanet.dev/download")?;
    // openplanet.dev hands out the file only with its own page as referrer.
    let (bytes, final_url) = fetch(&latest.url, MAX_INSTALLER, Some(PAGE))?;
    if !allowed_url(&final_url) {
        return Err(format!("The download ended up on {final_url}, which is not openplanet.dev; stopped"));
    }
    if !looks_like_installer(&bytes) {
        return Err("The download is not a Windows installer; stopped".into());
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let name = final_url
        .rsplit('/')
        .next()
        .map(|n| n.split('?').next().unwrap_or(n))
        .filter(|n| n.to_ascii_lowercase().ends_with(".exe") && n.starts_with("Openplanet") && !n.contains(['\\', ':', '/']))
        .unwrap_or("Openplanet-setup.exe");
    let path = dest.join(name);
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(Download { path: path.to_string_lossy().into(), url: final_url, version: latest.version, size: bytes.len() as u64, sha256: hex::encode(Sha256::digest(&bytes)) })
}

fn setup_dir(st: &AppState) -> PathBuf {
    st.cache_dir.join("openplanet-setup")
}

fn home() -> PathBuf {
    crate::openplanet::user_root()
}

/// The folder with the game's exe from the last scan.
fn game_dir(st: &AppState, b: Build) -> Option<PathBuf> {
    let snap = st.snapshot.lock().unwrap().clone()?;
    let list = match b.key {
        "next" => snap.games.tm2020.installs,
        "v4" => snap.games.maniaplanet.installs,
        _ => snap.games.turbo.installs,
    };
    list.iter().find_map(|i| {
        let p = PathBuf::from(&i.path);
        let d = if crate::fsx::is_file(&p) { p.parent()?.to_path_buf() } else { p };
        (crate::fsx::is_file(&d.join(b.exe)) || i.exe.is_some()).then_some(d)
    })
}

/// Latest version per build from openplanet.dev/download, cached for 6 hours (cache used offline).
fn latest_cached(st: &AppState, b: Build) -> Option<Latest> {
    let file = st.cache_dir.join("openplanet-download.html");
    let fresh = std::fs::metadata(&file).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_secs() < 6 * 3600);
    let html = if fresh {
        std::fs::read_to_string(&file).ok()
    } else {
        match crate::net::get_bytes_final(PAGE, 2 << 20) {
            Ok((b, _)) => {
                let _ = crate::fsx::write(&file, &b);
                Some(String::from_utf8_lossy(&b).into_owned())
            }
            Err(_) => std::fs::read_to_string(&file).ok(),
        }
    }?;
    parse_download_page(&html, b)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpInfo {
    #[serde(flatten)]
    pub status: OpStatus,
    pub latest: Option<Latest>,
    /// Installed version older than openplanet.dev's.
    pub update: bool,
}

/// Openplanet for a game: installed?, version, newest version, update hint.
#[tauri::command]
pub async fn openplanet_status(app: tauri::AppHandle, game: String, online: bool) -> Result<OpInfo, String> {
    crate::bg::run(move || -> Result<OpInfo, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let b = build_for(&game).ok_or("Openplanet does not exist for this game")?;
        let status = detect(game_dir(&st, b).as_deref(), &home(), b);
        let latest = if online { latest_cached(&st, b) } else { None };
        let update = match (&status.version, &latest) {
            (Some(v), Some(l)) => crate::modindex::cmp_version(v, &l.version) == std::cmp::Ordering::Less,
            _ => false,
        };
        Ok(OpInfo { status, latest, update })
    })
    .await
}

#[tauri::command]
pub async fn openplanet_setup_download(app: tauri::AppHandle, game: String) -> Result<Download, String> {
    crate::bg::run(move || -> Result<Download, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let b = build_for(&game).ok_or("Openplanet does not exist for this game")?;
        download_with(&setup_dir(&st).join(b.key), b, |u, max, referer| crate::net::get_bytes_final_ref(u, max, referer))
    })
    .await
}

/// Starts the downloaded installer visibly, with the game folder filled in, and reports
/// `openplanet-setup-done` when it closes.
#[tauri::command]
pub async fn openplanet_setup_run(app: AppHandle, game: String, path: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = app.state::<AppState>();
        let b = build_for(&game).ok_or("Openplanet does not exist for this game")?;
        let p = PathBuf::from(&path);
        if !crate::fsx::is_inside(&p, &setup_dir(&st)) || !p.is_file() || !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            return Err("Only the installer TM Horizon downloaded can be started".into());
        }
        let dir = game_dir(&st, b);
        let mut child = spawn_visible(&p, dir.as_deref())?;
        let a = app.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            let st = a.state::<AppState>();
            let s = detect(game_dir(&st, b).as_deref(), &home(), b);
            let _ = a.emit("openplanet-setup-done", serde_json::json!({ "game": game, "installed": s.installed, "version": s.version, "code": code }));
        });
        Ok(())
    })
    .await
}

/// NSIS: `/D=<folder>` must be the last argument and is not quoted.
pub fn nsis_dir_arg(dir: &Path) -> Option<String> {
    let s = dir.to_string_lossy();
    (!s.contains('"') && !s.is_empty()).then(|| format!("/D={s}"))
}

#[cfg(windows)]
fn spawn_visible(p: &Path, dir: Option<&Path>) -> Result<std::process::Child, String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(p);
    cmd.current_dir(p.parent().unwrap_or(p));
    if let Some(a) = dir.and_then(nsis_dir_arg) {
        cmd.raw_arg(a);
    }
    match cmd.spawn() {
        Ok(c) => Ok(c),
        // ERROR_ELEVATION_REQUIRED: let Windows show its permission prompt, and wait for that.
        Err(e) if e.raw_os_error() == Some(740) => {
            let mut ps = std::process::Command::new("powershell");
            ps.args(["-NoProfile", "-Command", "Start-Process", "-Wait", "-Verb", "RunAs", "-FilePath"]).arg(p);
            if let Some(a) = dir.and_then(nsis_dir_arg) {
                ps.arg("-ArgumentList").arg(format!("'{}'", a.replace('\'', "''")));
            }
            ps.spawn().map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(windows))]
fn spawn_visible(_p: &Path, _dir: Option<&Path>) -> Result<std::process::Child, String> {
    Err("On Linux, run the Openplanet installer inside the game's Wine/Proton prefix and add the dinput8 DLL override (openplanet.dev/docs/linux).".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE_HTML: &str = r#"
        <div class="column"><h1 class="title">Trackmania</h1><h2 class="subtitle mb-2">(2020)</h2>
          <a href="https://openplanet.dev/download/get?id=330" class="button is-danger"><span class="icon"></span>
          <span>Download 1.29.14</span></a></div>
        <div class="column"><h1 class="title">Maniaplanet 4</h1>
          <a href="https://openplanet.dev/download/get?id=331" class="button"><span>Download 1.29.13</span></a></div>
        <div class="column"><h1 class="title">Trackmania Turbo</h1>
          <a href="https://evil.example/download/get?id=332" class="button"><span>Download 1.29.14</span></a></div>
        <div class="column"><h1 class="title">TrackMania Forever</h1><h2>(Nations / United)</h2></div>"#;

    fn fake_exe() -> Vec<u8> {
        let mut b = vec![0u8; 70 * 1024];
        b[0..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        b[0x80..0x84].copy_from_slice(b"PE\0\0");
        b
    }

    #[test]
    fn download_page_per_game_and_hosts() {
        assert_eq!(parse_download_page(PAGE_HTML, NEXT), Some(Latest { url: "https://openplanet.dev/download/get?id=330".into(), version: "1.29.14".into() }));
        assert_eq!(parse_download_page(PAGE_HTML, V4).unwrap().version, "1.29.13");
        assert_eq!(parse_download_page(PAGE_HTML, TURBO), None, "links off openplanet.dev are refused");
        assert_eq!(build_for("tm2-canyon"), Some(V4));
        assert_eq!(build_for("tmuf"), None);
        assert!(allowed_url("https://cdn.openplanet.dev/builds/next/OpenplanetNext_1.29.14.exe"));
        assert!(!allowed_url("http://openplanet.dev/download"));
        assert!(!allowed_url("https://openplanet.dev.evil.example/x.exe"));
        assert!(!allowed_url("https://user@openplanet.dev/x.exe"));
    }

    #[test]
    fn version_from_the_dll_text() {
        let mut b = b"\0\0Openplanet \0junk Openplanet 1.29.14\0more Openplanet 1.29.14 (next, Public, 6fd4200f)\0".to_vec();
        assert_eq!(version_in(&b), Some(("1.29.14".into(), Some("next".into()))));
        b.truncate(40);
        assert_eq!(version_in(&b), Some(("1.29.14".into(), None)));
        assert_eq!(version_in(b"Openplanet 4 user folder"), None);
    }

    #[test]
    fn detection_in_a_sandbox() {
        let t = tempfile::tempdir().unwrap();
        let game = t.path().join("Trackmania");
        let home = t.path().join("home");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let s = detect(Some(&game), &home, NEXT);
        assert!(!s.installed && s.version.is_none() && !s.user_dir_found);
        std::fs::write(game.join("Openplanet.dll"), b"MZ....Openplanet 1.29.14 (next, Public, 6fd4200f)\0").unwrap();
        std::fs::create_dir_all(home.join("OpenplanetNext").join("Plugins")).unwrap();
        let s = detect(Some(&game), &home, NEXT);
        assert!(s.installed && s.dll_found && s.user_dir_found);
        assert_eq!(s.version.as_deref(), Some("1.29.14"));
        assert_eq!(s.branch.as_deref(), Some("next"));
        // Game folder unknown: the user folder counts, the version comes from its log.
        std::fs::write(home.join("OpenplanetNext").join("Openplanet.log"), b"[ 0] Openplanet 1.29.12 (next, Public, x)\n").unwrap();
        let s = detect(None, &home, NEXT);
        assert!(s.installed && !s.dll_found);
        assert_eq!(s.version.as_deref(), Some("1.29.12"));
        // ManiaPlanet uses its own user folder.
        assert!(!detect(None, &home, V4).installed);
    }

    #[test]
    fn mocked_download_into_a_sandbox() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("dl");
        let fetch = |u: &str, _max: u64, referer: Option<&str>| -> Result<(Vec<u8>, String), String> {
            if u == PAGE { return Ok((PAGE_HTML.as_bytes().to_vec(), u.to_string())); }
            assert_eq!(referer, Some(PAGE), "the file needs openplanet.dev as referrer");
            Ok((fake_exe(), "https://cdn.openplanet.dev/builds/next/OpenplanetNext_1.29.14.exe".into()))
        };
        let d = download_with(&dir, NEXT, fetch).unwrap();
        assert!(d.path.ends_with("OpenplanetNext_1.29.14.exe"));
        assert_eq!(d.version, "1.29.14");
        assert!(Path::new(&d.path).is_file());

        let off = |u: &str, _m: u64, _r: Option<&str>| -> Result<(Vec<u8>, String), String> {
            if u == PAGE { Ok((PAGE_HTML.as_bytes().to_vec(), u.into())) } else { Ok((fake_exe(), "https://mirror.example/OpenplanetNext.exe".into())) }
        };
        assert!(download_with(&t.path().join("b"), NEXT, off).unwrap_err().contains("not openplanet.dev"));
        let html = |u: &str, _m: u64, _r: Option<&str>| -> Result<(Vec<u8>, String), String> {
            if u == PAGE { Ok((PAGE_HTML.as_bytes().to_vec(), u.into())) } else { Ok((b"<html>302</html>".to_vec(), "https://openplanet.dev/download".into())) }
        };
        assert!(download_with(&t.path().join("c"), NEXT, html).unwrap_err().contains("not a Windows installer"));
        assert!(!t.path().join("b").exists() && !t.path().join("c").exists());
        assert_eq!(nsis_dir_arg(Path::new(r"C:\Games\Trackmania")).as_deref(), Some(r"/D=C:\Games\Trackmania"));
    }
}
