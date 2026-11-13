//! Tauri commands for the "Eigener Server" page, the tray and the close question.

use super::*;
use crate::state::AppState;
use serde::Deserialize;
use tauri::{AppHandle, Manager as _, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRow {
    pub def: ServerDef,
    pub run: RunInfo,
    /// A process from an earlier launcher run still runs (PID file + same program).
    pub leftover: bool,
    pub has_account: bool,
    pub has_token: bool,
    /// Entries the migration took off the map list (replays and other non-maps), for a notice.
    pub dropped: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub kinds: Vec<kinds::GameServerKind>,
    pub servers: Vec<ServerRow>,
    pub randomizer_repo: &'static str,
    pub platform: &'static str,
}

#[tauri::command]
pub async fn host_overview(app: tauri::AppHandle) -> Overview {
    crate::bg::run(move || -> Overview {
        let st = tauri::Manager::state::<AppState>(&app);
        let store = secrets::Store::default_for(&st.data_dir);
        let servers = load_all(&st.data_dir)
            .into_iter()
            .map(|def| {
                let run = mgr().info(&def.id);
                let leftover = run.state == "stopped" && procs::check_leftover(procs::read_pid(&server_dir(&st.data_dir, &def.id)).as_ref(), &procs::process_name) == procs::Leftover::Alive;
                let has_account = store.get(&def.id, secrets::ACCOUNT).is_some_and(|s| !s.is_empty());
                let has_token = store.get(&def.id, secrets::HUB_TOKEN).is_some_and(|s| !s.is_empty());
                let dropped = mgr().notices.lock().unwrap().get(&def.id).cloned().unwrap_or_default();
                ServerRow { def, run, leftover, has_account, has_token, dropped }
            })
            .collect();
        Overview { kinds: kinds::KINDS.to_vec(), servers, randomizer_repo: deps::RANDOMIZER_REPO, platform: if cfg!(windows) { "windows" } else { "linux" } }
    })
    .await
}

/// A new, unsaved server with free ports and an id.
#[tauri::command(async)]
pub fn host_new(st: State<AppState>, game: String) -> Result<ServerDef, String> {
    let k = kinds::kind(&game).ok_or("host.err.game")?;
    let all = load_all(&st.data_dir);
    let ports = config::pick_ports(&taken_ports(&all, ""), &config::port_free).ok_or("host.err.noPorts")?;
    let mut d = ServerDef { id: new_id(), game: k.id.into(), ports, ..Default::default() };
    d.randomizer.web_port = (8090u16..8190).find(|p| !taken_ports(&all, "").contains(p) && config::port_free(*p, false)).unwrap_or(8090);
    Ok(d)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsIn {
    /// Server account password; Some("") deletes it.
    pub account: Option<String>,
    /// Hub announce token (tmhs_...); Some("") deletes it.
    pub hub_token: Option<String>,
}

#[tauri::command]
pub async fn host_save(app: tauri::AppHandle, def: ServerDef, secrets_in: Option<SecretsIn>) -> Result<ServerDef, String> {
    crate::bg::run(move || -> Result<ServerDef, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let mut d = def;
        if d.id.is_empty() {
            d.id = new_id();
        }
        if !valid_id(&d.id) {
            return Err("bad id".into());
        }
        vet_maps(&mut d)?;
        model::validate(&d)?;
        let all = load_all(&st.data_dir);
        let taken = taken_ports(&all, &d.id);
        if [d.ports.game, d.ports.p2p, d.ports.xmlrpc].iter().any(|p| taken.contains(p)) {
            return Err("host.err.portsTaken".into());
        }
        let store = secrets::Store::default_for(&st.data_dir);
        if let Some(s) = secrets_in {
            if let Some(a) = s.account {
                if a.is_empty() {
                    store.delete(&d.id, secrets::ACCOUNT);
                } else {
                    store.set(&d.id, secrets::ACCOUNT, &a)?;
                }
            }
            if let Some(t) = s.hub_token {
                let t = t.trim().to_string();
                if t.is_empty() {
                    store.delete(&d.id, secrets::HUB_TOKEN);
                } else if !t.starts_with("tmhs_") || t.len() > 90 || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                    return Err("host.err.token".into());
                } else {
                    store.set(&d.id, secrets::HUB_TOKEN, &t)?;
                }
            }
        }
        d.listing.has_token = store.get(&d.id, secrets::HUB_TOKEN).is_some_and(|s| !s.is_empty());
        if d.created.is_empty() {
            d.created = now_secs().to_string();
        }
        let old = load(&st.data_dir, &d.id);
        save(&st.data_dir, &d)?;
        mapfiles::prune_tmx(&server_dir(&st.data_dir, &d.id), &d.maps);
        // a running server takes list and slot changes at once
        if mgr().info(&d.id).state == "running" {
            if let Ok((mut c, _)) = rpc(&d.id) {
                if let Ok(live) = read_status(&mut c) {
                    sync_lists(&mut c, &d, &live);
                }
                let _ = engines::apply_live_options(&d, &mut c);
            }
        }
        if old.as_ref().map(|o| o.autostart) != Some(d.autostart) {
            apply_autostart(&st.data_dir)?;
        }
        Ok(d)
    })
    .await
}

/// Scheduled task on when any server wants it (also after the exe was renamed: datamigrate).
pub(crate) fn apply_autostart(data: &Path) -> Result<(), String> {
    let want = load_all(data).iter().any(|d| d.autostart);
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        autostart::apply(want, &exe, &servers_root(data).join("_tmp")).map_err(|e| format!("host.err.autostart:{e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = want;
        Ok(())
    }
}

#[tauri::command]
pub async fn host_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if !valid_id(&id) {
            return Err("bad id".into());
        }
        if matches!(mgr().info(&id).state.as_str(), "starting" | "running" | "stopping") {
            return Err("host.err.running".into());
        }
        let dir = server_dir(&st.data_dir, &id);
        if procs::check_leftover(procs::read_pid(&dir).as_ref(), &procs::process_name) == procs::Leftover::Alive {
            return Err("host.err.leftover".into());
        }
        secrets::Store::default_for(&st.data_dir).delete_server(&id);
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        mgr().run.lock().unwrap().remove(&id);
        apply_autostart(&st.data_dir)
    })
    .await
}

#[tauri::command]
pub async fn host_start(app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = tauri::Manager::state::<AppState>(&app);
        start(&st.data_dir, &id)
    })
    .await
}

#[tauri::command]
pub async fn host_stop(app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = tauri::Manager::state::<AppState>(&app);
        stop(&st.data_dir, &id)
    })
    .await
}

#[tauri::command(async)]
pub fn host_status(id: String) -> Result<LiveStatus, String> {
    status(&id)
}

#[tauri::command(async)]
pub fn host_player(id: String, action: String, login: String) -> Result<(), String> {
    let (mut c, _) = rpc(&id)?;
    player_action(&mut c, &action, &login)
}

/// Our console log plus the server's newest own log (ConsoleLog / GameLog).
#[tauri::command]
pub async fn host_log(app: tauri::AppHandle, id: String) -> Result<String, String> {
    crate::bg::run(move || -> Result<String, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if !valid_id(&id) {
            return Err("bad id".into());
        }
        let dir = server_dir(&st.data_dir, &id);
        let mut out = procs::tail(&dir.join("console.log"), 24_000);
        let plan_dir = mgr().run.lock().unwrap().get(&id).and_then(|r| r.plan.as_ref().map(|p| p.server_dir.clone()));
        let server_logs = plan_dir.unwrap_or_else(|| engines::dedicated_dir(&dir)).join("Logs");
        if let Ok(rd) = std::fs::read_dir(&server_logs) {
            let newest = rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".txt")).max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
            if let Some(e) = newest {
                out.push_str(&format!("\n----- {} -----\n", e.file_name().to_string_lossy()));
                out.push_str(&procs::tail(&e.path(), 24_000));
            }
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn host_leftover(app: tauri::AppHandle, id: String, action: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let dir = server_dir(&st.data_dir, &id);
        let Some(p) = procs::read_pid(&dir) else { return Ok(()) };
        match action.as_str() {
            "stop" => {
                procs::kill_leftover(&p)?;
                netops::upnp_unmap(&p.upnp);
                procs::clear_pid(&dir);
                Ok(())
            }
            // forget: the process keeps running on its own; the launcher no longer tracks it
            "forget" => {
                procs::clear_pid(&dir);
                Ok(())
            }
            _ => Err("unknown action".into()),
        }
    })
    .await
}

#[tauri::command(async)]
pub fn host_set_hub(url: String) {
    *mgr().hub_url.lock().unwrap() = if crate::hubindex::hub_url_ok(&url) { url } else { String::new() };
}

#[tauri::command]
pub async fn host_reach(app: tauri::AppHandle, id: String, hub: String) -> Result<netops::Reach, String> {
    crate::bg::run(move || -> Result<netops::Reach, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let d = load(&st.data_dir, &id).ok_or("host.err.unknown")?;
        let upnp = mgr().info(&id).upnp;
        match netops::hub_reach(&hub, d.ports.game) {
            Ok((ip, tcp)) => Ok(netops::verdict(Some(&ip), Some(&tcp), upnp.as_ref())),
            Err(e) if e == "too-often" => Err("host.err.tooOften".into()),
            Err(e) => {
                let mut r = netops::verdict(None, None, upnp.as_ref());
                r.detail = Some(e);
                Ok(r)
            }
        }
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallInfo {
    pub supported: bool,
    pub exists: bool,
    /// What runs in the UAC window, shown before the player confirms.
    pub command: String,
}

fn firewall_program(data: &Path, d: &ServerDef) -> Option<PathBuf> {
    let k = kinds::kind(&d.game)?;
    let dir = server_dir(data, &d.id);
    Some(match d.engine.as_str() {
        "randomizer" => engines::randomizer_server_dir(&dir.join("randomizer"), &d.game).join(k.exe()),
        _ => engines::dedicated_dir(&dir).join(k.exe()),
    })
}

fn firewall_calls(data: &Path, d: &ServerDef) -> Result<Vec<Vec<String>>, String> {
    let k = kinds::kind(&d.game).ok_or("host.err.game")?;
    let prog = firewall_program(data, d).ok_or("host.err.game")?;
    let p2p = (k.cfg_style != kinds::CfgStyle::Tm2020).then_some(d.ports.p2p);
    Ok(netops::firewall_add_args(&d.id, &prog.to_string_lossy(), d.ports.game, p2p))
}

#[tauri::command]
pub async fn host_firewall(app: tauri::AppHandle, id: String) -> Result<FirewallInfo, String> {
    crate::bg::run(move || -> Result<FirewallInfo, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let d = load(&st.data_dir, &id).ok_or("host.err.unknown")?;
        let calls = firewall_calls(&st.data_dir, &d)?;
        let command = calls.iter().map(|c| format!("netsh {}", c.join(" "))).collect::<Vec<_>>().join("\n");
        #[cfg(windows)]
        return Ok(FirewallInfo { supported: true, exists: netops::firewall_rule_exists(&id), command });
        #[cfg(not(windows))]
        Ok(FirewallInfo { supported: false, exists: false, command })
    })
    .await
}

/// Adds the rule in an elevated window. The player confirms the UAC prompt; nothing silent.
#[tauri::command]
pub async fn host_firewall_add(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    crate::bg::run(move || -> Result<bool, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let d = load(&st.data_dir, &id).ok_or("host.err.unknown")?;
        let line = netops::elevated_cmd_line(&firewall_calls(&st.data_dir, &d)?)?;
        #[cfg(windows)]
        {
            netops::run_elevated_cmd(&line).map_err(|e| if e == "cancelled" { "host.err.uacCancelled".to_string() } else { e })?;
            Ok(netops::firewall_rule_exists(&id))
        }
        #[cfg(not(windows))]
        {
            let _ = line;
            Err("Windows only".into())
        }
    })
    .await
}

/// Hub listing: only with consent (the public IP is shown) and only an address the self-test saw.
#[tauri::command]
pub async fn host_listing_submit(app: tauri::AppHandle, id: String, hub: String, contact: String, consent: bool) -> Result<ServerDef, String> {
    crate::bg::run(move || -> Result<ServerDef, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if !consent {
            return Err("host.err.consent".into());
        }
        let mut d = load(&st.data_dir, &id).ok_or("host.err.unknown")?;
        if !d.internet {
            return Err("host.err.lan".into());
        }
        let (ip, tcp) = netops::hub_reach(&hub, d.ports.game)?;
        if tcp != "open" {
            return Err("host.err.notReachable".into());
        }
        let game = match d.game.as_str() {
            g @ ("tmnf" | "tmuf" | "eswc" | "tms" | "tmo") => g,
            _ => return Err("host.err.listGame".into()),
        };
        let address = format!("{ip}:{}", d.ports.game);
        let name = crate::serverquery::strip_format(&d.name);
        let hub_id = netops::hub_submit(&hub, game, &address, name.trim(), contact.trim())?;
        d.listing.consent_at = Some(now_secs().to_string());
        d.listing.hub_id = Some(hub_id);
        d.listing.address = Some(address);
        save(&st.data_dir, &d)?;
        Ok(d)
    })
    .await
}

#[tauri::command]
pub async fn host_listing_withdraw(app: tauri::AppHandle, id: String) -> Result<ServerDef, String> {
    crate::bg::run(move || -> Result<ServerDef, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let mut d = load(&st.data_dir, &id).ok_or("host.err.unknown")?;
        d.listing = model::Listing::default();
        secrets::Store::default_for(&st.data_dir).delete(&id, secrets::HUB_TOKEN);
        save(&st.data_dir, &d)?;
        Ok(d)
    })
    .await
}

/// The player's maps (header facts, no thumbnails; non-maps left out).
#[tauri::command]
pub async fn host_local_maps(game: String) -> Vec<mapfiles::MapMeta> {
    crate::bg::run(move || -> Vec<mapfiles::MapMeta> {
        if kinds::kind(&game).is_none() {
            return vec![];
        }
        let Some(docs) = crate::platform::documents_dir() else { return vec![] };
        let Some(root) = maps_root(&game, &docs) else { return vec![] };
        mapfiles::list_maps(&root, 3000)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub maps: Vec<mapfiles::MapMeta>,
    /// File names that are not maps (replays, other .Gbx): not added.
    pub skipped: Vec<String>,
}

/// Map files from anywhere; only maps come back (the dialog filter is a hint, the class decides).
#[tauri::command]
pub async fn host_pick_maps(app: AppHandle) -> Result<Picked, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("Maps").add_filter("TrackMania maps", &["Challenge.Gbx", "Map.Gbx"]).blocking_pick_files())
        .await
        .map_err(|e| e.to_string())?;
    let paths: Vec<PathBuf> = picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut out = Picked { maps: vec![], skipped: vec![] };
        for p in paths {
            let folder = p.parent().and_then(|x| x.file_name()).map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
            match mapfiles::meta(&p, &folder) {
                Some(m) => out.maps.push(m),
                None => out.skipped.push(p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()),
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?)
}

/// The thumbnail embedded in a map file (data: URL, upside down as TrackMania stores it).
#[tauri::command]
pub async fn host_map_thumb(path: String) -> Option<String> {
    crate::bg::run(move || -> Option<String> {
        mapfiles::map_name_ok(&path).then(|| mapfiles::thumbnail(Path::new(&path))).flatten()
    })
    .await
}

/// Header facts for the entries of a server's map list (TMX maps: the server's downloaded copy).
#[tauri::command]
pub async fn host_maps_meta(app: tauri::AppHandle, id: String, game: String, maps: Vec<model::MapRef>) -> Result<Vec<Option<mapfiles::MapMeta>>, String> {
    crate::bg::run(move || -> Result<Vec<Option<mapfiles::MapMeta>>, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if !valid_id(&id) {
            return Err("bad id".into());
        }
        let site = kinds::kind(&game).and_then(|k| k.tmx);
        let dir = server_dir(&st.data_dir, &id);
        Ok(maps
            .iter()
            .map(|m| {
                let f = mapfiles::file_of(&st.data_dir, &dir, site, m)?;
                let folder = match m {
                    model::MapRef::File { .. } => f.parent().and_then(|x| x.file_name()).map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(),
                    model::MapRef::Tmx { .. } => "TMX".into(),
                };
                mapfiles::meta(&f, &folder)
            })
            .collect())
    })
    .await
}

/// What a pasted TMX id, link, pack or search finds (network, rate limited).
#[tauri::command]
pub async fn host_tmx_preview(game: String, input: String) -> Result<tmx::Preview, String> {
    crate::bg::run(move || -> Result<tmx::Preview, String> {
        let k = kinds::kind(&game).ok_or("host.err.game")?;
        let site = k.tmx.ok_or("host.err.noTmx")?;
        tmx::preview_live(site, &input)
    })
    .await
}

/// Downloads TMX maps into the server's own folder (progress as "host-tmx-progress" events).
#[tauri::command]
pub async fn host_tmx_add(app: AppHandle, id: String, game: String, ids: Vec<u64>) -> Result<tmx::AddResult, String> {
    crate::bg::run(move || -> Result<tmx::AddResult, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        use tauri::Emitter;
        if !valid_id(&id) {
            return Err("bad id".into());
        }
        if ids.len() > tmx::MAX_LIST {
            return Err("host.err.tmxTooMany".into());
        }
        let k = kinds::kind(&game).ok_or("host.err.game")?;
        let site = k.tmx.ok_or("host.err.noTmx")?;
        let dir = server_dir(&st.data_dir, &id);
        let progress = |done: usize, total: usize| {
            let _ = app.emit("host-tmx-progress", serde_json::json!({ "id": id, "done": done, "total": total }));
        };
        Ok(tmx::add(&dir, site, &ids, &tmx::get_gbx, &progress))
    })
    .await
}

/// A new server's folder is dropped when its wizard is cancelled (TMX maps may already be in it).
#[tauri::command(async)]
pub fn host_discard(st: State<AppState>, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("bad id".into());
    }
    let dir = server_dir(&st.data_dir, &id);
    if dir.is_dir() && !dir.join("server.json").exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn host_dismiss_notice(id: String) {
    mgr().notices.lock().unwrap().remove(&id);
}

/// Players seen on this server (newest first) for the guest/ban lists.
#[tauri::command(async)]
pub fn host_seen(st: State<AppState>, id: String) -> Result<Vec<players::Seen>, String> {
    if !valid_id(&id) {
        return Err("bad id".into());
    }
    Ok(players::load(&server_dir(&st.data_dir, &id)))
}

fn script_style(d: &ServerDef) -> bool {
    kinds::kind(&d.game).is_some_and(|k| k.match_style == kinds::MatchStyle::Script)
}

/// Everything the console tab shows, in one go.
#[tauri::command(async)]
pub fn host_console(id: String) -> Result<console::ConsoleState, String> {
    let (mut c, d) = rpc(&id)?;
    let st = console::read(&mut c, script_style(&d))?;
    record_seen(&id, &st.live);
    Ok(st)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleIn {
    /// "kick" | "ban" | "unban" | "guest" | "unguest" | "spec" | "play" | "chat" | "next" | "restart" | "jump" | "timelimit" | "pause" | "resume"
    pub action: String,
    pub login: Option<String>,
    pub text: Option<String>,
    pub value: Option<u32>,
}

#[tauri::command(async)]
pub fn host_console_do(id: String, cmd: ConsoleIn) -> Result<(), String> {
    let (mut c, d) = rpc(&id)?;
    let login = || cmd.login.clone().unwrap_or_default();
    let a = match cmd.action.as_str() {
        x @ ("kick" | "ban" | "unban" | "guest" | "unguest") => console::Action::Player { action: x.into(), login: login() },
        "spec" => console::Action::Spectator { login: login(), spec: true },
        "play" => console::Action::Spectator { login: login(), spec: false },
        "chat" => console::Action::Chat(cmd.text.clone().unwrap_or_default()),
        "next" => console::Action::Next,
        "restart" => console::Action::Restart,
        "jump" => console::Action::Jump(cmd.value.ok_or("value")? as usize),
        "timelimit" => console::Action::TimeLimit(cmd.value.ok_or("value")?),
        "pause" => console::Action::Pause(true),
        "resume" => console::Action::Pause(false),
        _ => return Err("unknown action".into()),
    };
    console::run(&mut c, script_style(&d), &a)
}

// ------------------------------------------------------------------ close, tray, autostart

#[tauri::command]
pub fn host_running_count() -> usize {
    mgr().running_count()
}

/// Answer to "keep servers running?": "keep" hides the window to the tray, "stop" ends everything.
#[tauri::command(async)]
pub fn host_close_choice(app: AppHandle, st: State<AppState>, choice: String) -> Result<(), String> {
    match choice.as_str() {
        "keep" => {
            ensure_tray(&app)?;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            Ok(())
        }
        "stop" => {
            stop_all(&st.data_dir);
            app.exit(0);
            Ok(())
        }
        _ => Err("unknown choice".into()),
    }
}

pub fn ensure_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    if app.tray_by_id("host").is_some() {
        return Ok(());
    }
    let open = MenuItem::with_id(app, "host-open", "Open TM Horizon", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "host-quit", "Stop servers and quit", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open, &quit]).map_err(|e| e.to_string())?;
    let mut b = TrayIconBuilder::with_id("host").tooltip("TM Horizon: servers running").menu(&menu).on_menu_event(|app, e| match e.id.as_ref() {
        "host-open" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        "host-quit" => {
            if let Some(data) = mgr().data() {
                stop_all(&data);
            }
            app.exit(0);
        }
        _ => {}
    });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

/// `--start-servers` (scheduled task at logon): window hidden, tray icon, autostart servers on.
pub fn start_autostart_servers(app: &AppHandle, data: &Path) {
    let _ = ensure_tray(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    for d in load_all(data).into_iter().filter(|d| d.autostart) {
        let _ = start(data, &d.id);
    }
}
