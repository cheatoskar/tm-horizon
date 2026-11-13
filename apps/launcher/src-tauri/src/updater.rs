//! TM Horizon updates through tauri-plugin-updater: `latest.json` of the GitHub release
//! (stable: the latest release, beta: the `updater-beta` release), signed installers checked
//! against the public key in tauri.conf.json (`plugins.updater.pubkey`, the key in
//! ~/.tauri/tm-horizon-updater.key since 0.5.0). See docs/release.md.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const STABLE_URL: &str = "https://github.com/cheatoskar/tm-horizon/releases/latest/download/latest.json";
pub const BETA_URL: &str = "https://github.com/cheatoskar/tm-horizon/releases/download/updater-beta/latest.json";

static PENDING: Mutex<Option<Update>> = Mutex::new(None);
/// Downloaded (signature checked by the plugin) and waiting to be installed: at the next start, when the
/// launcher closes, or on "Restart now". Also on disk (`<data>\updates`) for the next start.
static STAGED: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);

pub fn endpoint(channel: &str) -> &'static str {
    if channel == "beta" {
        BETA_URL
    } else {
        STABLE_URL
    }
}

/// Test hooks (TMHUB_UPDATE_ENDPOINT, TMHUB_UPDATE_PUBKEY, TMHUB_UPDATE_DRY_RUN) work in debug builds only;
/// a release build ignores them. `debug` is a parameter so the tests can check both cases.
fn hook(debug: bool, value: Option<String>) -> Option<String> {
    if debug { value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) } else { None }
}

fn pick_endpoint(channel: &str, debug: bool, env: Option<String>) -> String {
    hook(debug, env).unwrap_or_else(|| endpoint(channel).to_string())
}

/// The config's key (in tauri.conf.json since 0.5.0); debug builds take TMHUB_UPDATE_PUBKEY first, so the
/// local end-to-end test (tools/updater-e2e.mjs) can use its throwaway key.
fn pick_pubkey(config: &str, debug: bool, env: Option<String>) -> String {
    hook(debug, env).unwrap_or_else(|| config.trim().to_string())
}

fn pick_dry_run(debug: bool, env: Option<String>) -> bool {
    hook(debug, env).is_some_and(|v| v == "1")
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// false: this build cannot update itself (no public key, or a deb/rpm install on Linux).
    pub enabled: bool,
    /// Why not: "no-key" (built without the updater key) or "package" (deb/rpm on Linux).
    pub reason: Option<String>,
    pub current: String,
    pub channel: String,
    pub at_start: bool,
    /// Install updates automatically (download in the background, install at the next start or on close).
    pub auto: bool,
    /// Version downloaded and waiting to be installed (memory or disk), newer than this build.
    pub staged: Option<String>,
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// The public key of the build; in debug builds TMHUB_UPDATE_PUBKEY fills in when the config has none.
fn pubkey(app: &AppHandle) -> String {
    let cfg = app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|v| v.as_str()).unwrap_or("");
    pick_pubkey(cfg, cfg!(debug_assertions), env_var("TMHUB_UPDATE_PUBKEY"))
}

/// Why this build cannot update itself, if it cannot (a code the UI translates).
fn blocker(app: &AppHandle) -> Option<String> {
    if pubkey(app).is_empty() {
        return Some("no-key".into());
    }
    if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none() {
        return Some("package".into());
    }
    None
}

fn base(app: &AppHandle, st: &AppState) -> UpdateInfo {
    let s = st.settings();
    let reason = blocker(app);
    UpdateInfo {
        enabled: reason.is_none(),
        reason,
        current: app.package_info().version.to_string(),
        channel: if s.update_channel == "beta" { "beta".into() } else { "stable".into() },
        at_start: s.update_at_start,
        auto: s.update_auto,
        staged: staged_meta(&st.data_dir).map(|m| m.version).filter(|v| newer(v, &app.package_info().version.to_string())),
        ..Default::default()
    }
}

// ------------------------------------------------------------------ staging and the install rules

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StagedMeta {
    pub version: String,
    pub sha256: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

fn staged_dir(data: &Path) -> PathBuf {
    data.join("updates")
}

pub fn staged_meta(data: &Path) -> Option<StagedMeta> {
    serde_json::from_slice(&std::fs::read(staged_dir(data).join("staged.json")).ok()?).ok()
}

/// Keeps the downloaded installer for the next start (one at a time; an older one is removed).
pub fn write_staged(data: &Path, meta: &StagedMeta, bytes: &[u8]) -> Result<(), String> {
    let dir = staged_dir(data);
    let _ = std::fs::remove_dir_all(&dir);
    crate::fsx::write(&dir.join("installer.bin"), bytes)?;
    crate::fsx::write(&dir.join("staged.json"), &serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?)
}

/// The staged installer if it is still the file that was downloaded (SHA-256 against the note).
pub fn read_staged(data: &Path, version: &str) -> Option<Vec<u8>> {
    let m = staged_meta(data).filter(|m| m.version == version)?;
    let b = std::fs::read(staged_dir(data).join("installer.bin")).ok()?;
    (format!("{:x}", Sha256::digest(&b)) == m.sha256).then_some(b)
}

pub fn clear_staged(data: &Path) {
    let _ = std::fs::remove_dir_all(staged_dir(data));
}

/// `a` is a newer version than `b` (semver; unparsable = not newer).
pub fn newer(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a.trim_start_matches('v')), semver::Version::parse(b.trim_start_matches('v'))) {
        (Ok(x), Ok(y)) => x > y,
        _ => false,
    }
}

/// When a staged update may be installed without asking: automatic updates on, a staged version newer than
/// this build, and no game running (a game started from the launcher must never lose its launcher mid-run).
/// `Err` = the reason it waits.
pub fn may_install(auto: bool, staged: Option<&str>, current: &str, game_running: Option<&str>) -> Result<(), String> {
    let Some(v) = staged else { return Err("nothing staged".into()) };
    if !newer(v, current) {
        return Err("staged version is not newer".into());
    }
    if !auto {
        return Err("automatic updates are off".into());
    }
    if let Some(g) = game_running {
        return Err(format!("{g} is running"));
    }
    Ok(())
}

/// When the installer runs, and whether the launcher comes back afterwards.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum When {
    /// "Restart now" in the pill / Settings.
    Now,
    /// Start of a session with an update downloaded earlier (the close did not install it).
    Start,
    /// The player closed the launcher: install, but do not open it again.
    Close,
}

/// Relaunch after installing: yes when the player is using the launcher (Now, Start), never after a close.
/// Windows: the plugin's NSIS updater runs the installer passive (`/P /UPDATE`) and adds `/R` (start the app
/// again) only when this is true. Elsewhere the UI restarts the app itself after Now / Start.
pub fn relaunch_after(w: When) -> bool {
    w != When::Close
}

/// The first running game process (any TrackMania game), if any. TMLoader alone does not count: its tray icon
/// stays open after the game closed, and the launcher's own update touches nothing of TMLoader.
pub fn game_running(running: &[String]) -> Option<String> {
    let games: Vec<String> = ["tmnf", "tmuf", "tmn-eswc", "tm-sunrise", "tm-original", "tm-2003", "tm2020", "tm2-stadium", "tm-turbo"].iter().map(|g| g.to_string()).collect();
    let procs: Vec<String> = crate::history::processes_for(&games).into_iter().filter(|p| p != "tmloader.exe").collect();
    running.iter().find(|r| procs.iter().any(|p| p.eq_ignore_ascii_case(r))).cloned()
}

/// Settings of the update check plus whether it can run at all; no network.
#[tauri::command(async)]
pub fn update_status(app: AppHandle, st: State<AppState>) -> UpdateInfo {
    base(&app, &st)
}

#[tauri::command(async)]
pub fn update_settings(app: AppHandle, st: State<AppState>, channel: String, at_start: bool, auto: Option<bool>) -> Result<UpdateInfo, String> {
    if channel != "stable" && channel != "beta" {
        return Err("Unknown channel".into());
    }
    let switched = st.settings().update_channel != channel;
    st.update_settings(|s| {
        s.update_channel = channel;
        s.update_at_start = at_start;
        if let Some(a) = auto {
            s.update_auto = a;
        }
    })?;
    if switched {
        // Another channel: what was downloaded for the old one is not wanted any more.
        clear_staged(&st.data_dir);
        *STAGED.lock().unwrap() = None;
    }
    *PENDING.lock().unwrap() = None;
    Ok(base(&app, &st))
}

/// Asks the release server whether a newer version exists on the chosen channel.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let mut info = {
        let st = app.state::<AppState>();
        base(&app, &st)
    };
    if !info.enabled {
        return Ok(info);
    }
    let url = pick_endpoint(&info.channel, cfg!(debug_assertions), env_var("TMHUB_UPDATE_ENDPOINT")).parse().map_err(|e| format!("{e}"))?;
    // http:// endpoints are only warned about in debug builds and refused in release builds, so the local test server needs no switch.
    let updater = app.updater_builder().pubkey(pubkey(&app)).endpoints(vec![url]).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| format!("No update info ({e})"))?;
    if let Some(u) = &found {
        info.available = true;
        info.version = Some(u.version.clone());
        info.notes = u.body.clone();
        // ISO 8601 (the UI parses it with Date); the plugin's own Display form is not.
        info.date = u.date.map(|d| crate::fsx::iso_from_millis((d.unix_timestamp_nanos() / 1_000_000) as i64));
    }
    *PENDING.lock().unwrap() = found;
    Ok(info)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    done: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    /// Test mode (TMHUB_UPDATE_DRY_RUN=1 in a debug build): downloaded and signature checked, nothing installed.
    pub dry_run: bool,
    /// The UI has to offer a restart (not on Windows, where the installer closes the app itself).
    pub restart: bool,
}

/// Downloads and installs the update found by `update_check` (signature checked by the plugin).
/// Events "update-progress" report the download. On Windows the installer takes over and the
/// app closes; elsewhere the UI asks for a restart.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<InstallOutcome, String> {
    let Some(update) = PENDING.lock().unwrap().take() else { return Err("Check for updates first".into()) };
    let dry = pick_dry_run(cfg!(debug_assertions), env_var("TMHUB_UPDATE_DRY_RUN"));
    let mut downloaded: u64 = 0;
    let a = app.clone();
    let b = app.clone();
    let on_chunk = move |chunk: usize, total: Option<u64>| {
        downloaded += chunk as u64;
        let _ = a.emit("update-progress", Progress { downloaded, total, done: false });
    };
    let on_done = move || {
        let _ = b.emit("update-progress", Progress { downloaded: 0, total: None, done: true });
    };
    if dry {
        // `download` verifies the signature against the public key; only the install step is skipped.
        update.download(on_chunk, on_done).await.map_err(|e| e.to_string())?;
        return Ok(InstallOutcome { dry_run: true, restart: false });
    }
    update.download_and_install(on_chunk, on_done).await.map_err(|e| e.to_string())?;
    Ok(InstallOutcome { dry_run: false, restart: !cfg!(windows) })
}

/// Background download of the update found by `update_check` (automatic updates): kept in memory and on
/// disk, installed later by `update_apply`, at the next start or when the launcher closes.
#[tauri::command]
pub async fn update_stage(app: AppHandle) -> Result<UpdateInfo, String> {
    let Some(update) = PENDING.lock().unwrap().take() else { return Err("Check for updates first".into()) };
    let data = app.state::<AppState>().data_dir.clone();
    let a = app.clone();
    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = a.emit("update-progress", Progress { downloaded, total, done: false });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let meta = StagedMeta {
        version: update.version.clone(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        notes: update.body.clone(),
        date: update.date.map(|d| crate::fsx::iso_from_millis((d.unix_timestamp_nanos() / 1_000_000) as i64)),
    };
    let _ = write_staged(&data, &meta, &bytes);
    *STAGED.lock().unwrap() = Some((update, bytes));
    let st = app.state::<AppState>();
    let mut info = base(&app, &st);
    info.staged = Some(meta.version);
    Ok(info)
}

/// Installs the staged update now ("Restart now", or the start of the next session). Refused while a game runs.
/// A staged file from an earlier session is used when the last check found the same version again.
#[tauri::command]
pub async fn update_apply(app: AppHandle) -> Result<InstallOutcome, String> {
    let data = app.state::<AppState>().data_dir.clone();
    if let Some(g) = game_running(&crate::platform::running_process_names()) {
        return Err(format!("Close the game first ({g} is running)."));
    }
    let staged = STAGED.lock().unwrap().take();
    let (update, bytes) = match staged {
        Some(x) => x,
        None => {
            let update = PENDING.lock().unwrap().take().ok_or("Nothing downloaded yet")?;
            let bytes = read_staged(&data, &update.version).ok_or("The downloaded update is gone or changed.")?;
            (update, bytes)
        }
    };
    if pick_dry_run(cfg!(debug_assertions), env_var("TMHUB_UPDATE_DRY_RUN")) {
        return Ok(InstallOutcome { dry_run: true, restart: false });
    }
    clear_staged(&data);
    update.restart_after_install(relaunch_after(When::Now)).install(bytes).map_err(|e| e.to_string())?;
    Ok(InstallOutcome { dry_run: false, restart: !cfg!(windows) })
}

/// Main window closing: install a staged update first when the rules allow it (automatic updates on, no game
/// running). Returns true when it took over (the close was prevented; the app exits after installing).
pub fn on_close(app: &AppHandle) -> bool {
    let st = app.state::<AppState>();
    let auto = st.settings().update_auto;
    let current = app.package_info().version.to_string();
    let staged = STAGED.lock().unwrap().as_ref().map(|(u, _)| u.version.clone());
    if staged.is_none() || pick_dry_run(cfg!(debug_assertions), env_var("TMHUB_UPDATE_DRY_RUN")) {
        return false;
    }
    let running = game_running(&crate::platform::running_process_names());
    if may_install(auto, staged.as_deref(), &current, running.as_deref()).is_err() {
        return false;
    }
    let Some((update, bytes)) = STAGED.lock().unwrap().take() else { return false };
    clear_staged(&st.data_dir);
    let a = app.clone();
    std::thread::spawn(move || {
        // Windows: the installer takes over and the process ends there; elsewhere exit after installing.
        let _ = update.restart_after_install(relaunch_after(When::Close)).install(bytes);
        a.exit(0);
    });
    true
}

#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels() {
        assert_eq!(endpoint("beta"), BETA_URL);
        assert_eq!(endpoint("stable"), STABLE_URL);
        assert_eq!(endpoint("anything"), STABLE_URL);
    }

    #[test]
    fn endpoint_hook_debug_only() {
        let e = Some("http://127.0.0.1:1/latest.json".to_string());
        assert_eq!(pick_endpoint("stable", true, e.clone()), "http://127.0.0.1:1/latest.json");
        assert_eq!(pick_endpoint("beta", false, e), BETA_URL);
        assert_eq!(pick_endpoint("stable", true, Some("  ".into())), STABLE_URL);
    }

    #[test]
    fn pubkey_hook_only_when_config_empty_and_debug() {
        assert_eq!(pick_pubkey("", true, Some("K".into())), "K");
        assert_eq!(pick_pubkey("", false, Some("K".into())), "");
        assert_eq!(pick_pubkey("CFG", true, Some("K".into())), "K");
        assert_eq!(pick_pubkey("CFG", false, Some("K".into())), "CFG");
        assert_eq!(pick_pubkey("CFG", true, None), "CFG");
        assert_eq!(pick_pubkey(" ", true, None), "");
    }

    #[test]
    fn versions_compare_by_semver() {
        assert!(newer("0.5.1", "0.5.0"));
        assert!(newer("v0.6.0", "0.5.10"));
        assert!(newer("0.5.1", "0.5.1-beta.2"));
        assert!(!newer("0.5.0", "0.5.0"));
        assert!(!newer("0.4.9", "0.5.0"));
        assert!(!newer("junk", "0.5.0"));
    }

    #[test]
    fn relaunch_only_while_in_use() {
        assert!(relaunch_after(When::Now));
        assert!(relaunch_after(When::Start), "an install at start must bring the launcher back");
        assert!(!relaunch_after(When::Close), "closed by the player: stays closed");
    }

    #[test]
    fn install_rules() {
        assert!(may_install(true, Some("0.5.2"), "0.5.1", None).is_ok());
        assert!(may_install(false, Some("0.5.2"), "0.5.1", None).is_err(), "automatic updates off: only by hand");
        assert!(may_install(true, Some("0.5.1"), "0.5.1", None).is_err(), "already this version");
        assert!(may_install(true, None, "0.5.1", None).is_err());
        assert!(may_install(true, Some("0.5.2"), "0.5.1", Some("TmForever.exe")).unwrap_err().contains("TmForever.exe"));
    }

    #[test]
    fn running_games_block_the_install() {
        assert_eq!(game_running(&["explorer.exe".into(), "TmForever.exe".into()]).as_deref(), Some("TmForever.exe"));
        assert_eq!(game_running(&["TMLoader.exe".into()]), None, "TMLoader alone is not a game");
        assert_eq!(game_running(&["explorer.exe".into(), "tm-horizon.exe".into()]), None);
    }

    #[test]
    fn staged_file_roundtrip_and_tamper_check() {
        let t = tempfile::tempdir().unwrap();
        let bytes = b"installer bytes".to_vec();
        let meta = StagedMeta { version: "0.5.2".into(), sha256: format!("{:x}", Sha256::digest(&bytes)), notes: Some("- fixes".into()), date: None };
        write_staged(t.path(), &meta, &bytes).unwrap();
        assert_eq!(staged_meta(t.path()), Some(meta.clone()));
        assert_eq!(read_staged(t.path(), "0.5.2"), Some(bytes.clone()));
        assert_eq!(read_staged(t.path(), "0.5.3"), None, "other version");
        std::fs::write(staged_dir(t.path()).join("installer.bin"), b"changed").unwrap();
        assert_eq!(read_staged(t.path(), "0.5.2"), None, "changed on disk");
        write_staged(t.path(), &StagedMeta { version: "0.5.3".into(), ..meta }, &bytes).unwrap();
        assert_eq!(staged_meta(t.path()).unwrap().version, "0.5.3");
        clear_staged(t.path());
        assert_eq!(staged_meta(t.path()), None);
    }

    #[test]
    fn dry_run_hook() {
        assert!(pick_dry_run(true, Some("1".into())));
        assert!(!pick_dry_run(true, Some("0".into())));
        assert!(!pick_dry_run(false, Some("1".into())));
        assert!(!pick_dry_run(true, None));
    }

    /// Signature path without the app: TMHUB_E2E_DIR = folder written by tools/updater-e2e.mjs
    /// (pubkey.txt, good/ and bad/ with the installer and its .sig). Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn e2e_signature_files() {
        use minisign_verify::{PublicKey, Signature};
        use std::{fs, path::PathBuf};
        let dir = PathBuf::from(std::env::var("TMHUB_E2E_DIR").expect("TMHUB_E2E_DIR"));
        let dec = |s: String| String::from_utf8(base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s.trim()).unwrap()).unwrap();
        let pk = PublicKey::decode(&dec(fs::read_to_string(dir.join("pubkey.txt")).unwrap())).unwrap();
        let name = "TM-Horizon_9.9.9_x64-setup.exe";
        let sig = Signature::decode(&dec(fs::read_to_string(dir.join("good").join(format!("{name}.sig"))).unwrap())).unwrap();
        let good = fs::read(dir.join("good").join(name)).unwrap();
        let bad = fs::read(dir.join("bad").join(name)).unwrap();
        assert!(pk.verify(&good, &sig, true).is_ok(), "good file must verify");
        assert!(pk.verify(&bad, &sig, true).is_err(), "tampered file must fail");
    }
}
