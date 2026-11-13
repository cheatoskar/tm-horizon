//! Tauri commands: the native side of `window.tmHubNative` (src/data/native.ts).

use crate::gameinstall::{self, Source};
use crate::launch::{self, LaunchTarget, PlanInput, Runner};
use crate::scan::{self, FoundInstall, ScanInput};
use crate::perf;
use crate::state::{AppState, PreparedSetup};
use crate::{clips, discord, fsx, modindex, net, platform, settings::Settings, tmloader, web};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
pub struct ActionResult {
    pub ok: bool,
    pub message: String,
    pub command: Option<String>,
}

pub(crate) fn ok(message: impl Into<String>, command: Option<String>) -> ActionResult {
    ActionResult { ok: true, message: message.into(), command }
}
pub(crate) fn fail(message: impl Into<String>) -> ActionResult {
    ActionResult { ok: false, message: message.into(), command: None }
}

pub const PROTOCOL: &str = "tmhub";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub settings: Settings,
    pub tmloader_root: Option<String>,
    pub tmloader_default: Option<String>,
    pub embedded_profile: String,
    pub clips_dir: Option<String>,
    pub data_dir: String,
    pub protocol_command: Option<String>,
    pub protocol_expected: String,
    pub pending_links: Vec<String>,
    /// .Gbx files the launcher was started with ("Open with").
    pub pending_files: Vec<String>,
    /// The build has a Discord application id, so "Show what I play in Discord" can work.
    pub discord_available: bool,
}

#[tauri::command(async)]
pub fn app_info(app: AppHandle, st: State<AppState>) -> AppInfo {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: platform::NAME.into(),
        settings: st.settings(),
        tmloader_root: st.tmloader_root().map(|p| p.to_string_lossy().into()),
        tmloader_default: tmloader::default_root().map(|p| p.to_string_lossy().into()),
        embedded_profile: web::profile_dir(&app).to_string_lossy().into(),
        clips_dir: clips::clips_dir(platform::documents_dir().as_deref()).map(|p| p.to_string_lossy().into()),
        data_dir: st.data_dir.to_string_lossy().into(),
        protocol_command: platform::protocol_command(PROTOCOL),
        protocol_expected: platform::protocol_command_line(&exe),
        pending_links: std::mem::take(&mut *st.pending_links.lock().unwrap()),
        pending_files: std::mem::take(&mut *st.pending_files.lock().unwrap()),
        discord_available: discord::valid_app_id(discord::DISCORD_APP_ID),
    }
}

pub(crate) fn do_scan(st: &AppState) -> scan::Snapshot {
    let t0 = std::time::Instant::now();
    let s = st.settings();
    let mut snap = scan::scan(&ScanInput { tmloader_root: st.tmloader_root(), found: s.found_installs, manual: s.extra_folders });
    crate::classiccmds::add_console_installs(&mut snap, &st.data_dir, &s.consoles);
    *st.snapshot.lock().unwrap() = Some(snap.clone());
    // The next start shows this result at once and scans again in the background.
    if let Ok(json) = serde_json::to_vec(&snap) {
        let _ = fsx::write(&st.cache_dir.join("snapshot.json"), &json);
    }
    perf::log(st, "scan", t0.elapsed().as_millis());
    snap
}

/// Is one of the game's processes running? (Used to switch Play to "Running".)
#[tauri::command(async)]
pub fn game_running(st: State<AppState>, game_id: String) -> bool {
    let exe = st.install(&game_id).and_then(|i| i.exe);
    let want = crate::discord::process_names(&game_id, exe.as_deref());
    let running = platform::running_process_names();
    running.iter().any(|p| want.iter().any(|w| p.eq_ignore_ascii_case(w)) || p.eq_ignore_ascii_case("tmloader.exe") && (game_id == "tmnf" || game_id == "tmuf"))
}

/// The last scan result from disk (shown instantly at start-up while a fresh scan runs).
#[tauri::command(async)]
pub fn cached_snapshot(st: State<AppState>) -> Option<serde_json::Value> {
    let bytes = std::fs::read(st.cache_dir.join("snapshot.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Timings measured in the UI (first paint, toggle, play, add mod) go into the same log.
#[tauri::command(async)]
pub fn perf_log(st: State<AppState>, what: String, ms: u64) {
    if what.len() <= 40 && what.chars().all(|c| c.is_ascii_alphanumeric() || " -_:.".contains(c)) {
        perf::log(&st, &what, ms as u128);
    }
}

/// After a profile write only TMLoader's part changes: re-read it into the last snapshot instead of
/// scanning every game folder again (a full scan took seconds on big Steam libraries).
pub(crate) fn refresh_tmloader(st: &AppState) -> scan::Snapshot {
    let cached = st.snapshot.lock().unwrap().clone();
    let Some(mut snap) = cached else { return do_scan(st) };
    snap.tmloader = st.tmloader_root().as_deref().map(tmloader::read_info).unwrap_or_default();
    *st.snapshot.lock().unwrap() = Some(snap.clone());
    snap
}

/// The last snapshot with TMLoader re-read (fast; used after profile changes).
#[tauri::command]
pub async fn tml_snapshot(app: AppHandle) -> Result<scan::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_tmloader(&app.state::<AppState>())).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan(app: AppHandle) -> Result<scan::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || do_scan(&app.state::<AppState>())).await.map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ mod index, hub data

pub(crate) fn cache_file(st: &AppState, name: &str) -> PathBuf {
    st.cache_dir.join(name)
}

fn servers(st: &AppState) -> Vec<String> {
    let from_cfg = st.snapshot.lock().unwrap().as_ref().map(|s| s.tmloader.servers.clone()).unwrap_or_default();
    modindex::with_extra(if from_cfg.is_empty() { modindex::FALLBACK_SERVERS.iter().map(|s| s.to_string()).collect() } else { from_cfg })
}

/// Last fetched index (instant), or null.
#[tauri::command(async)]
pub fn mod_index_cached(st: State<AppState>) -> Option<Value> {
    let text = std::fs::read_to_string(cache_file(&st, "mod-index.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    if let Some(raw) = v.get("raw").and_then(Value::as_object) {
        let mut ri = st.raw_index.lock().unwrap();
        ri.products = raw.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if let Some(ix) = v.get("index") {
            ri.servers_from_index(ix);
        }
    }
    v.get("index").cloned()
}

pub(crate) fn refresh_index(st: &AppState) -> Value {
    let (index, raw) = modindex::fetch(&servers(st));
    let any_ok = index["servers"].as_array().map(|a| a.iter().any(|s| s["ok"] == true)).unwrap_or(false);
    if any_ok {
        let doc = json!({ "index": index, "raw": raw.products });
        let _ = fsx::write(&cache_file(st, "mod-index.json"), doc.to_string().as_bytes());
        *st.raw_index.lock().unwrap() = raw;
    }
    index
}

#[tauri::command]
pub async fn mod_index_refresh(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_index(&app.state::<AppState>())).await.map_err(|e| e.to_string())
}

/// Files the launcher needs from the hub URL (all or none) ...
const HUB_FILES: [&str; 3] = ["servers.json", "projects.json", "mods.json"];
/// ... and newer files it uses when they are there (an older hub build may not have them).
const HUB_OPTIONAL: [&str; 2] = ["events.json", "communities.json"];

#[tauri::command(async)]
pub fn hub_data_cached(st: State<AppState>) -> Option<Value> {
    if crate::RELEASE_PREVIEW {
        return None; // the bundled copy only
    }
    let mut out = serde_json::Map::new();
    for f in HUB_FILES {
        let t = std::fs::read_to_string(cache_file(&st, &format!("hub/{f}"))).ok()?;
        out.insert(f.trim_end_matches(".json").into(), serde_json::from_str(&t).ok()?);
    }
    for f in HUB_OPTIONAL {
        if let Some(v) = std::fs::read_to_string(cache_file(&st, &format!("hub/{f}"))).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            out.insert(f.trim_end_matches(".json").into(), v);
        }
    }
    Some(Value::Object(out))
}

#[tauri::command]
pub async fn hub_data_refresh(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let base = st.settings().hub_url;
        if crate::RELEASE_PREVIEW {
            return Err("No hub in this version".to_string());
        }
        if base.trim().is_empty() {
            return Err("No hub URL set".to_string());
        }
        let base = format!("{}/", base.trim_end_matches('/'));
        let mut out = serde_json::Map::new();
        for f in HUB_FILES {
            let v = net::get_json(&format!("{base}{f}"))?;
            if v.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
                return Err(format!("{base}{f}: unknown format"));
            }
            out.insert(f.trim_end_matches(".json").into(), v);
        }
        for f in HUB_OPTIONAL {
            if let Ok(v) = net::get_json(&format!("{base}{f}")) {
                if v.get("schemaVersion").and_then(Value::as_i64) == Some(1) {
                    out.insert(f.trim_end_matches(".json").into(), v);
                }
            }
        }
        for f in HUB_FILES.iter().chain(HUB_OPTIONAL.iter()) {
            if let Some(v) = out.get(f.trim_end_matches(".json")) {
                let _ = fsx::write(&cache_file(&st, &format!("hub/{f}")), v.to_string().as_bytes());
            }
        }
        Ok(Value::Object(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ launching

pub fn runner() -> Runner {
    Runner::Native
}

pub(crate) fn execute(app: &AppHandle, target: &LaunchTarget) -> Result<(), String> {
    match target {
        // Linux: steam:// links start `steam -applaunch <id>` (platform::url_command).
        LaunchTarget::Url { url } => match platform::url_command(url) {
            Some(spec) => platform::spawn(&spec).map(|_| ()).map_err(|e| e.to_string()),
            None => app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()),
        },
        LaunchTarget::Exe { exe, args, cwd } => {
            if fsx::blocked(exe) {
                return Err("Refusing to start this file".into());
            }
            // A Defender block (os error 5/225/226 on a file Defender has a detection for) gets its own message.
            platform::spawn(&launch::wrap(&runner(), exe, args, cwd.as_deref()))
                .map(|_| ())
                .map_err(|e| crate::defender::start_error(exe, e.raw_os_error()).unwrap_or_else(|| format!("{}: {e}", exe.display())))
        }
    }
}

pub(crate) fn plan_input<'a>(st: &AppState, game: &'a str, install: &'a scan::InstallInfo, tml: &'a Option<PathBuf>, profile: Option<&'a str>, join: Option<&'a str>) -> PlanInput<'a> {
    PlanInput {
        game_id: game,
        install,
        tmloader_exe: tml.as_deref(),
        profile,
        eswc_use_launcher: st.settings().eswc_use_launcher,
        join,
    }
}

pub(crate) fn tmloader_exe(st: &AppState) -> Option<PathBuf> {
    let snap = st.snapshot.lock().unwrap();
    let t = &snap.as_ref()?.tmloader;
    t.installed.then(|| t.exe.as_ref().map(PathBuf::from)).flatten().filter(|p| fsx::is_file(p))
}

/// Mod ids switched on in a TMLoader profile (from the last scan).
pub(crate) fn profile_mods(st: &AppState, profile: Option<&str>) -> Vec<(String, Option<String>)> {
    let Some(name) = profile else { return vec![] };
    let snap = st.snapshot.lock().unwrap();
    snap.as_ref()
        .and_then(|s| s.tmloader.profiles.iter().find(|p| p.name == name))
        .map(|p| p.mods.iter().map(|m| (m.id.clone(), m.version.clone())).collect())
        .unwrap_or_default()
}

/// The install to start: the game's own, or a profile's separate installation (its own folder and
/// exe; started without TMLoader, see docs/design/instances.md).
pub(crate) fn start_install(st: &AppState, game_id: &str, instance: Option<&str>) -> Result<(String, scan::InstallInfo), String> {
    match instance {
        Some(id) => {
            let i = crate::instances::get(&st.data_dir, id)?;
            if !Path::new(&i.path).is_dir() {
                return Err("The separate installation's folder is missing".into());
            }
            Ok((i.game.clone(), crate::instances::install_info(&i)))
        }
        None => st.install(game_id).map(|i| (game_id.to_string(), i)).ok_or_else(|| "Not installed".to_string()),
    }
}

/// Remembers which install folder of a game Play starts (`dir` empty = back to the first one).
/// Only a folder that is one of the game's installs is accepted.
#[tauri::command(async)]
pub fn set_selected_install(st: State<AppState>, game_id: String, dir: Option<String>) -> Result<(), String> {
    let dir = dir.filter(|d| !d.trim().is_empty());
    if let Some(d) = &dir {
        let known = crate::horizoncmds::installs_of(&st, &game_id).iter().any(|i| fsx::norm(Path::new(&i.path)) == fsx::norm(Path::new(d)));
        if !known {
            return Err("This folder is not one of the game's installs".into());
        }
    }
    st.update_settings(|s| match dir {
        Some(d) => {
            s.selected_install.insert(game_id, d);
        }
        None => {
            s.selected_install.remove(&game_id);
        }
    })?;
    Ok(())
}

/// Files read ahead of a start, keyed by path, size and change time: read again only when one changes.
static PREWARMED: std::sync::Mutex<Vec<(PathBuf, u64, Option<std::time::SystemTime>)>> = std::sync::Mutex::new(Vec::new());

/// The files Windows reads when the game starts: the exe and the loader DLLs next to it.
fn start_files(install: &scan::InstallInfo) -> Vec<PathBuf> {
    let dir = Path::new(&install.path);
    let mut out: Vec<PathBuf> = install.exe.iter().map(|e| if Path::new(e).is_absolute() { PathBuf::from(e) } else { dir.join(e) }).collect();
    out.extend(["dinput8.dll", "d3d9.dll", "dxgi.dll", "d3d11.dll"].iter().map(|f| dir.join(f)));
    out.retain(|p| fsx::is_file(p));
    out
}

/// Reads the start files once in the background (game page opened), so the virus scanner checks them
/// before the click and not between the click and the game window (1.7 to 5 s in my timings, the
/// second start right after took 4 ms). Unchanged files are not read again.
#[tauri::command]
pub async fn launch_prewarm(app: tauri::AppHandle, game_id: String) {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<AppState>(&app);
        let Some(install) = st.install(&game_id) else { return };
        let t0 = std::time::Instant::now();
        let mut read = 0usize;
        for p in start_files(&install) {
            let Ok(m) = std::fs::metadata(&p) else { continue };
            let key = (p.clone(), m.len(), m.modified().ok());
            if PREWARMED.lock().unwrap().contains(&key) {
                continue;
            }
            if std::fs::read(&p).is_ok() {
                read += 1;
                let mut list = PREWARMED.lock().unwrap();
                list.retain(|(q, _, _)| q != &p);
                list.push(key);
            }
        }
        if read > 0 {
            perf::log(&st, "play-prewarm", t0.elapsed().as_millis());
        }
    })
    .await
}

#[tauri::command]
pub async fn launch_game(app: AppHandle, game_id: String, profile: Option<String>, join: Option<String>, game_name: Option<String>, instance: Option<String>, dir: Option<String>) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        // `dir`: Play on one row of the Installations card (one of the game's install folders).
        let dir = dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from);
        launch_with(&app, &st, game_id, profile, join, game_name, instance, dir.as_deref(), false)
    })
    .await
}

/// Play, optionally from one of the game's other install folders (`dir`, e.g. a test copy added
/// by hand) and in Horizon Host's safe mode (no plugins).
#[allow(clippy::too_many_arguments)]
pub(crate) fn launch_with(app: &AppHandle, st: &AppState, game_id: String, profile: Option<String>, join: Option<String>, game_name: Option<String>, instance: Option<String>, dir: Option<&Path>, safe: bool) -> ActionResult {
    let t0 = std::time::Instant::now();
    let picked = match (dir, instance.as_deref()) {
        (Some(d), None) => crate::horizoncmds::installs_of(st, &game_id).into_iter().find(|i| fsx::norm(Path::new(&i.path)) == fsx::norm(d)).map(|i| (game_id.clone(), i)).ok_or_else(|| "This folder is not one of the game's installs".to_string()),
        _ => start_install(st, &game_id, instance.as_deref()),
    };
    let (game_id, install) = match picked {
        Ok(x) => x,
        Err(e) => return fail(e),
    };
    perf::log(st, "play-step-install", t0.elapsed().as_millis());
    // A Forever instance with a TMLoader profile starts through its own TMLoader copy
    // (instancetml.rs); TMLoader knows one game folder per product, so the installed one cannot.
    if let Some(id) = instance.as_deref() {
        match instance_tmloader(st, id) {
            Ok(Some((t, tml_profile))) => {
                return match execute(app, &t) {
                    Ok(()) => {
                        perf::log(st, "play-spawn", t0.elapsed().as_millis());
                        start_presence(st, &game_id, game_name.as_deref(), Some(&tml_profile), install.exe.as_deref());
                        crate::playtime::track(st.data_dir.clone(), format!("{game_id}@{id}"), discord::process_names(&game_id, install.exe.as_deref()));
                        ok("Starting", Some(t.display()))
                    }
                    Err(e) => ActionResult { ok: false, message: e, command: Some(t.display()) },
                };
            }
            Ok(None) => {}
            Err(e) => return fail(e),
        }
    }
    let profile = if instance.is_some() { None } else { profile };
    let tml = tmloader_exe(st);
    if profile.is_some() && tml.is_none() {
        return fail("TMLoader not found");
    }
    // Horizon Host: profile.json (which plugins load, safe mode) for this start.
    if let Err(e) = crate::horizonhost::before_start(&st.data_dir, &game_id, Path::new(&install.path), st.tmloader_root().as_deref(), profile.as_deref(), safe) {
        if safe {
            return fail(format!("Could not switch Horizon Client to safe mode: {e}"));
        }
        eprintln!("horizon profile.json: {e}");
    }
    perf::log(st, "play-step-horizon", t0.elapsed().as_millis());
    let p = plan_input(st, &game_id, &install, &tml, profile.as_deref(), join.as_deref());
    match launch::plan_launch(&p) {
        Err(e) => fail(e),
        Ok(t) => match { perf::log(st, "play-step-plan", t0.elapsed().as_millis()); execute(app, &t) } {
            Ok(()) => {
                // play-spawn - play-step-plan = the time Windows needed to create the process (antivirus scans land here).
                perf::log(st, "play-spawn", t0.elapsed().as_millis());
                start_presence(st, &game_id, game_name.as_deref(), profile.as_deref(), install.exe.as_deref());
                crate::playtime::track(st.data_dir.clone(), game_id.clone(), discord::process_names(&game_id, install.exe.as_deref()));
                crate::startwatch::maybe_start(st, &game_id, install.exe.as_deref());
                ok("Starting", Some(t.display()))
            }
            Err(e) => ActionResult { ok: false, message: e, command: Some(t.display()) },
        },
    }
}

/// The start of a Forever instance that has a TMLoader profile: (re)builds its TMLoader copy and
/// returns `<instance>\TMLoader\TMLoader.exe run TmForever "<profile>"`. None: no profile set.
fn instance_tmloader(st: &AppState, id: &str) -> Result<Option<(LaunchTarget, String)>, String> {
    let inst = crate::instances::get(&st.data_dir, id)?;
    let Some(profile) = inst.tml_profile.clone() else { return Ok(None) };
    if launch::family(&inst.game) != Some(launch::Family::Forever) {
        return Ok(None);
    }
    let main = st.tmloader_root().filter(|r| fsx::is_file(&r.join("config.yaml"))).ok_or("TMLoader not found")?;
    let exe = crate::instancetml::prepare(&main, Path::new(&inst.path), &profile)?;
    Ok(Some((launch::tmloader_run(&exe, &profile, vec![]), profile)))
}

/// Discord Rich Presence for a started game. TICK / ForeverTAS sessions show the tool; TMInterface
/// profiles get none (TMInterface sets its own status).
fn start_presence(st: &AppState, game_id: &str, game_name: Option<&str>, profile: Option<&str>, exe: Option<&str>) {
    let settings = st.settings();
    if !settings.discord_presence {
        return;
    }
    let show_tas = settings.discord_tas;
    let app_id = discord::DISCORD_APP_ID.to_string();
    let mods: Vec<String> = profile_mods(st, profile).into_iter().map(|(id, _)| id).collect();
    if !discord::should_set_presence(&app_id, &mods) {
        return;
    }
    discord::start(
        discord::PresenceRequest {
            app_id,
            game_id: game_id.into(),
            game_name: game_name.filter(|n| !n.trim().is_empty()).unwrap_or(game_id).into(),
            profile: profile.map(String::from),
            show_tas,
            processes: discord::process_names(game_id, exe),
        },
    );
}

/// Only existing .Gbx files in the game's own folders (Documents\TrackMania, \ManiaPlanet,
/// \Trackmania*, or the game folder for ESWC and the old games) are handed to a game.
pub fn map_path_ok(p: &Path, docs: Option<&Path>, game_dir: &Path) -> Result<(), String> {
    map_path_ok_in(p, docs, game_dir, &[])
}

/// `map_path_ok` with more allowed folders (an instance's own user folder, Documents\TrackMania_<id>).
pub fn map_path_ok_in(p: &Path, docs: Option<&Path>, game_dir: &Path, extra: &[PathBuf]) -> Result<(), String> {
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !name.ends_with(".gbx") || !launch::valid_file_arg(&p.to_string_lossy()) {
        return Err("Not a map or replay file".into());
    }
    if !fsx::is_file(p) {
        return Err("File not found".into());
    }
    let real = fsx::resolve(p).ok_or("File not found")?;
    let mut roots: Vec<PathBuf> = vec![game_dir.to_path_buf()];
    roots.extend(extra.iter().cloned());
    if let Some(d) = docs {
        roots.extend(["TrackMania", "ManiaPlanet", "Trackmania2020", "Trackmania"].iter().map(|x| d.join(x)));
    }
    let inside = roots.iter().any(|r| fsx::resolve(r).is_some_and(|rr| fsx::is_inside(&real, &rr)));
    if inside {
        Ok(())
    } else {
        Err("Maps are only opened from the game's own folders".into())
    }
}

/// Switches of an old game's exe, read once per exe (path + size + modified time) and kept in memory.
/// Read only; refused for blocked paths (StarForce ESWC folder) and files over 64 MB.
fn exe_switches_cached(exe: &Path) -> launch::ExeSwitches {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, u64, Option<std::time::SystemTime>), launch::ExeSwitches>>> = OnceLock::new();
    let Ok(meta) = std::fs::metadata(exe) else { return launch::ExeSwitches::default() };
    if fsx::blocked(exe) || meta.len() > 64 << 20 {
        return launch::ExeSwitches::default();
    }
    let key = (exe.to_path_buf(), meta.len(), meta.modified().ok());
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(s) = cache.lock().unwrap().get(&key) {
        return s.clone();
    }
    let s = std::fs::read(exe).map(|b| launch::exe_switches(&b)).unwrap_or_default();
    cache.lock().unwrap().insert(key, s.clone());
    s
}

/// `path` relative to `root` with forward slashes, comparing folder names without case (Windows).
pub fn rel_inside(path: &Path, root: &Path) -> Option<String> {
    let p: Vec<String> = path.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let r: Vec<String> = root.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if p.len() <= r.len() || !p.iter().zip(&r).all(|(a, b)| a.eq_ignore_ascii_case(b)) {
        return None;
    }
    Some(p[r.len()..].join("/"))
}

#[tauri::command]
pub async fn open_map(app: AppHandle, game_id: String, profile: Option<String>, path: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        let Some(install) = st.install(&game_id) else { return fail("Not installed") };
        open_map_in(&app, &st, game_id, profile, path, install, &[])
    })
    .await
}

/// Opens a saved map or replay in one install of the game (`install`: the one Play starts, or a copy
/// picked in the .Gbx dialog); `extra` = more folders the file may be in (an instance's user folder).
pub(crate) fn open_map_in(app: &AppHandle, st: &AppState, game_id: String, profile: Option<String>, path: String, install: scan::InstallInfo, extra: &[PathBuf]) -> ActionResult {
    {
        let app = app.clone();
        let t0 = std::time::Instant::now();
        if let Err(e) = map_path_ok_in(Path::new(&path), platform::documents_dir().as_deref(), Path::new(&install.path), extra) {
            return fail(e);
        }
        // ESWC, Sunrise and Original: a running game with Horizon Client opens the map itself (bridge
        // event play_map); never a second copy of the game. Not running: the game starts and, when Horizon
        // Client is in its folder, gets the map as soon as the client is connected (up to 60 s); otherwise the
        // map waits under Downloaded (Original is never started for a map). Forever keeps /file and TMLoader
        // (no game-memory writes).
        let mut after_start: Option<(&str, String, String)> = None;
        if let Some(code) = match game_id.as_str() { "tmn-eswc" => Some("tmn"), "tm-sunrise" => Some("tms"), "tm-original" => Some("tmo"), _ => None } {
            let tracks = Path::new(&install.path).join("GameData").join("Tracks");
            let rel = rel_inside(Path::new(&path), &tracks);
            let title = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let title = title.split(".Challenge").next().unwrap_or(&title).to_string();
            if let Some(rel) = rel.as_deref().filter(|r| crate::clientbridge::play_map_path_ok(r)) {
                if crate::clientbridge::play_map(code, rel, &title) {
                    return ok("Sent to the game. It opens the map from its main menu.", None);
                }
            }
            let exe = install.exe.as_deref().and_then(|e| Path::new(e).file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let running = !exe.is_empty() && platform::running_process_names().iter().any(|p| p.eq_ignore_ascii_case(&exe));
            if code == "tmo" || running {
                return ok(if running { "Saved. The game is running: open the map under Downloaded." } else { "Saved. Open the map in the game under Downloaded." }, None);
            }
            let host = crate::horizonhost::read_record(&Path::new(&install.path).join(crate::horizonhost::format::HOST_DIR)).is_some();
            if let (true, Some(rel)) = (host, rel.filter(|r| crate::clientbridge::play_map_path_ok(r))) {
                after_start = Some((code, rel, title));
            }
        }
        let tml = tmloader_exe(&st);
        let p = plan_input(&st, &game_id, &install, &tml, profile.as_deref(), None);
        let sw = match launch::family(&game_id) {
            Some(launch::Family::Eswc | launch::Family::Legacy) => install.exe.as_deref().map(|e| exe_switches_cached(Path::new(e))).unwrap_or_default(),
            _ => launch::ExeSwitches::default(),
        };
        match launch::plan_open_map_with(&p, Path::new(&path), &sw) {
            Err(e) => fail(e),
            Ok(m) => match execute(&app, &m.target).inspect(|_| {
                // A game started for a map (TMX "Play", the .Gbx dialog): Discord and play time as for Play.
                perf::log(&st, "map-spawn", t0.elapsed().as_millis());
                start_presence(&st, &game_id, None, profile.as_deref(), install.exe.as_deref());
                crate::playtime::track(st.data_dir.clone(), game_id.clone(), discord::process_names(&game_id, install.exe.as_deref()));
            }) {
                Ok(()) if !m.direct && after_start.is_some() => {
                    let (code, rel, title) = after_start.unwrap();
                    let sent = wait_and_play(|| crate::clientbridge::play_map(code, &rel, &title), Duration::from_secs(60), Duration::from_secs(1));
                    let shown = rel.strip_prefix("Challenges/").unwrap_or(&rel).to_string();
                    ok(if sent { "Map loaded in the game.".to_string() } else { format!("Map saved: {shown}") }, Some(m.target.display()))
                }
                Ok(()) => ok(if m.direct { "Opening the map" } else { "Starting. Find the map under Downloaded." }, Some(m.target.display())),
                Err(e) => ActionResult { ok: false, message: e, command: Some(m.target.display()) },
            },
        }
    }
}

/// Tries `send` until it succeeds or `limit` is over (the game's Horizon Client connects to the bridge a few
/// seconds after the start). True when it was sent.
pub fn wait_and_play(mut send: impl FnMut() -> bool, limit: Duration, step: Duration) -> bool {
    let t0 = std::time::Instant::now();
    loop {
        if send() {
            return true;
        }
        if t0.elapsed() >= limit {
            return false;
        }
        std::thread::sleep(step);
    }
}

/// What Play would run, without running it (shown on the game page).
#[tauri::command(async)]
pub fn launch_preview(st: State<AppState>, game_id: String, profile: Option<String>, instance: Option<String>) -> Option<String> {
    let (game_id, install) = start_install(&st, &game_id, instance.as_deref()).ok()?;
    // Instance with a TMLoader profile: its own TMLoader copy (built at Play, not here).
    if let Some(inst) = instance.as_deref().and_then(|id| crate::instances::get(&st.data_dir, id).ok()) {
        if let (Some(p), Some(launch::Family::Forever)) = (inst.tml_profile.as_deref(), launch::family(&inst.game)) {
            let exe = Path::new(&inst.path).join(crate::instancetml::DIR).join("TMLoader.exe");
            return Some(launch::tmloader_run(&exe, p, vec![]).display());
        }
    }
    let profile = if instance.is_some() { None } else { profile };
    let tml = tmloader_exe(&st);
    let p = plan_input(&st, &game_id, &install, &tml, profile.as_deref(), None);
    launch::plan_launch(&p).ok().map(|t| t.display())
}

#[tauri::command(async)]
pub fn open_external(app: AppHandle, url: String) -> ActionResult {
    let u = url.to_lowercase();
    if !(u.starts_with("https://") || u.starts_with("http://") || u.starts_with("steam://") || u.starts_with("uplay://") || u.starts_with("com.epicgames.launcher://")
        || u.starts_with("tmtp://") || u.starts_with("maniaplanet://") || u == crate::defender::THREAT_HISTORY)
    {
        return fail("Unsupported link");
    }
    match app.opener().open_url(&url, None::<&str>) {
        Ok(()) => ok("Opened", Some(url)),
        Err(e) => fail(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn reveal_path(app: AppHandle, path: String) -> ActionResult {
    let p = PathBuf::from(&path);
    if fsx::blocked(&p) {
        return fail("Refusing to open this folder");
    }
    let r = if p.is_dir() { app.opener().open_path(&path, None::<&str>) } else { app.opener().reveal_item_in_dir(&p) };
    match r {
        Ok(()) => ok("Opened", Some(path)),
        Err(e) => fail(e.to_string()),
    }
}

// ------------------------------------------------------------------ TMLoader writes

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInstallResult {
    pub ok: bool,
    pub message: String,
    pub installed: Vec<tmloader::InstallReport>,
    pub enabled: bool,
}

pub(crate) fn installed_versions(st: &AppState, id: &str) -> Vec<String> {
    st.snapshot
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.tmloader.products.get(id).map(|p| p.versions.iter().filter(|v| v.installed).map(|v| v.version.clone()).collect()))
        .unwrap_or_default()
}

/// (product, version) pairs to install: the mod and its missing dependencies.
pub(crate) fn install_plan(st: &AppState, raw: &modindex::RawIndex, id: &str, version: &str, out: &mut Vec<(String, String)>, depth: usize) -> Result<(), String> {
    if depth > 5 || out.iter().any(|(p, _)| p == id) {
        return Ok(());
    }
    let product = raw.products.get(id).ok_or_else(|| format!("{id} is not on any TMLoader server"))?;
    if product.get("type").and_then(Value::as_str) == Some("program") {
        return Ok(());
    }
    let entry = product.get("versions").and_then(|v| v.get(version)).ok_or_else(|| format!("{id} {version} not in the index"))?;
    out.push((id.into(), version.into()));
    for d in entry.get("dependencies").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Some(did) = d.get("id").and_then(Value::as_str) else { continue };
        let range = d.get("version").and_then(Value::as_str);
        let have = installed_versions(st, did);
        if tmloader::pick_version(range, have.iter().map(String::as_str)).is_some() {
            continue;
        }
        let Some(dp) = raw.products.get(did) else { continue };
        if dp.get("type").and_then(Value::as_str) == Some("program") {
            continue;
        }
        let vs: Vec<String> = dp.get("versions").and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
        let Some(v) = tmloader::pick_version(range, vs.iter().map(String::as_str)) else {
            return Err(format!("No version of {did} matches {}", range.unwrap_or("any")));
        };
        install_plan(st, raw, did, &v, out, depth + 1)?;
    }
    Ok(())
}

/// Downloads, checks (SHA-256 from the index) and extracts each (product, version).
pub(crate) fn install_versions(app: &AppHandle, st: &AppState, raw: &modindex::RawIndex, root: &Path, plan: &[(String, String)], backup: &Path) -> Result<Vec<tmloader::InstallReport>, String> {
    let _guard = tmloader::write_lock();
    let mut reports = Vec::new();
    for (pid, ver) in plan {
        let product = &raw.products[pid];
        let entry = &product["versions"][ver];
        let link = entry.get("download_link").and_then(Value::as_str).ok_or_else(|| format!("{pid} {ver} has no download"))?;
        let _ = app.emit("mod-progress", json!({ "mod": pid, "version": ver, "step": "download" }));
        let bytes = net::get_bytes(link, 512 << 20)?;
        let product_y: serde_yaml::Value = serde_json::from_value(product.clone()).map_err(|e| e.to_string())?;
        let entry_y: serde_yaml::Value = serde_json::from_value(entry.clone()).map_err(|e| e.to_string())?;
        tmloader::ensure_idle()?;
        let iv = tmloader::IndexVersion { product_id: pid, product: &product_y, version: ver, entry: &entry_y };
        let r = tmloader::install_from_zip(root, &iv, &bytes, &st.cache_dir.join("staging").join(pid), backup)?;
        reports.push(r);
    }
    Ok(reports)
}

fn install_mod_blocking(app: &AppHandle, mod_id: &str, version: &str, profile: Option<&str>, enable: bool) -> Result<ModInstallResult, String> {
    let st = app.state::<AppState>();
    tmloader::ensure_idle()?;
    let root = st.tmloader_root().ok_or("TMLoader not found")?;
    if !fsx::is_file(&root.join("config.yaml")) {
        return Err(if tmloader::has_exe(&root) { "TMLoader is installed but has not started yet. Start it once (it creates its settings), then install the mod.".into() } else { "TMLoader not found".to_string() });
    }
    if st.raw_index.lock().unwrap().products.is_empty() {
        refresh_index(&st);
    }
    let raw = st.raw_index.lock().unwrap().clone();
    let mut plan = Vec::new();
    install_plan(&st, &raw, mod_id, version, &mut plan, 0)?;
    let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", "mod-install", mod_id).detail(version), crate::history::tml_watches(&root, &plan));
    let backup = st.backup_dir();
    let reports = install_versions(app, &st, &raw, &root, &plan, &backup)?;
    let mut enabled = false;
    if enable {
        if let Some(p) = profile {
            enabled = tmloader::set_profile_mod(&root, p, mod_id, true, &backup)?;
        }
    }
    refresh_tmloader(&st);
    let names: Vec<String> = reports.iter().map(|r| format!("{} {}", r.product, r.version)).collect();
    Ok(ModInstallResult {
        ok: true,
        message: format!("Installed {}{}", names.join(", "), if enabled { format!(", on in \"{}\"", profile.unwrap_or("")) } else { String::new() }),
        installed: reports,
        enabled,
    })
}

#[tauri::command]
pub async fn install_mod(app: AppHandle, mod_id: String, version: String, profile: Option<String>, enable: bool) -> Result<ModInstallResult, String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let r = install_mod_blocking(&a, &mod_id, &version, profile.as_deref(), enable);
        perf::log(&a.state::<AppState>(), "install-mod-backend", t0.elapsed().as_millis());
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_profile_mod(app: tauri::AppHandle, profile: String, mod_id: String, on: bool) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        let t0 = std::time::Instant::now();
        let r = (|| -> Result<bool, String> {
            tmloader::ensure_idle()?;
            let root = st.tmloader_root().ok_or("TMLoader not found")?;
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", if on { "mod-on" } else { "mod-off" }, &mod_id).detail(&profile), crate::history::tml_profiles(&root));
            tmloader::set_profile_mod(&root, &profile, &mod_id, on, &st.backup_dir())
        })();
        eprintln!("set_profile_mod {mod_id} {on}: {} ms", t0.elapsed().as_millis());
        match r {
            Ok(changed) => {
                ok(if changed { format!("{mod_id} {} in \"{profile}\"", if on { "on" } else { "off" }) } else { "No change".into() }, None)
            }
            Err(e) => fail(e),
        }
    })
    .await
}

// ------------------------------------------------------------------ clips

#[tauri::command]
pub async fn list_clips(app: AppHandle) -> Value {
    crate::bg::run(move || -> Value {
        let dir = clips::clips_dir(platform::documents_dir().as_deref());
        let list = dir.as_deref().map(clips::list).unwrap_or_default();
        if let Some(d) = &dir {
            if d.is_dir() {
                let _ = app.asset_protocol_scope().allow_directory(d, false);
            }
        }
        json!({ "dir": dir, "clips": list })
    })
    .await
}

// ------------------------------------------------------------------ embedded browser

#[tauri::command]
pub async fn web_show(app: AppHandle, mode: String, game: String, site: Option<String>, url: Option<String>, x: f64, y: f64, w: f64, h: f64) -> Result<String, String> {
    web::show(&app, &mode, &game, site.as_deref().unwrap_or(""), url, x, y, w, h)
}
#[tauri::command]
pub async fn web_bounds(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    web::bounds(&app, x, y, w, h)
}
#[tauri::command]
pub async fn web_hide(app: AppHandle) -> Result<(), String> {
    web::hide(&app)
}
#[tauri::command]
pub async fn web_tip_show(app: AppHandle, label: String, x: f64, y: f64, w: f64, dark: bool) -> Result<(), String> {
    crate::tipwin::show(&app, &label, x, y, w, dark)
}
#[tauri::command]
pub async fn web_tip_hide(app: AppHandle) -> Result<(), String> {
    crate::tipwin::hide(&app);
    Ok(())
}
#[tauri::command]
pub async fn web_nav(app: AppHandle, action: String) -> Result<(), String> {
    web::nav(&app, &action)
}
#[tauri::command]
pub async fn web_navigate(app: AppHandle, url: String) -> Result<(), String> {
    web::navigate(&app, &url)
}
#[tauri::command]
pub async fn web_clear(app: AppHandle) -> Result<(), String> {
    web::clear(&app)
}

// ------------------------------------------------------------------ settings, protocol

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub hub_url: Option<String>,
    pub update_url: Option<String>,
    pub eswc_use_launcher: Option<bool>,
    pub protocol_asked: Option<bool>,
    pub discord_presence: Option<bool>,
    pub discord_tas: Option<bool>,
    pub cover_downloads: Option<bool>,
    pub language: Option<String>,
    pub theme: Option<String>,
    pub accent: Option<String>,
    pub density: Option<String>,
    pub mods_view: Option<String>,
    pub default_game: Option<String>,
    pub play_from_home: Option<bool>,
    pub setup_done: Option<bool>,
}

#[tauri::command]
pub async fn save_settings(app: tauri::AppHandle, patch: SettingsPatch) -> Result<Settings, String> {
    crate::bg::run(move || -> Result<Settings, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        st.update_settings(|s| {
            if let Some(v) = patch.hub_url {
                s.hub_url = v;
            }
            if let Some(v) = patch.update_url {
                s.update_url = v;
            }
            if let Some(v) = patch.eswc_use_launcher {
                s.eswc_use_launcher = v;
            }
            if let Some(v) = patch.protocol_asked {
                s.protocol_asked = v;
            }
            if let Some(v) = patch.discord_presence {
                s.discord_presence = v;
            }
            if let Some(v) = patch.discord_tas {
                s.discord_tas = v;
            }
            if let Some(v) = patch.cover_downloads {
                s.cover_downloads = v;
            }
            if let Some(v) = patch.language {
                if ["", "en", "de", "pl", "fr"].contains(&v.as_str()) {
                    s.language = v;
                }
            }
            if let Some(v) = patch.theme {
                if ["dark", "midnight", "light"].contains(&v.as_str()) {
                    s.theme = v;
                }
            }
            if let Some(v) = patch.accent {
                if ["orange", "blue", "green", "purple", "red", "teal", "game"].contains(&v.as_str()) {
                    s.accent = v;
                }
            }
            if let Some(v) = patch.density {
                if ["normal", "compact"].contains(&v.as_str()) {
                    s.density = v;
                }
            }
            if let Some(v) = patch.mods_view {
                if ["tiles", "list"].contains(&v.as_str()) {
                    s.mods_view = v;
                }
            }
            if let Some(v) = patch.default_game {
                if v.len() <= 32 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                    s.default_game = v;
                }
            }
            if let Some(v) = patch.play_from_home {
                s.play_from_home = v;
            }
            if let Some(v) = patch.setup_done {
                s.setup_done = Some(v);
            }
        })
    })
    .await
}

#[tauri::command(async)]
pub fn protocol_register(st: State<AppState>) -> ActionResult {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => return fail(e.to_string()),
    };
    let _ = st.update_settings(|s| s.protocol_asked = true);
    match platform::register_protocol(PROTOCOL, &exe, "TM Horizon") {
        Ok(()) => ok("tmhub:// links now open TM Horizon", platform::protocol_command(PROTOCOL)),
        Err(e) => fail(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn protocol_unregister() -> ActionResult {
    match platform::unregister_protocol(PROTOCOL) {
        Ok(()) => ok("tmhub:// links removed", None),
        Err(e) => fail(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn take_pending_links(st: State<AppState>) -> Vec<String> {
    std::mem::take(&mut *st.pending_links.lock().unwrap())
}

// ------------------------------------------------------------------ folders, drive scan

/// Starts ManiaPlanet itself (no title) so the player can add a title pack in its menu, and returns when it
/// closes (the page then scans again). `dir` must be a found ManiaPlanet folder. A Steam install whose exe
/// is not there goes through steam://rungameid/228760 and returns at once.
#[tauri::command]
pub async fn open_maniaplanet(app: AppHandle, dir: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let d = PathBuf::from(&dir);
        if let Some((_, exe)) = scan::classify(&d).into_iter().find(|(g, _)| *g == "maniaplanet") {
            let spec = crate::launch::CommandSpec { program: exe, args: vec![], cwd: Some(d), env: vec![] };
            crate::platform::run_and_wait(&spec).map_err(|e| e.to_string())?;
            return Ok(());
        }
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url("steam://rungameid/228760", None::<&str>).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn add_folder(app: AppHandle) -> Result<Value, String> {
    // The dialog waits for the user: on the blocking pool, not on an async worker.
    crate::bg::run(move || -> Result<Value, String> {
        use tauri_plugin_dialog::DialogExt;
        // Start in the last added folder's parent, else C:\Program Files (x86) (where the old games install).
        let st = app.state::<AppState>();
        let last = st.settings().extra_folders.last().map(PathBuf::from).and_then(|p| p.parent().map(Path::to_path_buf));
        let start = last.filter(|p| fsx::is_dir(p)).or_else(|| std::env::var_os("ProgramFiles(x86)").map(PathBuf::from).filter(|p| fsx::is_dir(p)));
        let mut dlg = app.dialog().file().set_title("Folder with the game's exe");
        if let Some(d) = start {
            dlg = dlg.set_directory(d);
        }
        let picked = dlg.blocking_pick_folder();
        let Some(fp) = picked else { return Ok(json!({ "added": false })) };
        let dir = fp.into_path().map_err(|e| e.to_string())?;
        if fsx::blocked(&dir) {
            return Err("This folder is the protected original ESWC and is not supported.".into());
        }
        let found = scan::classify(&dir);
        if found.is_empty() {
            return Ok(json!({ "added": false, "message": "No TrackMania exe in this folder." }));
        }
        let st = app.state::<AppState>();
        let d = dir.to_string_lossy().into_owned();
        st.update_settings(|s| {
            if !s.extra_folders.iter().any(|x| fsx::norm(Path::new(x)) == fsx::norm(&dir)) {
                s.extra_folders.push(d.clone());
            }
        })?;
        Ok(json!({ "added": true, "games": found.iter().map(|(g, _)| *g).collect::<Vec<_>>(), "path": d }))
    })
    .await
}

#[tauri::command]
pub async fn remove_folder(app: tauri::AppHandle, path: String) -> Result<Settings, String> {
    crate::bg::run(move || -> Result<Settings, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        st.update_settings(|s| {
            s.extra_folders.retain(|x| fsx::norm(Path::new(x)) != fsx::norm(Path::new(&path)));
            s.found_installs.retain(|x| fsx::norm(Path::new(&x.path)) != fsx::norm(Path::new(&path)));
        })
    })
    .await
}

#[tauri::command]
pub async fn scan_drives(app: AppHandle) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = app.state::<AppState>();
        if st.drive_scan_running.swap(true, Ordering::SeqCst) {
            return Err("Already scanning".into());
        }
        st.drive_scan_cancel.store(false, Ordering::SeqCst);
        let cancel = st.drive_scan_cancel.clone();
        let a = app.clone();
        std::thread::spawn(move || {
            let drives = platform::fixed_drives();
            let t0 = std::time::Instant::now();
            // Known game places first (results in seconds), then the whole drives without them again.
            let known = scan::known_roots(&drives);
            let mut found = scan::walk_for_games(&known, 5, &cancel, |p, n, f| {
                let _ = a.emit("drive-scan", json!({ "dir": p.to_string_lossy(), "dirs": n, "found": f, "phase": "known" }));
            });
            let base = found.len();
            let more = scan::walk_for_games_skipping(&drives, 7, &cancel, &known, |p, n, f| {
                let _ = a.emit("drive-scan", json!({ "dir": p.to_string_lossy(), "dirs": n, "found": base + f, "phase": "drives" }));
            });
            for f in more {
                if !found.iter().any(|x| x.game == f.game && fsx::norm(Path::new(&x.path)) == fsx::norm(Path::new(&f.path))) {
                    found.push(f);
                }
            }
            let st = a.state::<AppState>();
            let cancelled = cancel.load(Ordering::SeqCst);
            if !cancelled {
                let f2: Vec<FoundInstall> = found.clone();
                let _ = st.update_settings(|s| s.found_installs = f2);
            }
            st.drive_scan_running.store(false, Ordering::SeqCst);
            let _ = a.emit("drive-scan-done", json!({ "found": found, "cancelled": cancelled, "seconds": t0.elapsed().as_secs(), "drives": drives }));
        });
        Ok(())
    })
    .await
}

#[tauri::command(async)]
pub fn cancel_drive_scan(st: State<AppState>) {
    st.drive_scan_cancel.store(true, Ordering::SeqCst);
}

// ------------------------------------------------------------------ getting games

#[tauri::command(async)]
pub fn game_source(game: String) -> Source {
    gameinstall::source(&game)
}

#[tauri::command]
pub async fn game_download(app: AppHandle, game: String) -> Result<gameinstall::Verdict, String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = a.state::<AppState>();
        let Source::Download { url, file, sha256: known, .. } = gameinstall::source(&game) else { return Err("No official download for this game".to_string()) };
        let recorded = st.settings().installer_hashes.get(url).cloned();
        let dir = st.cache_dir.join("setups");
        let g = game.clone();
        let (path, verdict) = gameinstall::download_and_verify(
            url,
            file,
            &dir,
            &gameinstall::HttpFetch,
            &platform::verify_signature,
            recorded.as_deref(),
            known,
            &mut |got, total| {
                let _ = a.emit("game-download", json!({ "game": g, "received": got, "total": total }));
            },
        )?;
        if verdict.ok {
            st.setups.lock().unwrap().insert(game.clone(), PreparedSetup { url: url.into(), path, verdict: verdict.clone() });
        }
        Ok(verdict)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn game_run_setup(app: AppHandle, game: String, confirmed: Option<bool>) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = app.state::<AppState>();
        let prepared = st.setups.lock().unwrap().remove(&game).ok_or("Download the setup first")?;
        if prepared.verdict.needs_confirm && confirmed != Some(true) {
            return Err("This setup needs your confirmation first".into());
        }
        // The file may have been swapped since it was checked: hash it again right before running.
        let now = gameinstall::sha256_file(&prepared.path)?;
        if !now.eq_ignore_ascii_case(&prepared.verdict.sha256) {
            let _ = std::fs::remove_file(&prepared.path);
            return Err("The setup file changed after the check. Not run.".into());
        }
        let (url, sha, update) = (prepared.url.clone(), prepared.verdict.sha256.clone(), prepared.verdict.update_record);
        st.update_settings(|s| {
            if update {
                s.installer_hashes.insert(url, sha);
            } else {
                s.installer_hashes.entry(url).or_insert(sha);
            }
        })?;
        let a = app.clone();
        std::thread::spawn(move || {
            let cmd = gameinstall::setup_command(&prepared.path);
            let code = platform::run_setup_and_wait(&cmd.program, cmd.cwd.as_deref());
            let snap = do_scan(&a.state::<AppState>());
            let _ = a.emit("game-setup-done", json!({ "game": game, "code": code.as_ref().ok(), "error": code.err().map(|e| e.to_string()), "snapshot": snap }));
        });
        Ok(())
    })
    .await
}

// ------------------------------------------------------------------ updates (stub)

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>().settings();
        if crate::RELEASE_PREVIEW {
            return Err("Updates come through the GitHub release (Settings > Updates)".to_string());
        }
        let url = if s.update_url.trim().is_empty() { format!("{}/launcher.json", s.hub_url.trim_end_matches('/')) } else { s.update_url };
        let current = env!("CARGO_PKG_VERSION");
        let v = net::get_json(&url).map_err(|e| format!("No update info ({e})"))?;
        let latest = v.get("version").and_then(Value::as_str).unwrap_or("");
        let newer = matches!((semver::Version::parse(latest), semver::Version::parse(current)), (Ok(l), Ok(c)) if l > c);
        Ok(json!({ "current": current, "latest": latest, "newer": newer, "url": v.get("url"), "notes": v.get("notes") }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ window

#[tauri::command]
pub fn win(app: AppHandle, action: String) -> Result<(), String> {
    let w = app.get_window("main").ok_or("no window")?;
    match action.as_str() {
        "minimize" => w.minimize(),
        "toggle-maximize" => {
            if w.is_maximized().unwrap_or(false) {
                w.unmaximize()
            } else {
                w.maximize()
            }
        }
        "close" => w.close(),
        _ => Ok(()),
    }
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_goes_to_the_client_once_it_is_connected() {
        // A fake bridge: the client connects on the third try.
        let mut tries = 0;
        assert!(wait_and_play(|| { tries += 1; tries >= 3 }, Duration::from_millis(500), Duration::from_millis(1)));
        assert_eq!(tries, 3);
        // Never connects: gives up after the limit.
        let t0 = std::time::Instant::now();
        assert!(!wait_and_play(|| false, Duration::from_millis(30), Duration::from_millis(5)));
        assert!(t0.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn maps_only_from_game_folders() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("Documents");
        let game = t.path().join("TmNationsForever");
        let dl = docs.join("TrackMania").join("Tracks").join("Challenges").join("Downloaded");
        std::fs::create_dir_all(&dl).unwrap();
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(dl.join("A07.Challenge.Gbx"), b"GBX").unwrap();
        std::fs::write(t.path().join("elsewhere.Challenge.Gbx"), b"GBX").unwrap();
        std::fs::write(dl.join("notes.txt"), b"x").unwrap();
        assert!(map_path_ok(&dl.join("A07.Challenge.Gbx"), Some(&docs), &game).is_ok());
        assert!(map_path_ok(&t.path().join("elsewhere.Challenge.Gbx"), Some(&docs), &game).is_err());
        assert!(map_path_ok(&dl.join("notes.txt"), Some(&docs), &game).is_err());
        assert!(map_path_ok(&dl.join("missing.Challenge.Gbx"), Some(&docs), &game).is_err());
        assert!(map_path_ok(&dl.join("..").join("..").join("..").join("..").join("..").join("elsewhere.Challenge.Gbx"), Some(&docs), &game).is_err());
    }
}
