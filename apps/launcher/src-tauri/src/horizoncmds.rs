//! Tauri commands for Horizon Host (logic and tests in horizonhost.rs).
//!
//! Every legacy command takes the game id and the folder; the folder must be one of the scanned
//! installs of that game (also folders added by hand) or one of TM Horizon's instances of it, so
//! the UI can never point a write at any other folder.
use crate::commands::{fail, ok, ActionResult};
use crate::horizonhost::{self as hh, format, Kind};
use crate::scan::InstallInfo;
use crate::state::AppState;
use crate::{fsx, platform};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Every install of a game from the last scan (AppState::install only gives the first).
pub(crate) fn installs_of(st: &AppState, game: &str) -> Vec<InstallInfo> {
    let snap = st.snapshot.lock().unwrap();
    let Some(s) = snap.as_ref() else { return vec![] };
    let g = &s.games;
    match game {
        "tmnf" => g.tmnf.installs.clone(),
        "tmuf" => g.tmuf.installs.clone(),
        "tmn-eswc" => g.eswc.installs.clone(),
        "tm-original" => g.original.installs.clone(),
        "tm-sunrise" => g.sunrise.installs.clone(),
        _ => vec![],
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub dir: String,
    pub label: String,
    /// "install" | "instance"
    pub kind: String,
    pub instance_id: Option<String>,
    pub host_installed: Option<String>,
}

fn targets(st: &AppState, game: &str) -> Vec<Target> {
    let mut out: Vec<Target> = installs_of(st, game)
        .into_iter()
        .filter(|i| !fsx::blocked(Path::new(&i.path)))
        .map(|i| Target { host_installed: hh::read_record(&Path::new(&i.path).join(format::HOST_DIR)).map(|r| r.version), label: i.source.clone(), dir: i.path, kind: "install".into(), instance_id: None })
        .collect();
    for i in crate::instances::list(&st.data_dir).into_iter().filter(|i| i.game == game && Path::new(&i.path).is_dir()) {
        out.push(Target { host_installed: hh::read_record(&Path::new(&i.path).join(format::HOST_DIR)).map(|r| r.version), label: i.name.clone(), dir: i.path.clone(), kind: "instance".into(), instance_id: Some(i.id) });
    }
    out
}

fn check_target(st: &AppState, game: &str, dir: &str) -> Result<PathBuf, String> {
    if !hh::is_legacy(game) {
        return Err("Horizon Client's Legacy Loader is for ESWC, Sunrise and Original".into());
    }
    let want = fsx::norm(Path::new(dir));
    let t = targets(st, game).into_iter().find(|t| fsx::norm(Path::new(&t.dir)) == want).ok_or("This folder is not one of the game's installs; add it with \"Add folder\" first")?;
    let p = PathBuf::from(t.dir);
    let g = hh::legacy_game_of(&p)?;
    if g != game {
        return Err("This folder holds another game".into());
    }
    Ok(p)
}

/// The exes that hold the files of this game's install (a running Nations Forever does not block ESWC).
fn game_exes(game: &str) -> &'static [&'static str] {
    match game {
        "tmn-eswc" => &["tmnationseswc.exe"],
        "tm-sunrise" => &["tmsunrise.exe"],
        "tm-original" => &["tmoriginal.exe", "trackmania.exe"],
        "tmnf" | "tmuf" => &["tmforever.exe", "tmloader.exe"],
        _ => &["tmnationseswc.exe", "tmsunrise.exe", "tmoriginal.exe", "trackmania.exe", "tmforever.exe"],
    }
}

fn game_running(game: &str) -> Result<(), String> {
    let exes = game_exes(game);
    match platform::running_process_names().into_iter().find(|p| exes.iter().any(|e| p.eq_ignore_ascii_case(e))) {
        Some(p) => Err(format!("{p} is running. Close the game first.")),
        None => Ok(()),
    }
}

fn source_info(st: &AppState) -> (hh::SourceInfo, Option<PathBuf>) {
    match hh::load_store(&st.data_dir).dev_dir.filter(|d| !d.trim().is_empty()) {
        Some(d) => (hh::SourceInfo { kind: "dev".into(), path: Some(d.clone()), ..Default::default() }, Some(PathBuf::from(d))),
        None => (hh::SourceInfo { kind: "github".into(), path: Some(format!("github.com/{}", hh::GITHUB_REPO)), ..Default::default() }, None),
    }
}

fn legacy_package(st: &AppState, game: &str) -> Result<hh::Package, String> {
    match source_info(st).1 {
        Some(d) => hh::dev_legacy_cached(&d, game),
        None => hh::github_legacy(game),
    }
}

/// Version and file list for the card and the update check: no zip download from GitHub.
fn tml_listing(st: &AppState) -> Result<hh::Package, String> {
    match source_info(st).1 {
        Some(d) => hh::dev_tml_source(&d).map(|s| s.pkg),
        None => hh::github_tml_listing_cached(),
    }
}

/// The TMLoader product "Horizon Host" with its files (install, update, module install): the
/// local build folder, else the latest GitHub release.
fn tml_package(st: &AppState) -> Result<hh::TmlSource, String> {
    match source_info(st).1 {
        Some(d) => hh::dev_tml_source(&d),
        None => hh::github_tml_cached(),
    }
}

fn res(r: Result<String, String>) -> ActionResult {
    match r {
        Ok(m) => ok(m, None),
        Err(e) => fail(e),
    }
}

// ------------------------------------------------------------------ updates

/// One installed Horizon Host that has (or has not) a newer version in the source.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostUpdate {
    pub game: String,
    pub dir: String,
    pub label: String,
    pub installed: String,
    pub latest: Option<String>,
    pub update: bool,
    /// "dev" (local build folder) or "github".
    pub source: String,
    pub error: Option<String>,
}

/// Installed hosts against the source's newest version. Never installs anything.
pub fn host_updates(installed: &[(String, Target)], latest: &Result<String, String>, source: &str) -> Vec<HostUpdate> {
    installed
        .iter()
        .filter_map(|(game, t)| {
            let v = t.host_installed.clone()?;
            let (latest, error) = match latest {
                Ok(l) => (Some(l.clone()), None),
                Err(e) => (None, Some(e.clone())),
            };
            let update = latest.as_deref().is_some_and(|l| crate::updates::is_newer(l, &v));
            Some(HostUpdate { game: game.clone(), dir: t.dir.clone(), label: t.label.clone(), installed: v, latest, update, source: source.into(), error })
        })
        .collect()
}

/// For the Updates list: every installed Horizon Host of ESWC / Sunrise / Original and whether
/// the source (local dist, else the GitHub releases of cheatoskar/horizon-host) has a newer one.
#[tauri::command]
pub async fn horizon_updates(app: tauri::AppHandle) -> Vec<HostUpdate> {
    crate::bg::run(move || -> Vec<HostUpdate> {
        let st = tauri::Manager::state::<AppState>(&app);
        let mut installed = vec![];
        for g in ["tmn-eswc", "tm-sunrise", "tm-original"] {
            installed.extend(targets(&st, g).into_iter().filter(|t| t.host_installed.is_some()).map(|t| (g.to_string(), t)));
        }
        // TMNF/TMUF: the TMLoader product (one for both games; the card of the installed one opens).
        let tml = st.tmloader_root().and_then(|r| hh::tml_versions(&r).pop().map(|(v, _)| (v, hh::tml_product_dir(&r))));
        if installed.is_empty() && tml.is_none() {
            return vec![];
        }
        let (info, dev) = source_info(&st);
        let latest = match dev {
            Some(d) => hh::dev_version(&d).ok_or_else(|| "The build folder has no manifest.json".to_string()),
            None => crate::updates::latest_tag(&st.cache_dir, hh::GITHUB_REPO).map(|t| crate::updates::norm_version(&t)),
        };
        let mut out = host_updates(&installed, &latest, &info.kind);
        if let Some((v, dir)) = tml {
            let game = if st.install("tmnf").is_none() && st.install("tmuf").is_some() { "tmuf" } else { "tmnf" };
            let (l, error) = match &latest {
                Ok(l) => (Some(l.clone()), None),
                Err(e) => (None, Some(e.clone())),
            };
            let update = l.as_deref().is_some_and(|l| crate::updates::is_newer(l, &v));
            out.push(HostUpdate { game: game.into(), dir: dir.to_string_lossy().into(), label: "TMLoader".into(), installed: v, latest: l, update, source: info.kind.clone(), error });
        }
        out
    })
    .await
}

// ------------------------------------------------------------------ source

fn source_now(st: &AppState) -> hh::SourceInfo {
    let (mut s, _) = source_info(st);
    match legacy_package(st, "tmn-eswc") {
        Ok(p) => s.version = Some(p.version),
        Err(e) => s.error = Some(e),
    }
    if let Ok(p) = tml_listing(st) {
        s.tml_version = Some(p.version);
    }
    s
}

fn source_set(st: &AppState, path: Option<String>) -> Result<hh::SourceInfo, String> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        if fsx::blocked(Path::new(p)) || !Path::new(p).is_dir() {
            return Err(format!("Folder not found: {p}"));
        }
    }
    hh::update_store(&st.data_dir, |s| s.dev_dir = path)?;
    Ok(source_now(st))
}

#[tauri::command]
pub async fn horizon_source(app: tauri::AppHandle) -> hh::SourceInfo {
    crate::bg::run(move || -> hh::SourceInfo {
        let st = tauri::Manager::state::<AppState>(&app);
        source_now(&st)
    })
    .await
}

/// Sets the local build folder (None = GitHub releases).
#[tauri::command]
pub async fn horizon_source_set(app: tauri::AppHandle, path: Option<String>) -> Result<hh::SourceInfo, String> {
    crate::bg::run(move || -> Result<hh::SourceInfo, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        source_set(&st, path)
    })
    .await
}

#[tauri::command]
pub async fn horizon_source_pick(app: AppHandle) -> Result<Option<hh::SourceInfo>, String> {
    // The dialog waits for the user: on the blocking pool, not on an async worker.
    crate::bg::run(move || -> Result<Option<hh::SourceInfo>, String> {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().set_title("Horizon Client build folder (dist)").blocking_pick_folder();
        let Some(fp) = picked else { return Ok(None) };
        let dir = fp.into_path().map_err(|e| e.to_string())?;
        source_set(&app.state::<AppState>(), Some(dir.to_string_lossy().into())).map(Some)
    })
    .await
}

// ------------------------------------------------------------------ legacy games

#[tauri::command]
pub async fn horizon_targets(app: tauri::AppHandle, game: String) -> Vec<Target> {
    crate::bg::run(move || -> Vec<Target> {
        let st = tauri::Manager::state::<AppState>(&app);
        if !hh::is_legacy(&game) {
            return vec![];
        }
        targets(&st, &game)
    })
    .await
}

#[tauri::command]
pub async fn horizon_status(app: tauri::AppHandle, game: String, dir: String) -> Result<hh::Status, String> {
    crate::bg::run(move || -> Result<hh::Status, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let t0 = std::time::Instant::now();
        let d = check_target(&st, &game, &dir)?;
        let r = hh::status(&d, &st.data_dir, legacy_package(&st, &game), source_info(&st).0);
        crate::perf::log(&st, "horizon: card status", t0.elapsed().as_millis());
        r
    })
    .await
}

#[tauri::command]
pub async fn horizon_prepare(app: tauri::AppHandle, game: String, dir: String) -> Result<hh::Plan, String> {
    crate::bg::run(move || -> Result<hh::Plan, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let d = check_target(&st, &game, &dir)?;
        hh::prepare(&d, &st.data_dir, legacy_package(&st, &game)?)
    })
    .await
}

#[tauri::command]
pub async fn horizon_apply(app: tauri::AppHandle, game: String, dir: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        res((|| {
            let d = check_target(&st, &game, &dir)?;
            game_running(&game)?;
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "host-install", "Horizon Client"), crate::history::game_dir_watches(&d, true));
            hh::apply(&d, &st.data_dir)
        })())
    })
    .await
}

#[tauri::command]
pub async fn horizon_remove(app: tauri::AppHandle, game: String, dir: String, restore_previous: bool) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        res((|| {
            let d = check_target(&st, &game, &dir)?;
            game_running(&game)?;
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "host-remove", "Horizon Client"), crate::history::game_dir_watches(&d, true));
            hh::remove(&d, &st.data_dir, restore_previous)
        })())
    })
    .await
}

#[tauri::command]
pub async fn horizon_restore(app: tauri::AppHandle, game: String, dir: String, id: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        res((|| {
            let d = check_target(&st, &game, &dir)?;
            game_running(&game)?;
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "host-restore", "Horizon Client"), crate::history::game_dir_watches(&d, true));
            hh::restore(&d, &st.data_dir, &id)
        })())
    })
    .await
}

#[tauri::command]
pub async fn horizon_migrate_autosave(app: tauri::AppHandle, game: String, dir: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        res((|| {
            let d = check_target(&st, &game, &dir)?;
            game_running(&game)?;
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "host-install", "Horizon Client"), crate::history::game_dir_watches(&d, true));
            hh::migrate_autosave(&d, &st.data_dir, &legacy_package(&st, &game)?)
        })())
    })
    .await
}

/// Where a plugin goes: legacy folder, or the TMLoader version folder a profile runs.
fn plugin_base(st: &AppState, game: &str, dir: Option<&str>, profile: Option<&str>) -> Result<(Kind, PathBuf, String), String> {
    if hh::is_legacy(game) {
        let d = check_target(st, game, dir.ok_or("no folder")?)?;
        let scope = hh::dir_scope(&d);
        return Ok((Kind::Legacy, d, scope));
    }
    if hh::is_forever(game) {
        let profile = profile.ok_or("Pick a TMLoader profile first")?;
        let root = st.tmloader_root().ok_or("TMLoader not found")?;
        let info = crate::tmloader::read_info(&root);
        let pinned = info.profiles.iter().find(|p| p.name == profile).and_then(|p| p.mods.iter().find(|m| m.id == format::TML_PRODUCT)).and_then(|m| m.version.clone());
        let h = hh::tml_host_root(&root, pinned.as_deref()).ok_or("Horizon Client is not installed in TMLoader")?;
        return Ok((Kind::Tml, h, hh::tml_scope(profile)));
    }
    Err("Horizon Client does not run on this game".into())
}

#[tauri::command]
pub async fn horizon_plugin_install(app: tauri::AppHandle, game: String, dir: Option<String>, profile: Option<String>, id: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        res((|| {
            let (kind, base, _) = plugin_base(&st, &game, dir.as_deref(), profile.as_deref())?;
            game_running(&game)?;
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "host-plugin", &id), plugin_watch(kind, &base, &id));
            if kind == Kind::Tml {
                crate::tmloader::ensure_idle()?;
                return hh::install_plugin(kind, &base, &st.data_dir, &tml_package(&st)?.pkg, &id);
            }
            hh::install_plugin(kind, &base, &st.data_dir, &legacy_package(&st, &game)?, &id)
        })())
    })
    .await
}

#[tauri::command]
pub async fn horizon_plugin_remove(app: tauri::AppHandle, game: String, dir: Option<String>, profile: Option<String>, id: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        res((|| {
            let (kind, base, scope) = plugin_base(&st, &game, dir.as_deref(), profile.as_deref())?;
            game_running(&game)?;
            let history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "host-plugin-remove", &id), plugin_watch(kind, &base, &id));
            let m = hh::remove_plugin(kind, &base, &st.data_dir, &id)?;
            history.finish();
            if hh::enabled(&st.data_dir, &scope).is_some() {
                hh::set_enabled(&st.data_dir, &scope, &id, false, &[])?;
            }
            Ok(m)
        })())
    })
    .await
}

/// The plugin's folder (for the change history).
fn plugin_watch(kind: Kind, base: &Path, id: &str) -> Vec<crate::history::Watch> {
    let host_root = if kind == Kind::Legacy { base.join(format::HOST_DIR) } else { base.to_path_buf() };
    if id.is_empty() || id.contains(['/', '\\', '.']) {
        return vec![];
    }
    vec![crate::history::Watch::Tree(host_root.join("plugins").join(id))]
}

/// On/off for the next start (written into profile.json then).
#[tauri::command]
pub async fn horizon_plugin_enable(app: tauri::AppHandle, game: String, dir: Option<String>, profile: Option<String>, id: String, on: bool) -> Result<Vec<String>, String> {
    crate::bg::run(move || -> Result<Vec<String>, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        // Only two small JSON files change; the card flips its switch itself and does not reload.
        let t0 = std::time::Instant::now();
        let (kind, base, scope) = plugin_base(&st, &game, dir.as_deref(), profile.as_deref())?;
        let host_root = if kind == Kind::Legacy { base.join(format::HOST_DIR) } else { base };
        let inst = hh::installed_plugins(&host_root);
        let defaults: Vec<String> = inst.iter().filter(|m| m.enabled_by_default).map(|m| m.id.clone()).collect();
        let list = hh::set_enabled(&st.data_dir, &scope, &id, on, &defaults)?;
        // The in-game menu's own switch too (settings\host.json), only for an installed module.
        if inst.iter().any(|m| m.id == id) {
            hh::set_menu_switch(&host_root, &id, on)?;
        }
        crate::perf::log(&st, "horizon: module switch", t0.elapsed().as_millis());
        Ok(list)
    })
    .await
}

#[tauri::command]
pub async fn horizon_log(app: tauri::AppHandle, game: String, dir: Option<String>, profile: Option<String>) -> Result<Option<hh::LogFile>, String> {
    crate::bg::run(move || -> Result<Option<hh::LogFile>, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let (kind, base, _) = plugin_base(&st, &game, dir.as_deref(), profile.as_deref())?;
        let host_root = if kind == Kind::Legacy { base.join(format::HOST_DIR) } else { base };
        Ok(hh::latest_log(&host_root))
    })
    .await
}

/// Play from a chosen folder (legacy) or TMLoader profile (Forever), optionally without plugins.
#[tauri::command]
pub async fn horizon_play(app: AppHandle, game: String, dir: Option<String>, profile: Option<String>, safe: bool, game_name: Option<String>) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        if hh::is_legacy(&game) {
            let d = match check_target(&st, &game, dir.as_deref().unwrap_or("")) {
                Ok(d) => d,
                Err(e) => return fail(e),
            };
            let inst = targets(&st, &game).into_iter().find(|t| fsx::norm(Path::new(&t.dir)) == fsx::norm(&d)).and_then(|t| t.instance_id);
            if let Some(id) = inst {
                // An instance starts through start_install; launch_with writes its profile.json.
                return crate::commands::launch_with(&app, &st, game, None, None, game_name, Some(id), None, safe);
            }
            return crate::commands::launch_with(&app, &st, game, None, None, game_name, None, Some(&d), safe);
        }
        crate::commands::launch_with(&app, &st, game, profile, None, game_name, None, None, safe)
    })
    .await
}

// ------------------------------------------------------------------ Forever (TMLoader product)

#[tauri::command]
pub async fn horizon_tml_status(app: tauri::AppHandle, game: String, profile: Option<String>) -> hh::TmlStatus {
    crate::bg::run(move || -> hh::TmlStatus {
        let st = tauri::Manager::state::<AppState>(&app);
        let root = st.tmloader_root();
        hh::tml_status(root.as_deref(), &st.data_dir, profile.as_deref(), &game, tml_listing(&st), source_info(&st).0)
    })
    .await
}

#[tauri::command]
pub async fn horizon_tml_prepare(app: tauri::AppHandle) -> Result<hh::TmlPlan, String> {
    crate::bg::run(move || -> Result<hh::TmlPlan, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let root = st.tmloader_root().ok_or("TMLoader not found")?;
        hh::tml_plan(&root, &tml_package(&st)?.pkg)
    })
    .await
}

#[tauri::command]
pub async fn horizon_tml_apply(app: AppHandle, profiles: Vec<String>) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        let r = (|| {
            let root = st.tmloader_root().ok_or("TMLoader not found")?;
            crate::tmloader::ensure_idle()?;
            let src = tml_package(&st)?;
            let mut w = crate::history::tml_profiles(&root);
            w.push(crate::history::Watch::Tree(hh::tml_product_dir(&root)));
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", "host-install", "Horizon Client"), w);
            hh::tml_apply(&root, &src.pkg, &src.extra, src.product_desc.as_deref(), &profiles, &st.backup_dir())
        })();
        crate::commands::refresh_tmloader(&st);
        res(r)
    })
    .await
}

#[tauri::command]
pub async fn horizon_tml_remove(app: AppHandle) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        let r = (|| {
            let root = st.tmloader_root().ok_or("TMLoader not found")?;
            crate::tmloader::ensure_idle()?;
            let mut w = crate::history::tml_profiles(&root);
            w.push(crate::history::Watch::Tree(hh::tml_product_dir(&root)));
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", "host-remove", "Horizon Client"), w);
            hh::tml_remove(&root, &st.backup_dir())
        })();
        crate::commands::refresh_tmloader(&st);
        res(r)
    })
    .await
}

#[tauri::command]
pub async fn horizon_tml_set_profile(app: AppHandle, profile: String, on: bool) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        let r = (|| {
            let root = st.tmloader_root().ok_or("TMLoader not found")?;
            crate::tmloader::ensure_idle()?;
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", if on { "mod-on" } else { "mod-off" }, "Horizon Client").detail(&profile), crate::history::tml_profiles(&root));
            crate::tmloader::set_profile_mod(&root, &profile, format::TML_PRODUCT, on, &st.backup_dir())?;
            Ok(if on { format!("Horizon Client on in {profile}") } else { format!("Horizon Client off in {profile}") })
        })();
        crate::commands::refresh_tmloader(&st);
        res(r)
    })
    .await
}

// ------------------------------------------------------------------ plugin catalog (Mods page)

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTarget {
    pub game: String,
    pub dir: String,
    pub label: String,
    pub host_installed: Option<String>,
    pub plugins: Vec<hh::PluginState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub source: hh::SourceInfo,
    /// Plugins in the source (legacy build), with their games.
    pub plugins: Vec<format::PluginMeta>,
    /// Every legacy folder with its plugin states.
    pub targets: Vec<CatalogTarget>,
}

#[tauri::command]
pub async fn horizon_catalog(app: tauri::AppHandle) -> Catalog {
    crate::bg::run(move || -> Catalog {
        let st = tauri::Manager::state::<AppState>(&app);
        let mut source = source_info(&st).0;
        let mut plugins: Vec<format::PluginMeta> = Vec::new();
        let mut out = Vec::new();
        for game in ["tmn-eswc", "tm-sunrise", "tm-original"] {
            // One package per game (the host ships per-game zips); the plugin list is their union.
            let pkg = legacy_package(&st, game);
            match &pkg {
                Ok(p) => {
                    source.version = Some(p.version.clone());
                    for m in p.plugins("horizon/plugins/").into_values().filter_map(|(_, m)| m) {
                        if !plugins.iter().any(|x| x.id == m.id) {
                            plugins.push(m);
                        }
                    }
                }
                Err(e) if game == "tmn-eswc" => source.error = Some(e.clone()),
                Err(_) => {}
            }
            for t in targets(&st, game) {
                let d = Path::new(&t.dir);
                let en = hh::enabled(&st.data_dir, &hh::dir_scope(d));
                out.push(CatalogTarget {
                    plugins: hh::plugin_states(&d.join(format::HOST_DIR), pkg.as_ref().ok(), "horizon/plugins/", game, en.as_deref()),
                    game: game.into(),
                    label: t.label,
                    host_installed: t.host_installed,
                    dir: t.dir,
                });
            }
        }
        Catalog { source, plugins, targets: out }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(dir: &str, v: Option<&str>) -> Target {
        Target { dir: dir.into(), label: "Steam".into(), kind: "install".into(), instance_id: None, host_installed: v.map(String::from) }
    }

    #[test]
    fn updates_are_only_shown_never_installed() {
        let l = vec![("tmn-eswc".to_string(), t("C:/a", Some("0.2.0"))), ("tm-sunrise".to_string(), t("C:/b", Some("0.3.0"))), ("tm-original".to_string(), t("C:/c", None))];
        let u = host_updates(&l, &Ok("0.3.0".into()), "dev");
        assert_eq!(u.len(), 2, "no host, no row");
        assert!(u[0].update && u[0].latest.as_deref() == Some("0.3.0") && u[0].installed == "0.2.0");
        assert!(!u[1].update);
        let e = host_updates(&l, &Err("offline".into()), "github");
        assert!(e.iter().all(|x| !x.update && x.error.as_deref() == Some("offline") && x.source == "github"));
    }
}

#[cfg(test)]
mod running_tests {
    use super::game_exes;

    #[test]
    fn only_the_games_own_exe_blocks_its_install() {
        assert_eq!(game_exes("tmn-eswc"), ["tmnationseswc.exe"]);
        assert!(!game_exes("tmn-eswc").contains(&"tmforever.exe"), "a running Nations Forever does not block ESWC");
        assert!(game_exes("tmnf").contains(&"tmforever.exe"));
        assert!(game_exes("tm-original").contains(&"trackmania.exe"));
        assert_eq!(game_exes("other").len(), 5);
    }
}
