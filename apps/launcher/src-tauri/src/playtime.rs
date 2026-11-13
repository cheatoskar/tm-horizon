//! Play time per game, per separate installation (instance) and per game copy, counted while the
//! game's process runs and TM Horizon is open. One watcher thread looks at the running processes
//! every few seconds: games started by TM Horizon, by TMX "Play", by a shortcut or by the game's own
//! file association all count. The exe's folder tells which copy runs (copies.rs); a start from TM
//! Horizon leaves a hint with its game id (ManiaPlanet titles, instances) for the process it starts.
//! Stored locally in `<app data>\playtime.json` and `playsessions.json`; nothing is sent anywhere.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Poll interval while a game runs.
pub const POLL_MS: u64 = 5_000;
/// The process has to show up within this long after the start.
pub const START_WAIT_MS: u64 = 180_000;
/// One poll counts at most this long (a sleeping PC does not add hours).
pub const MAX_STEP_MS: u64 = 3 * POLL_MS;
/// Polls without the process before the session is over.
const MISSES: u32 = 2;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    pub seconds: u64,
    pub sessions: u32,
    /// Unix ms of the last session's end.
    pub last_played: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    /// Key: game id, or `game@instance`.
    pub games: BTreeMap<String, Entry>,
}

pub fn file(data: &Path) -> PathBuf {
    data.join("playtime.json")
}

pub fn load(data: &Path) -> Store {
    std::fs::read(file(data)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static L: Mutex<()> = Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

/// Adds time (and optionally a finished session) to a key.
pub fn add(data: &Path, key: &str, seconds: u64, session_end: Option<u64>) -> Result<(), String> {
    let _g = lock();
    let mut s = load(data);
    let e = s.games.entry(key.to_string()).or_default();
    e.seconds += seconds;
    if let Some(t) = session_end {
        e.sessions += 1;
        e.last_played = t;
    }
    crate::fsx::write(&file(data), &serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?)
}

/// One finished session (for the statistics page: play time per day).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionRec {
    /// Game id or `game@instance`.
    pub key: String,
    /// Unix ms: first and last time the process was seen.
    pub start: u64,
    pub end: u64,
    pub seconds: u64,
    /// Copy id (copies.rs) the exe ran from; None for sessions from before 0.5.1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy: Option<String>,
}

/// Sessions kept at most (oldest go first).
pub const MAX_SESSIONS: usize = 5000;

pub fn sessions_file(data: &Path) -> PathBuf {
    data.join("playsessions.json")
}

pub fn load_sessions(data: &Path) -> Vec<SessionRec> {
    std::fs::read(sessions_file(data)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Appends a finished session.
pub fn log_session(data: &Path, rec: SessionRec) -> Result<(), String> {
    let _g = lock();
    let mut v = load_sessions(data);
    v.push(rec);
    if v.len() > MAX_SESSIONS {
        let n = v.len() - MAX_SESSIONS;
        v.drain(..n);
    }
    crate::fsx::write(&sessions_file(data), &serde_json::to_vec(&v).map_err(|e| e.to_string())?)
}

/// Counting of one session; time goes in, "how much to add" and "is it over" come out.
#[derive(Debug)]
pub struct Session {
    started: u64,
    last: Option<u64>,
    misses: u32,
    done: bool,
}

impl Session {
    pub fn new(now_ms: u64) -> Self {
        Session { started: now_ms, last: None, misses: 0, done: false }
    }
    pub fn done(&self) -> bool {
        self.done
    }
    /// The process was seen at least once.
    pub fn played(&self) -> bool {
        self.last.is_some()
    }
    /// One poll: `running` = the game's process exists. Returns the milliseconds to add.
    pub fn tick(&mut self, now_ms: u64, running: bool) -> u64 {
        if self.done {
            return 0;
        }
        match (self.last, running) {
            (None, true) => {
                self.last = Some(now_ms);
                0
            }
            (None, false) => {
                if now_ms.saturating_sub(self.started) > START_WAIT_MS {
                    self.done = true;
                }
                0
            }
            (Some(l), true) => {
                self.misses = 0;
                self.last = Some(now_ms);
                now_ms.saturating_sub(l).min(MAX_STEP_MS)
            }
            (Some(_), false) => {
                self.misses += 1;
                if self.misses >= MISSES {
                    self.done = true;
                }
                // The process ended somewhere since the last poll: count half a step.
                POLL_MS / 2
            }
        }
    }
}

/// What TM Horizon just started: the next new process with one of these names gets this key.
#[derive(Debug, Clone)]
pub struct Hint {
    pub key: String,
    pub processes: Vec<String>,
    pub at: u64,
}

fn hints() -> &'static Mutex<Vec<Hint>> {
    static H: OnceLock<Mutex<Vec<Hint>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(Vec::new()))
}

/// A game TM Horizon just started: its process (when it shows up within START_WAIT_MS) counts under
/// `key` (game id or `game@instance`). The watcher counts it either way; the hint only names it.
pub fn track(_data: PathBuf, key: String, processes: Vec<String>) {
    if processes.is_empty() {
        return;
    }
    let now = crate::tmxupload::now_ms();
    let mut h = hints().lock().unwrap_or_else(|e| e.into_inner());
    h.retain(|x| now.saturating_sub(x.at) < START_WAIT_MS && x.key != key);
    h.push(Hint { key, processes: processes.iter().map(|p| p.to_lowercase()).collect(), at: now });
}

/// Takes the newest unexpired hint for a process name.
pub fn take_hint(hints: &mut Vec<Hint>, name: &str, now: u64) -> Option<Hint> {
    hints.retain(|x| now.saturating_sub(x.at) < START_WAIT_MS);
    let i = hints.iter().rposition(|h| h.processes.iter().any(|p| p == name))?;
    Some(hints.remove(i))
}

/// Exe names the watcher looks for (lower case).
pub const GAME_EXES: [&str; 7] = ["tmforever.exe", "tmnationseswc.exe", "tmsunrise.exe", "tmoriginal.exe", "trackmania.exe", "trackmaniaturbo.exe", "maniaplanet.exe"];

/// Game id of an exe that is in no known copy (moved, or a folder the scan has not seen).
pub fn game_of_name(name: &str, forever_default: &str) -> Option<String> {
    Some(match name {
        "tmforever.exe" => forever_default.to_string(),
        "tmnationseswc.exe" => "tmn-eswc".into(),
        "tmsunrise.exe" => "tm-sunrise".into(),
        "tmoriginal.exe" => "tm-original".into(),
        "trackmania.exe" => "tm2020".into(),
        "trackmaniaturbo.exe" => "tm-turbo".into(),
        "maniaplanet.exe" => "maniaplanet".into(),
        _ => return None,
    })
}

/// Who a running game process is: play-time key and copy id.
pub fn identify(p: &crate::platform::Proc, copies: &[crate::copies::GameCopy], hints: &mut Vec<Hint>, now: u64, forever_default: &str) -> Option<(String, Option<String>)> {
    let found = p.path.as_deref().and_then(|e| crate::copies::of_exe(copies, e));
    let copy = found.as_ref().map(|(c, _)| c.clone());
    if let Some(h) = take_hint(hints, &p.name, now) {
        return Some((h.key, copy));
    }
    match found {
        Some((c, game)) => {
            let inst = copies.iter().find(|x| x.id == c).and_then(|x| x.instance.clone());
            Some((inst.map(|i| format!("{game}@{i}")).unwrap_or(game), Some(c)))
        }
        // An exe named trackmania.exe in no copy is Trackmania (2020); Original's is in its copy.
        None => game_of_name(&p.name, forever_default).map(|g| (g, None)),
    }
}

/// One process being counted.
#[derive(Debug)]
struct Live {
    key: String,
    copy: Option<String>,
    s: Session,
    pending: u64,
    total: u64,
    first: u64,
    flushed: u64,
}

/// What a poll wants written.
#[derive(Debug, Clone, PartialEq)]
pub enum Write {
    /// Seconds to add to a key; with a session end when the session is over.
    Add { key: String, seconds: u64, end: Option<u64> },
    Session(SessionRec),
}

/// The watcher's state: one session per process id.
#[derive(Debug, Default)]
pub struct Watcher {
    live: HashMap<u32, Live>,
}

impl Watcher {
    pub fn counting(&self) -> usize {
        self.live.len()
    }

    /// One look at the running game processes. `who` names a new process (None = not a game).
    pub fn poll(&mut self, now: u64, procs: &[crate::platform::Proc], who: &mut dyn FnMut(&crate::platform::Proc) -> Option<(String, Option<String>)>) -> Vec<Write> {
        let mut out = vec![];
        for p in procs {
            if self.live.contains_key(&p.pid) {
                continue;
            }
            if let Some((key, copy)) = who(p) {
                let mut s = Session::new(now);
                s.tick(now, true);
                self.live.insert(p.pid, Live { key, copy, s, pending: 0, total: 0, first: now, flushed: now });
            }
        }
        let mut done = vec![];
        for (pid, l) in self.live.iter_mut() {
            let running = procs.iter().any(|p| p.pid == *pid);
            let step = l.s.tick(now, running);
            l.pending += step;
            l.total += step;
            if l.s.done() {
                done.push(*pid);
            } else if l.pending >= 60_000 && now.saturating_sub(l.flushed) >= 60_000 {
                out.push(Write::Add { key: l.key.clone(), seconds: l.pending / 1000, end: None });
                l.pending %= 1000;
                l.flushed = now;
            }
        }
        for pid in done {
            if let Some(l) = self.live.remove(&pid) {
                out.push(Write::Add { key: l.key.clone(), seconds: l.pending / 1000, end: Some(now) });
                out.push(Write::Session(SessionRec { key: l.key, start: l.first, end: now, seconds: l.total / 1000, copy: l.copy }));
            }
        }
        out
    }

    /// The launcher closes: what was counted so far is kept (no session record: it has no end).
    pub fn flush(&mut self) -> Vec<Write> {
        self.live.values_mut().filter(|l| l.pending >= 1000).map(|l| {
            let w = Write::Add { key: l.key.clone(), seconds: l.pending / 1000, end: None };
            l.pending %= 1000;
            w
        }).collect()
    }
}

pub fn apply(data: &Path, writes: Vec<Write>) {
    for w in writes {
        let _ = match w {
            Write::Add { key, seconds, end } => add(data, &key, seconds, end),
            Write::Session(r) => log_session(data, r),
        };
    }
}

/// The watcher thread (launcher start): every POLL_MS the game processes, copies refreshed every minute.
pub fn start_watcher(app: tauri::AppHandle) {
    use tauri::Manager;
    let _ = std::thread::Builder::new().name("playtime".into()).spawn(move || {
        let mut w = Watcher::default();
        let mut copies: Vec<crate::copies::GameCopy> = vec![];
        let mut names: Vec<String> = GAME_EXES.iter().map(|s| s.to_string()).collect();
        let mut forever_default = "tmnf".to_string();
        let mut refreshed: Option<std::time::Instant> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
            let st = app.state::<crate::state::AppState>();
            if refreshed.is_none_or(|t| t.elapsed() > std::time::Duration::from_secs(60)) {
                copies = crate::copies::all(&st);
                // Renamed game exes (e.g. a patched ESWC exe) of the scanned installs count too.
                for g in ["tmnf", "tmuf", "tmn-eswc", "tm-sunrise", "tm-original", "tm2020"] {
                    for i in crate::horizoncmds::installs_of(&st, g).into_iter().chain(st.install(g)) {
                        if let Some(n) = i.exe.as_deref().and_then(|e| Path::new(e).file_name()).map(|n| n.to_string_lossy().to_lowercase()) {
                            if n.ends_with(".exe") && !names.contains(&n) {
                                names.push(n);
                            }
                        }
                    }
                }
                forever_default = if st.install("tmuf").is_some() && st.install("tmnf").is_none() { "tmuf".into() } else { "tmnf".into() };
                refreshed = Some(std::time::Instant::now());
            }
            let procs = crate::platform::running_processes(&names);
            let now = crate::tmxupload::now_ms();
            let writes = {
                let mut h = hints().lock().unwrap_or_else(|e| e.into_inner());
                w.poll(now, &procs, &mut |p| identify(p, &copies, &mut h, now, &forever_default))
            };
            apply(&st.data_dir, writes);
        }
    });
}

/// Play time per key, for the game page and the library.
#[tauri::command(async)]
pub fn playtime_all(st: tauri::State<crate::state::AppState>) -> Store {
    load(&st.data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_counts_only_while_the_process_runs() {
        let mut s = Session::new(0);
        assert_eq!(s.tick(5_000, false), 0, "not up yet");
        assert_eq!(s.tick(10_000, true), 0, "first sight starts the clock");
        assert_eq!(s.tick(15_000, true), 5_000);
        assert_eq!(s.tick(20_000, true), 5_000);
        // A PC that slept for an hour adds three polls at most.
        assert_eq!(s.tick(3_620_000, true), MAX_STEP_MS);
        assert!(!s.done());
        s.tick(3_625_000, false);
        assert!(!s.done(), "one miss is not the end");
        s.tick(3_630_000, false);
        assert!(s.done() && s.played());
        assert_eq!(s.tick(3_640_000, true), 0);
    }

    #[test]
    fn a_game_that_never_shows_up_is_given_up() {
        let mut s = Session::new(1_000);
        s.tick(60_000, false);
        assert!(!s.done());
        s.tick(1_000 + START_WAIT_MS + 1, false);
        assert!(s.done() && !s.played());
    }

    #[test]
    fn sessions_are_logged_and_capped() {
        let t = tempfile::tempdir().unwrap();
        assert!(load_sessions(t.path()).is_empty());
        for i in 0..3 {
            log_session(t.path(), SessionRec { key: "tmnf".into(), start: i * 10, end: i * 10 + 5, seconds: 5, copy: None }).unwrap();
        }
        let v = load_sessions(t.path());
        assert_eq!(v.len(), 3);
        assert_eq!(v[2].start, 20);
    }

    #[test]
    fn store_adds_per_game_and_instance() {
        let t = tempfile::tempdir().unwrap();
        assert!(load(t.path()).games.is_empty());
        add(t.path(), "tmnf", 600, None).unwrap();
        add(t.path(), "tmnf", 60, Some(1234)).unwrap();
        add(t.path(), "tmnf@copy1", 30, Some(2000)).unwrap();
        let s = load(t.path());
        assert_eq!(s.games["tmnf"], Entry { seconds: 660, sessions: 1, last_played: 1234 });
        assert_eq!(s.games["tmnf@copy1"].seconds, 30);
        std::fs::write(file(t.path()), b"{ broken").unwrap();
        assert!(load(t.path()).games.is_empty());
    }

    fn proc(pid: u32, name: &str, path: &str) -> crate::platform::Proc {
        crate::platform::Proc { pid, name: name.into(), path: Some(PathBuf::from(path)) }
    }

    fn copies() -> Vec<crate::copies::GameCopy> {
        let list = vec![
            crate::copies::Install { game: "tmn-eswc".into(), dir: PathBuf::from("C:/Games/ESWC"), label: "ESWC".into(), instance: None, user_dir: None, selected: true },
            crate::copies::Install { game: "tmn-eswc".into(), dir: PathBuf::from("C:/Games/ESWC-next"), label: "ESWC-next".into(), instance: None, user_dir: None, selected: false },
            crate::copies::Install { game: "tmuf".into(), dir: PathBuf::from("C:/inst/x"), label: "X".into(), instance: Some("x".into()), user_dir: Some("TrackMania_x".into()), selected: false },
        ];
        crate::copies::build(Some(Path::new("C:/Docs")), &list, &|_| None)
    }

    #[test]
    fn direct_starts_count_per_copy() {
        let c = copies();
        let mut hints = vec![];
        let mut w = Watcher::default();
        let mut who = |p: &crate::platform::Proc| identify(p, &c, &mut hints, 0, "tmnf");
        // A game started from a desktop shortcut (no hint): found by its folder.
        let eswc = proc(10, "tmnationseswc.exe", "C:/Games/ESWC-next/TmNationsESWC.exe");
        assert!(w.poll(0, &[eswc.clone()], &mut who).is_empty());
        assert_eq!(w.counting(), 1);
        let mut out = vec![];
        for i in 1..=24 {
            out.extend(w.poll(i * POLL_MS, &[eswc.clone()], &mut who));
        }
        // Two minutes: a minute's flush on the way.
        assert!(out.iter().any(|x| matches!(x, Write::Add { key, seconds, end: None } if key == "tmn-eswc" && *seconds >= 60)), "{out:?}");
        out.extend(w.poll(25 * POLL_MS, &[], &mut who));
        out.extend(w.poll(26 * POLL_MS, &[], &mut who));
        let rec = out.iter().find_map(|x| if let Write::Session(r) = x { Some(r.clone()) } else { None }).expect("session logged");
        assert_eq!(rec.key, "tmn-eswc");
        assert!(rec.copy.as_deref().unwrap().contains("eswc-next"), "{rec:?}");
        let added: u64 = out.iter().filter_map(|x| if let Write::Add { seconds, .. } = x { Some(*seconds) } else { None }).sum();
        assert_eq!((rec.seconds, added), (125, 125), "120 s seen + two half polls while it ended");
        assert_eq!(w.counting(), 0);
    }

    #[test]
    fn hints_name_launcher_starts_and_instances_get_their_key() {
        let c = copies();
        let mut hints = vec![Hint { key: "tm2-canyon".into(), processes: vec!["maniaplanet.exe".into()], at: 0 }];
        let mp = proc(5, "maniaplanet.exe", "C:/MP/ManiaPlanet.exe");
        assert_eq!(identify(&mp, &c, &mut hints, 1000, "tmnf"), Some(("tm2-canyon".into(), None)));
        assert!(hints.is_empty(), "a hint is used once");
        assert_eq!(identify(&mp, &c, &mut hints, 1000, "tmnf"), Some(("maniaplanet".into(), None)));
        // Instance folder: game@instance and the instance's copy.
        let x = proc(6, "tmforever.exe", "C:/inst/x/TmForever.exe");
        let (key, copy) = identify(&x, &c, &mut hints, 0, "tmnf").unwrap();
        assert_eq!(key, "tmuf@x");
        assert!(copy.unwrap().ends_with("trackmania_x"));
        // An old hint does not stick to a later start.
        let mut old = vec![Hint { key: "tmnf@y".into(), processes: vec!["tmforever.exe".into()], at: 0 }];
        let p = proc(7, "tmforever.exe", "D:/Elsewhere/TmForever.exe");
        assert_eq!(identify(&p, &c, &mut old, START_WAIT_MS + 1, "tmuf"), Some(("tmuf".into(), None)));
        // Not a game.
        assert_eq!(identify(&proc(8, "notepad.exe", "C:/x/notepad.exe"), &c, &mut vec![], 0, "tmnf"), None);
    }

    #[test]
    fn flush_keeps_counted_time() {
        let mut w = Watcher::default();
        let p = proc(1, "tmsunrise.exe", "C:/S/TmSunrise.exe");
        let mut who = |_: &crate::platform::Proc| Some(("tm-sunrise".to_string(), None));
        w.poll(0, &[p.clone()], &mut who);
        w.poll(5_000, &[p.clone()], &mut who);
        w.poll(10_000, &[p], &mut who);
        assert_eq!(w.flush(), vec![Write::Add { key: "tm-sunrise".into(), seconds: 10, end: None }]);
        assert!(w.flush().is_empty());
    }
}
