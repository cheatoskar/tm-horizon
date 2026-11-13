//! Linux implementation of the platform layer. The games are Windows programs that live in
//! Wine/Proton prefixes; `wine.rs` finds the prefixes and maps paths, this file plugs that
//! into the functions the scanner and the commands use:
//! - Documents / %LOCALAPPDATA% (TMLoader) come from the main prefix (Settings > Linux, else
//!   the first prefix that has TMLoader, then one with Documents/TrackMania, then any).
//! - "Program Files" is the list of every prefix's Program Files folders, so the normal scan
//!   finds games in all of them; `system.reg` gives the installed-programs list and Ubisoft.
//! - Steam: native, Flatpak and Snap roots; Steam games start through `steam -applaunch`.
//! - Spawning a `.exe` wraps it in Wine, umu-run or Proton (chosen per game, see
//!   `wine::plan_runner`), with host paths in its arguments turned into Windows paths.

use super::wine::{self, Prefix, Tools};
use super::{SignatureInfo, UbisoftInstall, UninstallEntry};
use crate::launch::{Arg, CommandSpec};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const NAME: &str = "linux";

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn user() -> Option<String> {
    std::env::var("USER").ok().filter(|u| !u.is_empty())
}

/// An executable on PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file())
}

// ------------------------------------------------------------------ prefixes (cached)

struct Cache {
    at: Instant,
    generation: u64,
    prefixes: Vec<Prefix>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(10);

pub fn wine_env() -> wine::Env {
    let (_, data_dir, _) = super::config();
    wine::Env {
        home: home(),
        wineprefix: std::env::var_os("WINEPREFIX").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()),
        steam_libraries: crate::scan::steam_libraries().0.into_iter().map(|l| PathBuf::from(l.path)).collect(),
        hub_prefixes: data_dir.map(|d| d.join("prefixes")),
        user: user(),
    }
}

/// Every prefix found (cached for a few seconds; new settings reset it).
pub fn prefixes() -> Vec<Prefix> {
    let (cfg, _, generation) = super::config();
    {
        let c = CACHE.lock().unwrap();
        if let Some(c) = c.as_ref() {
            if c.generation == generation && c.at.elapsed() < TTL {
                return c.prefixes.clone();
            }
        }
    }
    let found = wine::find_prefixes(&wine_env(), &cfg);
    *CACHE.lock().unwrap() = Some(Cache { at: Instant::now(), generation, prefixes: found.clone() });
    found
}

/// The prefix whose Documents and AppData the launcher uses.
pub fn main_prefix() -> Option<PathBuf> {
    let (cfg, _, _) = super::config();
    if let Some(p) = cfg.prefix.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(p));
    }
    pick_main(&prefixes(), user().as_deref())
}

/// TMLoader first, then Documents/TrackMania, then a Forever install, then the first one.
pub fn pick_main(list: &[Prefix], user: Option<&str>) -> Option<PathBuf> {
    let tml = |d: &Path| wine::local_app_data(d, user).map(|l| wine::resolve_ci(&l.join("TMLoader")).is_dir()).unwrap_or(false);
    let docs = |d: &Path| wine::documents(d, user).map(|l| wine::resolve_ci(&l.join("TrackMania")).is_dir()).unwrap_or(false);
    let forever = |d: &Path| {
        wine::program_files(d).iter().any(|pf| {
            ["TmNationsForever", "TmUnitedForever", "TrackMania Nations Forever", "TrackMania United Forever"].iter().any(|n| wine::resolve_ci(&pf.join(n)).is_dir())
        })
    };
    list.iter()
        .find(|p| tml(&p.path))
        .or_else(|| list.iter().find(|p| docs(&p.path)))
        .or_else(|| list.iter().find(|p| forever(&p.path)))
        .or_else(|| list.first())
        .map(|p| p.path.clone())
}

/// Runners TM Horizon downloaded itself (Linux game setup): `<data>/runners/umu/umu-run` and
/// `<data>/runners/proton/<GE-Proton...>`.
pub fn own_runners_dir() -> Option<PathBuf> {
    super::config().1.map(|d| d.join("runners"))
}

pub fn tools() -> Tools {
    let roots = steam_roots();
    let libs: Vec<PathBuf> = crate::scan::steam_libraries().0.into_iter().map(|l| PathBuf::from(l.path)).collect();
    let own = own_runners_dir();
    let own_umu = own.as_ref().map(|d| d.join("umu/umu-run")).filter(|p| p.is_file());
    let mut protons = wine::find_protons(&roots, &libs);
    // Own Proton builds after Steam's (Steam ones are what the user picked there).
    if let Some(d) = &own {
        for p in std::fs::read_dir(d.join("proton")).into_iter().flatten().flatten().map(|e| e.path()) {
            if p.join("proton").is_file() && !protons.contains(&p) {
                protons.push(p);
            }
        }
    }
    Tools { wine: which("wine"), umu: which("umu-run").or(own_umu), protons, steam_root: roots.first().cloned() }
}

/// Whether this wine binary is a staging build (`wine --version`, cached per binary).
pub fn wine_staging(wine: &Path) -> bool {
    static SEEN: Mutex<Vec<(PathBuf, bool)>> = Mutex::new(Vec::new());
    if let Some((_, s)) = SEEN.lock().unwrap().iter().find(|(p, _)| p == wine) {
        return *s;
    }
    let s = Command::new(wine)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| wine::parse_wine_version(&String::from_utf8_lossy(&o.stdout)))
        .map(|(_, s)| s)
        .unwrap_or(false);
    SEEN.lock().unwrap().push((wine.to_path_buf(), s));
    s
}

// ------------------------------------------------------------------ known folders

pub fn documents_dir() -> Option<PathBuf> {
    super::documents_override().or_else(|| main_prefix().and_then(|p| wine::documents(&p, user().as_deref()))).or_else(dirs::document_dir)
}

/// %LOCALAPPDATA% of the main prefix (TMLoader lives there).
pub fn local_app_data() -> Option<PathBuf> {
    main_prefix().and_then(|p| wine::local_app_data(&p, user().as_deref()))
}

/// Program Files folders of every prefix.
pub fn program_files() -> Vec<PathBuf> {
    prefixes().iter().flat_map(|p| wine::program_files(&p.path)).collect()
}

/// Only used for the StarForce ESWC guard (fsx), which must not depend on the prefix search
/// (the search itself goes through fsx). The StarForce version does not run under Wine.
pub fn program_files_x86() -> PathBuf {
    PathBuf::from("/nonexistent/Program Files (x86)")
}

pub fn program_data() -> Option<PathBuf> {
    main_prefix().map(|p| wine::program_data(&p))
}

/// Native Steam, Flatpak Steam and Snap Steam, each once (`~/.steam/steam` is a link).
pub fn steam_roots() -> Vec<PathBuf> {
    let h = home();
    let mut out: Vec<PathBuf> = Vec::new();
    for p in [
        h.join(".local/share/Steam"),
        h.join(".steam/steam"),
        h.join(".steam/root"),
        h.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
        h.join(".var/app/com.valvesoftware.Steam/data/Steam"),
        h.join("snap/steam/common/.local/share/Steam"),
    ] {
        let Ok(real) = std::fs::canonicalize(&p) else { continue };
        if real.join("steamapps").is_dir() && !out.contains(&real) {
            out.push(real);
        }
    }
    out
}

pub fn uninstall_entries() -> Vec<UninstallEntry> {
    let mut out = Vec::new();
    for p in prefixes() {
        for (name, loc) in wine::uninstall_entries(&p.path) {
            out.push(UninstallEntry { name, location: loc.and_then(|l| wine::windows_to_host(&p.path, &l)) });
        }
    }
    out
}

pub fn ubisoft_installs() -> Vec<UbisoftInstall> {
    let mut out = Vec::new();
    for p in prefixes() {
        for (id, dir) in wine::ubisoft_installs(&p.path) {
            if let Some(dir) = wine::windows_to_host(&p.path, &dir) {
                out.push(UbisoftInstall { id, dir });
            }
        }
    }
    out
}

pub fn ubisoft_games_dir() -> PathBuf {
    main_prefix().map(|p| p.join("drive_c/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games")).unwrap_or_else(|| PathBuf::from("/nonexistent/ubisoft"))
}

/// Epic on Linux runs through Heroic/Legendary; not read yet.
pub fn epic_manifest_dir() -> Option<PathBuf> {
    None
}

/// Roots for "Scan drives": home and mounted drives.
pub fn fixed_drives() -> Vec<PathBuf> {
    let mut out = vec![home()];
    let u = user().unwrap_or_default();
    // Under WSL /mnt/<letter> are the Windows drives; the Windows build scans those.
    let wsl = std::env::var_os("WSL_DISTRO_NAME").is_some();
    let mnt = if wsl { None } else { Some(PathBuf::from("/mnt")) };
    for base in mnt.into_iter().chain([PathBuf::from("/media").join(&u), PathBuf::from("/run/media").join(&u)]) {
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten() {
                // WSL mounts Windows drives under /mnt/<letter>; skip its /mnt/wsl* helpers.
                let n = e.file_name().to_string_lossy().to_lowercase();
                if e.path().is_dir() && !n.starts_with("wsl") {
                    out.push(e.path());
                }
            }
        }
    }
    out
}

/// Running processes whose exe name (argv[0]'s file name, lower case) is in `names`; the path is
/// argv[0] as Wine shows it (a Windows path), so play time can tell the game copies apart.
pub fn running_processes(names: &[String]) -> Vec<super::Proc> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir("/proc") else { return out };
    for e in rd.flatten() {
        let Ok(pid) = e.file_name().to_string_lossy().parse::<u32>() else { continue };
        let Ok(cmd) = std::fs::read(e.path().join("cmdline")) else { continue };
        let argv0 = String::from_utf8_lossy(cmd.split(|b| *b == 0).next().unwrap_or_default()).to_string();
        let Some(base) = argv0.rsplit(['/', '\\']).next().map(str::to_lowercase) else { continue };
        if names.iter().any(|n| *n == base) {
            out.push(super::Proc { pid, name: base, path: Some(std::path::PathBuf::from(argv0)) });
        }
    }
    out
}

/// Process names, lower case: `comm` and the file name of argv[0] (Wine processes show their
/// Windows exe there, e.g. `C:\...\TmForever.exe`; `comm` is cut at 15 characters).
pub fn running_process_names() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/proc") {
        for e in rd.flatten() {
            if !e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            if let Ok(comm) = std::fs::read_to_string(e.path().join("comm")) {
                out.push(comm.trim().to_lowercase());
            }
            if let Ok(cmd) = std::fs::read(e.path().join("cmdline")) {
                let argv0 = cmd.split(|b| *b == 0).next().unwrap_or_default();
                let s = String::from_utf8_lossy(argv0);
                if let Some(base) = s.rsplit(['/', '\\']).next().filter(|b| !b.is_empty()) {
                    let b = base.to_lowercase();
                    if !out.contains(&b) {
                        out.push(b);
                    }
                }
            }
        }
    }
    out
}

// ------------------------------------------------------------------ starting programs

fn build(spec: &CommandSpec) -> Command {
    let mut cmd = Command::new(&spec.program);
    for a in &spec.args {
        match a {
            Arg::Plain(s) | Arg::Raw(s) => {
                cmd.arg(s);
            }
        }
    }
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd
}

/// A Windows program goes through its runner (Wine / umu-run / Proton); anything else runs as is.
pub fn linux_spec(spec: &CommandSpec) -> io::Result<CommandSpec> {
    if !wine::is_windows_program(&spec.program) {
        return Ok(spec.clone());
    }
    let (cfg, _, _) = super::config();
    let tools = tools();
    let runner = wine::plan_runner(&cfg, &tools, &spec.program, main_prefix().as_deref()).map_err(|e| io::Error::new(io::ErrorKind::NotFound, e))?;
    let mut out = wine::wrap_spec(&runner, spec);
    // umu-run downloaded by TM Horizon is not on PATH.
    if matches!(runner, crate::launch::Runner::Umu { .. }) {
        if let Some(u) = &tools.umu {
            out.program = u.clone();
        }
    }
    // Fixes chosen in the Linux game setup (only prefixes that have the options file).
    let prefix = match &runner {
        crate::launch::Runner::Wine { prefix, .. } | crate::launch::Runner::Umu { prefix, .. } => Some(prefix.clone()),
        crate::launch::Runner::Proton { compat_data, .. } => Some(compat_data.join("pfx")),
        crate::launch::Runner::Native => None,
    };
    if let Some(o) = prefix.as_deref().and_then(wine::read_options) {
        let staging = matches!(&runner, crate::launch::Runner::Wine { wine, .. } if wine_staging(wine));
        out = wine::apply_options(out, &runner, &o, which("taskset").as_deref(), staging);
    }
    Ok(out)
}

pub fn spawn(spec: &CommandSpec) -> io::Result<u32> {
    let spec = linux_spec(spec)?;
    let mut child = build(&spec).spawn()?;
    let id = child.id();
    // Reap it in the background so it does not stay a zombie while the launcher runs.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(id)
}

pub fn run_and_wait(spec: &CommandSpec) -> io::Result<i32> {
    let spec = linux_spec(spec)?;
    Ok(build(&spec).status()?.code().unwrap_or(-1))
}

/// Windows setups with parameters run through the same runner; the parameters are split on spaces
/// outside quotes.
pub fn run_setup_and_wait_args(exe: &Path, params: &str, cwd: Option<&Path>) -> io::Result<i32> {
    if crate::fsx::blocked(exe) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "refusing to start this file"));
    }
    let mut args = Vec::new();
    let (mut cur, mut q) = (String::new(), false);
    for ch in params.chars() {
        match ch {
            '"' => q = !q,
            ' ' if !q => {
                if !cur.is_empty() {
                    args.push(Arg::plain(std::mem::take(&mut cur)));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        args.push(Arg::plain(cur));
    }
    run_and_wait(&CommandSpec { program: exe.to_path_buf(), args, cwd: cwd.map(Path::to_path_buf), env: vec![] })
}

pub fn run_setup_and_wait(exe: &Path, cwd: Option<&Path>) -> io::Result<i32> {
    if crate::fsx::blocked(exe) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "refusing to start this file"));
    }
    run_and_wait(&CommandSpec { program: exe.to_path_buf(), args: vec![], cwd: cwd.map(Path::to_path_buf), env: vec![] })
}

/// Store links that need a program rather than xdg-open: `steam://rungameid/<id>` becomes
/// `steam -applaunch <id>` (native Steam) or the same through `flatpak run com.valvesoftware.Steam`.
pub fn url_command(url: &str) -> Option<CommandSpec> {
    let id = wine::steam_rungame_id(url)?;
    let args = |pre: &[&str]| pre.iter().map(|s| Arg::plain(*s)).chain([Arg::plain("-applaunch"), Arg::plain(id.to_string())]).collect::<Vec<_>>();
    if let Some(steam) = which("steam") {
        return Some(CommandSpec { program: steam, args: args(&[]), cwd: None, env: vec![] });
    }
    let flatpak_steam = home().join(".var/app/com.valvesoftware.Steam").is_dir() || Path::new("/var/lib/flatpak/app/com.valvesoftware.Steam").is_dir();
    if let (Some(fp), true) = (which("flatpak"), flatpak_steam) {
        return Some(CommandSpec { program: fp, args: args(&["run", "com.valvesoftware.Steam"]), cwd: None, env: vec![] });
    }
    None
}

// ------------------------------------------------------------------ tmhub:// links

const DESKTOP_FILE: &str = "tm-horizon-url-handler.desktop";

fn applications_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| home().join(".local/share")).join("applications")
}

/// The AppImage itself when running from one (its mount point changes on every start).
fn stable_exe(exe: &str) -> String {
    std::env::var("APPIMAGE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| exe.to_string())
}

/// The Exec line of the desktop file registered for `scheme`, if any.
pub fn protocol_command(scheme: &str) -> Option<String> {
    let out = Command::new("xdg-mime").args(["query", "default", &format!("x-scheme-handler/{scheme}")]).stderr(Stdio::null()).output().ok()?;
    let file = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if file.is_empty() {
        return None;
    }
    let mut dirs_list = vec![applications_dir()];
    dirs_list.extend(std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into()).split(':').map(|d| PathBuf::from(d).join("applications")));
    dirs_list.into_iter().find_map(|d| {
        let text = std::fs::read_to_string(d.join(&file)).ok()?;
        text.lines().find_map(|l| l.strip_prefix("Exec=").map(str::to_string))
    })
}

/// Writes a desktop file for `scheme://` in ~/.local/share/applications and makes it the
/// default handler (xdg-mime). Only after the user agreed, as on Windows.
pub fn register_protocol(scheme: &str, exe: &Path, label: &str) -> io::Result<()> {
    let exe = stable_exe(&exe.to_string_lossy());
    let dir = applications_dir();
    std::fs::create_dir_all(&dir)?;
    let text = format!(
        "[Desktop Entry]\nType=Application\nName={label}\nExec={}\nIcon=tm-horizon\nNoDisplay=true\nTerminal=false\nMimeType=x-scheme-handler/{scheme};\n",
        protocol_command_line(&exe)
    );
    std::fs::write(dir.join(DESKTOP_FILE), text)?;
    let _ = Command::new("update-desktop-database").arg(&dir).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let st = Command::new("xdg-mime").args(["default", DESKTOP_FILE, &format!("x-scheme-handler/{scheme}")]).status()?;
    if st.success() {
        Ok(())
    } else {
        Err(io::Error::other("xdg-mime failed"))
    }
}

pub fn protocol_command_line(exe: &str) -> String {
    format!("\"{}\" %u", stable_exe(exe))
}

pub fn unregister_protocol(_scheme: &str) -> io::Result<()> {
    match std::fs::remove_file(applications_dir().join(DESKTOP_FILE)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

// ------------------------------------------------------------------ system info

pub fn os_summary() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_string())))
        .unwrap_or_else(|| "Linux".into())
}

/// Graphics adapters from `lspci` (empty when it is not installed).
pub fn gpus() -> Vec<String> {
    let Ok(out) = Command::new("lspci").stderr(Stdio::null()).output() else { return vec![] };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains("VGA compatible controller") || l.contains("3D controller"))
        .filter_map(|l| l.split_once(": ").map(|(_, n)| n.trim().to_string()))
        .collect()
}

pub fn verify_signature(_path: &Path) -> SignatureInfo {
    SignatureInfo { trusted: false, detail: "No Authenticode check on Linux".into(), signer: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_prefix_prefers_tmloader() {
        let t = tempfile::tempdir().unwrap();
        let mk = |n: &str, sub: &str| {
            let p = t.path().join(n);
            std::fs::create_dir_all(p.join("drive_c/users/me").join(sub)).unwrap();
            Prefix { path: p, source: "Test".into(), steam_app_id: None }
        };
        let a = mk("a", "Documents");
        let b = mk("b", "Documents/TrackMania");
        let c = mk("c", "AppData/Local/TMLoader");
        assert_eq!(pick_main(&[a.clone(), b.clone(), c.clone()], Some("me")), Some(c.path.clone()));
        assert_eq!(pick_main(&[a.clone(), b.clone()], Some("me")), Some(b.path.clone()));
        assert_eq!(pick_main(&[a.clone()], Some("me")), Some(a.path.clone()));
        assert_eq!(pick_main(&[], Some("me")), None);
    }

    /// End-to-end against a fake home with prefixes (nothing is started): build one with
    /// prefixes, then `HOME=<fake home> USER=tester cargo test fake_home -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn fake_home_scan() {
        use std::sync::atomic::AtomicBool;
        let home = std::env::var("HOME").unwrap();
        assert!(home.contains("fakehome"), "run with HOME=<fake home>");
        for p in prefixes() {
            println!("prefix  {} ({}{})", p.path.display(), p.source, p.steam_app_id.map(|i| format!(" {i}")).unwrap_or_default());
        }
        println!("main    {:?}", main_prefix());
        println!("docs    {:?}", documents_dir());
        let tml = crate::tmloader::resolve_root(None);
        println!("tmldr   {tml:?}");
        let snap = crate::scan::scan(&crate::scan::ScanInput { tmloader_root: tml.clone(), found: vec![], manual: vec![] });
        let g = &snap.games;
        for (id, list) in [("tmnf", &g.tmnf.installs), ("tmuf", &g.tmuf.installs), ("maniaplanet", &g.maniaplanet.installs), ("tmn-eswc", &g.eswc.installs)] {
            for i in list {
                println!("game    {id}: {} [{}] launch={:?}", i.path, i.source, i.launch);
            }
        }
        println!("recent  {:?}", snap.recent.get("forever").map(|r| r.maps.iter().map(|m| m.name.clone()).collect::<Vec<_>>()));
        assert!(g.tmnf.installs.iter().any(|i| i.path.contains("/.wine/")));
        assert!(g.tmuf.installs.iter().any(|i| i.source == "Steam"));
        assert!(!g.maniaplanet.installs.is_empty());
        assert!(tml.unwrap().ends_with("drive_c/users/tester/AppData/Local/TMLoader"));
        let found = crate::scan::walk_for_games(&[PathBuf::from(&home)], 10, &AtomicBool::new(false), |_, _, _| {});
        for f in &found {
            println!("walk    {} {}", f.game, f.path);
        }
        assert!(!found.iter().any(|f| f.path.to_lowercase().contains("trackmania nations eswc")));
        // How TMLoader would start (not started): runner, Windows paths in the arguments.
        let main = main_prefix().unwrap();
        let exe = main.join("drive_c/users/tester/AppData/Local/TMLoader/TMLoader.exe");
        let map = main.join("drive_c/users/tester/Documents/TrackMania/Tracks/Challenges/Downloaded/A07 Race.Challenge.Gbx");
        let spec = CommandSpec { program: exe, args: vec![Arg::plain("run"), Arg::plain("TmForever"), Arg::plain("Default"), Arg::plain(format!("/file={}", map.display()))], cwd: None, env: vec![] };
        let s = linux_spec(&spec).unwrap();
        println!("start   {} {:?} env={:?}", s.program.display(), s.args.iter().map(|a| a.unquoted()).collect::<Vec<_>>(), s.env);
        let steam_exe = PathBuf::from(&g.tmuf.installs.iter().find(|i| i.source == "Steam").unwrap().exe.clone().unwrap());
        let s2 = linux_spec(&CommandSpec { program: steam_exe, args: vec![], cwd: None, env: vec![] }).unwrap();
        println!("steam   {} {:?}", s2.program.display(), s2.args.iter().map(|a| a.unquoted()).collect::<Vec<_>>());
        println!("url     {:?}", url_command("steam://rungameid/7200").map(|c| c.program));
    }

    #[test]
    fn steam_links_use_the_steam_program() {
        // Only checks the parsing; which() depends on the machine.
        if let Some(spec) = url_command("steam://rungameid/11020") {
            assert!(spec.args.iter().any(|a| a.unquoted() == "-applaunch"));
            assert_eq!(spec.args.last().unwrap().unquoted(), "11020");
        }
        assert!(url_command("uplay://launch/5595/0").is_none());
    }
}
