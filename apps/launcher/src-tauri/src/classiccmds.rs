//! Commands for the classic games: console games through emulators (consoles.rs), the Steam fix for
//! Nations/United Forever (steamfix.rs) and the "Recommended for your game" card (suggest.rs).
//! Nothing here runs without a click in the UI; nothing writes into a game folder except the Steam
//! fix (Nadeo.ini with backup and History, Nadeo's own update) and the Highlands ZIP (History).

use crate::consoles::{self, ConsoleSettings, Emu};
use crate::state::AppState;
use crate::{commands, fsx, platform, scan, steamfix, suggest};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

/// Fills the console games into a fresh scan result (called by `commands::do_scan`).
pub fn add_console_installs(snap: &mut scan::Snapshot, data: &Path, s: &ConsoleSettings) {
    let mut m = consoles::installs(data, s);
    let mut take = |id: &str| scan::Installs { installs: m.remove(id).unwrap_or_default() };
    snap.games.ds = take("tm-ds");
    snap.games.turbo_ds = take("tm-turbo-ds");
    snap.games.wii = take("tm-wii");
}

fn running(names: &[&str]) -> Option<String> {
    let r = platform::running_process_names();
    names.iter().find(|n| r.iter().any(|p| p.eq_ignore_ascii_case(n))).map(|n| n.to_string())
}

// ------------------------------------------------------------------ consoles

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleGameStatus {
    pub game: &'static consoles::ConsoleGame,
    pub dump: Option<consoles::DumpInfo>,
    /// The saved dump path is gone or no longer readable.
    pub dump_error: Option<String>,
    pub textures_dir: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleStatus {
    pub games: Vec<ConsoleGameStatus>,
    pub dolphin: consoles::EmuStatus,
    pub melonds: consoles::EmuStatus,
    pub resolution: u8,
    pub textures: bool,
}

/// Dolphin's custom texture folder for a game id: `<user>\Load\Textures\<id>` (portable Dolphin: its
/// own `User` folder; else `Documents\Dolphin Emulator`).
fn textures_dir(dolphin: &consoles::EmuStatus, id: &str) -> Option<PathBuf> {
    let exe = PathBuf::from(dolphin.exe.as_ref()?);
    let dir = exe.parent()?;
    let user = if dir.join("portable.txt").is_file() { dir.join("User") } else { platform::documents_dir()?.join("Dolphin Emulator") };
    Some(user.join("Load").join("Textures").join(id))
}

fn console_status_of(st: &AppState) -> ConsoleStatus {
    let s = st.settings().consoles;
    let dolphin = consoles::emulator(&st.data_dir, &s, Emu::Dolphin, true);
    let melonds = consoles::emulator(&st.data_dir, &s, Emu::MelonDs, true);
    let games = consoles::GAMES
        .iter()
        .map(|g| {
            let (dump, dump_error) = match s.dumps.get(g.id) {
                None => (None, None),
                Some(p) => match consoles::check_dump(g.id, Path::new(p)) {
                    Ok(d) => (Some(d), None),
                    Err(e) => (None, Some(format!("{p}: {e}"))),
                },
            };
            let textures_dir = match (&dump, g.emu) {
                (Some(d), Emu::Dolphin) => textures_dir(&dolphin, &d.code).map(|p| p.to_string_lossy().into_owned()),
                _ => None,
            };
            ConsoleGameStatus { game: g, dump, dump_error, textures_dir }
        })
        .collect();
    ConsoleStatus { games, dolphin, melonds, resolution: s.dolphin_resolution, textures: s.dolphin_textures }
}

#[tauri::command]
pub async fn console_status(app: tauri::AppHandle) -> ConsoleStatus {
    crate::bg::run(move || -> ConsoleStatus {
        let st = tauri::Manager::state::<AppState>(&app);
        console_status_of(&st)
    })
    .await
}

/// Downloads and unpacks the emulator (official release, pinned SHA-256) into the launcher's data.
#[tauri::command]
pub async fn console_emulator_install(app: AppHandle, emu: String) -> Result<String, String> {
    let emu = Emu::from_key(&emu).ok_or("Unknown emulator")?;
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let exe = consoles::install(&st.data_dir, emu, &crate::hosting::deps::http_fetch)?;
        commands::do_scan(&st);
        Ok(exe.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Choose Dolphin.exe / melonDS.exe": an existing install.
#[tauri::command]
pub async fn console_emulator_pick(app: AppHandle, emu: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let emu = Emu::from_key(&emu).ok_or("Unknown emulator")?;
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || a.dialog().file().set_title(emu.exe()).add_filter(emu.name(), &["exe"]).blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    if !consoles::exe_name_ok(emu, &p) {
        return Err(format!("Pick {} (the emulator's own exe).", emu.exe()));
    }
    let st = app.state::<AppState>();
    let v = p.to_string_lossy().into_owned();
    st.update_settings(|s| match emu {
        Emu::Dolphin => s.consoles.dolphin_exe = Some(v.clone()),
        Emu::MelonDs => s.consoles.melonds_exe = Some(v.clone()),
    })?;
    commands::do_scan(&st);
    Ok(Some(v))
}

/// Forget a picked emulator (the downloaded or found one is used again).
#[tauri::command(async)]
pub fn console_emulator_forget(st: State<AppState>, emu: String) -> Result<(), String> {
    let emu = Emu::from_key(&emu).ok_or("Unknown emulator")?;
    st.update_settings(|s| match emu {
        Emu::Dolphin => s.consoles.dolphin_exe = None,
        Emu::MelonDs => s.consoles.melonds_exe = None,
    })?;
    commands::do_scan(&st);
    Ok(())
}

/// Picks the player's dump of `game`, checks its header and remembers it.
#[tauri::command]
pub async fn console_dump_pick(app: AppHandle, game: String) -> Result<Option<consoles::DumpInfo>, String> {
    use tauri_plugin_dialog::DialogExt;
    let g = consoles::game(&game).ok_or("Not a console game")?;
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || a.dialog().file().set_title(g.name).add_filter(g.name, g.extensions).blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let d = consoles::check_dump(&game, &p)?;
    let st = app.state::<AppState>();
    st.update_settings(|s| {
        s.consoles.dumps.insert(game.clone(), d.path.clone());
    })?;
    commands::do_scan(&st);
    Ok(Some(d))
}

#[tauri::command(async)]
pub fn console_dump_clear(st: State<AppState>, game: String) -> Result<(), String> {
    st.update_settings(|s| {
        s.consoles.dumps.remove(&game);
    })?;
    commands::do_scan(&st);
    Ok(())
}

/// Dolphin options (applied per start with `-C`, Dolphin's own settings stay as they are).
#[tauri::command]
pub async fn console_options(app: tauri::AppHandle, resolution: u8, textures: bool) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if resolution > 8 {
            return Err("Resolution 0-8".into());
        }
        st.update_settings(|s| {
            s.consoles.dolphin_resolution = resolution;
            s.consoles.dolphin_textures = textures;
        })?;
        commands::do_scan(&st);
        Ok(())
    })
    .await
}

/// Creates (on this click) and opens Dolphin's texture folder for the game.
#[tauri::command(async)]
pub fn console_textures_folder(app: AppHandle, st: State<AppState>, game: String) -> Result<String, String> {
    let status = console_status_of(&st);
    let dir = status.games.into_iter().find(|g| g.game.id == game).and_then(|g| g.textures_dir).ok_or("Pick Dolphin and the game file first")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(&dir, None::<&str>).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ------------------------------------------------------------------ Steam fix

fn forever_dir(st: &AppState, game: &str) -> Result<PathBuf, String> {
    if game != "tmnf" && game != "tmuf" {
        return Err("Only for Nations and United Forever".into());
    }
    let dir = st.install_dir(game).ok_or("Not installed")?;
    if fsx::blocked(&dir) {
        return Err("Refusing this folder".into());
    }
    Ok(dir)
}

fn setups_dir(st: &AppState) -> PathBuf {
    st.cache_dir.join("setups")
}

#[tauri::command]
pub async fn steamfix_status(app: tauri::AppHandle, game: String) -> Result<steamfix::Status, String> {
    crate::bg::run(move || -> Result<steamfix::Status, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let dir = forever_dir(&st, &game)?;
        Ok(steamfix::status(&dir, &setups_dir(&st)))
    })
    .await
}

/// Step 1: Distro=MILIN in Nadeo.ini (backup next to it + History entry).
#[tauri::command(async)]
pub fn steamfix_apply_ini(st: State<AppState>, game: String) -> Result<steamfix::Status, String> {
    let dir = forever_dir(&st, &game)?;
    if !steamfix::is_steam_install(&dir) {
        return Err("Only for Steam installs".into());
    }
    if let Some(p) = running(&["tmforever.exe", "tmloader.exe"]) {
        return Err(format!("Close the game first ({p} is running)."));
    }
    let watches = vec![crate::history::Watch::File(dir.join("Nadeo.ini")), crate::history::Watch::File(dir.join(steamfix::BACKUP_NAME))];
    crate::history::record(&st.data_dir, crate::history::Op::for_game(&game, "steam-fix", "Nadeo.ini").detail("Distro=MILIN"), watches, || steamfix::apply_ini(&dir))?;
    Ok(steamfix::status(&dir, &setups_dir(&st)))
}

#[tauri::command(async)]
pub fn steamfix_undo_ini(st: State<AppState>, game: String) -> Result<steamfix::Status, String> {
    let dir = forever_dir(&st, &game)?;
    if let Some(p) = running(&["tmforever.exe", "tmloader.exe"]) {
        return Err(format!("Close the game first ({p} is running)."));
    }
    steamfix::undo_ini(&dir)?;
    Ok(steamfix::status(&dir, &setups_dir(&st)))
}

/// Step 2a: downloads Nadeo's update (only on this click) and checks size + SHA-256.
#[tauri::command]
pub async fn steamfix_download(app: AppHandle, game: String) -> Result<steamfix::Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let dir = forever_dir(&st, &game)?;
        let a = app.clone();
        steamfix::download_update(&setups_dir(&st), &crate::gameinstall::HttpFetch, &mut |got, total| {
            let _ = a.emit("steamfix-download", json!({ "game": game, "received": got, "total": total }));
        })?;
        Ok(steamfix::status(&dir, &setups_dir(&st)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Step 2b: runs the checked update silently into the game folder; rescans when it exits.
#[tauri::command]
pub async fn steamfix_run(app: AppHandle, game: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let dir = forever_dir(&st, &game)?;
        if !steamfix::is_steam_install(&dir) {
            return Err("Only for Steam installs".into());
        }
        if let Some(p) = running(&["tmforever.exe", "tmloader.exe"]) {
            return Err(format!("Close the game first ({p} is running)."));
        }
        let exe = setups_dir(&st).join(steamfix::UPDATE_FILE);
        // Checked again right before it runs.
        steamfix::verify_file(&exe, steamfix::UPDATE_SHA256, steamfix::UPDATE_SIZE).map_err(|e| format!("Download the update again: {e}"))?;
        let params = steamfix::installer_params(&dir)?;
        let a = app.clone();
        std::thread::spawn(move || {
            let code = platform::run_setup_and_wait_args(&exe, &params, exe.parent());
            let snap = commands::do_scan(&a.state::<AppState>());
            let _ = a.emit("steamfix-done", json!({ "game": game, "code": code.as_ref().ok(), "error": code.err().map(|e| e.to_string()), "snapshot": snap }));
        });
        Ok(())
    })
    .await
}

// ------------------------------------------------------------------ suggestions / Highlands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlandsInfo {
    pub spec: suggest::ZipSpec,
    pub downloads: Option<String>,
    pub found: Vec<String>,
}

/// The catalog's expected file and the matching ZIPs in Downloads changed after `since_ms` (Unix ms).
#[tauri::command]
pub async fn highlands_info(since_ms: Option<u64>) -> HighlandsInfo {
    crate::bg::run(move || -> HighlandsInfo {
        let spec = suggest::highlands_spec();
        let dl = dirs::download_dir();
        let since = since_ms.map(|ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms));
        let found = dl.as_deref().map(|d| suggest::find_in(d, &spec, since)).unwrap_or_default();
        HighlandsInfo { spec, downloads: dl.map(|d| d.to_string_lossy().into_owned()), found: found.into_iter().map(|p| p.to_string_lossy().into_owned()).collect() }
    })
    .await
}

#[tauri::command]
pub async fn highlands_pick(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("TrackMania Highlands").add_filter("ZIP", &["zip"]).blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn highlands_check(path: String) -> Result<suggest::ZipCheck, String> {
    crate::bg::run(move || -> Result<suggest::ZipCheck, String> {
        suggest::check(Path::new(&path), &suggest::highlands_spec())
    })
    .await
}

/// Unpacks into the United Forever folder; returns the History entry (Undo there or on the card).
#[tauri::command]
pub async fn highlands_install(app: tauri::AppHandle, path: String, confirmed: bool) -> Result<Option<String>, String> {
    crate::bg::run(move || -> Result<Option<String>, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let dir = forever_dir(&st, "tmuf")?;
        if let Some(p) = running(&["tmforever.exe", "tmloader.exe"]) {
            return Err(format!("Close the game first ({p} is running)."));
        }
        suggest::install(&st.data_dir, "tmuf", &dir, Path::new(&path), &suggest::highlands_spec(), confirmed)
    })
    .await
}

/// Highlands in the United Forever folder: installed, switched on.
#[tauri::command]
pub async fn highlands_state(app: AppHandle) -> Option<suggest::HighlandsState> {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<AppState>(&app);
        forever_dir(&st, "tmuf").ok().map(|d| suggest::highlands_state(&d))
    })
    .await
}

/// Highlands on or off without uninstalling (renames its environment collection and car).
#[tauri::command]
pub async fn highlands_set_enabled(app: AppHandle, on: bool) -> Result<suggest::HighlandsState, String> {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<AppState>(&app);
        let dir = forever_dir(&st, "tmuf")?;
        if let Some(p) = running(&["tmforever.exe", "tmloader.exe"]) {
            return Err(format!("Close the game first ({p} is running)."));
        }
        suggest::highlands_set_enabled(&dir, on)
    })
    .await
}

/// Recommendations that are already done for this game ("highlands", "horizon", "steamfix"): the card
/// hides them. `profile` is the TMLoader profile that starts the game (Forever).
#[tauri::command(async)]
pub fn suggestions_done(st: State<AppState>, game: String, profile: Option<String>) -> Vec<String> {
    let dir = st.install_dir(&game);
    let mut out = vec![];
    if game == "tmuf" {
        if let Some(d) = &dir {
            let hist: Vec<crate::history::Change> = crate::history::list(&st.data_dir, Some("tmuf"), false).into_iter().map(|v| v.change).collect();
            if suggest::highlands_present(d, &hist) {
                out.push("highlands".to_string());
            }
        }
    }
    if ["tmnf", "tmuf", "tmn-eswc", "tm-sunrise", "tm-original"].contains(&game.as_str()) {
        let on: Vec<String> = if game == "tmnf" || game == "tmuf" {
            st.tmloader_root()
                .filter(|r| fsx::is_file(&r.join("config.yaml")))
                .map(|r| crate::tmloader::read_info(&r).profiles.into_iter().filter(|p| p.mods.iter().any(|m| m.id == crate::horizonhost::format::TML_PRODUCT)).map(|p| p.name).collect())
                .unwrap_or_default()
        } else {
            vec![]
        };
        if suggest::horizon_on(&game, dir.as_deref(), &on, profile.as_deref()) {
            out.push("horizon".to_string());
        }
    }
    if let (true, Some(d)) = (game == "tmnf" || game == "tmuf", &dir) {
        if crate::steamfix::status(d, &st.cache_dir).ini_fixed {
            out.push("steamfix".to_string());
        }
    }
    out
}

/// Hides one recommendation ("<game>:<item>") for good.
#[tauri::command(async)]
pub fn suggestion_dismiss(st: State<AppState>, key: String) -> Result<Vec<String>, String> {
    let s = st.update_settings(|s| {
        if !s.suggestions_dismissed.contains(&key) {
            s.suggestions_dismissed.push(key.clone());
        }
    })?;
    Ok(s.suggestions_dismissed)
}
