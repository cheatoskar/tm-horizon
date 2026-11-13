//! Discord Rich Presence over Discord's local IPC (named pipe `\\.\pipe\discord-ipc-<0..9>`),
//! without the Discord SDK DLL. Uses TM Horizon's own Discord application
//! (`DISCORD_APP_ID`); off while that constant is empty or "Show what I play in Discord" is off.
//!
//! Protocol: each frame is `opcode: u32 LE`, `length: u32 LE`, then `length` bytes of JSON.
//! Opcode 0 = handshake `{"v":1,"client_id":"<id>"}`, 1 = frame (commands such as SET_ACTIVITY),
//! 2 = close. Discord answers the handshake with a READY frame. The activity stays while the
//! pipe is open: one thread holds the connection and switches between "In TM Horizon" (only the
//! launcher is open) and "Playing <game>" (a game TM Horizon started); closing the pipe clears it.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Id of TM Horizon's Discord application (17-20 digits). Empty until I create the application
/// on discord.com/developers and paste its Application ID here (see docs/discord-presence.md).
pub const DISCORD_APP_ID: &str = "1570034548580950057";

pub const OP_HANDSHAKE: u32 = 0;
pub const OP_FRAME: u32 = 1;
pub const OP_CLOSE: u32 = 2;

/// Asset keys I upload to the Discord application (Rich Presence > Art Assets).
/// Missing keys are simply not shown by Discord.
pub const ICON_KEY: &str = "tmhub";

/// Counts the games TM Horizon started (a newer start replaces the line of an older one).
static SESSION: AtomicU64 = AtomicU64::new(0);

pub fn encode_frame(op: u32, payload: &Value) -> Vec<u8> {
    let body = payload.to_string().into_bytes();
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// Reads one frame: (opcode, JSON). Frames larger than 64 KiB are refused.
pub fn read_frame(r: &mut impl Read) -> Result<(u32, Value), String> {
    let mut head = [0u8; 8];
    r.read_exact(&mut head).map_err(|e| e.to_string())?;
    let op = u32::from_le_bytes(head[0..4].try_into().unwrap());
    let len = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
    if len > 64 << 10 {
        return Err("Discord frame too large".into());
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

/// A Discord application id is a snowflake: 17 to 20 digits.
pub fn valid_app_id(id: &str) -> bool {
    let id = id.trim();
    (17..=20).contains(&id.len()) && id.chars().all(|c| c.is_ascii_digit())
}

/// Asset key per game (I upload e.g. "tmnf", "tm2-stadium"; see docs).
pub fn game_asset(game_id: &str) -> String {
    game_id.to_lowercase()
}

/// A TAS tool shown in the presence instead of the plain "Playing" line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TasTool {
    Tick,
    ForeverTas,
}

impl TasTool {
    pub fn name(self) -> &'static str {
        match self {
            TasTool::Tick => "TICK",
            TasTool::ForeverTas => "ForeverTAS",
        }
    }

    /// Asset key of the tool's logo in the Discord application.
    pub fn asset(self) -> &'static str {
        match self {
            TasTool::Tick => "tas-tick",
            TasTool::ForeverTas => "tas-forevertas",
        }
    }

    /// TICK (Trackmania 2020) and ForeverTAS (Forever games) are separate programs next to the
    /// game; found by their running exe (lower-case names), only for the game they belong to.
    pub fn from_processes(game_id: &str, running: &[String]) -> Option<TasTool> {
        match game_id {
            "tm2020" if running.iter().any(|n| n.starts_with("tick") && n.ends_with(".exe") && !n.contains("unins")) => Some(TasTool::Tick),
            "tmnf" | "tmuf" if running.iter().any(|n| n == "forevertas.exe") => Some(TasTool::ForeverTas),
            _ => None,
        }
    }
}

/// The SET_ACTIVITY command: "Playing <game>", elapsed time from `start_unix`, TM Horizon icon.
/// With a TAS tool: "TAS \u{b7} <game>", "with <tool>" and the tool's logo as the small image.
pub fn activity_command(pid: u32, game_name: &str, game_id: &str, profile: Option<&str>, tool: Option<TasTool>, start_unix: u64, nonce: &str) -> Value {
    let mut activity = json!({
        "details": format!("Playing {game_name}"),
        "timestamps": { "start": start_unix },
        "assets": {
            "large_image": game_asset(game_id),
            "large_text": game_name,
            "small_image": ICON_KEY,
            "small_text": "TM Horizon",
        },
        "instance": false,
    });
    if let Some(t) = tool {
        activity["details"] = json!(format!("TAS \u{b7} {game_name}"));
        activity["state"] = json!(format!("with {}", t.name()));
        activity["assets"]["small_image"] = json!(t.asset());
        activity["assets"]["small_text"] = json!(t.name());
    } else if let Some(p) = profile.filter(|p| !p.trim().is_empty()) {
        activity["state"] = json!(format!("Profile: {p}"));
    }
    json!({ "cmd": "SET_ACTIVITY", "args": { "pid": pid, "activity": activity }, "nonce": nonce })
}

/// No presence of ours when TMInterface is on in the started profile: TMInterface sets its own
/// Discord status (its `discord_presence` setting), a second one would fight with it.
pub fn should_set_presence(app_id: &str, profile_mods: &[String]) -> bool {
    valid_app_id(app_id) && !profile_mods.iter().any(|m| m.eq_ignore_ascii_case("TMInterface"))
}

/// The TAS tool of a running session (TICK / ForeverTAS by process). None when the TAS setting
/// is off.
pub fn detect_tool(show_tas: bool, game_id: &str, running: &[String]) -> Option<TasTool> {
    if !show_tas {
        return None;
    }
    TasTool::from_processes(game_id, running)
}

fn set_activity(pipe: &mut (impl Read + Write), cmd: &Value) -> bool {
    if pipe.write_all(&encode_frame(OP_FRAME, cmd)).is_err() {
        return false;
    }
    read_frame(pipe).is_ok()
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(windows)]
fn connect() -> Option<std::fs::File> {
    (0..10).find_map(|i| std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{i}")).ok())
}

#[cfg(not(windows))]
fn connect() -> Option<std::os::unix::net::UnixStream> {
    let dir = std::env::var("XDG_RUNTIME_DIR").or_else(|_| std::env::var("TMPDIR")).unwrap_or_else(|_| "/tmp".into());
    (0..10).find_map(|i| std::os::unix::net::UnixStream::connect(format!("{dir}/discord-ipc-{i}")).ok())
}

pub struct PresenceRequest {
    pub app_id: String,
    pub game_id: String,
    pub game_name: String,
    pub profile: Option<String>,
    /// "Show TAS tool in Discord".
    pub show_tas: bool,
    /// Lower-case exe names that count as "the game is running".
    pub processes: Vec<String>,
}

/// The line Discord should show right now.
#[derive(Debug, Clone, PartialEq)]
pub enum Want {
    /// Nothing (presence off).
    Nothing,
    /// "In TM Horizon": only the launcher is open.
    Browsing,
    /// "Playing <game>" for the started game, with the TAS tool when one runs.
    Playing(Option<TasTool>),
    /// "Playing <game>" for a game TM Horizon did not start (game id, TAS tool), no profile.
    Direct(String, Option<TasTool>),
}

/// Settings and install facts the presence thread reads every round.
pub struct Cfg {
    pub enabled: bool,
    /// "Show TAS tool in Discord".
    pub show_tas: bool,
    /// Game id for `tmforever.exe`: "tmuf" when only United is installed, else "tmnf".
    pub forever_default: String,
}

/// Display name per launcher game id (as in the game catalog).
pub fn game_name(game_id: &str) -> &'static str {
    match game_id {
        "tmnf" => "TrackMania Nations Forever",
        "tmuf" => "TrackMania United Forever",
        "tmn-eswc" => "TrackMania Nations ESWC",
        "tm2020" => "Trackmania",
        "tm-turbo" => "Trackmania Turbo",
        "tm-sunrise" => "TrackMania Sunrise",
        "tm-original" => "TrackMania Original",
        "maniaplanet" => "ManiaPlanet",
        _ => "Trackmania",
    }
}

/// The game TM Horizon started last, until its process is gone.
struct Started {
    req: PresenceRequest,
    asked: Instant,
    seen: bool,
}

fn started() -> &'static std::sync::Mutex<Option<Started>> {
    static S: std::sync::OnceLock<std::sync::Mutex<Option<Started>>> = std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(None))
}

/// Decides the line. `started`: the game TM Horizon started (request, its process was seen, the
/// wait for it is over). Returns the line and whether the started game is finished (forget it).
pub fn decide(cfg: &Cfg, started: Option<(&PresenceRequest, bool, bool)>, running: &[String]) -> (Want, bool) {
    if !cfg.enabled {
        return (Want::Nothing, started.is_some());
    }
    // A known game that TM Horizon did not start: shown as "Playing <game>" too.
    let direct = crate::playtime::GAME_EXES
        .iter()
        .find(|e| running.iter().any(|r| r == **e))
        .and_then(|e| crate::playtime::game_of_name(e, &cfg.forever_default));
    let idle = match direct {
        Some(g) => {
            let tool = detect_tool(cfg.show_tas, &g, running);
            Want::Direct(g, tool)
        }
        None => Want::Browsing,
    };
    if let Some((req, seen, wait_over)) = started {
        if req.processes.iter().any(|n| running.iter().any(|r| r == n)) {
            return (Want::Playing(detect_tool(req.show_tas, &req.game_id, running)), false);
        }
        if seen || wait_over {
            // The game closed (or never came): browsing, or the other game that runs.
            return (idle, true);
        }
    }
    (idle, false)
}

/// "In TM Horizon" while only the launcher is open.
pub fn browsing_command(pid: u32, start_unix: u64, nonce: &str) -> Value {
    json!({ "cmd": "SET_ACTIVITY", "args": { "pid": pid, "activity": {
        "details": "In TM Horizon",
        "state": "Browsing",
        "timestamps": { "start": start_unix },
        "assets": { "large_image": ICON_KEY, "large_text": "TM Horizon" },
        "instance": false,
    } }, "nonce": nonce })
}

/// A game TM Horizon started: shown once its process is up, until it exits (or a newer game is
/// started). The presence thread (`run_manager`) does the talking to Discord.
pub fn start(req: PresenceRequest) {
    *started().lock().unwrap_or_else(|e| e.into_inner()) = Some(Started { req, asked: Instant::now(), seen: false });
    SESSION.fetch_add(1, Ordering::SeqCst);
}

#[cfg(windows)]
type Pipe = std::fs::File;
#[cfg(not(windows))]
type Pipe = std::os::unix::net::UnixStream;

fn handshake(app_id: &str) -> Option<Pipe> {
    let mut pipe = connect()?;
    pipe.write_all(&encode_frame(OP_HANDSHAKE, &json!({ "v": 1, "client_id": app_id.trim() }))).ok()?;
    match read_frame(&mut pipe) {
        Ok((OP_FRAME, v)) if v.get("evt").and_then(Value::as_str) == Some("READY") => Some(pipe),
        _ => None,
    }
}

/// The presence thread (launcher start): one pipe to Discord; the line follows `enabled()` (the
/// setting) and the running processes, checked every 3 s. Discord not running is normal: asked
/// again every 30 s.
pub fn run_manager(config: impl Fn() -> Cfg + Send + 'static, running: fn() -> Vec<String>) {
    let _ = std::thread::Builder::new().name("discord".into()).spawn(move || {
        let app_id = DISCORD_APP_ID.to_string();
        if !valid_app_id(&app_id) {
            return;
        }
        let launcher_start = now_unix();
        let mut pipe: Option<Pipe> = None;
        let mut shown: Option<(Want, u64)> = None;
        let mut game_start = 0u64;
        let mut last_try: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let cfg = config();
            let on = cfg.enabled;
            let names = if on { running() } else { vec![] };
            let session = SESSION.load(Ordering::SeqCst);
            let want = {
                let mut g = started().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(s) = g.as_mut() {
                    if s.req.processes.iter().any(|n| names.iter().any(|r| r == n)) {
                        s.seen = true;
                    }
                }
                let (w, forget) = decide(&cfg, g.as_ref().map(|s| (&s.req, s.seen, s.asked.elapsed() > Duration::from_secs(180))), &names);
                if forget {
                    *g = None;
                }
                w
            };
            if shown.as_ref().is_some_and(|(w, s)| *w == want && *s == session) {
                continue;
            }
            if want == Want::Nothing {
                if let Some(mut p) = pipe.take() {
                    // Closing the pipe clears the activity.
                    let _ = p.write_all(&encode_frame(OP_CLOSE, &json!({})));
                }
                shown = Some((want, session));
                continue;
            }
            if pipe.is_none() {
                if last_try.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
                    continue;
                }
                last_try = Some(Instant::now());
                pipe = handshake(&app_id);
                if pipe.is_none() {
                    continue;
                }
            }
            let cmd = match &want {
                Want::Direct(game, tool) => {
                    // Start = when this game was first seen (the line changed to it just now).
                    if !matches!(&shown, Some((Want::Direct(g, _), _)) if g == game) {
                        game_start = now_unix();
                    }
                    activity_command(std::process::id(), game_name(game), game, None, *tool, game_start, &format!("tmhub-d{session}"))
                }
                Want::Playing(tool) => {
                    if !matches!(shown, Some((Want::Playing(_), s)) if s == session) {
                        game_start = now_unix();
                    }
                    let g = started().lock().unwrap_or_else(|e| e.into_inner());
                    let Some(s) = g.as_ref() else { continue };
                    activity_command(std::process::id(), &s.req.game_name, &s.req.game_id, s.req.profile.as_deref(), *tool, game_start, &format!("tmhub-{session}"))
                }
                _ => browsing_command(std::process::id(), launcher_start, &format!("tmhub-b{session}")),
            };
            if pipe.as_mut().is_some_and(|p| set_activity(p, &cmd)) {
                shown = Some((want, session));
            } else {
                pipe = None;
                shown = None;
            }
        }
    });
}

/// Exe names (lower case) of a game's process, per launcher game id.
pub fn process_names(game_id: &str, exe: Option<&str>) -> Vec<String> {
    let mut v: Vec<String> = match game_id {
        "tmnf" | "tmuf" => vec!["tmforever.exe".into()],
        "tmn-eswc" => vec!["tmnationseswc.exe".into()],
        "tm2020" => vec!["trackmania.exe".into()],
        "tm-turbo" => vec!["trackmaniaturbo.exe".into()],
        "tm-sunrise" => vec!["tmsunrise.exe".into()],
        "tm-original" => vec!["tmoriginal.exe".into(), "trackmania.exe".into()],
        g if crate::launch::title_id(g).is_some() => vec!["maniaplanet.exe".into()],
        _ => vec![],
    };
    if let Some(name) = exe.and_then(|e| e.rsplit(['/', '\\']).next()).filter(|n| !n.is_empty()).map(|n| n.to_lowercase()) {
        if !v.contains(&name) {
            v.push(name);
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_roundtrip() {
        let v = json!({ "v": 1, "client_id": "123" });
        let f = encode_frame(OP_HANDSHAKE, &v);
        assert_eq!(&f[0..4], &[0, 0, 0, 0]);
        assert_eq!(u32::from_le_bytes(f[4..8].try_into().unwrap()) as usize, f.len() - 8);
        let (op, back) = read_frame(&mut std::io::Cursor::new(f)).unwrap();
        assert_eq!(op, OP_HANDSHAKE);
        assert_eq!(back, v);
    }

    #[test]
    fn oversized_frame_refused() {
        let mut f = vec![1, 0, 0, 0];
        f.extend_from_slice(&(1u32 << 20).to_le_bytes());
        assert!(read_frame(&mut std::io::Cursor::new(f)).is_err());
    }

    #[test]
    fn activity_shape() {
        let c = activity_command(42, "TrackMania Nations ESWC", "tmn-eswc", Some("Default"), None, 1_700_000_000, "n1");
        assert_eq!(c["cmd"], "SET_ACTIVITY");
        assert_eq!(c["args"]["pid"], 42);
        let a = &c["args"]["activity"];
        assert_eq!(a["details"], "Playing TrackMania Nations ESWC");
        assert_eq!(a["timestamps"]["start"], 1_700_000_000u64);
        assert_eq!(a["assets"]["small_image"], "tmhub");
        assert_eq!(a["assets"]["small_text"], "TM Horizon");
        assert_eq!(a["state"], "Profile: Default");
        let none = activity_command(1, "Trackmania", "tm2020", None, None, 0, "n");
        assert!(none["args"]["activity"].get("state").is_none());
    }

    #[test]
    fn presence_rules() {
        let id = "123456789012345678";
        assert!(valid_app_id(id));
        assert!(!valid_app_id(""));
        assert!(!valid_app_id("12345"));
        assert!(!valid_app_id("12345678901234567a"));
        assert!(should_set_presence(id, &["CoreMod".into(), "TMUnlimiter".into()]));
        // TMInterface has its own Discord status: no second one from the launcher.
        assert!(!should_set_presence(id, &["TMInterface".into(), "CoreMod".into()]));
        assert!(!should_set_presence("", &[]));
    }

    #[test]
    fn tas_activity_shape() {
        for (tool, name, asset) in [(TasTool::Tick, "TICK", "tas-tick"), (TasTool::ForeverTas, "ForeverTAS", "tas-forevertas")] {
            let c = activity_command(1, "TrackMania Nations Forever", "tmnf", Some("TAS"), Some(tool), 5, "n");
            let a = &c["args"]["activity"];
            assert_eq!(a["details"], "TAS \u{b7} TrackMania Nations Forever");
            assert_eq!(a["state"], format!("with {name}"));
            assert_eq!(a["assets"]["large_image"], "tmnf");
            assert_eq!(a["assets"]["small_image"], asset);
            assert_eq!(a["assets"]["small_text"], name);
        }
    }

    #[test]
    fn tool_detection() {
        let run = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(detect_tool(false, "tm2020", &run(&["tick.exe"])), None);
        assert_eq!(detect_tool(true, "tm2020", &run(&["trackmania.exe", "tick.exe"])), Some(TasTool::Tick));
        assert_eq!(detect_tool(true, "tm2020", &run(&["trackmania.exe", "unins000.exe"])), None);
        assert_eq!(detect_tool(true, "tmuf", &run(&["tmforever.exe", "forevertas.exe"])), Some(TasTool::ForeverTas));
        // A tool only counts for its own game.
        assert_eq!(detect_tool(true, "tmnf", &run(&["tick.exe"])), None);
        assert_eq!(detect_tool(true, "tm2020", &run(&["forevertas.exe"])), None);
        assert_eq!(detect_tool(true, "tmnf", &run(&["tmforever.exe"])), None);
    }

    #[test]
    fn process_names_per_game() {
        assert_eq!(process_names("tmuf", None), vec!["tmforever.exe"]);
        assert_eq!(process_names("tm2-stadium", Some(r"C:\MP\ManiaPlanet.exe")), vec!["maniaplanet.exe"]);
        assert_eq!(process_names("tmn-eswc", Some(r"D:\ESWC\TmNationsESWC.exe")), vec!["tmnationseswc.exe"]);
    }

    fn req(game: &str, procs: &[&str]) -> PresenceRequest {
        PresenceRequest { app_id: "1".into(), game_id: game.into(), game_name: game.into(), profile: None, show_tas: true, processes: procs.iter().map(|s| s.to_string()).collect() }
    }

    fn cfg(enabled: bool, show_tas: bool, forever: &str) -> Cfg {
        Cfg { enabled, show_tas, forever_default: forever.into() }
    }

    #[test]
    fn browsing_while_only_the_launcher_is_open() {
        let run = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let on = cfg(true, true, "tmnf");
        assert_eq!(decide(&on, None, &run(&["explorer.exe"])), (Want::Browsing, false));
        assert_eq!(decide(&cfg(false, true, "tmnf"), None, &run(&[])), (Want::Nothing, false), "setting off: nothing");
        let r = req("tmuf", &["tmforever.exe"]);
        // Started, not up yet: still browsing.
        assert_eq!(decide(&on, Some((&r, false, false)), &run(&[])), (Want::Browsing, false));
        assert_eq!(decide(&on, Some((&r, true, false)), &run(&["tmforever.exe"])), (Want::Playing(None), false));
        assert_eq!(decide(&on, Some((&r, true, false)), &run(&["tmforever.exe", "forevertas.exe"])), (Want::Playing(Some(TasTool::ForeverTas)), false));
        // The game closed: back to browsing, the request is done.
        assert_eq!(decide(&on, Some((&r, true, false)), &run(&[])), (Want::Browsing, true));
        // It never came up within the wait.
        assert_eq!(decide(&on, Some((&r, false, true)), &run(&[])), (Want::Browsing, true));
        // Setting switched off while playing.
        assert_eq!(decide(&cfg(false, true, "tmnf"), Some((&r, true, false)), &run(&["tmforever.exe"])), (Want::Nothing, true));
    }

    #[test]
    fn direct_start_shows_the_game() {
        let run = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let on = cfg(true, true, "tmnf");
        // Started outside TM Horizon: "Playing <game>", Forever follows the scan default.
        assert_eq!(decide(&on, None, &run(&["tmforever.exe"])), (Want::Direct("tmnf".into(), None), false));
        assert_eq!(decide(&cfg(true, true, "tmuf"), None, &run(&["tmforever.exe"])), (Want::Direct("tmuf".into(), None), false));
        assert_eq!(decide(&on, None, &run(&["explorer.exe", "trackmania.exe"])), (Want::Direct("tm2020".into(), None), false));
        // TAS tool as for launcher starts, only with the setting on.
        assert_eq!(decide(&on, None, &run(&["tmforever.exe", "forevertas.exe"])), (Want::Direct("tmnf".into(), Some(TasTool::ForeverTas)), false));
        assert_eq!(decide(&cfg(true, false, "tmnf"), None, &run(&["tmforever.exe", "forevertas.exe"])), (Want::Direct("tmnf".into(), None), false));
        // Presence off: nothing.
        assert_eq!(decide(&cfg(false, true, "tmnf"), None, &run(&["tmforever.exe"])), (Want::Nothing, false));
        // A game TM Horizon started has priority over another one that runs.
        let r = req("tm2020", &["trackmania.exe"]);
        assert_eq!(decide(&on, Some((&r, true, false)), &run(&["tmforever.exe", "trackmania.exe"])), (Want::Playing(None), false));
        // Its game closed while the other runs: that one is shown.
        assert_eq!(decide(&on, Some((&r, true, false)), &run(&["tmforever.exe"])), (Want::Direct("tmnf".into(), None), true));
        // Name for the activity.
        let c = activity_command(1, game_name("tmnf"), "tmnf", None, None, 9, "n");
        assert_eq!(c["args"]["activity"]["details"], "Playing TrackMania Nations Forever");
        assert!(c["args"]["activity"].get("state").is_none());
    }

    #[test]
    fn browsing_shape() {
        let c = browsing_command(7, 100, "n");
        let a = &c["args"]["activity"];
        assert_eq!(c["cmd"], "SET_ACTIVITY");
        assert_eq!(a["details"], "In TM Horizon");
        assert_eq!(a["state"], "Browsing");
        assert_eq!(a["assets"]["large_image"], ICON_KEY);
        assert_eq!(a["timestamps"]["start"], 100);
    }
}
