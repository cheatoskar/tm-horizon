//! "Eigener Server": the player's own game servers. Design and status: docs/design/server-hosting.md.
//!
//! - `kinds`: per game: download (pinned SHA-256), folders, config dialect, logins, query.
//! - `model`: server.json; `config`: dedicated_cfg / MatchSettings / lists / ports.
//! - `engines`: plain dedicated server, the 100% TMX randomizer.
//! - `procs`: hidden start, Job objects, PID files; `xmlrpc`: GBXRemote client (+ fake server).
//! - `netops`: UPnP, firewall command, hub self-test and listing; `autostart`: Task Scheduler.
//! - `secrets`: Credential Manager.
//! - `mapfiles`: only real maps (GBX class) go on a server; header facts and thumbnails for the picker.
//! - `tmx`: map ids, map packs and search links from TMX into the server's own folder.
//! - `players`: logins seen on a server (for the guest/ban lists); `console`: admin over XML-RPC.
//! - `demo` (debug builds, TMHUB_HOST_DEMO=1): a fake server for screenshots.
//!
//! Servers run as children of the launcher in a Job object each. Closing the window with servers
//! running asks first; "keep running" hides the window to the tray (the launcher process stays).

pub mod autostart;
pub mod config;
pub mod console;
#[cfg(debug_assertions)]
pub mod demo;
pub mod deps;
pub mod engines;
pub mod kinds;
pub mod mapfiles;
pub mod model;
pub mod netops;
pub mod players;
pub mod procs;
pub mod secrets;
pub mod tmx;
pub mod xmlrpc;

use model::ServerDef;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ------------------------------------------------------------------ store

pub fn servers_root(data: &Path) -> PathBuf {
    data.join("servers")
}

pub fn server_dir(data: &Path, id: &str) -> PathBuf {
    servers_root(data).join(id)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn new_id() -> String {
    let mut b = [0u8; 5];
    secrets::random_bytes(&mut b);
    format!("s{}", hex::encode(b))
}

pub fn load_all(data: &Path) -> Vec<ServerDef> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(servers_root(data)) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('_') || !valid_id(&name) {
            continue;
        }
        if let Some(mut d) = load(data, &name) {
            migrate(data, &mut d);
            out.push(d);
        }
    }
    out.sort_by(|a, b| a.created.cmp(&b.created));
    out
}

/// Older files may list replays as maps (the file picker took any .Gbx). They are dropped and the
/// file rewritten (the old one kept as server.json.bak); the names wait in the manager for the UI.
fn migrate(data: &Path, d: &mut ServerDef) {
    if mapfiles::drop_non_maps(&mut d.maps.clone()).is_empty() {
        return;
    }
    // two page loads may race: read, clean and write under one lock, from the file on disk
    static ONE: Mutex<()> = Mutex::new(());
    let _g = ONE.lock().unwrap();
    let Some(mut fresh) = load(data, &d.id) else { return };
    let dropped = mapfiles::drop_non_maps(&mut fresh.maps);
    if !dropped.is_empty() {
        let dir = server_dir(data, &d.id);
        let _ = std::fs::copy(dir.join("server.json"), dir.join("server.json.bak"));
        if save(data, &fresh).is_err() {
            return;
        }
        let mut n = mgr().notices.lock().unwrap();
        let list = n.entry(d.id.clone()).or_default();
        for x in dropped {
            if !list.contains(&x) {
                list.push(x);
            }
        }
    }
    *d = fresh;
}

/// Map entries that may be saved: map files by name and class (a missing file is let through, the
/// start reports it), TMX ids. Duplicates are dropped.
pub fn vet_maps(d: &mut ServerDef) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    d.maps.retain(|m| {
        seen.insert(match m {
            model::MapRef::File { path, .. } => path.to_ascii_lowercase(),
            model::MapRef::Tmx { id, .. } => format!("tmx:{id}"),
        })
    });
    for m in &d.maps {
        if let model::MapRef::File { path, .. } = m {
            let p = Path::new(path);
            if !mapfiles::has_map_ext(path) || (p.exists() && mapfiles::check_map(p).is_err()) {
                return Err(format!("host.err.notMap:{}", mapfiles::stem(path)));
            }
        }
    }
    Ok(())
}

pub fn load(data: &Path, id: &str) -> Option<ServerDef> {
    if !valid_id(id) {
        return None;
    }
    let b = std::fs::read(server_dir(data, id).join("server.json")).ok()?;
    let mut d: ServerDef = serde_json::from_slice(&b).ok()?;
    d.id = id.to_string();
    Some(d)
}

pub fn save(data: &Path, d: &ServerDef) -> Result<(), String> {
    if !valid_id(&d.id) {
        return Err("bad id".into());
    }
    let dir = server_dir(data, &d.id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("server.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(d).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    procs::restrict_to_user(&tmp);
    std::fs::rename(&tmp, dir.join("server.json")).map_err(|e| e.to_string())
}

/// Ports of all other saved servers (so a new one never collides with a stopped one either).
pub fn taken_ports(all: &[ServerDef], except: &str) -> Vec<u16> {
    all.iter().filter(|d| d.id != except).flat_map(|d| [d.ports.game, d.ports.p2p, d.ports.xmlrpc, d.randomizer.web_port]).filter(|p| *p != 0).collect()
}

// ------------------------------------------------------------------ running servers

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    /// "starting" | "running" | "stopping" | "stopped" | "crashed" | "failed" | "leftover"
    pub state: String,
    pub step: Option<String>,
    pub error: Option<String>,
    pub started: Option<u64>,
    pub upnp: Option<netops::UpnpResult>,
    /// The saved game port was busy at the start (often the running game client holds 2350), so this
    /// start moved the server to the next free set; the old game port, for the notice.
    pub ports_moved_from: Option<u16>,
}

impl Default for RunInfo {
    fn default() -> Self {
        RunInfo { state: "stopped".into(), step: None, error: None, started: None, upnp: None, ports_moved_from: None }
    }
}

struct Running {
    proc: Option<procs::Proc>,
    plan: Option<engines::LaunchPlan>,
    info: RunInfo,
    last_announce: Option<Instant>,
    last_upnp: Option<Instant>,
}

#[derive(Default)]
pub struct Manager {
    data: Mutex<Option<PathBuf>>,
    run: Mutex<HashMap<String, Running>>,
    hub_url: Mutex<String>,
    /// Map entries the migration dropped, per server, until the player closes the notice.
    pub notices: Mutex<HashMap<String, Vec<String>>>,
}

pub fn mgr() -> &'static Manager {
    static M: OnceLock<Manager> = OnceLock::new();
    M.get_or_init(Manager::default)
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn emit_state(id: &str) {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let info = mgr().info(id);
        let _ = app.emit("host-state", serde_json::json!({ "id": id, "info": info }));
    }
}

impl Manager {
    fn data(&self) -> Option<PathBuf> {
        self.data.lock().unwrap().clone()
    }

    pub fn info(&self, id: &str) -> RunInfo {
        self.run.lock().unwrap().get(id).map(|r| r.info.clone()).unwrap_or_default()
    }

    pub fn running_count(&self) -> usize {
        self.run.lock().unwrap().values().filter(|r| matches!(r.info.state.as_str(), "starting" | "running" | "stopping")).count()
    }

    fn set(&self, id: &str, f: impl FnOnce(&mut RunInfo)) {
        {
            let mut m = self.run.lock().unwrap();
            let r = m.entry(id.to_string()).or_insert_with(|| Running { proc: None, plan: None, info: RunInfo::default(), last_announce: None, last_upnp: None });
            f(&mut r.info);
        }
        emit_state(id);
    }
}

fn rpc_for(plan: &engines::LaunchPlan, port: u16) -> Result<xmlrpc::Client, String> {
    let mut c = xmlrpc::Client::connect(port, Duration::from_secs(5)).map_err(|e| e.to_string())?;
    c.authenticate(&plan.rpc_level, &plan.rpc_password).map_err(|e| e.to_string())?;
    Ok(c)
}

/// XML-RPC client for a running server (credentials from its launch plan).
pub fn rpc(id: &str) -> Result<(xmlrpc::Client, ServerDef), String> {
    let data = mgr().data().ok_or("not ready")?;
    let d = load(&data, id).ok_or("host.err.unknown")?;
    let plan = mgr().run.lock().unwrap().get(id).and_then(|r| r.plan.clone()).ok_or("host.err.notRunning")?;
    Ok((rpc_for(&plan, d.ports.xmlrpc)?, d))
}

/// Starts a server in the background; progress and the result arrive as "host-state" events.
pub fn start(data: &Path, id: &str) -> Result<(), String> {
    let d = load(data, id).ok_or("host.err.unknown")?;
    model::validate(&d)?;
    {
        let m = mgr().run.lock().unwrap();
        if m.get(id).is_some_and(|r| matches!(r.info.state.as_str(), "starting" | "running" | "stopping")) {
            return Err("host.err.running".into());
        }
    }
    let dir = server_dir(data, id);
    if procs::check_leftover(procs::read_pid(&dir).as_ref(), &procs::process_name) == procs::Leftover::Alive {
        return Err("host.err.leftover".into());
    }
    let k = kinds::kind(&d.game).ok_or("host.err.game")?;
    if !k.installable() {
        return Err("host.err.noPackage".into());
    }
    #[cfg(debug_assertions)]
    if demo::enabled() {
        return start_demo(id, &d);
    }
    mgr().set(id, |i| *i = RunInfo { state: "starting".into(), step: Some("prepare".into()), ..Default::default() });
    let data = data.to_path_buf();
    let id = id.to_string();
    std::thread::spawn(move || {
        if let Err(e) = start_blocking(&data, &id, &d, k) {
            mgr().set(&id, |i| {
                i.state = "failed".into();
                i.step = None;
                i.error = Some(e);
            });
        }
    });
    Ok(())
}

struct UnmapOnFail(Vec<String>);

impl Drop for UnmapOnFail {
    fn drop(&mut self) {
        netops::upnp_unmap(&self.0);
    }
}

fn start_blocking(data: &Path, id: &str, d: &ServerDef, k: &'static kinds::GameServerKind) -> Result<(), String> {
    // Ports may have been taken since the server was saved (the game client holds 2350/3450/5000 while it
    // runs): move to the next free set (2351/3451/5001, ...) and save it, so the config, UPnP and the
    // firewall rule all use the new ports. Fails only when nothing in the range is free.
    let need_p2p = k.cfg_style != kinds::CfgStyle::Tm2020;
    let moved = config::move_busy_ports(&d.ports, need_p2p, &taken_ports(&load_all(data), id), &config::port_free).ok_or("host.err.noPorts")?;
    let mut owned = d.clone();
    if let Some(p) = moved {
        let from = d.ports.game;
        owned.ports = p;
        save(data, &owned)?;
        mgr().set(id, move |i| i.ports_moved_from = Some(from));
    }
    // Router ports before the server starts (a mapping needs no listener): game + P2P, TCP and UDP, to
    // this PC's LAN address, never XML-RPC. When that fails the server's own UPnP is the fallback.
    let mut upnp = None;
    if owned.internet && owned.upnp {
        mgr().set(id, |i| i.step = Some("upnp".into()));
        let p2p = (k.cfg_style != kinds::CfgStyle::Tm2020).then_some(owned.ports.p2p);
        let mut r = netops::upnp_map(owned.ports.game, p2p, &crate::serverquery::strip_format(&owned.name));
        if !r.ok && k.cfg_style != kinds::CfgStyle::Legacy {
            owned.nat_upnp_fallback = true;
            r.server_fallback = true;
        }
        upnp = Some(r);
    }
    // A failed start removes the mappings again (a running server's are removed by stop, from the PID file).
    let mut unmap = UnmapOnFail(upnp.as_ref().map(|r| r.mapped.clone()).unwrap_or_default());
    let d = &owned;
    let dir = server_dir(data, id);
    let store = secrets::Store::default_for(data);
    let eng = engines::engine(&d.engine).ok_or("host.err.engine")?;
    let progress = |s: &str| {
        let s = s.to_string();
        mgr().set(id, move |i| i.step = Some(s));
    };
    let ctx = engines::Ctx { data, dir: &dir, kind: k, def: d, secrets: &store, fetch: &deps::http_fetch, progress: &progress };
    let plan = eng.prepare(&ctx)?;
    // Last check right before the start (another program may have taken a port meanwhile).
    if !config::port_free(d.ports.game, true) || (k.cfg_style != kinds::CfgStyle::Tm2020 && !config::port_free(d.ports.p2p, true)) || !config::port_free(d.ports.xmlrpc, false) {
        return Err("host.err.portBusy".into());
    }
    progress("start");
    let log = dir.join("console.log");
    let p = procs::spawn(&procs::Spawn { program: &plan.program, args: &plan.args, cwd: &plan.cwd, env: &plan.env, log: &log }).map_err(|e| format!("start: {e}"))?;
    let exe = plan.program.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let pid = procs::PidFile { pid: p.pid, exe, started: now_secs(), upnp: unmap.0.clone() };
    procs::write_pid(&dir, &pid)?;
    {
        let mut m = mgr().run.lock().unwrap();
        let r = m.entry(id.to_string()).or_insert_with(|| Running { proc: None, plan: None, info: RunInfo::default(), last_announce: None, last_upnp: None });
        r.proc = Some(p);
        r.plan = Some(plan.clone());
        r.info.started = Some(pid.started);
    }
    // Wait until XML-RPC answers (the randomizer may first download maps): up to 3 minutes.
    progress("wait");
    let until = Instant::now() + Duration::from_secs(180);
    let mut client = loop {
        if !alive(id) {
            return Err("host.err.exited".into());
        }
        if let Ok(c) = rpc_for(&plan, d.ports.xmlrpc) {
            break c;
        }
        if Instant::now() > until {
            return Err("host.err.noAnswer".into());
        }
        std::thread::sleep(Duration::from_millis(1500));
    };
    let _ = eng.after_start(&ctx, &mut client);
    unmap.0.clear();
    {
        let mut m = mgr().run.lock().unwrap();
        if let Some(r) = m.get_mut(id) {
            r.last_upnp = Some(Instant::now());
        }
    }
    mgr().set(id, |i| {
        i.state = "running".into();
        i.step = None;
        i.error = None;
        i.upnp = upnp;
    });
    ensure_watcher();
    Ok(())
}

#[cfg(debug_assertions)]
fn start_demo(id: &str, d: &ServerDef) -> Result<(), String> {
    let names: Vec<String> = d
        .maps
        .iter()
        .map(|m| match m {
            model::MapRef::File { name, .. } | model::MapRef::Tmx { name, .. } => name.clone(),
        })
        .collect();
    demo::start(id, d.ports.xmlrpc, &names)?;
    let plan = engines::LaunchPlan { program: PathBuf::new(), args: vec![], cwd: PathBuf::new(), env: vec![], server_dir: PathBuf::new(), rpc_level: "SuperAdmin".into(), rpc_password: "demo".into() };
    {
        let mut m = mgr().run.lock().unwrap();
        let r = m.entry(id.to_string()).or_insert_with(|| Running { proc: None, plan: None, info: RunInfo::default(), last_announce: None, last_upnp: None });
        r.plan = Some(plan);
    }
    mgr().set(id, |i| *i = RunInfo { state: "running".into(), started: Some(now_secs().saturating_sub(3720)), ..Default::default() });
    ensure_watcher();
    Ok(())
}

fn alive(id: &str) -> bool {
    #[cfg(debug_assertions)]
    if demo::is_running(id) {
        return true;
    }
    mgr().run.lock().unwrap().get_mut(id).and_then(|r| r.proc.as_mut()).is_some_and(|p| p.alive())
}

/// Stops a server: QuitGame over XML-RPC, then the job after 10 s; UPnP mappings removed.
pub fn stop(data: &Path, id: &str) -> Result<(), String> {
    let (proc, plan) = {
        let mut m = mgr().run.lock().unwrap();
        match m.get_mut(id) {
            Some(r) => {
                r.info.state = "stopping".into();
                (r.proc.take(), r.plan.take())
            }
            None => (None, None),
        }
    };
    emit_state(id);
    let dir = server_dir(data, id);
    let d = load(data, id);
    if let (Some(plan), Some(d)) = (&plan, &d) {
        if let Ok(mut c) = rpc_for(plan, d.ports.xmlrpc) {
            let _ = c.call("QuitGame", &[]);
        }
    }
    if let Some(mut p) = proc {
        if !p.wait_exit(10_000) {
            p.kill();
        } else {
            // a controller may leave its dedicated server behind: end the whole job
            p.kill();
        }
    }
    if let Some(pf) = procs::read_pid(&dir) {
        netops::upnp_unmap(&pf.upnp);
    }
    procs::clear_pid(&dir);
    #[cfg(debug_assertions)]
    demo::stopped(id);
    mgr().set(id, |i| *i = RunInfo::default());
    Ok(())
}

pub fn stop_all(data: &Path) {
    let ids: Vec<String> = mgr().run.lock().unwrap().iter().filter(|(_, r)| r.proc.is_some()).map(|(k, _)| k.clone()).collect();
    let hs: Vec<_> = ids
        .into_iter()
        .map(|id| {
            let data = data.to_path_buf();
            std::thread::spawn(move || stop(&data, &id))
        })
        .collect();
    for h in hs {
        let _ = h.join();
    }
}

/// Background loop (one for the launcher): crash detection, UPnP lease renewal, hub announce.
fn ensure_watcher() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(15));
        let Some(data) = mgr().data() else { continue };
        let ids: Vec<String> = mgr().run.lock().unwrap().iter().filter(|(_, r)| r.info.state == "running").map(|(k, _)| k.clone()).collect();
        for id in ids {
            if !alive(&id) {
                let dir = server_dir(&data, &id);
                if let Some(pf) = procs::read_pid(&dir) {
                    netops::upnp_unmap(&pf.upnp);
                }
                procs::clear_pid(&dir);
                mgr().set(&id, |i| {
                    i.state = "crashed".into();
                    i.error = Some("host.err.exited".into());
                });
                continue;
            }
            let Some(d) = load(&data, &id) else { continue };
            // players seen (for the lists); cheap: one call on the local port
            if let Ok((mut c, _)) = rpc(&id) {
                if let Ok(v) = c.call("GetPlayerList", &[xmlrpc::Value::Int(255), xmlrpc::Value::Int(0)]) {
                    let now: Vec<(String, String)> = v.as_array().iter().map(|p| (p.s("Login"), p.s("NickName"))).collect();
                    players::record(&server_dir(&data, &id), &now);
                }
            }
            let (renew, announce) = {
                let m = mgr().run.lock().unwrap();
                let r = m.get(&id);
                (
                    d.internet && d.upnp && r.and_then(|r| r.last_upnp).is_none_or(|t| t.elapsed() > Duration::from_secs(1800)),
                    d.internet && d.listing.consent_at.is_some() && d.listing.has_token && r.and_then(|r| r.last_announce).is_none_or(|t| t.elapsed() > Duration::from_secs(300)),
                )
            };
            if renew {
                let k = kinds::kind(&d.game);
                let p2p = k.filter(|k| k.cfg_style != kinds::CfgStyle::Tm2020).map(|_| d.ports.p2p);
                // Renewal (and the first mapping of a server found running after a launcher restart): the
                // result goes to the page and into the PID file, so a stop removes these mappings too.
                let res = netops::upnp_map(d.ports.game, p2p, &crate::serverquery::strip_format(&d.name));
                let dir = server_dir(&data, &id);
                if let Some(mut pf) = procs::read_pid(&dir) {
                    for e in &res.mapped {
                        if !pf.upnp.contains(e) {
                            pf.upnp.push(e.clone());
                        }
                    }
                    let _ = procs::write_pid(&dir, &pf);
                }
                if let Some(r) = mgr().run.lock().unwrap().get_mut(&id) {
                    r.last_upnp = Some(Instant::now());
                    let fallback = r.info.upnp.as_ref().is_some_and(|u| u.server_fallback);
                    r.info.upnp = Some(netops::UpnpResult { server_fallback: fallback && !res.ok, ..res });
                }
            }
            if announce {
                let hub = mgr().hub_url.lock().unwrap().clone();
                let token = secrets::Store::default_for(&data).get(&id, secrets::HUB_TOKEN);
                if let (false, Some(token), Ok(st)) = (hub.is_empty(), token, status(&id)) {
                    let a = netops::Announce { name: d.name.clone(), players: st.players.len() as u32, max_players: st.max_players, spectators: st.spectators, map: st.map.clone(), mode: st.mode.clone() };
                    let _ = netops::hub_announce(&hub, &token, &a);
                }
                if let Some(r) = mgr().run.lock().unwrap().get_mut(&id) {
                    r.last_announce = Some(Instant::now());
                }
            }
        }
    });
}

// ------------------------------------------------------------------ live status

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub login: String,
    pub nick: String,
    pub spectator: bool,
    pub ladder: i64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub status: String,
    pub players: Vec<Player>,
    pub spectators: u32,
    pub max_players: u32,
    pub map: Option<String>,
    pub mode: Option<String>,
    pub guests: Vec<String>,
    pub blacklist: Vec<String>,
    pub bans: Vec<String>,
}

fn mode_name(i: i64) -> &'static str {
    match i {
        0 => "Rounds",
        1 => "TimeAttack",
        2 => "Team",
        3 => "Laps",
        4 => "Stunts",
        5 => "Cup",
        _ => "Script",
    }
}

/// Status, players, map and lists over XML-RPC. Works the same against the fake server in tests.
pub fn read_status(c: &mut xmlrpc::Client) -> Result<LiveStatus, String> {
    let e = |e: xmlrpc::RpcError| e.to_string();
    let st = c.call("GetStatus", &[]).map_err(e)?;
    let list = c.call("GetPlayerList", &[xmlrpc::Value::Int(255), xmlrpc::Value::Int(0)]).map_err(e)?;
    let mut out = LiveStatus { status: st.s("Name"), ..Default::default() };
    for p in list.as_array() {
        // SpectatorStatus: the last digit is "is spectator"; older servers send IsSpectator
        let spec = p.get("IsSpectator").and_then(xmlrpc::Value::as_bool).unwrap_or(p.i("SpectatorStatus") % 10 == 1);
        let pl = Player { login: p.s("Login"), nick: p.s("NickName"), spectator: spec, ladder: p.i("LadderRanking") };
        if pl.login.is_empty() {
            continue;
        }
        if spec {
            out.spectators += 1;
        }
        out.players.push(pl);
    }
    if let Ok(m) = c.call("GetMaxPlayers", &[]) {
        out.max_players = m.i("CurrentValue") as u32;
    }
    if let Ok(m) = c.call("GetCurrentChallengeInfo", &[]).or_else(|_| c.call("GetCurrentMapInfo", &[])) {
        out.map = Some(m.s("Name")).filter(|s| !s.is_empty());
    }
    if let Ok(g) = c.call("GetGameMode", &[]) {
        out.mode = g.as_i64().map(|i| mode_name(i).to_string());
    }
    let logins = |v: xmlrpc::Value| v.as_array().iter().map(|x| x.s("Login")).filter(|s| !s.is_empty()).collect::<Vec<_>>();
    if let Ok(v) = c.call("GetGuestList", &[xmlrpc::Value::Int(500), xmlrpc::Value::Int(0)]) {
        out.guests = logins(v);
    }
    if let Ok(v) = c.call("GetBlackList", &[xmlrpc::Value::Int(500), xmlrpc::Value::Int(0)]) {
        out.blacklist = logins(v);
    }
    if let Ok(v) = c.call("GetBanList", &[xmlrpc::Value::Int(500), xmlrpc::Value::Int(0)]) {
        out.bans = logins(v);
    }
    Ok(out)
}

pub fn status(id: &str) -> Result<LiveStatus, String> {
    let (mut c, _) = rpc(id)?;
    let st = read_status(&mut c)?;
    record_seen(id, &st);
    Ok(st)
}

/// Writes the players of a status read into the server's "seen" list.
pub fn record_seen(id: &str, st: &LiveStatus) {
    if let Some(data) = mgr().data() {
        let now: Vec<(String, String)> = st.players.iter().map(|p| (p.login.clone(), p.nick.clone())).collect();
        players::record(&server_dir(&data, id), &now);
    }
}

/// Player actions. "ban" = ban now and put on the black list (saved to the file).
pub fn player_action(c: &mut xmlrpc::Client, action: &str, login: &str) -> Result<(), String> {
    if !model::valid_login(login) {
        return Err("host.err.login".into());
    }
    let e = |e: xmlrpc::RpcError| e.to_string();
    let l: xmlrpc::Value = login.into();
    match action {
        "kick" => c.call("Kick", &[l]).map(|_| ()).map_err(e),
        "ban" => {
            c.call("BanAndBlackList", &[l, "".into(), true.into()]).map_err(e)?;
            let _ = c.call("SaveBlackList", &["blacklist.txt".into()]);
            Ok(())
        }
        "unban" => {
            let _ = c.call("UnBan", &[l.clone()]);
            let _ = c.call("UnBlackList", &[l]);
            let _ = c.call("SaveBlackList", &["blacklist.txt".into()]);
            Ok(())
        }
        "guest" => {
            c.call("AddGuest", &[l]).map_err(e)?;
            let _ = c.call("SaveGuestList", &["guestlist.txt".into()]);
            Ok(())
        }
        "unguest" => {
            c.call("RemoveGuest", &[l]).map_err(e)?;
            let _ = c.call("SaveGuestList", &["guestlist.txt".into()]);
            Ok(())
        }
        _ => Err("unknown action".into()),
    }
}

/// Brings a running server's lists in line with the saved ones (after an edit in the UI).
pub fn sync_lists(c: &mut xmlrpc::Client, d: &ServerDef, live: &LiveStatus) {
    let has = |v: &[String], l: &str| v.iter().any(|x| x.eq_ignore_ascii_case(l));
    for g in &d.guests {
        if !has(&live.guests, g) {
            let _ = c.call("AddGuest", &[g.as_str().into()]);
        }
    }
    for g in &live.guests {
        if !has(&d.guests, g) {
            let _ = c.call("RemoveGuest", &[g.as_str().into()]);
        }
    }
    for b in &d.blacklist {
        if !has(&live.blacklist, b) {
            let _ = c.call("BlackList", &[b.as_str().into()]);
        }
    }
    for b in &live.blacklist {
        if !has(&d.blacklist, b) {
            let _ = c.call("UnBlackList", &[b.as_str().into()]);
        }
    }
    let _ = c.call("SaveGuestList", &["guestlist.txt".into()]);
    let _ = c.call("SaveBlackList", &["blacklist.txt".into()]);
}

// ------------------------------------------------------------------ local maps, TMX

/// The player's own map folder of a game (None when the game keeps maps in its install folder).
pub fn maps_root(game: &str, docs: &Path) -> Option<PathBuf> {
    Some(match game {
        "tmnf" | "tmuf" => docs.join("TrackMania").join("Tracks").join("Challenges"),
        "tm2" => docs.join("ManiaPlanet").join("Maps"),
        "tm2020" => crate::maps::tm2020_user_dir(docs).join("Maps"),
        _ => return None,
    })
}

// ------------------------------------------------------------------ app glue (tauri)

pub mod app;

pub fn init(app: &tauri::AppHandle, data: &Path) {
    let _ = APP.set(app.clone());
    *mgr().data.lock().unwrap() = Some(data.to_path_buf());
}

#[cfg(test)]
mod tests {
    use super::xmlrpc::{fake, Value};
    use super::*;
    use std::sync::{Arc, Mutex as M};

    #[test]
    fn store_roundtrip_and_ports() {
        let t = tempfile::tempdir().unwrap();
        assert!(load_all(t.path()).is_empty());
        let mut d = ServerDef { id: new_id(), created: "2".into(), ..Default::default() };
        save(t.path(), &d).unwrap();
        d.ports.game = 2351;
        let e = ServerDef { id: new_id(), created: "1".into(), ..Default::default() };
        save(t.path(), &e).unwrap();
        std::fs::create_dir_all(t.path().join("servers").join("_cache")).unwrap();
        let all = load_all(t.path());
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, e.id, "sorted by creation");
        assert!(load(t.path(), "../x").is_none());
        let taken = taken_ports(&all, &e.id);
        assert!(taken.contains(&2350) && taken.contains(&5000) && !taken.contains(&0));
    }

    /// Fake dedicated server with players, lists and a ban flow.
    fn fake_server() -> (fake::FakeServer, Arc<M<(Vec<String>, Vec<String>)>>) {
        let lists = Arc::new(M::new((vec!["buddy".to_string()], vec![])));
        let l2 = lists.clone();
        let srv = fake::start(
            2,
            Arc::new(move |name: &str, p: &[Value]| {
                let login = p.first().and_then(Value::as_str).unwrap_or("").to_string();
                let arr = |v: &Vec<String>| Value::Array(v.iter().map(|l| Value::Struct(vec![("Login".into(), l.as_str().into())])).collect());
                let mut g = l2.lock().unwrap();
                Ok(match name {
                    "Authenticate" => Value::Bool(true),
                    "GetStatus" => Value::Struct(vec![("Code".into(), Value::Int(4)), ("Name".into(), "Running - Play".into())]),
                    "GetPlayerList" => Value::Array(vec![
                        Value::Struct(vec![("Login".into(), "alice".into()), ("NickName".into(), "$f00Alice".into()), ("SpectatorStatus".into(), Value::Int(0)), ("LadderRanking".into(), Value::Int(12))]),
                        Value::Struct(vec![("Login".into(), "bob".into()), ("NickName".into(), "Bob".into()), ("SpectatorStatus".into(), Value::Int(2551101)), ("LadderRanking".into(), Value::Int(-1))]),
                    ]),
                    "GetMaxPlayers" => Value::Struct(vec![("CurrentValue".into(), Value::Int(16)), ("NextValue".into(), Value::Int(16))]),
                    "GetCurrentChallengeInfo" => Value::Struct(vec![("Name".into(), "A01-Race".into())]),
                    "GetGameMode" => Value::Int(1),
                    "GetGuestList" => arr(&g.0),
                    "GetBlackList" => arr(&g.1),
                    "GetBanList" => Value::Array(vec![]),
                    "BanAndBlackList" | "BlackList" => {
                        g.1.push(login);
                        Value::Bool(true)
                    }
                    "UnBlackList" => {
                        g.1.retain(|x| *x != login);
                        Value::Bool(true)
                    }
                    "AddGuest" => {
                        g.0.push(login);
                        Value::Bool(true)
                    }
                    "RemoveGuest" => {
                        g.0.retain(|x| *x != login);
                        Value::Bool(true)
                    }
                    "Kick" | "UnBan" | "SaveGuestList" | "SaveBlackList" | "QuitGame" => Value::Bool(true),
                    other => return Err((-1000, format!("unknown {other}"))),
                })
            }),
        );
        (srv, lists)
    }

    #[test]
    fn status_players_and_ban_flow() {
        let (srv, lists) = fake_server();
        let mut c = xmlrpc::Client::connect(srv.port, Duration::from_secs(3)).unwrap();
        c.authenticate("SuperAdmin", "x").unwrap();
        let st = read_status(&mut c).unwrap();
        assert_eq!(st.status, "Running - Play");
        assert_eq!(st.players.len(), 2);
        assert_eq!(st.players[0], Player { login: "alice".into(), nick: "$f00Alice".into(), spectator: false, ladder: 12 });
        assert!(st.players[1].spectator);
        assert_eq!((st.spectators, st.max_players), (1, 16));
        assert_eq!(st.map.as_deref(), Some("A01-Race"));
        assert_eq!(st.mode.as_deref(), Some("TimeAttack"));
        assert_eq!(st.guests, vec!["buddy"]);

        player_action(&mut c, "ban", "bob").unwrap();
        assert_eq!(lists.lock().unwrap().1, vec!["bob"]);
        player_action(&mut c, "kick", "alice").unwrap();
        assert!(player_action(&mut c, "ban", "bad login").is_err());
        player_action(&mut c, "unban", "bob").unwrap();
        assert!(lists.lock().unwrap().1.is_empty());
        let names = srv.names();
        assert!(names.contains(&"BanAndBlackList".to_string()) && names.contains(&"SaveBlackList".to_string()) && names.contains(&"Kick".to_string()));

        // lists edited in the UI: buddy removed, carol added as guest, mallory blacklisted
        let d = ServerDef { guests: vec!["carol".into()], blacklist: vec!["mallory".into()], ..Default::default() };
        let live = read_status(&mut c).unwrap();
        sync_lists(&mut c, &d, &live);
        let g = lists.lock().unwrap().clone();
        assert_eq!(g.0, vec!["carol"]);
        assert_eq!(g.1, vec!["mallory"]);
    }

    #[test]
    fn live_options_for_randomizer() {
        let (srv, _) = fake_server();
        let srv2 = fake::start(
            2,
            Arc::new(|_: &str, _: &[Value]| Ok(Value::Bool(true))),
        );
        drop(srv);
        let mut c = xmlrpc::Client::connect(srv2.port, Duration::from_secs(3)).unwrap();
        let d = ServerDef { password: "pw".into(), max_players: 20, ..Default::default() };
        engines::apply_live_options(&d, &mut c).unwrap();
        let calls = srv2.calls.lock().unwrap().clone();
        assert_eq!(calls[0], ("SetServerPassword".to_string(), vec![Value::from("pw")]));
        assert!(calls.iter().any(|(n, p)| n == "SetMaxPlayers" && p == &vec![Value::Int(20)]));
        assert!(calls.iter().any(|(n, _)| n == "LoadBlackList"));
    }

    /// Lifecycle without the real server: a sleeping process stands in for it, the fake answers
    /// XML-RPC. stop() asks QuitGame, ends the job, clears the PID file and the state.
    #[test]
    fn stop_flow_with_fake() {
        let t = tempfile::tempdir().unwrap();
        let (srv, _) = fake_server();
        let d = ServerDef { id: "stest1".into(), ports: model::Ports { game: 2399, p2p: 3499, xmlrpc: srv.port }, ..Default::default() };
        save(t.path(), &d).unwrap();
        let dir = server_dir(t.path(), &d.id);
        let (prog, args) = if cfg!(windows) { (PathBuf::from("cmd"), vec!["/c".to_string(), "ping -n 30 127.0.0.1 >nul".to_string()]) } else { (PathBuf::from("sleep"), vec!["30".to_string()]) };
        let p = procs::spawn(&procs::Spawn { program: &prog, args: &args, cwd: &dir, env: &[], log: &dir.join("console.log") }).unwrap();
        let pf = procs::PidFile { pid: p.pid, exe: procs::process_name(p.pid).unwrap_or_default(), started: 1, upnp: vec![] };
        procs::write_pid(&dir, &pf).unwrap();
        assert_eq!(procs::check_leftover(procs::read_pid(&dir).as_ref(), &procs::process_name), procs::Leftover::Alive);
        let plan = engines::LaunchPlan { program: prog.clone(), args: args.clone(), cwd: dir.clone(), env: vec![], server_dir: dir.clone(), rpc_level: "SuperAdmin".into(), rpc_password: "x".into() };
        mgr().run.lock().unwrap().insert(d.id.clone(), Running { proc: Some(p), plan: Some(plan), info: RunInfo { state: "running".into(), ..Default::default() }, last_announce: None, last_upnp: None });
        assert!(mgr().running_count() >= 1);
        assert!(alive(&d.id));
        stop(t.path(), &d.id).unwrap();
        assert!(srv.names().contains(&"QuitGame".to_string()));
        assert_eq!(mgr().info(&d.id).state, "stopped");
        assert!(procs::read_pid(&dir).is_none());
        assert_eq!(procs::check_leftover(Some(&pf), &procs::process_name), procs::Leftover::Stale, "process is gone");
    }

    #[test]
    fn maps_root_and_vetting() {
        let docs = Path::new("D");
        assert_eq!(maps_root("tmnf", docs).unwrap(), docs.join("TrackMania").join("Tracks").join("Challenges"));
        assert!(maps_root("eswc", docs).is_none());
        let t = tempfile::tempdir().unwrap();
        let rep = t.path().join("r.Replay.Gbx");
        std::fs::write(&rep, mapfiles::tests::replay_bytes()).unwrap();
        let ok = t.path().join("ok.Challenge.Gbx");
        std::fs::write(&ok, mapfiles::tests::map_bytes("ok", "me", 1)).unwrap();
        let f = |p: &Path| model::MapRef::File { path: p.to_string_lossy().into(), name: "x".into() };
        let mut d = ServerDef { maps: vec![f(&ok), f(&ok), model::MapRef::Tmx { id: 1, name: "a".into() }, model::MapRef::Tmx { id: 1, name: "a".into() }], ..Default::default() };
        vet_maps(&mut d).unwrap();
        assert_eq!(d.maps.len(), 2, "duplicates dropped");
        d.maps.push(f(&rep));
        assert_eq!(vet_maps(&mut d).unwrap_err(), "host.err.notMap:r.Replay");
    }

    /// An old server.json with replays in its map list: cleaned on load, backup kept, notice waits.
    #[test]
    fn migration_on_load() {
        let t = tempfile::tempdir().unwrap();
        let rep = t.path().join("summer mornings - FIXED_[TAS]cheatoskar(00'52''93).Replay.Gbx");
        std::fs::write(&rep, mapfiles::tests::replay_bytes()).unwrap();
        let ok = t.path().join("ok.Challenge.Gbx");
        std::fs::write(&ok, mapfiles::tests::map_bytes("ok", "me", 1)).unwrap();
        let f = |p: &Path, n: &str| model::MapRef::File { path: p.to_string_lossy().into(), name: n.into() };
        let d = ServerDef { id: "smig1".into(), maps: vec![f(&ok, "ok"), f(&rep, "summer mornings - FIXED_[TAS]cheatoskar(00'52''93).Replay.Gbx")], ..Default::default() };
        save(t.path(), &d).unwrap();
        let all = load_all(t.path());
        assert_eq!(all[0].maps.len(), 1);
        assert_eq!(load(t.path(), "smig1").unwrap().maps.len(), 1, "written back");
        assert!(server_dir(t.path(), "smig1").join("server.json.bak").is_file());
        let n = mgr().notices.lock().unwrap().get("smig1").cloned().unwrap();
        assert_eq!(n, vec!["summer mornings - FIXED_[TAS]cheatoskar(00'52''93).Replay.Gbx"]);
        // a second page load (or two at once) adds nothing twice
        let bak = server_dir(t.path(), "smig1").join("server.json.bak");
        std::fs::copy(&bak, server_dir(t.path(), "smig1").join("server.json")).unwrap();
        let hs: Vec<_> = (0..4).map(|_| { let p = t.path().to_path_buf(); std::thread::spawn(move || load_all(&p)) }).collect();
        for h in hs {
            assert_eq!(h.join().unwrap()[0].maps.len(), 1);
        }
        assert_eq!(mgr().notices.lock().unwrap().get("smig1").unwrap().len(), 1);
    }
}
