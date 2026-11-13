//! Server processes: started hidden with their output in a log file, each server in its own Windows
//! Job object (everything it starts, e.g. the dedicated server a controller launches, is in the same
//! job; the job kills them all when the launcher process ends or the server is stopped). A PID file
//! per server lets the next launcher start find servers that outlived it (crash, Linux).

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PidFile {
    pub pid: u32,
    /// File name of the program (lower case), checked before a PID is trusted (PIDs get reused).
    pub exe: String,
    pub started: u64,
    /// UPnP mappings made for this run ("TCP:2350"), removed on stop or on the next start.
    pub upnp: Vec<String>,
}

pub fn pid_path(dir: &Path) -> PathBuf {
    dir.join("run.json")
}

pub fn read_pid(dir: &Path) -> Option<PidFile> {
    std::fs::read(pid_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn write_pid(dir: &Path, p: &PidFile) -> Result<(), String> {
    std::fs::write(pid_path(dir), serde_json::to_vec_pretty(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn clear_pid(dir: &Path) {
    let _ = std::fs::remove_file(pid_path(dir));
}

/// What the PID file says about a server after a launcher start.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Leftover {
    None,
    /// The process still runs (same PID, same program name): offer stop or keep.
    Alive,
    /// The file is stale (process gone or the PID belongs to another program now).
    Stale,
}

pub fn check_leftover(p: Option<&PidFile>, name_of: &dyn Fn(u32) -> Option<String>) -> Leftover {
    let Some(p) = p else { return Leftover::None };
    match name_of(p.pid) {
        Some(n) if !p.exe.is_empty() && n.eq_ignore_ascii_case(&p.exe) => Leftover::Alive,
        _ => Leftover::Stale,
    }
}

/// Program file name of a running process (lower case), None if no such process.
#[cfg(windows)]
pub fn process_name(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        let mut out = None;
        while ok != 0 {
            if e.th32ProcessID == pid {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                out = Some(String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase());
                break;
            }
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
        out
    }
}

#[cfg(not(windows))]
pub fn process_name(pid: u32) -> Option<String> {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    Some(exe.file_name()?.to_string_lossy().to_lowercase())
}

/// SIGTERM to the process group `pid` leads. Never signals anything else: refuses pid <= 1, a
/// process that is not its own group leader, and the group this process itself belongs to.
#[cfg(unix)]
pub fn term_group(pid: u32) -> bool {
    if pid <= 1 || pid > i32::MAX as u32 {
        return false;
    }
    let pid = pid as libc::pid_t;
    unsafe {
        if libc::getpgid(pid) != pid || libc::getpgrp() == pid {
            return false;
        }
        libc::killpg(pid, libc::SIGTERM) == 0
    }
}

/// Ends a leftover process, only if it still is the program the PID file names.
pub fn kill_leftover(p: &PidFile) -> Result<(), String> {
    if check_leftover(Some(p), &process_name) != Leftover::Alive {
        return Ok(());
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let h = OpenProcess(PROCESS_TERMINATE, 0, p.pid);
        if h.is_null() {
            return Err(io::Error::last_os_error().to_string());
        }
        let ok = TerminateProcess(h, 1);
        CloseHandle(h);
        if ok == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // the server was started in its own process group: end the group
        term_group(p.pid);
        Ok(())
    }
}

// ------------------------------------------------------------------ job objects

#[cfg(windows)]
pub struct Job(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    pub fn new() -> io::Result<Job> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            if ok == 0 {
                let e = io::Error::last_os_error();
                windows_sys::Win32::Foundation::CloseHandle(h);
                return Err(e);
            }
            Ok(Job(h))
        }
    }

    pub fn assign(&self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as _) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Ends every process of the job now.
    pub fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE: closing the last handle ends the processes still in it.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// A started server process (and, on Windows, its job).
pub struct Proc {
    pub child: Child,
    #[cfg(windows)]
    pub job: Option<Job>,
    pub pid: u32,
}

impl Proc {
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Hard stop: the whole job (Windows) or the process group (Linux).
    pub fn kill(&mut self) {
        #[cfg(windows)]
        if let Some(j) = &self.job {
            j.terminate();
        }
        #[cfg(not(windows))]
        {
            term_group(self.pid);
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Waits up to `ms` for the process to end by itself.
    pub fn wait_exit(&mut self, ms: u64) -> bool {
        let until = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < until {
            if !self.alive() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        !self.alive()
    }
}

pub struct Spawn<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    /// Secrets go through the environment, never the command line.
    pub env: &'a [(String, String)],
    pub log: &'a Path,
}

/// Starts hidden, output into `log` (the previous log is kept as `.1`).
pub fn spawn(s: &Spawn) -> io::Result<Proc> {
    if s.log.exists() {
        let _ = std::fs::rename(s.log, s.log.with_extension("log.1"));
    }
    let out = std::fs::File::create(s.log)?;
    let err = out.try_clone()?;
    let mut cmd = Command::new(s.program);
    cmd.args(s.args).current_dir(s.cwd).stdin(Stdio::null()).stdout(Stdio::from(out)).stderr(Stdio::from(err));
    for (k, v) in s.env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd.spawn()?;
    let pid = child.id();
    #[cfg(windows)]
    {
        let job = Job::new().ok();
        if let Some(j) = &job {
            let _ = j.assign(&child);
        }
        Ok(Proc { child, job, pid })
    }
    #[cfg(not(windows))]
    Ok(Proc { child, pid })
}

/// Only this user may read the file (server config with passwords, secrets file).
pub fn restrict_to_user(p: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(user) = std::env::var("USERNAME") {
            let _ = Command::new("icacls")
                .arg(p)
                .args(["/inheritance:r", "/grant:r"])
                .arg(format!("{user}:F"))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x0800_0000)
                .status();
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
    }
}

/// Last `max` bytes of a log file, as text (for the log view).
pub fn tail(p: &Path, max: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(p) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > max {
        let _ = f.seek(SeekFrom::Start(len - max));
    }
    let mut b = Vec::new();
    let _ = f.read_to_end(&mut b);
    let s = String::from_utf8_lossy(&b).into_owned();
    if len > max {
        // drop the cut first line
        s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or(s)
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sleeper() -> (PathBuf, Vec<String>) {
        if cfg!(windows) {
            (PathBuf::from("cmd"), vec!["/c".into(), "ping -n 30 127.0.0.1 >nul".into()])
        } else {
            (PathBuf::from("sleep"), vec!["30".into()])
        }
    }

    #[test]
    fn spawn_kill_and_log() {
        let t = tempfile::tempdir().unwrap();
        let (prog, args) = sleeper();
        let log = t.path().join("console.log");
        std::fs::write(&log, "old").unwrap();
        let mut p = spawn(&Spawn { program: &prog, args: &args, cwd: t.path(), env: &[("X_SECRET".into(), "v".into())], log: &log }).unwrap();
        assert!(p.alive());
        assert!(t.path().join("console.log.1").exists(), "previous log kept");
        #[cfg(windows)]
        assert!(p.job.is_some());
        let started = std::time::Instant::now();
        p.kill();
        assert!(!p.alive());
        assert!(started.elapsed().as_secs() < 10);
    }

    #[cfg(windows)]
    #[test]
    fn job_kills_grandchildren() {
        // cmd starts ping as its own child; ending the job ends both
        let t = tempfile::tempdir().unwrap();
        let log = t.path().join("c.log");
        let args = vec!["/c".to_string(), "ping -n 60 127.0.0.1".to_string()];
        let mut p = spawn(&Spawn { program: Path::new("cmd"), args: &args, cwd: t.path(), env: &[], log: &log }).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let pings_before = crate::platform::running_process_names().iter().filter(|n| *n == "ping.exe").count();
        p.kill();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let pings_after = crate::platform::running_process_names().iter().filter(|n| *n == "ping.exe").count();
        assert!(pings_after < pings_before, "the grandchild ping.exe ended with the job ({pings_before} -> {pings_after})");
    }

    #[test]
    fn leftovers() {
        let me = std::process::id();
        let my_name = process_name(me).unwrap();
        let alive = PidFile { pid: me, exe: my_name.clone(), started: 1, upnp: vec![] };
        assert_eq!(check_leftover(Some(&alive), &process_name), Leftover::Alive);
        // same PID, other program: reused PID, never trusted
        let reused = PidFile { exe: "trackmaniaserver.exe".into(), ..alive.clone() };
        assert_eq!(check_leftover(Some(&reused), &process_name), Leftover::Stale);
        assert_eq!(check_leftover(Some(&PidFile { pid: 0xFFFF_FFF0, exe: my_name, ..Default::default() }), &process_name), Leftover::Stale);
        assert_eq!(check_leftover(None, &process_name), Leftover::None);
        // kill_leftover refuses anything that is not the named program (here: this test runner is
        // named, so we only check the refusing path with the reused file)
        kill_leftover(&reused).unwrap();
        assert!(process_name(me).is_some(), "the test process is still alive");
    }

    #[test]
    fn pid_file_roundtrip() {
        let t = tempfile::tempdir().unwrap();
        assert!(read_pid(t.path()).is_none());
        let p = PidFile { pid: 42, exe: "x.exe".into(), started: 7, upnp: vec!["TCP:2350".into()] };
        write_pid(t.path(), &p).unwrap();
        assert_eq!(read_pid(t.path()).unwrap(), p);
        clear_pid(t.path());
        assert!(read_pid(t.path()).is_none());
    }

    #[test]
    fn tail_cuts_at_line() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("l.txt");
        std::fs::write(&f, "line1\nline2\nline3\n").unwrap();
        assert_eq!(tail(&f, 1000), "line1\nline2\nline3\n");
        assert_eq!(tail(&f, 8), "line3\n");
        assert_eq!(tail(&t.path().join("none"), 10), "");
    }
}
