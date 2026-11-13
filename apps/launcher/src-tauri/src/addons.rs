//! Browser add-ons for the embedded browser (TMX, ManiaPark, ...).
//!
//! Only add-ons from the curated catalog (packages/catalog, category "browser-addon", bundled
//! into the binary) can be installed: the UI passes a catalog id, never a URL. An add-on whose
//! catalog entry says `install: "github"` is downloaded from the author's own GitHub release
//! (https only, size limit, SHA-256 checked against the digest GitHub publishes for the asset or a
//! SHA256SUMS file in the release); everything else only offers its store page.
//!
//! Install is two steps, like the catalog mods: `prepare` downloads, unpacks into a staging
//! folder and reads the add-on's manifest.json, so the UI can show the permissions it asks for;
//! `apply` (after the user's OK) moves it into `<app data>\BrowserAddons\<id>\<version>` and
//! records it in `addons.json`. Permissions beyond what the catalog lists are shown as a warning.
//!
//! The add-ons load into the embedded browser's own WebView2 profile only (Windows, see
//! `host`); the launcher UI's own webview never has extensions enabled. Extensions found in that
//! profile that are not in `addons.json` are removed when the view starts. WebKitGTK (Linux) has
//! no WebExtension support, so there the panel says so.
//!
//! A local development build can be installed when `TMHUB_ADDON_DEV=<catalog id>=<folder>` is set
//! (the folder is copied, so later edits need a reinstall).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::{catalogmods, fsx, net, updates};

/// The bundled catalog (same file the UI imports).
const CATALOG_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/catalog.json"));
const MAX_DOWNLOAD: u64 = 30 << 20;
const MAX_FILES: usize = 2000;

// ------------------------------------------------------------------ catalog

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddonSpec {
    /// "github" (installable from the author's GitHub release) or "store" (store page only).
    pub install: String,
    pub github: Option<String>,
    /// Glob for the release asset (case-insensitive, `*` only).
    pub asset: Option<String>,
    /// Permissions and host patterns the catalog reviewed; more in the real manifest = warning.
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CatalogAddon {
    pub id: String,
    pub name: String,
    pub spec: AddonSpec,
}

fn parse_catalog(json: &str) -> Vec<CatalogAddon> {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    v["entries"]
        .as_array()
        .map(|l| {
            l.iter()
                .filter(|e| e["category"] == "browser-addon")
                .filter_map(|e| {
                    let spec: AddonSpec = serde_json::from_value(e["addon"].clone()).ok()?;
                    Some(CatalogAddon { id: e["id"].as_str()?.to_string(), name: e["name"].as_str().unwrap_or("").to_string(), spec })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn catalog() -> &'static [CatalogAddon] {
    static C: OnceLock<Vec<CatalogAddon>> = OnceLock::new();
    C.get_or_init(|| parse_catalog(CATALOG_JSON))
}

fn find(id: &str) -> Result<&'static CatalogAddon, String> {
    catalog().iter().find(|a| a.id == id).ok_or_else(|| "Not an add-on from the TM Horizon list".to_string())
}

fn valid_repo(repo: &str) -> bool {
    repo.matches('/').count() == 1 && !repo.contains("..") && repo.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
}

// ------------------------------------------------------------------ manifest

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManifestInfo {
    pub name: String,
    pub version: String,
    pub manifest_version: u32,
    pub permissions: Vec<String>,
    /// Host patterns from host_permissions, optional_host_permissions and content script matches.
    pub hosts: Vec<String>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|l| l.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Reads an unpacked extension's manifest.json. Manifest V3 only (current Chromium and WebView2
/// no longer run V2 extensions). `__MSG_x__` names stay as they are.
pub fn parse_manifest(bytes: &[u8]) -> Result<ManifestInfo, String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}');
    let m: Value = serde_json::from_str(text).map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;
    let mv = m["manifest_version"].as_u64().unwrap_or(0) as u32;
    if mv != 3 {
        return Err(format!("Manifest V{mv}: only Manifest V3 add-ons run in the embedded browser"));
    }
    let mut permissions = strings(&m["permissions"]);
    permissions.extend(strings(&m["optional_permissions"]));
    let mut hosts = strings(&m["host_permissions"]);
    hosts.extend(strings(&m["optional_host_permissions"]));
    for cs in m["content_scripts"].as_array().cloned().unwrap_or_default() {
        hosts.extend(strings(&cs["matches"]));
    }
    // A permission that looks like a host pattern is one (MV2 habit carried over).
    let (pats, perms): (Vec<String>, Vec<String>) = permissions.into_iter().partition(|p| p.contains("://") || p == "<all_urls>");
    hosts.extend(pats);
    let mut perms = perms;
    perms.sort();
    perms.dedup();
    let mut seen = std::collections::HashSet::new();
    hosts.retain(|h| seen.insert(h.clone()));
    Ok(ManifestInfo {
        name: m["name"].as_str().unwrap_or("").to_string(),
        version: m["version"].as_str().unwrap_or("").to_string(),
        manifest_version: mv,
        permissions: perms,
        hosts,
    })
}

/// Host of a match pattern ("*://tmnf.exchange/*" -> "tmnf.exchange", "<all_urls>" -> "*").
pub fn pattern_host(p: &str) -> String {
    if p == "<all_urls>" {
        return "*".into();
    }
    let rest = p.split_once("://").map(|(_, r)| r).unwrap_or(p);
    rest.split('/').next().unwrap_or("").to_lowercase()
}

/// Permissions and hosts the manifest asks for beyond what the catalog lists.
pub fn extra_permissions(m: &ManifestInfo, spec: &AddonSpec) -> Vec<String> {
    let declared_hosts: Vec<String> = spec.hosts.iter().map(|h| pattern_host(h)).collect();
    let mut out: Vec<String> = m.permissions.iter().filter(|p| !spec.permissions.contains(p)).cloned().collect();
    for h in &m.hosts {
        let host = pattern_host(h);
        if !declared_hosts.contains(&host) && !out.contains(&host) {
            out.push(host);
        }
    }
    out
}

/// The extension's files from a zip: manifest.json at the root or one folder deep (that folder
/// is dropped). Unsafe paths are refused, not skipped.
pub fn extension_files(entries: Vec<(String, Vec<u8>)>) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut clean = Vec::with_capacity(entries.len());
    for (name, b) in entries {
        let rel = catalogmods::safe_rel(&name).ok_or_else(|| format!("Unsafe path in the add-on: {name}"))?;
        clean.push((rel, b));
    }
    if clean.iter().any(|(n, _)| n == "manifest.json") {
        return Ok(clean);
    }
    let tops: Vec<&str> = clean.iter().filter(|(n, _)| n.ends_with("/manifest.json") && n.matches('/').count() == 1).map(|(n, _)| n.split('/').next().unwrap()).collect();
    if tops.len() != 1 {
        return Err("No manifest.json in the add-on download".into());
    }
    let prefix = format!("{}/", tops[0]);
    Ok(clean.into_iter().filter_map(|(n, b)| n.strip_prefix(&prefix).map(|r| (r.to_string(), b))).collect())
}

fn unzip(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("not a zip: {e}"))?;
    if z.len() > MAX_FILES {
        return Err("The add-on zip has too many files".into());
    }
    let mut out = Vec::new();
    let mut total = 0u64;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        total += f.size();
        if total > 4 * MAX_DOWNLOAD {
            return Err("The add-on zip unpacks to too much".into());
        }
        let mut b = Vec::new();
        f.read_to_end(&mut b).map_err(|e| e.to_string())?;
        out.push((f.name().to_string(), b));
    }
    Ok(out)
}

pub fn sha256_hex(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

// ------------------------------------------------------------------ GitHub release

#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseAsset {
    pub tag: String,
    pub name: String,
    pub url: String,
    /// SHA-256 GitHub publishes for the asset ("digest": "sha256:...").
    pub digest: Option<String>,
    /// URL of a SHA256SUMS(.txt) / *.sha256 file in the same release.
    pub sums_url: Option<String>,
}

/// Picks the asset from a GitHub "release" JSON. Only https download links on github.com.
pub fn pick_asset(release: &Value, pattern: &str) -> Result<ReleaseAsset, String> {
    let tag = release["tag_name"].as_str().ok_or("The release has no tag")?.to_string();
    let assets = release["assets"].as_array().cloned().unwrap_or_default();
    let name_of = |a: &Value| a["name"].as_str().unwrap_or("").to_string();
    let a = assets.iter().find(|a| catalogmods::glob(pattern, &name_of(a))).ok_or("The latest release has no matching add-on file")?;
    let url = a["browser_download_url"].as_str().unwrap_or("").to_string();
    if !url.starts_with("https://github.com/") {
        return Err("The add-on download is not a GitHub release file".into());
    }
    let digest = a["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).filter(|d| d.len() == 64 && d.chars().all(|c| c.is_ascii_hexdigit())).map(|d| d.to_lowercase());
    let sums_url = assets
        .iter()
        .find(|s| {
            let n = name_of(s).to_lowercase();
            n.starts_with("sha256sums") || n == format!("{}.sha256", name_of(a).to_lowercase())
        })
        .and_then(|s| s["browser_download_url"].as_str().map(String::from))
        .filter(|u| u.starts_with("https://github.com/"));
    Ok(ReleaseAsset { tag, name: name_of(a), url, digest, sums_url })
}

/// The hash for `file` in a SHA256SUMS text ("<hex>  <name>" or "<hex> *<name>", or a lone hash).
pub fn sum_for(text: &str, file: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    for l in &lines {
        let mut it = l.split_whitespace();
        let (Some(h), name) = (it.next(), it.next()) else { continue };
        let ok = h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit());
        if ok && (name.map(|n| n.trim_start_matches('*').eq_ignore_ascii_case(file)).unwrap_or(lines.len() == 1)) {
            return Some(h.to_lowercase());
        }
    }
    None
}

// ------------------------------------------------------------------ installed state

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub id: String,
    /// Version from the add-on's manifest.
    pub version: String,
    /// Release tag it came from ("" for a dev build), used for update checks.
    #[serde(default)]
    pub tag: String,
    pub enabled: bool,
    /// "github:<owner/repo>" or "dev:<folder>".
    pub source: String,
    pub sha256: String,
    /// "github-digest", "sha256sums", "none" (no hash published) or "dev".
    pub verified: String,
    pub path: String,
    pub permissions: Vec<String>,
    pub hosts: Vec<String>,
    pub installed_at: String,
    /// The extension id WebView2 gave it (set once it is loaded).
    #[serde(default)]
    pub ext_id: Option<String>,
}

pub fn root(data: &Path) -> PathBuf {
    data.join("BrowserAddons")
}

fn state_file(data: &Path) -> PathBuf {
    root(data).join("addons.json")
}

fn lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

pub fn load(data: &Path) -> Vec<Installed> {
    std::fs::read_to_string(state_file(data)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(data: &Path, list: &[Installed]) -> Result<(), String> {
    let f = state_file(data);
    std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    fsx::write(&f, serde_json::to_string_pretty(list).map_err(|e| e.to_string())?.as_bytes())
}

pub fn update_state(data: &Path, f: impl FnOnce(&mut Vec<Installed>)) -> Result<Vec<Installed>, String> {
    let _g = lock().lock().unwrap();
    let mut list = load(data);
    f(&mut list);
    save(data, &list)?;
    Ok(list)
}

// ------------------------------------------------------------------ prepare / apply

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub version: String,
    pub tag: String,
    pub source: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub verified: String,
    pub permissions: Vec<String>,
    pub hosts: Vec<String>,
    /// Asked for beyond the catalog's list.
    pub extra: Vec<String>,
    pub update: bool,
}

struct Staged {
    plan: Plan,
    files: Vec<(String, Vec<u8>)>,
}

fn staged() -> &'static Mutex<HashMap<String, Staged>> {
    static S: OnceLock<Mutex<HashMap<String, Staged>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `TMHUB_ADDON_DEV=<id>=<folder>`: a local build of that add-on may be installed.
pub fn dev_folder(id: &str) -> Option<PathBuf> {
    let v = std::env::var("TMHUB_ADDON_DEV").ok()?;
    let (k, p) = v.split_once('=')?;
    (k.trim() == id && Path::new(p.trim()).join("manifest.json").is_file()).then(|| PathBuf::from(p.trim()))
}

fn read_dir_files(dir: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    fn walk(base: &Path, d: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
        for e in std::fs::read_dir(d).map_err(|e| e.to_string())? {
            let p = e.map_err(|e| e.to_string())?.path();
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with('.') || name == "node_modules" || name == "dist" || name.ends_with(".zip") {
                continue;
            }
            if p.is_dir() {
                walk(base, &p, out)?;
            } else {
                let rel = p.strip_prefix(base).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
                out.push((rel, std::fs::read(&p).map_err(|e| e.to_string())?));
                if out.len() > MAX_FILES {
                    return Err("The folder has too many files".into());
                }
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    Ok(out)
}

/// Downloads (or reads the dev folder), checks and stages one add-on; nothing is installed yet.
pub fn prepare(data: &Path, id: &str, dev: bool) -> Result<Plan, String> {
    let entry = find(id)?;
    let installed = load(data).into_iter().find(|i| i.id == id);
    let (files, tag, source, file, size, sha256, verified) = if dev {
        let dir = dev_folder(id).ok_or("No development folder set for this add-on (TMHUB_ADDON_DEV)")?;
        let files = read_dir_files(&dir)?;
        let size = files.iter().map(|(_, b)| b.len() as u64).sum();
        let mut all: Vec<u8> = Vec::new();
        for (n, b) in &files {
            all.extend_from_slice(n.as_bytes());
            all.extend_from_slice(b);
        }
        (files, String::new(), format!("dev:{}", dir.display()), dir.display().to_string(), size, sha256_hex(&all), "dev".to_string())
    } else {
        if entry.spec.install != "github" {
            return Err("This add-on is only available from its store page".into());
        }
        let repo = entry.spec.github.as_deref().filter(|r| valid_repo(r)).ok_or("The add-on has no valid GitHub source")?;
        let pattern = entry.spec.asset.as_deref().unwrap_or("*.zip");
        let rel = net::get_json(&format!("https://api.github.com/repos/{repo}/releases/latest"))?;
        let asset = pick_asset(&rel, pattern)?;
        let (bytes, fin) = net::get_bytes_final(&asset.url, MAX_DOWNLOAD)?;
        if !fin.starts_with("https://") {
            return Err("The download left https".into());
        }
        let sha = sha256_hex(&bytes);
        let (want, how) = match (&asset.digest, &asset.sums_url) {
            (Some(d), _) => (Some(d.clone()), "github-digest"),
            (None, Some(u)) => {
                let text = String::from_utf8_lossy(&net::get_bytes(u, 1 << 20)?).to_string();
                (Some(sum_for(&text, &asset.name).ok_or("The release's SHA256SUMS does not list the add-on file")?), "sha256sums")
            }
            _ => (None, "none"),
        };
        if let Some(w) = want {
            if w != sha {
                return Err(format!("SHA-256 mismatch: the release says {w}, the download is {sha}. Not installed."));
            }
        }
        let files = extension_files(unzip(&bytes)?)?;
        (files, asset.tag.clone(), format!("github:{repo}"), asset.name.clone(), bytes.len() as u64, sha, how.to_string())
    };
    let files = if dev { extension_files(files)? } else { files };
    let manifest = files.iter().find(|(n, _)| n == "manifest.json").ok_or("No manifest.json")?;
    let m = parse_manifest(&manifest.1)?;
    let plan = Plan {
        id: id.into(),
        name: if m.name.is_empty() || m.name.starts_with("__MSG_") { entry.name.clone() } else { m.name.clone() },
        version: m.version.clone(),
        tag,
        source,
        file,
        size,
        sha256,
        verified,
        extra: extra_permissions(&m, &entry.spec),
        permissions: m.permissions,
        hosts: m.hosts,
        update: installed.is_some(),
    };
    staged().lock().unwrap().insert(id.into(), Staged { plan: plan.clone(), files });
    Ok(plan)
}

fn folder_name(version: &str, sha: &str) -> String {
    let v: String = version.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
    format!("{}-{}", if v.is_empty() { "0".into() } else { v }, &sha[..sha.len().min(10)])
}

/// Writes the staged add-on into its own folder and records it. Returns the new record and the
/// previous one (its folder and WebView2 id are replaced by the host).
pub fn apply(data: &Path, id: &str) -> Result<(Installed, Option<Installed>), String> {
    let st = staged().lock().unwrap().remove(id).ok_or("Nothing prepared for this add-on; start again")?;
    let dir = root(data).join(id).join(folder_name(&st.plan.version, &st.plan.sha256));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    for (rel, b) in &st.files {
        let to = dir.join(rel);
        if !to.starts_with(&dir) || fsx::blocked(&to) {
            return Err(format!("Refused path {rel}"));
        }
        std::fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
        fsx::write(&to, b)?;
    }
    let previous = load(data).into_iter().find(|i| i.id == id);
    let rec = Installed {
        id: id.into(),
        version: st.plan.version.clone(),
        tag: st.plan.tag.clone(),
        enabled: previous.as_ref().map(|p| p.enabled).unwrap_or(true),
        source: st.plan.source.clone(),
        sha256: st.plan.sha256.clone(),
        verified: st.plan.verified.clone(),
        path: dir.to_string_lossy().to_string(),
        permissions: st.plan.permissions.clone(),
        hosts: st.plan.hosts.clone(),
        installed_at: fsx::stamp(),
        ext_id: None,
    };
    let r2 = rec.clone();
    update_state(data, move |l| {
        l.retain(|i| i.id != r2.id);
        l.push(r2);
    })?;
    Ok((rec, previous))
}

/// Deletes an add-on folder (only inside BrowserAddons).
pub fn delete_folder(data: &Path, path: &str) {
    let p = PathBuf::from(path);
    if p.starts_with(root(data)) && p.is_dir() {
        let _ = std::fs::remove_dir_all(&p);
    }
}

// ------------------------------------------------------------------ updates

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonUpdate {
    pub id: String,
    pub installed: String,
    pub latest: Option<String>,
    pub update: bool,
    pub error: Option<String>,
}

pub fn check_updates(data: &Path, cache: &Path) -> Vec<AddonUpdate> {
    load(data)
        .into_iter()
        .filter_map(|i| {
            let repo = i.source.strip_prefix("github:")?.to_string();
            let entry = find(&i.id).ok()?;
            if entry.spec.github.as_deref() != Some(repo.as_str()) {
                return None;
            }
            Some(match updates::latest_tag(cache, &repo) {
                Ok(t) => AddonUpdate { id: i.id.clone(), update: updates::is_newer(&t, &i.tag), installed: i.tag.clone(), latest: Some(t), error: None },
                Err(e) => AddonUpdate { id: i.id.clone(), installed: i.tag.clone(), latest: None, update: false, error: Some(e) },
            })
        })
        .collect()
}

// ------------------------------------------------------------------ host (WebView2)

/// What the platform can do: (supported, reason when not).
pub fn support() -> (bool, Option<String>) {
    if cfg!(windows) {
        (true, None)
    } else {
        (false, Some("The embedded browser on Linux (WebKitGTK) cannot run browser add-ons.".into()))
    }
}

#[cfg(windows)]
pub mod host {
    //! The embedded view's WebView2 profile: list, add, enable/disable and remove extensions.
    //! Every call runs on the UI thread through `with_webview`; the COM completion handlers send
    //! their result back over a channel, which the calling (command) thread waits on.
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{AppHandle, Manager, Runtime};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, BrowserExtensionEnableCompletedHandler, BrowserExtensionRemoveCompletedHandler, ProfileAddBrowserExtensionCompletedHandler, ProfileGetBrowserExtensionsCompletedHandler};
    use windows_core::{Interface, BOOL, HSTRING, PWSTR};

    #[derive(Debug, Clone)]
    pub struct Ext {
        pub id: String,
        pub name: String,
        pub enabled: bool,
    }

    fn profile(pw: &tauri::webview::PlatformWebview) -> Result<ICoreWebView2Profile7, String> {
        unsafe {
            let wv = pw.controller().CoreWebView2().map_err(|e| format!("webview: {e}"))?;
            let p = wv.cast::<ICoreWebView2_13>().map_err(|e| format!("WebView2 runtime too old for profiles: {e}"))?.Profile().map_err(|e| format!("profile: {e}"))?;
            p.cast::<ICoreWebView2Profile7>().map_err(|e| format!("WebView2 runtime too old for add-ons: {e}"))
        }
    }

    fn ext_info(e: &ICoreWebView2BrowserExtension) -> Ext {
        unsafe {
            let mut id = PWSTR::null();
            let mut name = PWSTR::null();
            let mut on = BOOL::default();
            let _ = e.Id(&mut id);
            let _ = e.Name(&mut name);
            let _ = e.IsEnabled(&mut on);
            Ext { id: take_pwstr(id), name: take_pwstr(name), enabled: on.as_bool() }
        }
    }

    fn run<R: Runtime, T: Send + 'static>(app: &AppHandle<R>, f: impl FnOnce(tauri::webview::PlatformWebview, mpsc::Sender<Result<T, String>>) + Send + 'static) -> Result<T, String> {
        let wv = app.get_webview(crate::web::LABEL).ok_or("The embedded browser is not open")?;
        let (tx, rx) = mpsc::channel();
        let tx2 = tx.clone();
        wv.with_webview(move |pw| f(pw, tx2)).map_err(|e| e.to_string())?;
        drop(tx);
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "The embedded browser did not answer".to_string())?
    }

    /// With the matching extension (by id) from the profile's list.
    fn with_ext<R: Runtime, T: Send + 'static>(
        app: &AppHandle<R>,
        id: &str,
        act: impl FnOnce(ICoreWebView2BrowserExtension, mpsc::Sender<Result<T, String>>) + Send + 'static,
    ) -> Result<T, String> {
        let id = id.to_string();
        run(app, move |pw, tx| {
            let p = match profile(&pw) {
                Ok(p) => p,
                Err(e) => return drop(tx.send(Err(e))),
            };
            let tx2 = tx.clone();
            let h = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |hr, list| {
                if hr.is_err() {
                    let _ = tx2.send(Err(format!("listing failed: {hr:?}")));
                    return Ok(());
                }
                let Some(list) = list else {
                    let _ = tx2.send(Err("no list".into()));
                    return Ok(());
                };
                let mut n = 0u32;
                unsafe { list.Count(&mut n)? };
                for i in 0..n {
                    let e = unsafe { list.GetValueAtIndex(i)? };
                    if ext_info(&e).id == id {
                        act(e, tx2);
                        return Ok(());
                    }
                }
                let _ = tx2.send(Err("The add-on is not loaded in the embedded browser".into()));
                Ok(())
            }));
            if let Err(e) = unsafe { p.GetBrowserExtensions(&h) } {
                let _ = tx.send(Err(format!("listing add-ons: {e}")));
            }
        })
    }

    pub fn list<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Ext>, String> {
        run(app, |pw, tx| {
            let p = match profile(&pw) {
                Ok(p) => p,
                Err(e) => return drop(tx.send(Err(e))),
            };
            let tx2 = tx.clone();
            let h = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |hr, list| {
                let mut out = Vec::new();
                if let (true, Some(list)) = (hr.is_ok(), list) {
                    let mut n = 0u32;
                    unsafe { list.Count(&mut n)? };
                    for i in 0..n {
                        out.push(ext_info(&unsafe { list.GetValueAtIndex(i)? }));
                    }
                    let _ = tx2.send(Ok(out));
                } else {
                    let _ = tx2.send(Err(format!("listing failed: {hr:?}")));
                }
                Ok(())
            }));
            if let Err(e) = unsafe { p.GetBrowserExtensions(&h) } {
                let _ = tx.send(Err(format!("listing add-ons: {e}")));
            }
        })
    }

    pub fn add<R: Runtime>(app: &AppHandle<R>, folder: &Path) -> Result<Ext, String> {
        let path = HSTRING::from(folder);
        run(app, move |pw, tx| {
            let p = match profile(&pw) {
                Ok(p) => p,
                Err(e) => return drop(tx.send(Err(e))),
            };
            let tx2 = tx.clone();
            let h = ProfileAddBrowserExtensionCompletedHandler::create(Box::new(move |hr, ext| {
                let _ = tx2.send(match (hr.is_ok(), ext) {
                    (true, Some(e)) => Ok(ext_info(&e)),
                    _ => Err(format!("WebView2 refused the add-on: {hr:?}")),
                });
                Ok(())
            }));
            if let Err(e) = unsafe { p.AddBrowserExtension(&path, &h) } {
                let _ = tx.send(Err(format!("adding the add-on: {e}")));
            }
        })
    }

    pub fn enable<R: Runtime>(app: &AppHandle<R>, id: &str, on: bool) -> Result<(), String> {
        with_ext(app, id, move |e, tx| {
            let tx2 = tx.clone();
            let h = BrowserExtensionEnableCompletedHandler::create(Box::new(move |hr| {
                let _ = tx2.send(hr.map_err(|e| format!("switching the add-on: {e}")));
                Ok(())
            }));
            if let Err(err) = unsafe { e.Enable(on, &h) } {
                let _ = tx.send(Err(err.to_string()));
            }
        })
    }

    pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
        with_ext(app, id, move |e, tx| {
            let tx2 = tx.clone();
            let h = BrowserExtensionRemoveCompletedHandler::create(Box::new(move |hr| {
                let _ = tx2.send(hr.map_err(|e| format!("removing the add-on: {e}")));
                Ok(())
            }));
            if let Err(err) = unsafe { e.Remove(&h) } {
                let _ = tx.send(Err(err.to_string()));
            }
        })
    }
}

/// WebView2 ids of every add-on this app ever loaded (so a removed or replaced one can be unloaded
/// later). Extensions WebView2 brings itself are never touched.
fn known_ids(data: &Path) -> Vec<String> {
    std::fs::read_to_string(root(data).join("loaded-ids.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn remember_id(data: &Path, id: &str) {
    let mut ids = known_ids(data);
    if !ids.iter().any(|i| i == id) {
        ids.push(id.to_string());
        let _ = std::fs::create_dir_all(root(data));
        let _ = fsx::write(&root(data).join("loaded-ids.json"), serde_json::to_string(&ids).unwrap_or_default().as_bytes());
    }
}

/// Makes the embedded profile match `addons.json`: add-ons this app loaded earlier but no longer
/// lists are unloaded, missing ones added (and their WebView2 id recorded), the on/off state
/// applied. No-op when the view is closed.
#[cfg(windows)]
pub fn sync<R: tauri::Runtime>(app: &tauri::AppHandle<R>, data: &Path) -> Result<Vec<String>, String> {
    use tauri::Manager;
    if app.get_webview(crate::web::LABEL).is_none() {
        return Ok(vec![]);
    }
    let mut notes = Vec::new();
    let present = host::list(app)?;
    let mut list = load(data);
    let known = known_ids(data);
    for e in &present {
        let listed = list.iter().any(|i| i.ext_id.as_deref() == Some(e.id.as_str()) && Path::new(&i.path).is_dir());
        if !listed && known.contains(&e.id) {
            host::remove(app, &e.id)?;
            notes.push(format!("removed {}", e.name));
        }
    }
    for i in list.iter_mut() {
        let loaded = i.ext_id.as_ref().and_then(|id| present.iter().find(|e| &e.id == id));
        let id = match loaded {
            Some(e) => e.id.clone(),
            None => {
                let e = host::add(app, Path::new(&i.path))?;
                remember_id(data, &e.id);
                notes.push(format!("loaded {}", e.name));
                i.ext_id = Some(e.id.clone());
                e.id
            }
        };
        let now = host::list(app)?.into_iter().find(|e| e.id == id).map(|e| e.enabled);
        if now.is_some() && now != Some(i.enabled) {
            host::enable(app, &id, i.enabled)?;
        }
    }
    let snapshot = list.clone();
    update_state(data, move |l| {
        for i in l.iter_mut() {
            if let Some(s) = snapshot.iter().find(|s| s.id == i.id && s.path == i.path) {
                i.ext_id = s.ext_id.clone();
            }
        }
    })?;
    Ok(notes)
}

#[cfg(not(windows))]
pub fn sync<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _data: &Path) -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            for (n, c) in files {
                z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
                std::io::Write::write_all(&mut z, c.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    const MV3: &str = r#"{"manifest_version":3,"name":"TMX Universal Track Downloader","version":"3.0.0",
        "permissions":["storage","alarms"],"host_permissions":["*://tmnf.exchange/*","https://100tmx.com/*","http://127.0.0.1/*"],
        "content_scripts":[{"matches":["*://tmuf.exchange/tracksearch*"],"js":["c.js"]}]}"#;

    #[test]
    fn bundled_catalog_has_the_owners_addon() {
        let a = catalog().iter().find(|a| a.id == "tmx-universal-track-downloader").expect("catalog entry");
        assert_eq!(a.spec.install, "github");
        assert_eq!(a.spec.github.as_deref(), Some("cheatoskar/TMX-Downloader"));
        assert!(catalog().iter().all(|a| a.spec.install == "github" || a.spec.install == "store"));
        assert!(catalog().iter().filter(|a| a.spec.install == "github").all(|a| a.spec.github.as_deref().map(valid_repo).unwrap_or(false)));
    }

    #[test]
    fn manifest_permissions_and_extras() {
        let m = parse_manifest(MV3.as_bytes()).unwrap();
        assert_eq!(m.version, "3.0.0");
        assert_eq!(m.permissions, vec!["alarms", "storage"]);
        assert!(m.hosts.contains(&"*://tmuf.exchange/tracksearch*".to_string()));
        let spec = AddonSpec {
            install: "github".into(),
            permissions: vec!["storage".into(), "alarms".into()],
            hosts: vec!["*://tmnf.exchange/*".into(), "*://tmuf.exchange/*".into(), "https://100tmx.com/*".into(), "http://127.0.0.1/*".into()],
            ..Default::default()
        };
        assert!(extra_permissions(&m, &spec).is_empty());
        let wide = parse_manifest(br#"{"manifest_version":3,"permissions":["tabs","<all_urls>"],"version":"1"}"#).unwrap();
        assert_eq!(extra_permissions(&wide, &spec), vec!["tabs".to_string(), "*".to_string()]);
        assert!(parse_manifest(br#"{"manifest_version":2,"version":"1"}"#).unwrap_err().contains("V2"));
        assert!(parse_manifest(b"not json").is_err());
        assert_eq!(pattern_host("*://TMNF.exchange/tracksearch*"), "tmnf.exchange");
    }

    #[test]
    fn zip_layouts_and_unsafe_paths() {
        let flat = extension_files(unzip(&zip_of(&[("manifest.json", MV3), ("icons/i.png", "x")])).unwrap()).unwrap();
        assert!(flat.iter().any(|(n, _)| n == "icons/i.png"));
        let nested = extension_files(unzip(&zip_of(&[("ext/manifest.json", MV3), ("ext/a.js", "1"), ("README.md", "r")])).unwrap()).unwrap();
        let names: Vec<_> = nested.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["manifest.json", "a.js"]);
        assert!(extension_files(unzip(&zip_of(&[("a/manifest.json", MV3), ("b/manifest.json", MV3)])).unwrap()).is_err());
        assert!(extension_files(unzip(&zip_of(&[("manifest.json", MV3), ("../evil.js", "x")])).unwrap()).is_err());
        assert!(extension_files(vec![("C:/x/manifest.json".into(), vec![])]).is_err());
    }

    #[test]
    fn release_assets_and_hashes() {
        let rel = json!({"tag_name": "v3.0.0", "assets": [
            {"name": "TMX-Downloader-3.0.0-firefox.zip", "browser_download_url": "https://github.com/o/r/releases/download/v3.0.0/TMX-Downloader-3.0.0-firefox.zip", "digest": "sha256:aa"},
            {"name": "TMX-Downloader-3.0.0-chrome.zip", "browser_download_url": "https://github.com/o/r/releases/download/v3.0.0/TMX-Downloader-3.0.0-chrome.zip", "digest": format!("sha256:{}", "AB".repeat(32))},
            {"name": "SHA256SUMS.txt", "browser_download_url": "https://github.com/o/r/releases/download/v3.0.0/SHA256SUMS.txt"}
        ]});
        let a = pick_asset(&rel, "TMX-Downloader-*-chrome.zip").unwrap();
        assert_eq!(a.tag, "v3.0.0");
        assert_eq!(a.name, "TMX-Downloader-3.0.0-chrome.zip");
        assert_eq!(a.digest.as_deref(), Some("ab".repeat(32).as_str()));
        assert!(a.sums_url.unwrap().ends_with("SHA256SUMS.txt"));
        assert!(pick_asset(&rel, "*.crx").is_err());
        let evil = json!({"tag_name": "1", "assets": [{"name": "x.zip", "browser_download_url": "http://example.com/x.zip"}]});
        assert!(pick_asset(&evil, "*.zip").is_err());
        let h = "c".repeat(64);
        assert_eq!(sum_for(&format!("{h}  TMX-Downloader-3.0.0-chrome.zip\n{}  other.zip\n", "d".repeat(64)), "TMX-Downloader-3.0.0-chrome.zip"), Some(h.clone()));
        assert_eq!(sum_for(&format!("{h} *x.zip"), "x.zip"), Some(h.clone()));
        assert_eq!(sum_for(&h, "x.zip"), Some(h.clone()));
        assert_eq!(sum_for("zz  x.zip", "x.zip"), None);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn only_catalog_ids_and_github_sources() {
        let t = tempfile::tempdir().unwrap();
        assert!(prepare(t.path(), "https://evil.example/x.zip", false).unwrap_err().contains("Not an add-on"));
        assert!(!valid_repo("../x") && !valid_repo("a/b/c") && valid_repo("cheatoskar/TMX-Downloader"));
        // Store-only entries are never downloaded.
        if let Some(store) = catalog().iter().find(|a| a.spec.install == "store") {
            assert!(prepare(t.path(), &store.id, false).unwrap_err().contains("store page"));
        }
    }

    #[test]
    fn apply_records_and_replaces_in_a_sandbox() {
        let t = tempfile::tempdir().unwrap();
        let id = "tmx-universal-track-downloader";
        let files = extension_files(unzip(&zip_of(&[("manifest.json", MV3), ("c.js", "//")])).unwrap()).unwrap();
        let plan = |v: &str, sha: &str| Plan {
            id: id.into(), name: "TMX".into(), version: v.into(), tag: format!("v{v}"), source: "github:cheatoskar/TMX-Downloader".into(),
            file: "x.zip".into(), size: 1, sha256: sha.into(), verified: "github-digest".into(), permissions: vec![], hosts: vec![], extra: vec![], update: false,
        };
        staged().lock().unwrap().insert(id.into(), Staged { plan: plan("2.7.1", &"a".repeat(64)), files: files.clone() });
        let (first, prev) = apply(t.path(), id).unwrap();
        assert!(prev.is_none());
        assert!(Path::new(&first.path).join("manifest.json").is_file());
        assert!(Path::new(&first.path).starts_with(root(t.path())));
        update_state(t.path(), |l| l[0].enabled = false).unwrap();
        staged().lock().unwrap().insert(id.into(), Staged { plan: plan("3.0.0", &"b".repeat(64)), files });
        let (second, prev) = apply(t.path(), id).unwrap();
        assert_eq!(prev.unwrap().version, "2.7.1");
        assert!(!second.enabled, "an update keeps the user's on/off choice");
        let list = load(t.path());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].tag, "v3.0.0");
        delete_folder(t.path(), &first.path);
        assert!(!Path::new(&first.path).exists());
        // Never outside BrowserAddons.
        let outside = t.path().join("keep");
        std::fs::create_dir_all(&outside).unwrap();
        delete_folder(t.path(), &outside.to_string_lossy());
        assert!(outside.exists());
        assert!(apply(t.path(), id).is_err(), "nothing staged any more");
    }

    #[test]
    fn update_versions() {
        assert!(updates::is_newer("v3.0.0", "v2.7.1"));
        assert!(!updates::is_newer("v2.7.1", "v2.7.1"));
        assert_eq!(folder_name("3.0.0", &"f".repeat(64)), "3.0.0-ffffffffff");
        assert_eq!(folder_name("1 /..", "ab"), "1__..-ab");
    }
}

// ------------------------------------------------------------------ commands

pub mod cmd {
    use super::*;
    use crate::state::AppState;
    use tauri::{AppHandle, Manager};

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AddonsInfo {
        pub supported: bool,
        pub reason: Option<String>,
        pub installed: Vec<Installed>,
        /// Catalog ids with a development folder set (TMHUB_ADDON_DEV).
        pub dev: Vec<String>,
    }

    fn dirs<R: tauri::Runtime>(app: &AppHandle<R>) -> (PathBuf, PathBuf) {
        let st = app.state::<AppState>();
        (st.data_dir.clone(), st.cache_dir.clone())
    }

    fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
        async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
    }

    /// Loads the profile's add-ons in step with addons.json (when the embedded view is open).
    pub fn sync_now<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let (data, _) = dirs(app);
        sync(app, &data).map(|_| ())
    }

    #[tauri::command]
    pub async fn addons_list(app: AppHandle) -> Result<AddonsInfo, String> {
        let (data, _) = dirs(&app);
        let (supported, reason) = support();
        Ok(AddonsInfo {
            supported,
            reason,
            installed: load(&data),
            dev: catalog().iter().filter(|a| dev_folder(&a.id).is_some()).map(|a| a.id.clone()).collect(),
        })
    }

    #[tauri::command]
    pub async fn addons_prepare(app: AppHandle, id: String, dev: bool) -> Result<Plan, String> {
        if !support().0 {
            return Err(support().1.unwrap_or_default());
        }
        let (data, _) = dirs(&app);
        blocking(move || prepare(&data, &id, dev)).await
    }

    #[tauri::command]
    pub async fn addons_apply(app: AppHandle, id: String) -> Result<Vec<Installed>, String> {
        let (data, _) = dirs(&app);
        let d2 = data.clone();
        let a2 = app.clone();
        blocking(move || {
            let (rec, prev) = apply(&d2, &id)?;
            if let Some(p) = prev {
                #[cfg(windows)]
                if let Some(ext) = &p.ext_id {
                    let _ = host::remove(&a2, ext);
                }
                if p.path != rec.path {
                    delete_folder(&d2, &p.path);
                }
            }
            let _ = &a2;
            sync(&a2, &d2)?;
            Ok(load(&d2))
        })
        .await
    }

    #[tauri::command]
    pub async fn addons_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<Vec<Installed>, String> {
        let (data, _) = dirs(&app);
        blocking(move || {
            update_state(&data, |l| {
                if let Some(i) = l.iter_mut().find(|i| i.id == id) {
                    i.enabled = enabled;
                }
            })?;
            sync(&app, &data)?;
            Ok(load(&data))
        })
        .await
    }

    #[tauri::command]
    pub async fn addons_remove(app: AppHandle, id: String) -> Result<Vec<Installed>, String> {
        let (data, _) = dirs(&app);
        blocking(move || {
            let rec = load(&data).into_iter().find(|i| i.id == id).ok_or("Not installed")?;
            update_state(&data, |l| l.retain(|i| i.id != id))?;
            // Unloading from the profile happens in sync (it is no longer in addons.json).
            sync(&app, &data)?;
            delete_folder(&data, &rec.path);
            Ok(load(&data))
        })
        .await
    }

    #[tauri::command]
    pub async fn addons_check(app: AppHandle) -> Result<Vec<AddonUpdate>, String> {
        let (data, cache) = dirs(&app);
        blocking(move || Ok(check_updates(&data, &cache))).await
    }
}

