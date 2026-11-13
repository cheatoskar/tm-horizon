//! "Record start": a diagnostic for long hangs during the game's loading bar. With the switch on for a game
//! and the game started from the launcher, the launcher watches the game process for its first 120 seconds,
//! from the outside only (no hooks, no injection, nothing in the game is changed):
//! - every 250 ms: main window title, hung state (`IsHungAppWindow`), CPU time, I/O counters, thread count,
//! - file activity in the user folder (`ReadDirectoryChangesW`, recursive), counted per top-level folder and
//!   second, plus the 20 most touched file names,
//! - size and modified time of `Config\User.FidCache.Gbx` and `C:\ProgramData\TrackMania\Game.FidCache.Gbx`
//!   before the start and after the 120 seconds.
//!
//! Result: `startwatch\<yyyymmdd-hhmmss>_<game>.json` and a short `.txt` timeline in the launcher data folder.
//! Windows only; the aggregation below is plain code and unit tested.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const WATCH_SECONDS: u32 = 120;
pub const SAMPLE_MS: u32 = 250;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Sample {
    pub t_ms: u32,
    pub title: String,
    pub hung: bool,
    pub cpu_ms: u64,
    pub read_bytes: u64,
    pub write_bytes: u64,
    pub read_ops: u64,
    pub write_ops: u64,
    pub threads: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct FsAgg {
    /// top-level folder -> events per second (index = second since process start)
    pub folders: BTreeMap<String, Vec<u32>>,
    pub files: BTreeMap<String, u32>,
    pub total: u32,
}

/// `Tracks\Replays\a\b.Gbx` -> `Tracks\Replays`; `Config\x` -> `Config`; a file in the root -> `(root)`.
pub fn folder_key(rel: &str) -> String {
    let parts: Vec<&str> = rel.split(['\\', '/']).filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [] | [_] => "(root)".into(),
        [a, b, _, ..] if a.eq_ignore_ascii_case("tracks") => format!("{a}\\{b}"),
        [a, ..] => a.to_string(),
    }
}

impl FsAgg {
    pub fn add(&mut self, second: u32, rel: &str) {
        let v = self.folders.entry(folder_key(rel)).or_default();
        if v.len() <= second as usize {
            v.resize(second as usize + 1, 0);
        }
        v[second as usize] += 1;
        *self.files.entry(rel.to_string()).or_default() += 1;
        self.total += 1;
    }

    /// The most touched files, most first.
    pub fn top_files(&self, n: usize) -> Vec<(String, u32)> {
        let mut v: Vec<(String, u32)> = self.files.iter().map(|(k, c)| (k.clone(), *c)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.truncate(n);
        v
    }
}

/// FILE_NOTIFY_INFORMATION records of one `ReadDirectoryChangesW` result: (action, relative name).
pub fn parse_notify(buf: &[u8]) -> Vec<(u32, String)> {
    let mut out = vec![];
    let mut p = 0usize;
    loop {
        let Some(h) = buf.get(p..p + 12) else { break };
        let next = u32::from_le_bytes(h[0..4].try_into().unwrap()) as usize;
        let action = u32::from_le_bytes(h[4..8].try_into().unwrap());
        let len = u32::from_le_bytes(h[8..12].try_into().unwrap()) as usize;
        let Some(name) = buf.get(p + 12..p + 12 + len) else { break };
        let u: Vec<u16> = name.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        out.push((action, String::from_utf16_lossy(&u)));
        if next == 0 {
            break;
        }
        p += next;
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Summary {
    pub seconds: f64,
    pub hung_ms: u64,
    pub longest_hung_ms: u64,
    /// Longest stretch where the process used (almost) no CPU.
    pub longest_idle_ms: u64,
    pub cpu_ms: u64,
    pub read_mb: f64,
    pub write_mb: f64,
    pub fs_events: u32,
    pub title_changes: u32,
}

pub fn summarize(samples: &[Sample], fs_total: u32) -> Summary {
    let mut s = Summary { fs_events: fs_total, ..Default::default() };
    let (mut hung_run, mut idle_run) = (0u64, 0u64);
    for (i, x) in samples.iter().enumerate() {
        if x.hung {
            s.hung_ms += SAMPLE_MS as u64;
            hung_run += SAMPLE_MS as u64;
            s.longest_hung_ms = s.longest_hung_ms.max(hung_run);
        } else {
            hung_run = 0;
        }
        if i > 0 {
            let p = &samples[i - 1];
            if x.title != p.title {
                s.title_changes += 1;
            }
            if x.cpu_ms.saturating_sub(p.cpu_ms) < 5 {
                idle_run += (x.t_ms.saturating_sub(p.t_ms)) as u64;
                s.longest_idle_ms = s.longest_idle_ms.max(idle_run);
            } else {
                idle_run = 0;
            }
        }
    }
    if let Some(l) = samples.last() {
        s.seconds = l.t_ms as f64 / 1000.0;
        s.cpu_ms = l.cpu_ms;
        s.read_mb = l.read_bytes as f64 / 1048576.0;
        s.write_mb = l.write_bytes as f64 / 1048576.0;
    }
    s
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Record {
    pub version: u32,
    pub game: String,
    pub started: String,
    /// Process exit within the 120 seconds (ms since start).
    pub exit_ms: Option<u64>,
    pub samples: Vec<Sample>,
    pub fs: FsAgg,
    pub caches_before: Vec<FileStat>,
    pub caches_after: Vec<FileStat>,
    pub summary: Summary,
}

pub fn stat_file(p: &Path) -> FileStat {
    let m = std::fs::metadata(p).ok();
    FileStat { path: p.to_string_lossy().into(), size: m.as_ref().map(|m| m.len()), modified: m.and_then(|m| m.modified().ok()).map(crate::fsx::iso) }
}

/// The human-readable timeline: one line per 5 seconds plus the odd spots.
pub fn timeline(r: &Record) -> String {
    let mut o = format!("Start recording {} at {}\r\n", r.game, r.started);
    let s = &r.summary;
    o += &format!(
        "Watched {:.0} s{}. CPU {:.1} s, read {:.0} MB, written {:.0} MB, hung {:.1} s (longest {:.1} s), no CPU for up to {:.1} s, {} file events.\r\n\r\n",
        s.seconds,
        r.exit_ms.map(|e| format!(", the game exited after {:.1} s", e as f64 / 1000.0)).unwrap_or_default(),
        s.cpu_ms as f64 / 1000.0,
        s.read_mb,
        s.write_mb,
        s.hung_ms as f64 / 1000.0,
        s.longest_hung_ms as f64 / 1000.0,
        s.longest_idle_ms as f64 / 1000.0,
        s.fs_events
    );
    o += "  sec  hung  cpu s  read MB  threads  files  title\r\n";
    let mut last_cpu = 0u64;
    let mut last_read = 0u64;
    let mut sec = 0u32;
    while sec * 1000 <= r.samples.last().map(|x| x.t_ms).unwrap_or(0) {
        let upto = sec * 1000 + 5000;
        let win: Vec<&Sample> = r.samples.iter().filter(|x| x.t_ms >= sec * 1000 && x.t_ms < upto).collect();
        if let Some(l) = win.last() {
            let hung = win.iter().filter(|x| x.hung).count() as u32 * SAMPLE_MS / 1000;
            let fs: u32 = r.fs.folders.values().map(|v| v.iter().skip(sec as usize).take(5).sum::<u32>()).sum();
            o += &format!(
                "{:5}  {:4}  {:5.1}  {:7.1}  {:7}  {:5}  {}\r\n",
                sec,
                hung,
                (l.cpu_ms.saturating_sub(last_cpu)) as f64 / 1000.0,
                (l.read_bytes.saturating_sub(last_read)) as f64 / 1048576.0,
                l.threads,
                fs,
                l.title
            );
            last_cpu = l.cpu_ms;
            last_read = l.read_bytes;
        }
        sec += 5;
    }
    o += "\r\nFile activity per folder (events):\r\n";
    for (k, v) in &r.fs.folders {
        o += &format!("  {k}: {}\r\n", v.iter().sum::<u32>());
    }
    o += "\r\nMost touched files:\r\n";
    for (n, c) in r.fs.top_files(20) {
        o += &format!("  {c:5}  {n}\r\n");
    }
    o += "\r\nCache files (before -> after):\r\n";
    for (a, b) in r.caches_before.iter().zip(&r.caches_after) {
        let f = |x: &FileStat| match x.size {
            Some(sz) => format!("{} bytes, {}", sz, x.modified.clone().unwrap_or_default()),
            None => "not readable".into(),
        };
        o += &format!("  {}\r\n    {}\r\n    {}\r\n", a.path, f(a), f(b));
    }
    o
}

pub fn dir(data: &Path) -> PathBuf {
    data.join("startwatch")
}

fn file_stamp() -> String {
    let s = crate::fsx::now_iso();
    format!("{}{}{}-{}{}{}", &s[0..4], &s[5..7], &s[8..10], &s[11..13], &s[14..16], &s[17..19])
}

/// Writes `<stamp>_<game>.json` and `.txt`.
pub fn save(data: &Path, r: &Record) -> Result<PathBuf, String> {
    let base = dir(data).join(format!("{}_{}", file_stamp(), r.game));
    crate::fsx::write(&base.with_extension("json"), serde_json::to_string_pretty(r).map_err(|e| e.to_string())?.as_bytes())?;
    crate::fsx::write(&base.with_extension("txt"), timeline(r).as_bytes())?;
    Ok(base.with_extension("json"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub file: String,
    pub game: String,
    pub started: String,
    pub exit_ms: Option<u64>,
    pub summary: Summary,
}

/// The newest `n` recordings.
pub fn list(data: &Path, n: usize) -> Vec<Row> {
    let mut names: Vec<String> = crate::fsx::list(&dir(data)).into_iter().filter(|e| !e.is_dir && e.name.ends_with(".json")).map(|e| e.name).collect();
    names.sort();
    names.reverse();
    names
        .into_iter()
        .filter_map(|f| {
            let r: Record = serde_json::from_str(&crate::fsx::read_string(&dir(data).join(&f))?).ok()?;
            Some(Row { file: f, game: r.game, started: r.started, exit_ms: r.exit_ms, summary: r.summary })
        })
        .take(n)
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    pub supported: bool,
    pub on: bool,
    pub rows: Vec<Row>,
}

#[tauri::command]
pub async fn startwatch_state(app: tauri::AppHandle, game_id: String) -> WatchState {
    crate::bg::run(move || -> WatchState {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let prefs = crate::optimize::load_prefs(&st.data_dir);
        WatchState { supported: cfg!(windows), on: prefs.record_start.get(&game_id).copied().unwrap_or(false), rows: list(&st.data_dir, 2) }
    })
    .await
}

#[tauri::command(async)]
pub fn startwatch_set(st: tauri::State<crate::state::AppState>, game_id: String, on: bool) -> Result<(), String> {
    let mut prefs = crate::optimize::load_prefs(&st.data_dir);
    prefs.record_start.insert(game_id, on);
    crate::optimize::save_prefs(&st.data_dir, &prefs)
}

#[tauri::command(async)]
pub fn startwatch_open_folder(app: tauri::AppHandle) -> crate::commands::ActionResult {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let st = app.state::<crate::state::AppState>();
    let d = dir(&st.data_dir);
    if let Err(e) = std::fs::create_dir_all(&d) {
        return crate::commands::fail(e.to_string());
    }
    match app.opener().open_path(d.to_string_lossy(), None::<&str>) {
        Ok(()) => crate::commands::ok("Opened", Some(d.to_string_lossy().into())),
        Err(e) => crate::commands::fail(e.to_string()),
    }
}

/// Called after the launcher started a game: starts the recording when the switch is on.
pub fn maybe_start(st: &crate::state::AppState, game: &str, exe: Option<&str>) {
    #[cfg(windows)]
    {
        use crate::horizonhost as hh;
        if !crate::optimize::load_prefs(&st.data_dir).record_start.get(game).copied().unwrap_or(false) {
            return;
        }
        let Some(name) = exe.and_then(|e| e.rsplit(['/', '\\']).next()).map(|n| n.to_lowercase()) else { return };
        let user = if hh::is_forever(game) {
            crate::platform::documents_dir().map(|d| d.join("TrackMania"))
        } else if hh::is_legacy(game) {
            st.install_dir(game).map(|d| d.join("GameData"))
        } else {
            None
        };
        let Some(user) = user.filter(|u| !crate::fsx::blocked(u)) else { return };
        let data = st.data_dir.clone();
        let game = game.to_string();
        let before = caches(&user);
        std::thread::spawn(move || win::run(&data, &game, &name, &user, before));
    }
    #[cfg(not(windows))]
    {
        let _ = (st, game, exe);
    }
}

fn caches(user: &Path) -> Vec<FileStat> {
    vec![stat_file(&user.join("Config").join("User.FidCache.Gbx")), stat_file(Path::new(r"C:\ProgramData\TrackMania\Game.FidCache.Gbx"))]
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetProcessIoCounters, GetProcessTimes, OpenProcess, IO_COUNTERS, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::System::IO::CancelIoEx;
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow, IsWindowVisible};

    fn find(name: &str) -> Option<(u32, u32)> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e);
            let mut found = None;
            while ok != 0 {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                if String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase() == name {
                    found = Some((e.th32ProcessID, e.cntThreads));
                    break;
                }
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
            found
        }
    }

    struct Win {
        pid: u32,
        title: String,
        hung: bool,
        found: bool,
    }

    unsafe extern "system" fn each(hwnd: HWND, lp: isize) -> i32 {
        let w = &mut *(lp as *mut Win);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == w.pid && IsWindowVisible(hwnd) != 0 {
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), 256).max(0) as usize;
            if n > 0 || !w.found {
                w.title = String::from_utf16_lossy(&buf[..n]);
                w.hung = IsHungAppWindow(hwnd) != 0;
                w.found = true;
            }
            if n > 0 {
                return 0;
            }
        }
        1
    }

    fn ft(f: FILETIME) -> u64 {
        ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
    }

    pub fn run(data: &Path, game: &str, exe: &str, user: &Path, before: Vec<FileStat>) {
        // The process may start late (TMLoader starts it); wait up to 90 s.
        let wait = Instant::now();
        let (pid, _) = loop {
            if let Some(p) = find(exe) {
                break p;
            }
            if wait.elapsed() > Duration::from_secs(90) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        unsafe {
            let h: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return;
            }
            let (mut c, mut x, mut k, mut u) = (std::mem::zeroed::<FILETIME>(), std::mem::zeroed::<FILETIME>(), std::mem::zeroed::<FILETIME>(), std::mem::zeroed::<FILETIME>());
            GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u);
            // Time zero = process creation (FILETIME 100 ns since 1601 -> unix ms).
            let created_unix_ms = (ft(c) / 10_000).saturating_sub(11_644_473_600_000);
            let now_unix_ms = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);

            let agg = Arc::new(Mutex::new(FsAgg::default()));
            let dir_h = {
                let w: Vec<u16> = user.to_string_lossy().encode_utf16().chain(Some(0)).collect();
                CreateFileW(w.as_ptr(), FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, std::ptr::null_mut())
            };
            let mut watcher = None;
            if dir_h != INVALID_HANDLE_VALUE {
                let agg2 = agg.clone();
                let dh = dir_h as usize;
                watcher = Some(std::thread::spawn(move || {
                    let mut buf = vec![0u8; 64 * 1024];
                    loop {
                        let mut got = 0u32;
                        let ok = ReadDirectoryChangesW(
                            dh as HANDLE,
                            buf.as_mut_ptr() as *mut _,
                            buf.len() as u32,
                            1,
                            FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION,
                            &mut got,
                            std::ptr::null_mut(),
                            None,
                        );
                        if ok == 0 {
                            break;
                        }
                        let sec = (now_unix_ms().saturating_sub(created_unix_ms) / 1000) as u32;
                        let mut a = agg2.lock().unwrap();
                        for (_, name) in parse_notify(&buf[..got as usize]) {
                            a.add(sec, &name);
                        }
                    }
                }));
            }

            let mut samples: Vec<Sample> = vec![];
            let mut exit_ms = None;
            loop {
                let t = now_unix_ms().saturating_sub(created_unix_ms);
                if t > WATCH_SECONDS as u64 * 1000 {
                    break;
                }
                let mut code = 0u32;
                if GetExitCodeProcess(h, &mut code) != 0 && code != 259 {
                    exit_ms = Some(t);
                    break;
                }
                let mut w = Win { pid, title: String::new(), hung: false, found: false };
                EnumWindows(Some(each), &mut w as *mut Win as isize);
                GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u);
                let mut io: IO_COUNTERS = std::mem::zeroed();
                GetProcessIoCounters(h, &mut io);
                let threads = find(exe).filter(|p| p.0 == pid).map(|p| p.1).unwrap_or(0);
                samples.push(Sample { t_ms: t as u32, title: w.title, hung: w.hung, cpu_ms: (ft(k) + ft(u)) / 10_000, read_bytes: io.ReadTransferCount, write_bytes: io.WriteTransferCount, read_ops: io.ReadOperationCount, write_ops: io.WriteOperationCount, threads });
                std::thread::sleep(Duration::from_millis(SAMPLE_MS as u64));
            }
            if dir_h != INVALID_HANDLE_VALUE {
                CancelIoEx(dir_h, std::ptr::null());
            }
            if let Some(w) = watcher {
                let _ = w.join();
            }
            if dir_h != INVALID_HANDLE_VALUE {
                CloseHandle(dir_h);
            }
            CloseHandle(h);
            let fs = agg.lock().unwrap().clone();
            let rec = Record {
                version: 1,
                game: game.into(),
                started: crate::fsx::iso(std::time::UNIX_EPOCH + Duration::from_millis(created_unix_ms)),
                exit_ms,
                summary: summarize(&samples, fs.total),
                samples,
                fs,
                caches_before: before,
                caches_after: caches(user),
            };
            if let Err(e) = save(data, &rec) {
                eprintln!("startwatch: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(t: u32, title: &str, hung: bool, cpu: u64, read: u64) -> Sample {
        Sample { t_ms: t, title: title.into(), hung, cpu_ms: cpu, read_bytes: read, threads: 5, ..Default::default() }
    }

    #[test]
    fn folder_keys() {
        assert_eq!(folder_key(r"Tracks\Replays\a\b.Gbx"), r"Tracks\Replays");
        assert_eq!(folder_key("tracks/Challenges/x.Gbx"), r"tracks\Challenges");
        assert_eq!(folder_key(r"Config\User.FidCache.Gbx"), "Config");
        assert_eq!(folder_key("Cache"), "(root)");
        assert_eq!(folder_key(r"Tracks\x.gbx"), "Tracks");
    }

    #[test]
    fn aggregates_per_folder_and_second() {
        let mut a = FsAgg::default();
        a.add(0, r"Tracks\Replays\a.Replay.Gbx");
        a.add(0, r"Tracks\Replays\a.Replay.Gbx");
        a.add(3, r"Tracks\Replays\b.Replay.Gbx");
        a.add(2, r"Config\User.FidCache.Gbx");
        assert_eq!(a.total, 4);
        assert_eq!(a.folders[r"Tracks\Replays"], vec![2, 0, 0, 1]);
        assert_eq!(a.folders["Config"], vec![0, 0, 1]);
        assert_eq!(a.top_files(1), vec![(r"Tracks\Replays\a.Replay.Gbx".to_string(), 2)]);
        assert_eq!(a.top_files(10).len(), 3);
    }

    fn notify(items: &[(u32, &str)]) -> Vec<u8> {
        let mut out = vec![];
        for (i, (act, name)) in items.iter().enumerate() {
            let u: Vec<u8> = name.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
            let rec = 12 + u.len();
            let pad = (4 - rec % 4) % 4;
            let next = if i + 1 == items.len() { 0 } else { (rec + pad) as u32 };
            out.extend(next.to_le_bytes());
            out.extend(act.to_le_bytes());
            out.extend((u.len() as u32).to_le_bytes());
            out.extend(u);
            if i + 1 != items.len() {
                out.extend(std::iter::repeat(0u8).take(pad));
            }
        }
        out
    }

    #[test]
    fn parses_notify_buffers() {
        let b = notify(&[(1, r"Tracks\a.Gbx"), (3, "Cache"), (2, "x")]);
        assert_eq!(parse_notify(&b), vec![(1, r"Tracks\a.Gbx".to_string()), (3, "Cache".to_string()), (2, "x".to_string())]);
        assert!(parse_notify(&[]).is_empty());
        assert!(parse_notify(&[1, 2, 3]).is_empty());
        let mut cut = notify(&[(1, "abcdef")]);
        cut.truncate(16);
        assert!(parse_notify(&cut).is_empty(), "a cut record is dropped, no panic");
    }

    #[test]
    fn summary_finds_hangs_and_idle() {
        let v = vec![s(0, "a", false, 0, 0), s(250, "a", true, 100, 1048576), s(500, "a", true, 100, 2097152), s(750, "Loading", true, 100, 2097152), s(1000, "Loading", false, 400, 3145728)];
        let m = summarize(&v, 7);
        assert_eq!((m.hung_ms, m.longest_hung_ms), (750, 750));
        assert_eq!(m.longest_idle_ms, 500, "250..750 without CPU");
        assert_eq!((m.title_changes, m.fs_events, m.cpu_ms), (1, 7, 400));
        assert_eq!(m.read_mb, 3.0);
        assert_eq!(m.seconds, 1.0);
        assert_eq!(summarize(&[], 0), Summary::default());
    }

    #[test]
    fn saves_lists_and_renders() {
        let t = tempfile::tempdir().unwrap();
        let mut fs = FsAgg::default();
        fs.add(1, r"Tracks\Replays\a.Gbx");
        let samples: Vec<Sample> = (0..40).map(|i| s(i * 250, "TrackMania", i > 10 && i < 20, i as u64 * 50, i as u64 * 1000)).collect();
        let rec = Record {
            version: 1,
            game: "tmnf".into(),
            started: "2026-11-11T10:00:00Z".into(),
            exit_ms: None,
            summary: summarize(&samples, fs.total),
            samples,
            fs,
            caches_before: vec![FileStat { path: "a".into(), size: Some(5), modified: None }],
            caches_after: vec![FileStat { path: "a".into(), size: None, modified: None }],
        };
        let p = save(t.path(), &rec).unwrap();
        assert!(p.is_file() && p.with_extension("txt").is_file());
        let rows = list(t.path(), 2);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].game, "tmnf");
        assert!(rows[0].summary.hung_ms > 0);
        let txt = timeline(&rec);
        assert!(txt.contains("Tracks\\Replays: 1") && txt.contains("not readable") && txt.contains("TrackMania"));
    }
}
