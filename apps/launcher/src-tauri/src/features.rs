//! Tauri commands for the newer features: problem reports, shareable packs, the TAS corner,
//! profile templates and pinning a mod version. Kept apart from commands.rs so that file stays
//! about the core (scan, launch, installs, embedded browser).

use crate::commands::{do_scan, fail, install_plan, install_versions, installed_versions, ok, profile_mods, refresh_index, ActionResult};
use crate::state::AppState;
use crate::{fsx, launch, openplanet, packs, platform, report, tas, tmloader};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState) -> T + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    let a = app.clone();
    async move { tauri::async_runtime::spawn_blocking(move || f(&a.state::<AppState>())).await.map_err(|e| e.to_string()) }
}

// ------------------------------------------------------------------ problem reports

/// Server a product was taken from, from the cached index.
fn product_server(st: &AppState, id: &str) -> Option<String> {
    st.raw_index.lock().unwrap().servers.get(id).and_then(|v| v.first().cloned())
}

fn report_input(st: &AppState, game_id: &str, game_name: &str, profile: Option<&str>) -> report::ReportInput {
    let install = st.install(game_id);
    let (tml_version, products) = {
        let snap = st.snapshot.lock().unwrap();
        let t = snap.as_ref().map(|s| &s.tmloader);
        (t.and_then(|t| t.version.clone()), t.map(|t| t.products.clone()).unwrap_or_default())
    };
    let forever = matches!(game_id, "tmnf" | "tmuf");
    let mods = if forever {
        profile_mods(st, profile)
            .into_iter()
            .map(|(id, pinned)| {
                let newest = products.get(&id).and_then(|p| {
                    let mut v: Vec<&str> = p.versions.iter().filter(|v| v.installed).map(|v| v.version.as_str()).collect();
                    v.sort_by(|a, b| crate::modindex::cmp_version(b, a));
                    v.first().map(|s| s.to_string())
                });
                report::EnabledMod { server: product_server(st, &id), pinned: pinned.is_some(), version: pinned.or(newest), id }
            })
            .collect()
    } else {
        vec![]
    };
    report::ReportInput {
        game_id: game_id.into(),
        game_name: game_name.into(),
        documents: platform::documents_dir(),
        tmloader_root: if forever { st.tmloader_root() } else { None },
        tmloader_version: if forever { tml_version } else { None },
        profile: profile.map(String::from),
        mods,
        install: install.as_ref().map(|i| i.path.clone()),
        install_source: install.as_ref().map(|i| i.source.clone()),
        launcher_version: env!("CARGO_PKG_VERSION").into(),
        os: platform::os_summary(),
        gpus: platform::gpus(),
        horizon_dirs: if crate::horizonhost::is_legacy(game_id) {
            crate::horizoncmds::installs_of(st, game_id)
                .into_iter()
                .map(|i| PathBuf::from(i.path))
                .chain(crate::instances::list(&st.data_dir).into_iter().filter(|i| i.game == game_id).map(|i| PathBuf::from(i.path)))
                .filter(|d| fsx::is_dir(&d.join(crate::horizonhost::format::HOST_DIR)))
                .collect()
        } else {
            vec![]
        },
    }
}

#[tauri::command]
pub async fn report_collect(app: AppHandle, game_id: String, game_name: String, profile: Option<String>) -> Result<report::Report, String> {
    blocking(&app, move |st| report::collect(&report_input(st, &game_id, &game_name, profile.as_deref()), &report::Redactor::from_env())).await
}

#[tauri::command]
pub async fn report_save(app: AppHandle, game_id: String, game_name: String, profile: Option<String>, selected: Vec<String>, target: String) -> Result<String, String> {
    blocking(&app, move |st| {
        let r = report::Redactor::from_env();
        let rep = report::collect(&report_input(st, &game_id, &game_name, profile.as_deref()), &r);
        let dir = match target.as_str() {
            "desktop" => dirs::desktop_dir(),
            _ => dirs::download_dir(),
        }
        .ok_or("Folder not found")?;
        report::save(&rep, &selected, &r, &dir).map(|p| p.to_string_lossy().into_owned())
    })
    .await?
}

// ------------------------------------------------------------------ packs

#[tauri::command(async)]
pub fn pack_encode(pack: packs::Pack) -> Result<String, String> {
    packs::encode_link(&pack)
}

#[tauri::command(async)]
pub fn pack_decode(text: String) -> Result<packs::Pack, String> {
    packs::decode(&text)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackCheck {
    pub pack: packs::Pack,
    pub forever: bool,
    pub mods: Vec<packs::ModCheck>,
    /// Every mod is installed or can be downloaded with a SHA-256 check.
    pub can_import: bool,
    pub problem: Option<String>,
}

fn check_pack(st: &AppState, pack: &packs::Pack) -> PackCheck {
    let forever = packs::is_forever(&pack.game);
    if !forever {
        let mods = pack.mods.iter().map(|m| packs::ModCheck { id: m.id.clone(), version: m.version.clone(), server: m.server.clone(), status: "other".into(), sha256: None }).collect();
        return PackCheck { pack: pack.clone(), forever, mods, can_import: true, problem: None };
    }
    if st.raw_index.lock().unwrap().products.is_empty() {
        refresh_index(st);
    }
    let raw = st.raw_index.lock().unwrap().clone();
    let mods: Vec<packs::ModCheck> = pack
        .mods
        .iter()
        .map(|m| {
            let servers = raw.servers.get(&m.id).cloned().unwrap_or_default();
            let entry = m.version.as_ref().and_then(|v| raw.products.get(&m.id).and_then(|p| p.get("versions")).and_then(|vs| vs.get(v)));
            packs::check_mod(m, &installed_versions(st, &m.id), &servers, entry)
        })
        .collect();
    let bad: Vec<String> = mods.iter().filter(|m| !matches!(m.status.as_str(), "installed" | "download")).map(|m| format!("{} {}", m.id, m.version.clone().unwrap_or_default())).collect();
    let tml = st.tmloader_root().filter(|r| fsx::is_file(&r.join("config.yaml")));
    let problem = if tml.is_none() {
        Some("TMLoader not found".to_string())
    } else if !bad.is_empty() {
        Some(format!("Not available from your TMLoader servers: {}", bad.join(", ")))
    } else {
        None
    };
    PackCheck { pack: pack.clone(), forever, can_import: problem.is_none(), mods, problem }
}

#[tauri::command]
pub async fn pack_check(app: AppHandle, pack: packs::Pack) -> Result<PackCheck, String> {
    packs::validate(&pack)?;
    blocking(&app, move |st| check_pack(st, &pack)).await
}

fn packs_dir(st: &AppState) -> PathBuf {
    st.data_dir.join("packs")
}

#[tauri::command]
pub async fn pack_import(app: AppHandle, pack: packs::Pack) -> Result<ActionResult, String> {
    packs::validate(&pack)?;
    let a = app.clone();
    blocking(&app, move |st| -> Result<ActionResult, String> {
        let check = check_pack(st, &pack);
        if let Some(p) = check.problem {
            return Err(p);
        }
        if !check.forever {
            let dir = packs_dir(st);
            let mut file = dir.join(format!("{}.tmhubpack", pack.name));
            let mut n = 2;
            while fsx::exists(&file) {
                file = dir.join(format!("{} ({n}).tmhubpack", pack.name));
                n += 1;
            }
            fsx::write(&file, serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())?.as_bytes())?;
            return Ok(ok(format!("Saved \"{}\"", pack.name), None));
        }
        tmloader::ensure_idle()?;
        let root = st.tmloader_root().ok_or("TMLoader not found")?;
        let raw = st.raw_index.lock().unwrap().clone();
        let mut plan = Vec::new();
        for m in check.mods.iter().filter(|m| m.status == "download") {
            install_plan(st, &raw, &m.id, m.version.as_deref().unwrap_or_default(), &mut plan, 0)?;
        }
        let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", "pack", &pack.name), crate::history::tml_watches(&root, &plan));
        let backup = st.backup_dir();
        let reports = install_versions(&a, st, &raw, &root, &plan, &backup)?;
        let mods: Vec<(String, Option<String>)> = pack.mods.iter().map(|m| (m.id.clone(), m.version.clone())).collect();
        tmloader::ensure_idle()?;
        let name = tmloader::create_profile(&root, &pack.name, pack.program.as_deref(), pack.args.as_deref(), &mods)?;
        do_scan(st);
        let got = if reports.is_empty() { String::new() } else { format!(", installed {}", reports.iter().map(|r| format!("{} {}", r.product, r.version)).collect::<Vec<_>>().join(", ")) };
        Ok(ok(format!("Profile \"{name}\" created{got}"), Some(name)))
    })
    .await?
}

#[tauri::command]
pub async fn packs_list(app: AppHandle) -> Result<Vec<packs::Pack>, String> {
    blocking(&app, |st| {
        let mut out: Vec<packs::Pack> = fsx::list(&packs_dir(st))
            .into_iter()
            .filter(|e| e.is_file && e.name.to_lowercase().ends_with(".tmhubpack"))
            .filter_map(|e| fsx::read_string(&e.path).and_then(|t| packs::decode(&t).ok()))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    })
    .await
}

#[tauri::command]
pub async fn pack_remove(app: AppHandle, name: String) -> Result<(), String> {
    blocking(&app, move |st| {
        let dir = packs_dir(st);
        for e in fsx::list(&dir) {
            if e.is_file && fsx::read_string(&e.path).and_then(|t| packs::decode(&t).ok()).is_some_and(|p| p.name == name) {
                std::fs::remove_file(&e.path).map_err(|x| x.to_string())?;
            }
        }
        Ok(())
    })
    .await?
}

/// Saves a .tmhubpack where the user picks.
#[tauri::command]
pub async fn pack_save_file(app: AppHandle, pack: packs::Pack) -> Result<Option<String>, String> {
    // The dialog waits for the user: on the blocking pool, not on an async worker.
    crate::bg::run(move || -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        packs::validate(&pack)?;
        let picked = app.dialog().file().set_file_name(format!("{}.tmhubpack", pack.name)).add_filter("TM Horizon pack", &["tmhubpack"]).blocking_save_file();
        let Some(fp) = picked else { return Ok(None) };
        let path = fp.into_path().map_err(|e| e.to_string())?;
        fsx::write(&path, serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())?.as_bytes())?;
        Ok(Some(path.to_string_lossy().into()))
    })
    .await
}

/// Reads a .tmhubpack the user picks.
#[tauri::command]
pub async fn pack_open_file(app: AppHandle) -> Result<Option<packs::Pack>, String> {
    // The dialog waits for the user: on the blocking pool, not on an async worker.
    crate::bg::run(move || -> Result<Option<packs::Pack>, String> {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().add_filter("TM Horizon pack", &["tmhubpack", "json"]).blocking_pick_file();
        let Some(fp) = picked else { return Ok(None) };
        let path = fp.into_path().map_err(|e| e.to_string())?;
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(u64::MAX) > packs::MAX_JSON {
            return Err("The pack file is too big".into());
        }
        let text = fsx::read_string(&path).ok_or("Cannot read the file")?;
        packs::decode(&text).map(Some)
    })
    .await
}

// ------------------------------------------------------------------ profiles

/// New TMLoader profile from a template (e.g. "TAS": TMInterface + CoreMod), empty, or as a copy of
/// another profile (`versions[i]` pins `mods[i]`; program version and start arguments kept).
#[tauri::command]
pub async fn profile_create(app: AppHandle, name: String, mods: Vec<String>, versions: Option<Vec<Option<String>>>, program_version: Option<String>, args: Option<String>) -> Result<ActionResult, String> {
    blocking(&app, move |st| -> Result<ActionResult, String> {
        tmloader::ensure_idle()?;
        let root = st.tmloader_root().ok_or("TMLoader not found")?;
        let versions = versions.unwrap_or_default();
        let list: Vec<(String, Option<String>)> = mods.into_iter().enumerate().map(|(i, m)| (m, versions.get(i).cloned().flatten())).collect();
        let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", "profile", &name), crate::history::tml_profiles(&root));
        let used = tmloader::create_profile(&root, &name, program_version.as_deref(), args.as_deref(), &list)?;
        do_scan(st);
        Ok(ok(format!("Profile \"{used}\" created"), Some(used)))
    })
    .await?
}

/// Deletes a TMLoader profile (backup first; never TMLoader's default or one a separate
/// installation starts with).
#[tauri::command]
pub async fn profile_delete(app: AppHandle, name: String) -> Result<ActionResult, String> {
    blocking(&app, move |st| -> Result<ActionResult, String> {
        tmloader::ensure_idle()?;
        let root = st.tmloader_root().ok_or("TMLoader not found")?;
        if let Some(i) = crate::instances::list(&st.data_dir).into_iter().find(|i| i.tml_profile.as_deref() == Some(name.as_str())) {
            return Err(format!("The separate installation \"{}\" starts with \"{name}\". Change it there first.", i.name));
        }
        let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", "profile", &name), crate::history::tml_profiles(&root));
        tmloader::delete_profile(&root, &name, &st.backup_dir())?;
        do_scan(st);
        Ok(ok(format!("Profile \"{name}\" deleted"), None))
    })
    .await?
}

#[tauri::command]
pub async fn set_profile_mod_version(app: AppHandle, profile: String, mod_id: String, version: Option<String>) -> Result<ActionResult, String> {
    blocking(&app, move |st| {
        let r = (|| -> Result<bool, String> {
            tmloader::ensure_idle()?;
            let root = st.tmloader_root().ok_or("TMLoader not found")?;
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmnf", "mod-version", &mod_id).detail(format!("{} · {profile}", version.as_deref().unwrap_or("latest"))), crate::history::tml_profiles(&root));
            tmloader::set_profile_mod_version(&root, &profile, &mod_id, version.as_deref(), &st.backup_dir())
        })();
        match r {
            Ok(changed) => {
                crate::commands::refresh_tmloader(st);
                ok(if changed { format!("{mod_id} {} in \"{profile}\"", version.as_deref().unwrap_or("newest")) } else { "No change".into() }, None)
            }
            Err(e) => fail(e),
        }
    })
    .await
}

// ------------------------------------------------------------------ TAS corner

#[tauri::command]
pub async fn tas_info(app: AppHandle) -> Result<tas::TasInfo, String> {
    let picked = app.state::<AppState>().settings().tick_exe.map(PathBuf::from);
    blocking(&app, move |_| tas::info(platform::documents_dir().as_deref(), &platform::uninstall_entries(), local_programs().as_deref(), picked.as_deref())).await
}

/// %LOCALAPPDATA%\Programs, where per-user installers put their apps.
fn local_programs() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Programs"))
}

fn tick_now(app: &AppHandle) -> tas::ForeverTas {
    let picked = app.state::<AppState>().settings().tick_exe.map(PathBuf::from);
    tas::tick(&platform::uninstall_entries(), local_programs().as_deref(), picked.as_deref())
}

/// Starts TICK (Trackmania 2020 TAS tool) if it is installed or was picked by hand.
#[tauri::command]
pub async fn tick_start(app: AppHandle) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let Some(exe) = tick_now(&app).exe.map(PathBuf::from) else { return fail("TICK is not installed") };
        if fsx::blocked(&exe) {
            return fail("Refusing to start this file");
        }
        let spec = launch::wrap(&crate::commands::runner(), &exe, &[], exe.parent());
        match platform::spawn(&spec) {
            Ok(_) => ok("Starting TICK", Some(exe.to_string_lossy().into())),
            Err(e) => fail(e.to_string()),
        }
    })
    .await
}

/// Lets the user point at TICK's exe when it is not found on its own (stored in the settings).
#[tauri::command]
pub async fn tick_locate(app: AppHandle) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        use tauri_plugin_dialog::DialogExt;
        let Some(picked) = app.dialog().file().set_title("TICK").add_filter("TICK", &["exe"]).blocking_pick_file() else { return fail("Cancelled") };
        let Some(p) = picked.into_path().ok() else { return fail("Not a local file") };
        if fsx::blocked(&p) || !fsx::is_file(&p) {
            return fail("Not usable");
        }
        let path = p.to_string_lossy().to_string();
        match app.state::<AppState>().update_settings(|s| s.tick_exe = Some(path.clone())) {
            Ok(_) => ok("TICK found", Some(path)),
            Err(e) => fail(e),
        }
    })
    .await
}

/// Opens one of TMInterface's folders (or config.txt) in Explorer / the default editor.
#[tauri::command]
pub async fn tas_open(app: AppHandle, key: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let Some(docs) = platform::documents_dir() else { return fail("Documents not found") };
        let Some(p) = tas::target(&docs, &key) else { return fail("Not found") };
        match app.opener().open_path(p.to_string_lossy(), None::<&str>) {
            Ok(()) => ok("Opened", Some(p.to_string_lossy().into())),
            Err(e) => fail(e.to_string()),
        }
    })
    .await
}

#[tauri::command]
pub async fn forevertas_start() -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let ft = tas::forevertas(&platform::uninstall_entries());
        let Some(exe) = ft.exe.map(PathBuf::from) else { return fail("ForeverTAS is not installed") };
        if fsx::blocked(&exe) {
            return fail("Refusing to start this file");
        }
        let spec = launch::wrap(&crate::commands::runner(), &exe, &[], exe.parent());
        match platform::spawn(&spec) {
            Ok(_) => ok("Starting ForeverTAS", Some(exe.to_string_lossy().into())),
            Err(e) => fail(e.to_string()),
        }
    })
    .await
}

/// Cached hub events (bundled copy otherwise) are part of hub_data_*; this only reports which
/// TMLoader server a mod comes from, for pack exports.
#[tauri::command]
pub async fn mod_servers(app: tauri::AppHandle) -> Value {
    crate::bg::run(move || -> Value {
        let st = tauri::Manager::state::<AppState>(&app);
        let raw = st.raw_index.lock().unwrap();
        json!(raw.servers)
    })
    .await
}

fn with_dirs(st: &AppState, games: &[String]) -> Vec<(String, Option<PathBuf>)> {
    games.iter().map(|g| (g.clone(), st.install_dir(g))).collect()
}

/// Where a caught download would go for each of `games` (for the "Install into" dialog).
#[tauri::command(async)]
pub async fn download_targets(app: AppHandle, path: String, kind: String, games: Vec<String>) -> Result<Vec<crate::web::CopyTarget>, String> {
    blocking(&app, move |st| crate::web::copy_targets(Path::new(&path), &kind, &with_dirs(st, &games), &platform::documents_dir().unwrap_or_default())).await
}

/// Copies a caught download into more games' folders.
#[tauri::command(async)]
pub async fn download_copy(app: AppHandle, path: String, kind: String, games: Vec<String>) -> Result<Vec<(String, String)>, String> {
    blocking(&app, move |st| {
        let routed = st.routed.lock().unwrap().clone();
        crate::web::copy_to(Path::new(&path), &kind, &with_dirs(st, &games), &platform::documents_dir().unwrap_or_default(), &routed)
    })
    .await?
}

/// Icon of a site in the embedded browser's switcher (fetched once, cached).
#[tauri::command(async)]
pub async fn site_icon(app: AppHandle, host: String) -> Result<String, String> {
    blocking(&app, move |st| crate::web::site_icon(&st.cache_dir, &host)).await?
}

/// The embedded view went to another listed site by itself: keep game and site in step.
#[tauri::command(async)]
pub fn web_follow(app: AppHandle, game: String, site: String) -> Result<(), String> {
    crate::web::follow(&app, &game, &site)
}

/// Quick reachability check of the page the embedded view is about to show (reason class + status).
#[tauri::command(async)]
pub async fn web_check(mode: String, url: String) -> Result<crate::web::WebCheck, String> {
    tauri::async_runtime::spawn_blocking(move || crate::web::check(&mode, &url)).await.map_err(|e| e.to_string())
}

/// Openplanet's public plugin list (cached for a day).
#[tauri::command(async)]
pub async fn op_catalog(app: AppHandle, force: bool) -> Result<Vec<openplanet::OpPlugin>, String> {
    blocking(&app, move |st| openplanet::catalog(&st.cache_dir, force)).await?
}

/// Plugins installed for a game, and whether Openplanet's folder exists at all.
#[tauri::command]
pub async fn op_installed(game: String) -> serde_json::Value {
    crate::bg::run(move || -> serde_json::Value {
        let dir = openplanet::plugin_dir(&openplanet::user_root(), &game);
        let root = dir.as_ref().and_then(|d| d.parent().map(|p| p.to_path_buf()));
        json!({
            "openplanet": root.as_deref().map(fsx::is_dir).unwrap_or(false),
            "dir": dir.as_ref().map(|d| d.to_string_lossy().to_string()),
            "plugins": dir.as_deref().map(openplanet::installed).unwrap_or_default(),
        })
    })
    .await
}

/// Installs one plugin (its .op from cdn.openplanet.dev) into the game's Openplanet Plugins folder.
#[tauri::command(async)]
pub async fn op_install(app: AppHandle, game: String, id: u64) -> ActionResult {
    let r = blocking(&app, move |st| {
        let list = openplanet::catalog(&st.cache_dir, false)?;
        let p = list.into_iter().find(|p| p.id == id).ok_or("Plugin not found")?;
        let watch = openplanet::plugin_dir(&openplanet::user_root(), &game).map(|d| vec![crate::history::Watch::Shallow(d)]).unwrap_or_default();
        let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "openplanet", &p.name), watch);
        openplanet::install(&openplanet::user_root(), &game, &p).map(|d| (p.name, d))
    })
    .await;
    match r {
        Ok(Ok((name, dest))) => ok(format!("{name} installed. Restart the game or reload plugins in Openplanet."), Some(dest.to_string_lossy().into())),
        Ok(Err(e)) | Err(e) => fail(e),
    }
}

/// Removes an installed plugin's .op from the game's Openplanet Plugins folder (with an undo entry).
#[tauri::command(async)]
pub async fn op_remove(app: AppHandle, game: String, identifier: String) -> ActionResult {
    let r = blocking(&app, move |st| {
        let watch = openplanet::plugin_dir(&openplanet::user_root(), &game).map(|d| vec![crate::history::Watch::Shallow(d)]).unwrap_or_default();
        let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "openplanet", &identifier), watch);
        openplanet::remove(&openplanet::user_root(), &game, &identifier)
    })
    .await;
    match r {
        Ok(Ok(p)) => ok("Removed. Restart the game or reload plugins in Openplanet.", Some(p.to_string_lossy().into())),
        Ok(Err(e)) | Err(e) => fail(e),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImgCacheInfo {
    pub bytes: u64,
    pub files: u32,
    pub max: u64,
}

/// Size of the picture cache (Settings).
#[tauri::command]
pub async fn img_cache_info(app: AppHandle) -> Result<ImgCacheInfo, String> {
    let (bytes, files) = blocking(&app, |st| crate::imgcache::usage(&st.cache_dir)).await?;
    Ok(ImgCacheInfo { bytes, files, max: crate::imgcache::MAX_TOTAL })
}

/// Empties the picture cache (Settings); pictures are fetched again when shown.
#[tauri::command]
pub async fn img_cache_clear(app: AppHandle) -> Result<ImgCacheInfo, String> {
    blocking(&app, |st| crate::imgcache::clear(&st.cache_dir)).await?;
    img_cache_info(app).await
}

/// A remote picture as a local file (fetched once, kept in the cache), allowed for the asset protocol.
#[tauri::command(async)]
pub async fn cached_image(app: AppHandle, url: String) -> Result<String, String> {
    let a = app.clone();
    let p = blocking(&app, move |st| crate::imgcache::get(&st.cache_dir, &url)).await??;
    let _ = a.asset_protocol_scope().allow_file(&p);
    Ok(p.to_string_lossy().into())
}

/// A game's replay or map folder (the user's own, not only Downloaded). Forever's Nations and United
/// share Documents\TrackMania; ESWC and the old games keep them in their GameData folder.
pub fn game_folder(game: &str, kind: &str, docs: &Path, install: Option<&Path>) -> Option<PathBuf> {
    use crate::launch::Family;
    let replays = kind == "replays";
    Some(match crate::launch::family(game)? {
        Family::Forever => docs.join("TrackMania").join("Tracks").join(if replays { "Replays" } else { "Challenges" }),
        Family::ManiaPlanet => docs.join("ManiaPlanet").join(if replays { "Replays" } else { "Maps" }),
        Family::Tm2020 => crate::maps::tm2020_user_dir(docs).join(if replays { "Replays" } else { "Maps" }),
        Family::Eswc | Family::Legacy | Family::Classic => install?.join("GameData").join("Tracks").join(if replays { "Replays" } else { "Challenges" }),
        Family::Turbo | Family::Console => return None,
    })
}

/// Opens a game's replay or map folder in Explorer (only when it exists; nothing is created).
#[tauri::command]
pub async fn open_game_folder(app: AppHandle, game: String, kind: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        let docs = platform::documents_dir().unwrap_or_default();
        let Some(dir) = game_folder(&game, &kind, &docs, st.install_dir(&game).as_deref()) else { return fail("No folder for this game") };
        if !fsx::is_dir(&dir) || fsx::blocked(&dir) {
            return fail(format!("Not found: {}", dir.display()));
        }
        match app.opener().open_path(dir.to_string_lossy(), None::<&str>) {
            Ok(()) => ok("Opened", Some(dir.to_string_lossy().into())),
            Err(e) => fail(e.to_string()),
        }
    })
    .await
}

#[cfg(test)]
mod folder_tests {
    use super::*;

    #[test]
    fn replay_and_map_folders_per_game() {
        let docs = Path::new("D");
        assert_eq!(game_folder("tmnf", "replays", docs, None), game_folder("tmuf", "replays", docs, None), "Nations and United share one folder");
        assert!(game_folder("tm2-canyon", "maps", docs, None).unwrap().ends_with("ManiaPlanet/Maps"));
        assert_eq!(game_folder("tmn-eswc", "replays", docs, None), None, "ESWC needs its install folder");
        assert!(game_folder("tmn-eswc", "replays", docs, Some(Path::new("E"))).unwrap().ends_with("GameData/Tracks/Replays"));
    }
}

/// Proxy-DLL mods next to a game's exe (read-only; ESWC and the old games).
#[tauri::command]
pub async fn proxy_mods(app: AppHandle, game: String) -> crate::proxymods::ProxyScan {
    crate::bg::run(move || -> crate::proxymods::ProxyScan {
        let st = app.state::<AppState>();
        st.install_dir(&game).map(|d| crate::proxymods::scan_dir(&d)).unwrap_or_default()
    })
    .await
}

// ---------------------------------------------------------------- ESWC proxy-DLL mods

fn eswc_dir(st: &AppState) -> Result<PathBuf, String> {
    st.install_dir("tmn-eswc").ok_or_else(|| "Nations ESWC not found".to_string())
}
fn eswc_backup_root(st: &AppState) -> PathBuf {
    st.data_dir.join("TM Horizon backups").join("eswc")
}

/// Downloads the latest release of an ESWC mod and says which files it would add or replace.
#[tauri::command]
pub async fn eswc_mod_prepare(app: tauri::AppHandle, mod_id: String) -> Result<crate::eswcmods::Plan, String> {
    crate::bg::run(move || -> Result<crate::eswcmods::Plan, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        crate::eswcmods::prepare(&eswc_dir(&st)?, &eswc_backup_root(&st), &mod_id)
    })
    .await
}

/// Writes the prepared files (after the user confirmed the list). Backup first.
#[tauri::command]
pub async fn eswc_mod_apply(app: tauri::AppHandle, mod_id: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        let _history = eswc_dir(&st).ok().map(|d| crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmn-eswc", "mod-install", &mod_id), crate::eswcmods::watches(&d)));
        match eswc_dir(&st).and_then(|d| crate::eswcmods::apply(&d, &eswc_backup_root(&st), &mod_id)) {
            Ok(m) => ok(m, None),
            Err(e) => fail(e),
        }
    })
    .await
}

#[tauri::command]
pub async fn eswc_mod_remove(app: tauri::AppHandle, mod_id: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        let _history = eswc_dir(&st).ok().map(|d| crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmn-eswc", "mod-remove", &mod_id), crate::eswcmods::watches(&d)));
        match eswc_dir(&st).and_then(|d| crate::eswcmods::remove(&d, &eswc_backup_root(&st), &mod_id)) {
            Ok(m) => ok(m, None),
            Err(e) => fail(e),
        }
    })
    .await
}

#[tauri::command]
pub async fn eswc_backups(app: tauri::AppHandle) -> Vec<crate::eswcmods::Backup> {
    crate::bg::run(move || -> Vec<crate::eswcmods::Backup> {
        let st = tauri::Manager::state::<AppState>(&app);
        crate::eswcmods::list_backups(&eswc_backup_root(&st))
    })
    .await
}

#[tauri::command]
pub async fn eswc_restore(app: tauri::AppHandle, id: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        let _history = eswc_dir(&st).ok().map(|d| crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmn-eswc", "mod-restore", &id), crate::eswcmods::watches(&d)));
        match eswc_dir(&st).and_then(|d| crate::eswcmods::restore(&d, &eswc_backup_root(&st), &id)) {
            Ok(m) => ok(m, None),
            Err(e) => fail(e),
        }
    })
    .await
}

// ---------------------------------------------------------------- catalog mods (installSpec)

/// `target` is a game id, or `<game>@<instance id>` for a profile's separate installation: then
/// game files go into the instance folder and Forever's Documents files into its own user folder.
fn catalog_root(st: &AppState, spec: &crate::catalogmods::InstallSpec, target: &str) -> Result<PathBuf, String> {
    catalog_root_in(st, spec, target, None).map(|(r, _)| r)
}

/// (target folder, the game's own folder). `dir`: one of the game's other install folders (the copy
/// picker of the install dialog); it must be a scanned install of that game.
fn catalog_root_in(st: &AppState, spec: &crate::catalogmods::InstallSpec, target: &str, dir: Option<&str>) -> Result<(PathBuf, PathBuf), String> {
    let (game, instance) = crate::instances::split_target(target);
    let picked = match dir.filter(|d| !d.trim().is_empty()) {
        Some(d) if instance.is_none() => Some(
            crate::horizoncmds::installs_of(st, game).into_iter().map(|i| PathBuf::from(i.path)).find(|p| crate::fsx::norm(p) == crate::fsx::norm(Path::new(d))).ok_or("This folder is not one of the game's installs")?,
        ),
        _ => None,
    };
    let root = catalog_root_base(st, spec, target, picked.as_deref())?;
    let game_dir = match (&picked, instance) {
        (Some(p), _) => p.clone(),
        (None, Some(id)) => PathBuf::from(crate::instances::get(&st.data_dir, id)?.path),
        (None, None) => st.install_dir(game).unwrap_or_else(|| root.clone()),
    };
    Ok((root, game_dir))
}

fn catalog_root_base(st: &AppState, spec: &crate::catalogmods::InstallSpec, target: &str, picked: Option<&Path>) -> Result<PathBuf, String> {
    let (game, instance) = crate::instances::split_target(target);
    if !spec.games.is_empty() && !spec.games.iter().any(|g| g == game) {
        return Err("This mod is not for that game".into());
    }
    if spec.kind == "tmloader-product" {
        let root = st.tmloader_root().ok_or("TMLoader not found")?;
        return Ok(tmloader::products_dir(&root));
    }
    let inst = match instance {
        Some(id) => {
            let i = crate::instances::get(&st.data_dir, id)?;
            if i.game != game && !(matches!(game, "tmnf" | "tmuf") && matches!(i.game.as_str(), "tmnf" | "tmuf")) {
                return Err("This installation is for another game".into());
            }
            Some(i)
        }
        None => None,
    };
    let game_dir = || match (&inst, picked) {
        (Some(i), _) => Ok(PathBuf::from(&i.path)),
        (None, Some(p)) => Ok(p.to_path_buf()),
        (None, None) => st.install_dir(game).ok_or_else(|| "Game not found".to_string()),
    };
    // Forever instance: UserSubDir=TrackMania_<id> (a folder name under Documents).
    let user_sub = inst.as_ref().and_then(|i| i.user_dir.clone()).filter(|d| !d.contains(['\\', '/', ':', '{'])).unwrap_or_else(|| "TrackMania".into());
    match spec.base.as_deref().unwrap_or("game") {
        "game" => game_dir(),
        "gamedata" => game_dir().map(|d| d.join("GameData")),
        "documents" if game == "tmnf" || game == "tmuf" => platform::documents_dir().map(|d| d.join(&user_sub)).ok_or_else(|| "Documents folder not found".to_string()),
        // TMInterface plugins (AngelScript) and scripts: Documents\TMInterface\Plugins / \Scripts.
        "tmi-plugins" if game == "tmnf" || game == "tmuf" => platform::documents_dir().map(|d| d.join("TMInterface").join("Plugins")).ok_or_else(|| "Documents folder not found".to_string()),
        "tmi-scripts" if game == "tmnf" || game == "tmuf" => platform::documents_dir().map(|d| d.join("TMInterface").join("Scripts")).ok_or_else(|| "Documents folder not found".to_string()),
        other => Err(format!("unknown target folder: {other}")),
    }
}

/// Downloads a catalog mod and lists what installing it would change (nothing is written yet).
#[tauri::command]
pub async fn catalog_mod_prepare(app: tauri::AppHandle, spec: crate::catalogmods::InstallSpec, entry_id: String, game: String, dir: Option<String>) -> Result<crate::catalogmods::Plan, String> {
    crate::bg::run(move || -> Result<crate::catalogmods::Plan, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let (root, game_dir) = catalog_root_in(&st, &spec, &game, dir.as_deref())?;
        crate::catalogmods::prepare_in(&spec, &entry_id, &game, &root, &game_dir, &st.data_dir)
    })
    .await
}

#[tauri::command]
pub async fn catalog_mod_apply(app: AppHandle, entry_id: String, game: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        let t0 = std::time::Instant::now();
        let (version, targets) = crate::catalogmods::staged_targets(&entry_id, &game);
        let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "mod-install", &entry_id).detail(version), targets);
        let r = crate::catalogmods::apply(&entry_id, &game, &st.data_dir);
        crate::perf::log(&st, "catalog-mod-install", t0.elapsed().as_millis());
        match r {
            Ok(m) => {
                crate::commands::refresh_tmloader(&st);
                ok(m, None)
            }
            Err(e) => fail(e),
        }
    })
    .await
}

#[tauri::command]
pub async fn catalog_mod_backups(app: tauri::AppHandle) -> Vec<crate::catalogmods::Backup> {
    crate::bg::run(move || -> Vec<crate::catalogmods::Backup> {
        let st = tauri::Manager::state::<AppState>(&app);
        crate::catalogmods::list_backups(&st.data_dir)
    })
    .await
}

#[tauri::command]
pub async fn catalog_mod_restore(app: AppHandle, id: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        let (game, targets) = crate::catalogmods::backup_targets(&id, &st.data_dir);
        let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "mod-restore", &id), targets);
        match crate::catalogmods::restore(&id, &st.data_dir) {
            Ok(m) => {
                crate::commands::refresh_tmloader(&st);
                ok(m, None)
            }
            Err(e) => fail(e),
        }
    })
    .await
}

// ---------------------------------------------------------------- updates for mods installed here

/// Why an update or rollback of a mod of `game` has to wait (a message), or None. Any TrackMania game counts;
/// an open TMLoader only for Forever mods, which can live in TMLoader's products folder.
fn any_game_running(game: &str) -> Option<String> {
    const EXES: [&str; 7] = ["tmforever.exe", "tmnationseswc.exe", "maniaplanet.exe", "trackmania.exe", "trackmaniaturbo.exe", "tmoriginal.exe", "tmsunrise.exe"];
    crate::optimize::close_first(&platform::running_process_names(), &EXES, matches!(game, "tmnf" | "tmuf"))
}

#[tauri::command]
pub async fn mod_installs(app: tauri::AppHandle) -> Vec<crate::updates::InstallRecord> {
    crate::bg::run(move || -> Vec<crate::updates::InstallRecord> {
        let st = tauri::Manager::state::<AppState>(&app);
        crate::updates::list(&st.data_dir)
    })
    .await
}

#[tauri::command]
pub async fn mod_updates_check(app: tauri::AppHandle, use_hub: Option<bool>) -> Vec<crate::updates::UpdateInfo> {
    crate::bg::run(move || -> Vec<crate::updates::UpdateInfo> {
        let st = tauri::Manager::state::<AppState>(&app);
        // The hub index only counts when it still verifies against the built-in keys.
        let hub = if use_hub.unwrap_or(false) {
            crate::hubindex::cached(&st.data_dir, &crate::hubindex::pinned_keys(), crate::hubindex::now_secs()).and_then(|r| r.ok()).map(|r| r.payload)
        } else {
            None
        };
        let list = crate::updates::check(&st.data_dir, &st.cache_dir, hub.as_ref());
        crate::clientbridge::notify_updates(&list);
        list
    })
    .await
}

#[tauri::command]
pub async fn mod_set_auto(app: tauri::AppHandle, entry_id: String, game: String, on: bool) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = tauri::Manager::state::<AppState>(&app);
        match crate::updates::set_auto(&st.data_dir, &entry_id, &game, on) {
            Ok(()) => ok(if on { "Auto-update on" } else { "Auto-update off" }, None),
            Err(e) => fail(e),
        }
    })
    .await
}

/// Updates one recorded mod: download, verify, back up, write (the old files stay restorable).
#[tauri::command]
pub async fn mod_update(app: AppHandle, entry_id: String, game: String, spec: Option<crate::catalogmods::InstallSpec>) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        if let Some(m) = any_game_running(&game) {
            return fail(m);
        }
        let Some(rec) = crate::updates::list(&st.data_dir).into_iter().find(|r| r.entry_id == entry_id && r.game == game) else { return fail("Not installed by TM Horizon") };
        let r = match rec.kind.as_str() {
            "eswc" => eswc_dir(&st).and_then(|d| {
                crate::eswcmods::prepare(&d, &eswc_backup_root(&st), &entry_id)?;
                let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game("tmn-eswc", "mod-update", &entry_id), crate::eswcmods::watches(&d));
                crate::eswcmods::apply(&d, &eswc_backup_root(&st), &entry_id)
            }),
            _ => (|| {
                // Hub projects: the caller passes the current spec (new file URL and sha256); else the recorded one.
                let spec: crate::catalogmods::InstallSpec = match spec {
                    Some(s) => s,
                    None => serde_json::from_value(rec.spec.clone().ok_or("no install spec recorded")?).map_err(|e| e.to_string())?,
                };
                let root = catalog_root(&st, &spec, &game)?;
                crate::catalogmods::prepare(&spec, &entry_id, &game, &root, &st.data_dir)?;
                let (version, targets) = crate::catalogmods::staged_targets(&entry_id, &game);
                let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "mod-update", &entry_id).detail(version), targets);
                crate::catalogmods::apply(&entry_id, &game, &st.data_dir)
            })(),
        };
        match r {
            Ok(m) => {
                crate::commands::refresh_tmloader(&st);
                ok(m, None)
            }
            Err(e) => fail(e),
        }
    })
    .await
}

/// Puts back what the last install or update replaced and removes what it added.
#[tauri::command]
pub async fn mod_rollback(app: AppHandle, entry_id: String, game: String) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        if let Some(m) = any_game_running(&game) {
            return fail(m);
        }
        let Some(rec) = crate::updates::list(&st.data_dir).into_iter().find(|r| r.entry_id == entry_id && r.game == game) else { return fail("Not installed by TM Horizon") };
        let Some(id) = rec.backup_id.clone() else { return fail("Nothing to roll back to (the install replaced no files)") };
        let watches = match rec.kind.as_str() {
            "eswc" => eswc_dir(&st).map(|d| crate::eswcmods::watches(&d)).unwrap_or_default(),
            _ => crate::catalogmods::backup_targets(&id, &st.data_dir).1,
        };
        let history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::for_game(&game, "mod-rollback", &entry_id), watches);
        let r = match rec.kind.as_str() {
            "eswc" => eswc_dir(&st).and_then(|d| crate::eswcmods::restore(&d, &eswc_backup_root(&st), &id)),
            _ => crate::catalogmods::restore(&id, &st.data_dir),
        };
        history.finish();
        match r {
            Ok(m) => {
                let _ = crate::updates::forget(&st.data_dir, &entry_id, &game);
                crate::commands::refresh_tmloader(&st);
                ok(m, None)
            }
            Err(e) => fail(e),
        }
    })
    .await
}
