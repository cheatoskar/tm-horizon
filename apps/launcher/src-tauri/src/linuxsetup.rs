//! Guided "install the game on Linux" (Linux only; on Windows every command answers "Linux only").
//!
//! Steps, each shown with its log in the setup dialog and cancellable:
//! 1. runner: Wine, wine-staging, umu-run or Proton must exist. Without root the user can let
//!    TM Horizon download umu-launcher (zipapp) and GE-Proton from their official GitHub releases
//!    into `<data>/runners` (SHA-256 from GitHub's asset digest, checked before unpacking).
//!    Distro install commands are only shown, never run (no sudo).
//! 2. prefix: `<data>/prefixes/<game>` (the scanner already looks there), `wineboot -u` (64-bit
//!    prefix; TMNF/TMUF are 32-bit programs and run in it), Windows version and the registry
//!    fixes (`wine::registry_text`).
//! 3. dxvk (plain Wine only; Proton has its own): official release, SHA-256 checked, DLLs copied
//!    into system32/syswow64, the overrides follow the DXVK switch.
//! 4. winetricks (optional verbs, only when winetricks exists).
//! 5. game: the official setup from `gameinstall::source` (TMNF from the Ubisoft CDN, TMUF from
//!    files.trackmaniaforever.com), pinned SHA-256 (Linux has no Authenticode check), run inside the
//!    prefix. Both are Inno Setup installers, so Inno's documented `/SILENT` switches are used;
//!    any other installer runs with its own window.
//! 6. tmloader: the guided TMLoader setup (`tmlsetup::download_with`, Tomashu's official page),
//!    its installer runs visibly inside the same prefix.
//! 7. register: Settings > Linux gets the game's runner and prefix, then a rescan.
//! "Repair" runs 1, 2, 3 and 7 again on an existing prefix.

use crate::launch::{Arg, CommandSpec};
use crate::platform::wine::{self, PrefixOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// SHA-256 of the official TMNF setup (530 600 781 bytes, downloaded and checked 2026-11-11).
/// On Linux there is no Authenticode check, so the setup must be exactly this file.
pub const TMNF_SHA256: &str = "2f659138ed4409da404970841e18f03d29921beaf6a424824c8312ddb20f6355";

pub const UMU_REPO: &str = "Open-Wine-Components/umu-launcher";
pub const GE_REPO: &str = "GloriousEggroll/proton-ge-custom";
pub const DXVK_REPO: &str = "doitsujin/dxvk";

/// Verbs the user may pick (Wine has its own d3dx9 and fonts; these are optional).
pub const WINETRICKS_VERBS: &[&str] = &["corefonts", "d3dx9"];

// ------------------------------------------------------------------ games

/// How a game gets into a prefix: "download" (official setup), "existing" (only "Add existing
/// installation"), "steam" (recommend Steam/Proton).
pub fn game_kind(game: &str) -> Option<&'static str> {
    match game {
        "tmnf" | "tmuf" => Some("download"),
        "tmn-eswc" | "tm-sunrise" | "tm-original" => Some("existing"),
        "maniaplanet" | "tm2-stadium" | "tm2-canyon" | "tm2-valley" | "tm2-lagoon" | "sm-storm" | "tm2020" | "tm-turbo" => Some("steam"),
        _ => None,
    }
}

/// Install folder the official setup uses (below Program Files (x86)) and the game exe.
pub fn game_folder(game: &str) -> Option<(&'static str, &'static str)> {
    match game {
        "tmnf" => Some(("TmNationsForever", "TmForever.exe")),
        "tmuf" => Some(("TmUnitedForever", "TmForever.exe")),
        _ => None,
    }
}

/// Known SHA-256 of a game's setup on Linux.
pub fn known_setup_hash(game: &str) -> Option<&'static str> {
    match game {
        "tmnf" => Some(TMNF_SHA256),
        "tmuf" => Some(crate::gameinstall::TMUF_SHA256),
        _ => None,
    }
}

/// The installed game exe inside a prefix, if there.
pub fn installed_exe(prefix: &Path, game: &str) -> Option<PathBuf> {
    let (folder, exe) = game_folder(game)?;
    wine::program_files(prefix).into_iter().map(|pf| wine::resolve_ci(&pf.join(folder).join(exe)).into_owned()).find(|p| p.is_file())
}

pub fn tmloader_exe(prefix: &Path, user: Option<&str>) -> Option<PathBuf> {
    let p = wine::resolve_ci(&wine::local_app_data(prefix, user)?.join("TMLoader").join("TMLoader.exe")).into_owned();
    p.is_file().then_some(p)
}

// ------------------------------------------------------------------ distro commands

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallCmd {
    pub label: &'static str,
    pub command: &'static str,
    /// Fits the running distribution.
    pub matches: bool,
}

/// Distribution family from /etc/os-release `ID` and `ID_LIKE`.
pub fn distro_family(id: &str, id_like: &str) -> &'static str {
    let all: Vec<String> = std::iter::once(id).chain(id_like.split_whitespace()).map(|s| s.trim_matches('"').to_lowercase()).collect();
    let has = |x: &str| all.iter().any(|a| a == x || a.starts_with(x));
    if has("arch") || has("manjaro") || has("endeavouros") || has("cachyos") {
        "arch"
    } else if has("fedora") || has("rhel") || has("nobara") {
        "fedora"
    } else if has("opensuse") || has("suse") {
        "suse"
    } else if has("debian") || has("ubuntu") || has("linuxmint") || has("pop") {
        "debian"
    } else {
        ""
    }
}

/// Commands that install Wine (and winetricks). Shown with a copy button; TM Horizon never runs
/// them (they need root). The one for this distribution comes first.
pub fn install_commands(family: &str) -> Vec<InstallCmd> {
    let all = [
        ("arch", "Arch, Manjaro, EndeavourOS", "sudo pacman -S --needed wine winetricks"),
        ("debian", "Debian, Ubuntu, Mint", "sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install --install-recommends wine wine32:i386 wine64 winetricks"),
        ("fedora", "Fedora", "sudo dnf install wine winetricks"),
        ("suse", "openSUSE", "sudo zypper install wine winetricks"),
        ("flatpak", "Flatpak (any distribution): Steam with Proton", "flatpak install flathub com.valvesoftware.Steam"),
    ];
    let mut v: Vec<InstallCmd> = all.iter().map(|(f, label, command)| InstallCmd { label, command, matches: *f == family }).collect();
    v.sort_by_key(|c| !c.matches);
    v
}

// ------------------------------------------------------------------ GitHub releases

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub tag: String,
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

/// The release asset `want` picks from a GitHub "latest release" answer. It must come from that
/// repository's release downloads and carry GitHub's SHA-256 digest (checked after the download).
pub fn pick_asset(repo: &str, release: &Value, want: impl Fn(&str, &str) -> bool) -> Result<Asset, String> {
    let tag = release.get("tag_name").and_then(Value::as_str).ok_or("No release found")?.to_string();
    let prefix = format!("https://github.com/{repo}/releases/download/");
    for a in release.get("assets").and_then(Value::as_array).into_iter().flatten() {
        let name = a.get("name").and_then(Value::as_str).unwrap_or("");
        if !want(name, &tag) {
            continue;
        }
        let url = a.get("browser_download_url").and_then(Value::as_str).unwrap_or("");
        if !url.starts_with(&prefix) || name.contains(['/', '\\']) || name.starts_with('.') {
            return Err(format!("{name}: not a release download of {repo}"));
        }
        let sha = a.get("digest").and_then(Value::as_str).and_then(|d| d.strip_prefix("sha256:")).unwrap_or("");
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("{name}: GitHub gives no SHA-256 for it; not downloaded"));
        }
        return Ok(Asset { tag, name: name.into(), url: url.into(), size: a.get("size").and_then(Value::as_u64).unwrap_or(0), sha256: sha.to_lowercase() });
    }
    Err(format!("No matching file in the latest {repo} release"))
}

pub fn want_umu(name: &str, _tag: &str) -> bool {
    name.starts_with("umu-launcher-") && name.ends_with("-zipapp.tar")
}

pub fn want_ge(name: &str, tag: &str) -> bool {
    name == format!("{tag}-x86_64.tar.gz") || name == format!("{tag}.tar.gz")
}

pub fn want_dxvk(name: &str, _tag: &str) -> bool {
    name.starts_with("dxvk-") && name.ends_with(".tar.gz") && !name.contains("native")
}

/// Where GitHub release downloads may end up after redirects.
pub fn github_download_host(u: &str) -> bool {
    let Ok(x) = url::Url::parse(u) else { return false };
    let h = x.host_str().unwrap_or("").to_ascii_lowercase();
    x.scheme() == "https" && x.username().is_empty() && (h == "github.com" || h.ends_with(".githubusercontent.com"))
}

// ------------------------------------------------------------------ installers

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallerKind {
    Inno,
    Nsis,
    Unknown,
}

/// Inno Setup and NSIS name themselves in the manifest and setup data ("Inno Setup Setup Data",
/// "Nullsoft Install System"); `bytes` is the start and the end of the file.
pub fn installer_kind_of(head: &[u8]) -> InstallerKind {
    let has = |n: &[u8]| head.windows(n.len()).any(|w| w == n);
    if has(b"Inno Setup") {
        InstallerKind::Inno
    } else if has(b"Nullsoft") {
        InstallerKind::Nsis
    } else {
        InstallerKind::Unknown
    }
}

/// Looks at the first and the last 8 MB (the TMNF setup has its Inno markers in the last MB of
/// its 530 MB, NSIS installers near the start).
pub fn installer_kind(p: &Path) -> InstallerKind {
    use std::io::{Read, Seek, SeekFrom};
    const PART: u64 = 8 << 20;
    let mut bytes = Vec::new();
    if let Ok(mut f) = std::fs::File::open(p) {
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = (&mut f).take(PART).read_to_end(&mut bytes);
        if len > PART && f.seek(SeekFrom::Start(len.saturating_sub(PART).max(PART))).is_ok() {
            let _ = f.take(PART).read_to_end(&mut bytes);
        }
    }
    installer_kind_of(&bytes)
}

/// Switches for a game setup: Inno Setup documents `/SILENT` (progress window only),
/// `/SUPPRESSMSGBOXES`, `/NORESTART` and `/SP-`; everything else runs with its own window.
pub fn setup_args(kind: InstallerKind) -> Vec<String> {
    match kind {
        InstallerKind::Inno => ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"].iter().map(|s| s.to_string()).collect(),
        _ => vec![],
    }
}

// ------------------------------------------------------------------ commands inside a prefix

/// What runs the setup steps.
#[derive(Debug, Clone, PartialEq)]
pub enum SetupRunner {
    Wine { wine: PathBuf },
    /// umu-run with a Proton (None = umu downloads UMU-Proton itself).
    Umu { umu: PathBuf, proton: Option<PathBuf>, game_id: String },
}

/// `program` (a host path to an exe, or a Wine builtin like `wineboot`) with `args` inside `prefix`.
pub fn prefix_cmd(r: &SetupRunner, prefix: &Path, program: &str, args: &[String]) -> CommandSpec {
    let args = std::iter::once(program.to_string()).chain(args.iter().cloned()).map(Arg::plain).collect();
    let mut env = vec![("WINEPREFIX".to_string(), prefix.to_string_lossy().into_owned()), ("WINEDEBUG".to_string(), "-all".to_string())];
    let program = match r {
        SetupRunner::Wine { wine } => {
            env.push(("WINEARCH".into(), "win64".into()));
            wine.clone()
        }
        SetupRunner::Umu { umu, proton, game_id } => {
            env.push(("GAMEID".into(), game_id.clone()));
            if let Some(p) = proton {
                env.push(("PROTONPATH".into(), p.to_string_lossy().into_owned()));
            }
            umu.clone()
        }
    };
    CommandSpec { program, args, cwd: Some(prefix.to_path_buf()), env }
}

/// Creates or updates the prefix. Mono/Gecko are switched off so no install dialog pops up
/// (the games do not need them). umu creates a prefix when it runs an empty command.
pub fn wineboot_cmd(r: &SetupRunner, prefix: &Path) -> CommandSpec {
    let mut c = match r {
        SetupRunner::Wine { .. } => prefix_cmd(r, prefix, "wineboot", &["-u".into()]),
        SetupRunner::Umu { .. } => prefix_cmd(r, prefix, "", &[]),
    };
    c.env.push(("WINEDLLOVERRIDES".into(), "mscoree,mshtml=".into()));
    c
}

pub fn regedit_cmd(r: &SetupRunner, prefix: &Path, reg_file: &Path) -> CommandSpec {
    prefix_cmd(r, prefix, "regedit", &["/S".into(), wine::host_to_windows(prefix, reg_file)])
}

/// winetricks for plain Wine (WINE points at the chosen wine); umu has a `winetricks` verb.
pub fn winetricks_cmd(r: &SetupRunner, prefix: &Path, winetricks: Option<&Path>, verbs: &[String]) -> Option<CommandSpec> {
    let mut args = vec!["-q".to_string()];
    args.extend(verbs.iter().cloned());
    match r {
        SetupRunner::Wine { wine } => {
            let wt = winetricks?;
            Some(CommandSpec {
                program: wt.to_path_buf(),
                args: args.into_iter().map(Arg::plain).collect(),
                cwd: Some(prefix.to_path_buf()),
                env: vec![("WINEPREFIX".into(), prefix.to_string_lossy().into_owned()), ("WINE".into(), wine.to_string_lossy().into_owned()), ("WINEDEBUG".into(), "-all".into())],
            })
        }
        SetupRunner::Umu { .. } => Some(prefix_cmd(r, prefix, "winetricks", &args)),
    }
}

/// `wineserver -k` next to the chosen wine: ends every Wine process of the prefix (cancel).
pub fn wineserver_kill_cmd(r: &SetupRunner, prefix: &Path) -> Option<CommandSpec> {
    let SetupRunner::Wine { wine } = r else { return None };
    let ws = wine.parent().map(|d| d.join("wineserver")).filter(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("wineserver"));
    Some(CommandSpec { program: ws, args: vec![Arg::plain("-k")], cwd: None, env: vec![("WINEPREFIX".into(), prefix.to_string_lossy().into_owned())] })
}

/// (from, to) for DXVK's DLLs: x64 into system32, x32 into syswow64 (64-bit prefix) or system32
/// (32-bit prefix).
pub fn dxvk_copies(dxvk: &Path, prefix: &Path) -> Vec<(PathBuf, PathBuf)> {
    let win = prefix.join("drive_c/windows");
    let wow = win.join("syswow64");
    let mut out = Vec::new();
    for d in wine::DXVK_DLLS {
        let f = format!("{d}.dll");
        if wow.is_dir() {
            out.push((dxvk.join("x64").join(&f), win.join("system32").join(&f)));
            out.push((dxvk.join("x32").join(&f), wow.join(&f)));
        } else {
            out.push((dxvk.join("x32").join(&f), win.join("system32").join(&f)));
        }
    }
    out
}

// ------------------------------------------------------------------ plan

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SetupPlan {
    pub game: String,
    /// "wine" or "umu".
    pub runner: String,
    /// Download umu-launcher / GE-Proton into the launcher's data folder.
    pub get_umu: bool,
    pub get_proton: bool,
    /// Proton folder for umu (empty = the downloaded one, else the newest found).
    pub proton: Option<String>,
    pub winetricks: Vec<String>,
    pub install_game: bool,
    pub tmloader: bool,
    pub options: PrefixOptions,
    /// Repair an existing prefix: runner, wineboot, registry, DXVK, register (no game/TMLoader setup).
    pub repair: bool,
}

impl Default for SetupPlan {
    fn default() -> Self {
        SetupPlan { game: String::new(), runner: "wine".into(), get_umu: false, get_proton: false, proton: None, winetricks: vec![], install_game: true, tmloader: true, options: PrefixOptions::default(), repair: false }
    }
}

pub fn validate_plan(p: &SetupPlan) -> Result<(), String> {
    if game_kind(&p.game) != Some("download") {
        return Err(format!("{}: no guided setup on Linux (add an existing installation instead)", p.game));
    }
    if !["wine", "umu"].contains(&p.runner.as_str()) {
        return Err(format!("Unknown runner {}", p.runner));
    }
    if p.get_umu && p.runner != "umu" {
        return Err("umu-launcher is only downloaded for the umu runner".into());
    }
    if let Some(v) = p.winetricks.iter().find(|v| !WINETRICKS_VERBS.contains(&v.as_str())) {
        return Err(format!("Unknown winetricks verb {v}"));
    }
    if let Some(vd) = &p.options.virtual_desktop {
        if wine::desktop_size(vd).is_none() {
            return Err(format!("Not a screen size: {vd}"));
        }
    }
    if p.options.cpu_limit > 64 {
        return Err("CPU limit: at most 64".into());
    }
    if !wine::WINDOWS_VERSIONS.contains(&p.options.windows_version.as_str()) {
        return Err(format!("Unknown Windows version {}", p.options.windows_version));
    }
    if let Some(x) = p.proton.as_deref().filter(|s| !s.trim().is_empty()) {
        if !x.starts_with('/') {
            return Err(format!("Not a full path: {x}"));
        }
    }
    Ok(())
}

/// The steps the dialog shows, in order.
pub fn plan_steps(p: &SetupPlan) -> Vec<&'static str> {
    let mut s = vec!["runner", "prefix"];
    if p.options.dxvk && p.runner == "wine" {
        s.push("dxvk");
    }
    if !p.repair {
        if !p.winetricks.is_empty() {
            s.push("winetricks");
        }
        if p.install_game {
            s.push("game");
        }
        if p.tmloader {
            s.push("tmloader");
        }
    }
    s.push("register");
    s
}

/// Settings > Linux after the setup: the game runs with this runner in this prefix; the prefix
/// becomes the main one (Documents, TMLoader) when none was picked.
pub fn register(l: &mut wine::LinuxSettings, game: &str, runner: &str, prefix: &Path, proton: Option<&Path>) {
    let g = l.games.entry(game.to_string()).or_default();
    g.runner = Some(runner.to_string());
    g.prefix = Some(prefix.to_string_lossy().into_owned());
    g.proton = if runner == "umu" { proton.map(|p| p.to_string_lossy().into_owned()) } else { None };
    if l.prefix.as_deref().map(str::trim).unwrap_or("").is_empty() {
        l.prefix = Some(prefix.to_string_lossy().into_owned());
    }
}

/// Options saved in an existing prefix keep the DXVK version the setup recorded.
pub fn merge_options(new: &PrefixOptions, old: Option<&PrefixOptions>) -> PrefixOptions {
    let mut o = new.clone();
    if o.dxvk_version.is_none() {
        o.dxvk_version = old.and_then(|x| x.dxvk_version.clone());
    }
    o
}

// ------------------------------------------------------------------ status (both OSes)

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WineInfo {
    pub path: String,
    pub version: String,
    pub staging: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub path: String,
    pub name: String,
    /// Downloaded by TM Horizon (in its data folder).
    pub own: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Runners {
    pub wine: Option<WineInfo>,
    pub umu: Option<ToolInfo>,
    pub protons: Vec<ToolInfo>,
    pub winetricks: Option<String>,
    pub python3: bool,
    pub taskset: bool,
    pub distro: String,
    pub commands: Vec<InstallCmd>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub platform: String,
    pub game: String,
    /// "download", "existing", "steam" or "" (no Linux setup for this game).
    pub kind: String,
    pub prefix: String,
    pub prefix_exists: bool,
    pub installed: Option<String>,
    pub tmloader: bool,
    pub options: PrefixOptions,
    pub running: Option<String>,
    /// Steps of the running (or last) setup of this game with their state, for a reopened dialog.
    pub steps: Vec<StepState>,
    pub runners: Runners,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub step: String,
    /// "wait", "run", "ok", "skip", "fail".
    pub state: String,
    pub note: String,
}

#[cfg(not(windows))]
pub use imp::*;

#[cfg(windows)]
mod win_stubs {
    use super::*;
    use crate::state::AppState;
    use tauri::{AppHandle, State};
    const ONLY: &str = "Only on Linux";

    #[tauri::command(async)]
    pub fn linux_setup_status(game: String) -> SetupStatus {
        SetupStatus { platform: crate::platform::NAME.into(), game, ..Default::default() }
    }
    #[tauri::command(async)]
    pub fn linux_setup_start(_app: AppHandle, _plan: SetupPlan) -> Result<Vec<&'static str>, String> {
        Err(ONLY.into())
    }
    #[tauri::command(async)]
    pub fn linux_setup_cancel() {}
    #[tauri::command(async)]
    pub fn linux_setup_options(_st: State<AppState>, _game: String, _options: PrefixOptions) -> Result<PrefixOptions, String> {
        Err(ONLY.into())
    }
    #[tauri::command(async)]
    pub fn linux_setup_log(_st: State<AppState>, _game: String) -> String {
        String::new()
    }
}
#[cfg(windows)]
pub use win_stubs::*;

// ------------------------------------------------------------------ the job (Linux)

#[cfg(not(windows))]
mod imp {
    use super::*;
    use crate::platform;
    use crate::state::AppState;
    use std::io::{BufRead, Read, Write};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager, State};

    struct Job {
        game: String,
        cancel: Arc<AtomicBool>,
    }
    static JOB: Mutex<Option<Job>> = Mutex::new(None);
    /// (game, steps) of the running or last setup.
    static STEPS: Mutex<Option<(String, Vec<StepState>)>> = Mutex::new(None);

    fn set_step(game: &str, step: &str, state: &str, note: &str) {
        if let Some((g, list)) = STEPS.lock().unwrap().as_mut() {
            if g == game {
                if let Some(s) = list.iter_mut().find(|s| s.step == step) {
                    s.state = state.into();
                    s.note = note.into();
                }
            }
        }
    }

    fn user() -> Option<String> {
        std::env::var("USER").ok().filter(|u| !u.is_empty())
    }

    pub fn prefix_dir(data_dir: &Path, game: &str) -> PathBuf {
        data_dir.join("prefixes").join(game)
    }

    fn log_path(data_dir: &Path, game: &str) -> PathBuf {
        data_dir.join("logs").join(format!("linux-setup-{game}.log"))
    }

    fn os_release() -> (String, String, String) {
        let t = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let get = |k: &str| t.lines().find_map(|l| l.strip_prefix(&format!("{k}=")).map(|v| v.trim_matches('"').to_string())).unwrap_or_default();
        (get("ID"), get("ID_LIKE"), get("PRETTY_NAME"))
    }

    fn version_of(p: &Path, arg: &str) -> String {
        Command::new(p).arg(arg).stdin(Stdio::null()).stderr(Stdio::null()).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string()).unwrap_or_default()
    }

    pub fn runners() -> Runners {
        let tools = platform::tools();
        let own = platform::own_runners_dir();
        let is_own = |p: &Path| own.as_ref().is_some_and(|o| p.starts_with(o));
        let wine = tools.wine.as_ref().map(|w| {
            let (version, staging) = wine::parse_wine_version(&version_of(w, "--version")).unwrap_or_default();
            WineInfo { path: w.to_string_lossy().into(), version, staging }
        });
        let umu = tools.umu.as_ref().map(|u| ToolInfo { path: u.to_string_lossy().into(), name: version_of(u, "--version"), own: is_own(u) });
        let protons = tools.protons.iter().map(|p| ToolInfo { path: p.to_string_lossy().into(), name: wine::proton_name(p), own: is_own(p) }).collect();
        let (id, like, pretty) = os_release();
        Runners {
            wine,
            umu,
            protons,
            winetricks: platform::which("winetricks").map(|p| p.to_string_lossy().into()),
            python3: platform::which("python3").is_some(),
            taskset: platform::which("taskset").is_some(),
            distro: pretty,
            commands: install_commands(distro_family(&id, &like)),
        }
    }

    #[tauri::command(async)]
    pub fn linux_setup_status(st: State<AppState>, game: String) -> SetupStatus {
        let prefix = prefix_dir(&st.data_dir, &game);
        let exists = wine::is_prefix(&prefix);
        let running = JOB.lock().unwrap().as_ref().map(|j| j.game.clone());
        SetupStatus {
            platform: platform::NAME.into(),
            kind: game_kind(&game).unwrap_or("").into(),
            installed: if exists { installed_exe(&prefix, &game).map(|p| p.to_string_lossy().into()) } else { None },
            tmloader: exists && tmloader_exe(&prefix, user().as_deref()).is_some(),
            options: wine::read_options(&prefix).unwrap_or_default(),
            prefix: prefix.to_string_lossy().into(),
            prefix_exists: exists,
            running,
            steps: STEPS.lock().unwrap().as_ref().filter(|(g, _)| *g == game).map(|(_, l)| l.clone()).unwrap_or_default(),
            runners: runners(),
            game,
        }
    }

    #[tauri::command(async)]
    pub fn linux_setup_log(st: State<AppState>, game: String) -> String {
        let t = std::fs::read_to_string(log_path(&st.data_dir, &game)).unwrap_or_default();
        let lines: Vec<&str> = t.lines().collect();
        lines[lines.len().saturating_sub(400)..].join("\n")
    }

    #[tauri::command(async)]
    pub fn linux_setup_cancel() {
        if let Some(j) = JOB.lock().unwrap().as_ref() {
            j.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Saves the fixes of a game's prefix and writes their registry part into it.
    #[tauri::command(async)]
    pub fn linux_setup_options(st: State<AppState>, game: String, options: PrefixOptions) -> Result<PrefixOptions, String> {
        validate_plan(&SetupPlan { game: game.clone(), options: options.clone(), ..Default::default() })?;
        if JOB.lock().unwrap().is_some() {
            return Err("A setup is running".into());
        }
        let prefix = prefix_dir(&st.data_dir, &game);
        if !wine::is_prefix(&prefix) {
            return Err("Set up the prefix first".into());
        }
        let o = merge_options(&options, wine::read_options(&prefix).as_ref());
        wine::write_options(&prefix, &o).map_err(|e| e.to_string())?;
        // Registry fixes only through plain Wine (Proton rewrites its prefix on start anyway).
        if let Some(w) = platform::tools().wine {
            let r = SetupRunner::Wine { wine: w };
            let reg = prefix.join("tmhub.reg");
            std::fs::write(&reg, wine::registry_text(&o)).map_err(|e| e.to_string())?;
            let mut c = build(&regedit_cmd(&r, &prefix, &reg));
            let _ = c.stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        Ok(o)
    }

    /// Starts the setup in the background. Events: `linux-setup-step` {game, step, state, note},
    /// `linux-setup-log` {game, line}, `linux-setup-progress` {game, step, received, total},
    /// `linux-setup-done` {game, ok, cancelled, error}.
    #[tauri::command(async)]
    pub fn linux_setup_start(app: AppHandle, plan: SetupPlan) -> Result<Vec<&'static str>, String> {
        validate_plan(&plan)?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut j = JOB.lock().unwrap();
            if j.is_some() {
                return Err("A setup is already running".into());
            }
            *j = Some(Job { game: plan.game.clone(), cancel: cancel.clone() });
        }
        let steps = plan_steps(&plan);
        *STEPS.lock().unwrap() = Some((plan.game.clone(), steps.iter().map(|s| StepState { step: s.to_string(), state: "wait".into(), note: String::new() }).collect()));
        let a = app.clone();
        std::thread::spawn(move || {
            let st = a.state::<AppState>();
            let res = run_job(&st, &plan, cancel.clone(), &|name, v| {
                let _ = a.emit(name, v);
            });
            *JOB.lock().unwrap() = None;
            let _ = a.emit("linux-setup-done", serde_json::json!({ "game": plan.game, "ok": res.is_ok(), "cancelled": cancel.load(Ordering::SeqCst), "error": res.err() }));
        });
        Ok(steps)
    }

    /// The whole setup, blocking; `emit(event, payload)` reports steps, log lines and progress.
    pub fn run_job(st: &AppState, plan: &SetupPlan, cancel: Arc<AtomicBool>, emit: &dyn Fn(&str, Value)) -> Result<(), String> {
        let mut ctx = Ctx::new(emit, st, plan, cancel);
        let res = ctx.run_all();
        match &res {
            Err(e) => ctx.log(&format!("STOPPED: {e}")),
            Ok(()) => ctx.log("Finished."),
        }
        res
    }

    fn build(spec: &CommandSpec) -> Command {
        let mut c = Command::new(&spec.program);
        for a in &spec.args {
            c.arg(a.unquoted());
        }
        if let Some(d) = &spec.cwd {
            c.current_dir(d);
        }
        for (k, v) in &spec.env {
            c.env(k, v);
        }
        c.stdin(Stdio::null());
        c
    }

    fn shown(spec: &CommandSpec) -> String {
        let env: Vec<String> = spec.env.iter().filter(|(k, _)| k != "WINEDEBUG").map(|(k, v)| format!("{k}={}", crate::launch::quote(v))).collect();
        let args: Vec<String> = spec.args.iter().map(|a| crate::launch::quote(&a.unquoted())).collect();
        format!("{} {} {}", env.join(" "), crate::launch::quote(&spec.program.to_string_lossy()), args.join(" ")).trim().to_string()
    }

    struct Ctx<'a> {
        emit: &'a dyn Fn(&str, Value),
        st: &'a AppState,
        plan: &'a SetupPlan,
        cancel: Arc<AtomicBool>,
        log: Option<std::fs::File>,
        prefix: PathBuf,
        runner: Option<SetupRunner>,
        proton: Option<PathBuf>,
        step: &'static str,
    }

    impl<'a> Ctx<'a> {
        fn new(emit: &'a dyn Fn(&str, Value), st: &'a AppState, plan: &'a SetupPlan, cancel: Arc<AtomicBool>) -> Self {
            let lp = log_path(&st.data_dir, &plan.game);
            let _ = std::fs::create_dir_all(lp.parent().unwrap());
            let log = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&lp).ok();
            Ctx { emit, st, plan, cancel, log, prefix: prefix_dir(&st.data_dir, &plan.game), runner: None, proton: None, step: "" }
        }

        fn cancelled(&self) -> bool {
            self.cancel.load(Ordering::SeqCst)
        }

        fn check(&self) -> Result<(), String> {
            if self.cancelled() {
                Err("Cancelled".into())
            } else {
                Ok(())
            }
        }

        fn log(&mut self, line: &str) {
            if let Some(f) = self.log.as_mut() {
                let _ = writeln!(f, "{line}");
            }
            (self.emit)("linux-setup-log", serde_json::json!({ "game": self.plan.game, "line": line }));
        }

        fn state(&mut self, step: &'static str, state: &str, note: &str) {
            self.step = step;
            set_step(&self.plan.game, step, state, note);
            if !note.is_empty() {
                self.log(&format!("[{step}] {note}"));
            }
            (self.emit)("linux-setup-step", serde_json::json!({ "game": self.plan.game, "step": step, "state": state, "note": note }));
        }

        fn run_all(&mut self) -> Result<(), String> {
            let steps = plan_steps(self.plan);
            self.log(&format!("TM Horizon Linux setup for {} ({})", self.plan.game, if self.plan.repair { "repair" } else { "install" }));
            self.log(&format!("Steps: {}", steps.join(", ")));
            for s in steps {
                self.check()?;
                self.state(s, "run", "");
                let r = match s {
                    "runner" => self.step_runner(),
                    "prefix" => self.step_prefix(),
                    "dxvk" => self.step_dxvk(),
                    "winetricks" => self.step_winetricks(),
                    "game" => self.step_game(),
                    "tmloader" => self.step_tmloader(),
                    "register" => self.step_register(),
                    _ => Ok(String::new()),
                };
                match r {
                    Ok(note) if note.starts_with("skip:") => self.state(s, "skip", note.trim_start_matches("skip:").trim()),
                    Ok(note) => self.state(s, "ok", &note),
                    Err(e) => {
                        let e = if self.cancelled() { "Cancelled".to_string() } else { e };
                        self.state(s, "fail", &e);
                        return Err(e);
                    }
                }
            }
            Ok(())
        }

        /// Runs a command, its output into the log, waiting until it ends (or cancel/timeout).
        fn run(&mut self, spec: &CommandSpec, timeout: Duration) -> Result<i32, String> {
            self.log(&format!("$ {}", shown(spec)));
            let mut cmd = build(spec);
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
            // Own process group: cancel ends the whole tree (wine starts helpers).
            cmd.process_group(0);
            let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", spec.program.display()))?;
            let (tx, rx) = std::sync::mpsc::channel::<String>();
            for r in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)].into_iter().flatten() {
                let tx = tx.clone();
                std::thread::spawn(move || {
                    for l in std::io::BufReader::new(r).lines().map_while(Result::ok) {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                });
            }
            drop(tx);
            let t0 = Instant::now();
            let mut lines = 0usize;
            loop {
                while let Ok(l) = rx.try_recv() {
                    lines += 1;
                    // Wine can be chatty; keep the log readable.
                    if lines <= 400 {
                        self.log(&format!("  {l}"));
                    } else if lines == 401 {
                        self.log("  (more output cut)");
                    }
                }
                if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                    for l in rx.try_iter().take(50) {
                        self.log(&format!("  {l}"));
                    }
                    let code = s.code().unwrap_or(-1);
                    self.log(&format!("  exit code {code}"));
                    return Ok(code);
                }
                if self.cancelled() || t0.elapsed() > timeout {
                    let why = if self.cancelled() { "Cancelled" } else { "Took too long" };
                    let _ = Command::new("kill").args(["-TERM", &format!("-{}", child.id())]).status();
                    std::thread::sleep(Duration::from_millis(500));
                    let _ = child.kill();
                    let _ = child.wait();
                    if let Some(k) = self.runner.as_ref().and_then(|r| wineserver_kill_cmd(r, &self.prefix)) {
                        let _ = build(&k).stdout(Stdio::null()).stderr(Stdio::null()).status();
                    }
                    return Err(why.into());
                }
                std::thread::sleep(Duration::from_millis(150));
            }
        }

        /// GitHub release asset -> verified file in the cache.
        fn fetch_asset(&mut self, repo: &str, want: fn(&str, &str) -> bool) -> Result<(Asset, PathBuf), String> {
            let rel = crate::net::get_json(&format!("https://api.github.com/repos/{repo}/releases/latest"))?;
            let a = pick_asset(repo, &rel, want)?;
            self.log(&format!("{repo} {}: {} ({} MB), SHA-256 {}", a.tag, a.name, a.size / 1_000_000, a.sha256));
            let dest = self.st.cache_dir.join("linux-setup").join(&a.name);
            if dest.is_file() && crate::gameinstall::sha256_file(&dest).ok().as_deref() == Some(a.sha256.as_str()) {
                self.log("Already downloaded, same SHA-256.");
                return Ok((a, dest));
            }
            self.download(&a.url, &dest, a.size.max(1) * 2, github_download_host)?;
            let sha = crate::gameinstall::sha256_file(&dest)?;
            if sha != a.sha256 {
                let _ = std::fs::remove_file(&dest);
                return Err(format!("{}: SHA-256 {sha} does not match GitHub's {}; deleted", a.name, a.sha256));
            }
            self.log("SHA-256 matches.");
            Ok((a, dest))
        }

        fn download(&mut self, url: &str, dest: &Path, max: u64, host_ok: fn(&str) -> bool) -> Result<(), String> {
            self.log(&format!("Download {url}"));
            let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
            let agent = ureq::AgentBuilder::new()
                .user_agent(crate::net::UA)
                .redirects(5)
                .timeout_connect(Duration::from_secs(15))
                .timeout_read(Duration::from_secs(120))
                .tls_connector(Arc::new(tls))
                .build();
            let r = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
            if !host_ok(r.get_url()) {
                return Err(format!("The download went to {}, not an allowed host; stopped", r.get_url()));
            }
            let total: Option<u64> = r.header("content-length").and_then(|v| v.parse().ok());
            if total.is_some_and(|t| t > max) {
                return Err(format!("{url}: larger than expected"));
            }
            std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            let part = dest.with_extension("part");
            let res = (|| -> Result<(), String> {
                let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
                let mut rd = r.into_reader().take(max + 1);
                let mut buf = vec![0u8; 1 << 16];
                let (mut got, mut last) = (0u64, 0u64);
                loop {
                    self.check()?;
                    let n = rd.read(&mut buf).map_err(|e| format!("{url}: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    got += n as u64;
                    if got > max {
                        return Err(format!("{url}: larger than expected"));
                    }
                    f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    if got - last > (2 << 20) {
                        last = got;
                        (self.emit)("linux-setup-progress", serde_json::json!({ "game": self.plan.game, "step": self.step, "received": got, "total": total }));
                    }
                }
                f.sync_all().map_err(|e| e.to_string())?;
                (self.emit)("linux-setup-progress", serde_json::json!({ "game": self.plan.game, "step": self.step, "received": got, "total": total }));
                std::fs::rename(&part, dest).map_err(|e| e.to_string())
            })();
            if res.is_err() {
                let _ = std::fs::remove_file(&part);
            }
            res
        }

        /// `tar -xf` into `dir` (GNU tar refuses absolute and `..` member names).
        fn untar(&mut self, archive: &Path, dir: &Path) -> Result<(), String> {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let spec = CommandSpec { program: "tar".into(), args: vec![Arg::plain("-xf"), Arg::plain(archive.to_string_lossy()), Arg::plain("-C"), Arg::plain(dir.to_string_lossy())], cwd: None, env: vec![] };
            match self.run(&spec, Duration::from_secs(900))? {
                0 => Ok(()),
                c => Err(format!("tar failed ({c})")),
            }
        }

        fn step_runner(&mut self) -> Result<String, String> {
            let own = platform::own_runners_dir().ok_or("No data folder")?;
            if self.plan.get_umu {
                if platform::which("python3").is_none() {
                    return Err("umu-launcher needs python3; install it with your package manager".into());
                }
                let (a, file) = self.fetch_asset(UMU_REPO, want_umu)?;
                let _ = std::fs::remove_dir_all(own.join("umu"));
                self.untar(&file, &own)?;
                let u = own.join("umu/umu-run");
                if !u.is_file() {
                    return Err(format!("{} has no umu/umu-run", a.name));
                }
                self.log(&format!("umu-launcher {} in {}", a.tag, u.display()));
            }
            if self.plan.get_proton {
                let (a, file) = self.fetch_asset(GE_REPO, want_ge)?;
                let dir = own.join("proton");
                let target = dir.join(&a.tag);
                if !target.join("proton").is_file() {
                    let _ = std::fs::remove_dir_all(&target);
                    self.untar(&file, &dir)?;
                }
                if !target.join("proton").is_file() {
                    return Err(format!("{} did not unpack into {}", a.name, target.display()));
                }
                self.proton = Some(target);
            }
            let tools = platform::tools();
            let (cfg, _, _) = platform::config();
            let runner = match self.plan.runner.as_str() {
                "umu" => {
                    let umu = tools.umu.clone().ok_or("umu-run not found. Let TM Horizon download it, or install umu-launcher.")?;
                    let proton = self
                        .proton
                        .clone()
                        .or_else(|| self.plan.proton.as_deref().filter(|s| !s.trim().is_empty()).map(PathBuf::from))
                        .or_else(|| tools.protons.first().cloned());
                    self.proton = proton.clone();
                    SetupRunner::Umu { umu, proton, game_id: wine::umu_game_id(Some(&self.plan.game), &self.prefix) }
                }
                _ => {
                    let w = cfg.wine.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from).or(tools.wine.clone());
                    SetupRunner::Wine { wine: w.ok_or("Wine not found. Install it with the command shown, or use umu-run (no root needed).")? }
                }
            };
            let note = match &runner {
                SetupRunner::Wine { wine } => version_of(wine, "--version"),
                SetupRunner::Umu { umu, proton, .. } => format!("{} with {}", umu.display(), proton.as_ref().map(|p| wine::proton_name(p)).unwrap_or_else(|| "UMU-Proton (umu downloads it)".into())),
            };
            self.runner = Some(runner);
            Ok(note)
        }

        fn runner(&self) -> SetupRunner {
            self.runner.clone().expect("runner step ran")
        }

        fn write_registry(&mut self, o: &PrefixOptions) -> Result<(), String> {
            let reg = self.prefix.join("tmhub.reg");
            std::fs::write(&reg, wine::registry_text(o)).map_err(|e| e.to_string())?;
            let c = regedit_cmd(&self.runner(), &self.prefix, &reg);
            match self.run(&c, Duration::from_secs(300))? {
                0 => Ok(()),
                c => Err(format!("regedit failed ({c})")),
            }
        }

        fn step_prefix(&mut self) -> Result<String, String> {
            std::fs::create_dir_all(&self.prefix).map_err(|e| e.to_string())?;
            let fresh = !wine::is_prefix(&self.prefix);
            let c = wineboot_cmd(&self.runner(), &self.prefix);
            let code = self.run(&c, Duration::from_secs(900))?;
            if !wine::is_prefix(&self.prefix) {
                return Err(format!("wineboot ended ({code}) without creating {}", self.prefix.display()));
            }
            let o = merge_options(&self.plan.options, wine::read_options(&self.prefix).as_ref());
            wine::write_options(&self.prefix, &o).map_err(|e| e.to_string())?;
            self.write_registry(&o)?;
            Ok(format!("{} {}", if fresh { "Created" } else { "Updated" }, self.prefix.display()))
        }

        fn step_dxvk(&mut self) -> Result<String, String> {
            let (a, file) = self.fetch_asset(DXVK_REPO, want_dxvk)?;
            let dir = self.st.cache_dir.join("linux-setup").join("dxvk");
            let _ = std::fs::remove_dir_all(&dir);
            self.untar(&file, &dir)?;
            let root = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).find(|p| p.join("x64").is_dir() || p.join("x32").is_dir()).ok_or("DXVK archive without x64/x32")?;
            for (from, to) in dxvk_copies(&root, &self.prefix) {
                if !from.is_file() {
                    continue;
                }
                std::fs::copy(&from, &to).map_err(|e| format!("{} -> {}: {e}", from.display(), to.display()))?;
            }
            let version = a.tag.trim_start_matches('v').to_string();
            let mut o = merge_options(&self.plan.options, wine::read_options(&self.prefix).as_ref());
            o.dxvk_version = Some(version.clone());
            wine::write_options(&self.prefix, &o).map_err(|e| e.to_string())?;
            self.write_registry(&o)?;
            Ok(format!("DXVK {version}"))
        }

        fn step_winetricks(&mut self) -> Result<String, String> {
            let wt = platform::which("winetricks");
            let Some(c) = winetricks_cmd(&self.runner(), &self.prefix, wt.as_deref(), &self.plan.winetricks) else {
                return Ok("skip: winetricks is not installed".into());
            };
            match self.run(&c, Duration::from_secs(1800))? {
                0 => Ok(self.plan.winetricks.join(", ")),
                c => Err(format!("winetricks failed ({c})")),
            }
        }

        fn step_game(&mut self) -> Result<String, String> {
            let game = self.plan.game.clone();
            if let Some(exe) = installed_exe(&self.prefix, &game) {
                return Ok(format!("skip: already installed ({})", exe.display()));
            }
            let crate::gameinstall::Source::Download { url, file, size, .. } = crate::gameinstall::source(&game) else {
                return Err("No official download for this game".into());
            };
            let known = known_setup_hash(&game).ok_or("No known SHA-256 for this setup")?;
            let dest = self.st.cache_dir.join("setups").join(file);
            if !(dest.is_file() && crate::gameinstall::sha256_file(&dest).ok().as_deref() == Some(known)) {
                // Nadeo's hosts only (TMUF is plain http; the pinned SHA-256 below guards it).
                fn host_ok(u: &str) -> bool {
                    url::Url::parse(u).ok().and_then(|x| x.host_str().map(str::to_ascii_lowercase)).is_some_and(|h| h == "nadeo-download.cdn.ubi.com" || h == "files.trackmaniaforever.com")
                }
                self.download(url, &dest, size + (1 << 20), host_ok)?;
            } else {
                self.log("Setup already downloaded, same SHA-256.");
            }
            let sha = crate::gameinstall::sha256_file(&dest)?;
            if !sha.eq_ignore_ascii_case(known) {
                let _ = std::fs::remove_file(&dest);
                return Err(format!("The setup is not the known file (SHA-256 {sha}). Deleted, not run."));
            }
            self.log(&format!("SHA-256 {sha} matches the known setup."));
            let _ = self.st.update_settings(|s| {
                s.installer_hashes.entry(url.to_string()).or_insert(sha.clone());
            });
            let kind = installer_kind(&dest);
            let args = setup_args(kind);
            self.log(&format!("Installer: {kind:?}{}", if args.is_empty() { ", runs with its own window" } else { ", silent switches" }));
            let c = prefix_cmd(&self.runner(), &self.prefix, &dest.to_string_lossy(), &args);
            let code = self.run(&c, Duration::from_secs(3600))?;
            let exe = installed_exe(&self.prefix, &game).ok_or(format!("The setup ended ({code}) but the game is not in the prefix"))?;
            Ok(exe.to_string_lossy().into_owned())
        }

        fn step_tmloader(&mut self) -> Result<String, String> {
            if let Some(p) = tmloader_exe(&self.prefix, user().as_deref()) {
                return Ok(format!("skip: already there ({})", p.display()));
            }
            self.log(&format!("TMLoader installer from {}", crate::tmlsetup::PAGE));
            let d = crate::tmlsetup::download_with(&self.st.cache_dir.join("tmloader-setup"), |u, max| crate::net::get_bytes_final(u, max))?;
            self.log(&format!("{} ({} KB, SHA-256 {})", d.url, d.size / 1024, d.sha256));
            self.check()?;
            // Tomashu's page documents no silent switches: his installer shows its own steps.
            let c = prefix_cmd(&self.runner(), &self.prefix, &d.path, &[]);
            let code = self.run(&c, Duration::from_secs(3600))?;
            let p = tmloader_exe(&self.prefix, user().as_deref()).ok_or(format!("The TMLoader installer ended ({code}) without installing TMLoader"))?;
            Ok(p.to_string_lossy().into_owned())
        }

        fn step_register(&mut self) -> Result<String, String> {
            let (runner, prefix, proton) = (self.plan.runner.clone(), self.prefix.clone(), self.proton.clone());
            let game = self.plan.game.clone();
            let saved = self.st.update_settings(|s| register(&mut s.linux, &game, &runner, &prefix, proton.as_deref()))?;
            platform::configure(&saved.linux, None);
            let snap = crate::commands::do_scan(self.st);
            let found = match game.as_str() {
                "tmnf" => snap.games.tmnf.installs.iter().any(|i| Path::new(&i.path).starts_with(&prefix)),
                "tmuf" => snap.games.tmuf.installs.iter().any(|i| Path::new(&i.path).starts_with(&prefix)),
                _ => false,
            };
            (self.emit)("linux-setup-snapshot", serde_json::to_value(&snap).unwrap_or_default());
            Ok(if found { format!("{game} found in {}", prefix.display()) } else { "Saved in Settings > Linux".into() })
        }
    }

    /// End to end in a throwaway HOME (needs wine, tar and the network; downloads DXVK and the
    /// 530 MB TMNF setup unless TMHUB_E2E_SETUP points at an already downloaded copy):
    /// `HOME=/tmp/tmh-e2e USER=tester TMHUB_E2E=tmnf cargo test e2e_setup -- --ignored --nocapture`
    /// TMHUB_E2E_TMLOADER=1 also installs TMLoader (NSIS `/S` here, so it runs unattended; the
    /// app itself shows Tomashu's installer).
    #[cfg(test)]
    mod e2e {
        use super::*;

        #[test]
        #[ignore]
        fn e2e_setup() {
            let game = std::env::var("TMHUB_E2E").unwrap_or_else(|_| "tmnf".into());
            let home = PathBuf::from(std::env::var("HOME").unwrap());
            assert!(home.starts_with("/tmp"), "run with a throwaway HOME under /tmp");
            let data = home.join(".local/share/app.tmhub.launcher");
            let cache = home.join(".cache/app.tmhub.launcher");
            let st = AppState::new(home.join(".config/app.tmhub.launcher"), data.clone(), cache.clone());
            if let (Ok(seed), crate::gameinstall::Source::Download { file, .. }) = (std::env::var("TMHUB_E2E_SETUP"), crate::gameinstall::source(&game)) {
                std::fs::create_dir_all(cache.join("setups")).unwrap();
                std::fs::copy(seed, cache.join("setups").join(file)).unwrap();
            }
            let emit = |name: &str, v: Value| match name {
                "linux-setup-log" => println!("    {}", v["line"].as_str().unwrap_or("")),
                "linux-setup-progress" | "linux-setup-snapshot" => {}
                _ => println!(">> {name} {v}"),
            };
            let plan = SetupPlan { game: game.clone(), runner: "wine".into(), tmloader: false, ..Default::default() };
            let t0 = Instant::now();
            run_job(&st, &plan, Arc::new(AtomicBool::new(false)), &emit).unwrap();
            println!("== install took {:?}", t0.elapsed());
            let prefix = prefix_dir(&data, &game);
            let exe = installed_exe(&prefix, &game).expect("game in the prefix");
            println!("== game exe {}", exe.display());
            let o = wine::read_options(&prefix).unwrap();
            assert!(o.dxvk_version.is_some());
            let d3d9 = std::fs::read(prefix.join("drive_c/windows/syswow64/d3d9.dll")).unwrap();
            assert!(d3d9.windows(4).any(|w| w == b"DXVK" || w == b"dxvk"), "syswow64/d3d9.dll is DXVK's");
            let user_reg = std::fs::read_to_string(prefix.join("user.reg")).unwrap();
            assert!(user_reg.contains("\"GrabFullscreen\"=\"Y\""), "registry fixes in user.reg");
            assert!(user_reg.contains("\"d3d9\"=\"native,builtin\""));

            if std::env::var("TMHUB_E2E_TMLOADER").is_ok() {
                let d = crate::tmlsetup::download_with(&cache.join("tmloader-setup"), |u, max| crate::net::get_bytes_final(u, max)).unwrap();
                let w = SetupRunner::Wine { wine: platform::tools().wine.unwrap() };
                let c = prefix_cmd(&w, &prefix, &d.path, &["/S".into()]);
                let code = build(&c).status().unwrap();
                println!("== TMLoader installer exit {code:?}");
            }
            let tml = tmloader_exe(&prefix, user().as_deref());
            println!("== TMLoader {tml:?}");

            // Repair keeps everything and runs again.
            let rep = SetupPlan { repair: true, ..plan.clone() };
            run_job(&st, &rep, Arc::new(AtomicBool::new(false)), &emit).unwrap();

            // Registered: Settings > Linux and the scanner.
            let s = st.settings();
            assert_eq!(s.linux.games[&game].prefix.as_deref(), Some(prefix.to_string_lossy().as_ref()));
            assert_eq!(s.linux.games[&game].runner.as_deref(), Some("wine"));
            let snap = crate::commands::do_scan(&st);
            let list = if game == "tmnf" { &snap.games.tmnf.installs } else { &snap.games.tmuf.installs };
            for i in list {
                println!("== scanner {}: {} [{}] launch={:?}", game, i.path, i.source, i.launch);
            }
            assert!(list.iter().any(|i| Path::new(&i.path).starts_with(&prefix)));

            // How it starts (not started): TMLoader when there, else the game exe.
            let (program, args) = match tml {
                Some(t) => (t, vec![Arg::plain("run"), Arg::plain("TmForever"), Arg::plain("Default")]),
                None => (exe.clone(), vec![]),
            };
            let spec = platform::linux_spec(&CommandSpec { program, args, cwd: None, env: vec![] }).unwrap();
            println!("== start {}", shown(&spec));
            assert!(spec.env.contains(&("WINEPREFIX".into(), prefix.to_string_lossy().into_owned())));
            assert!(spec.env.contains(&("WINEDLLOVERRIDES".into(), "d3d8,d3d9,d3d10core,d3d11,dxgi=n,b".into())));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release() -> Value {
        json!({
            "tag_name": "GE-Proton11-12",
            "assets": [
                { "name": "GE-Proton11-12-aarch64.tar.gz", "size": 1, "digest": "sha256:cbf85e13a6a500cb6747881620b061faccf3c93e05e2102c6b5e992d5aa44c78",
                  "browser_download_url": "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-12/GE-Proton11-12-aarch64.tar.gz" },
                { "name": "GE-Proton11-12-x86_64.sha512sum", "size": 159, "digest": "sha256:cf7564e3d7b79540121affaae435ab9b5d83e9a5892c7c11b90d6745319e48ad",
                  "browser_download_url": "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-12/GE-Proton11-12-x86_64.sha512sum" },
                { "name": "GE-Proton11-12-x86_64.tar.gz", "size": 566859228, "digest": "sha256:0595159E417C3DBBFB7CC3AE0D3ED15A617CC607AA23EF756EA79029D7AF5D70",
                  "browser_download_url": "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-12/GE-Proton11-12-x86_64.tar.gz" }
            ]
        })
    }

    #[test]
    fn github_assets_need_a_digest_and_the_right_repo() {
        let a = pick_asset(GE_REPO, &release(), want_ge).unwrap();
        assert_eq!(a.name, "GE-Proton11-12-x86_64.tar.gz");
        assert_eq!(a.tag, "GE-Proton11-12");
        assert_eq!(a.sha256, "0595159e417c3dbbfb7cc3ae0d3ed15a617cc607aa23ef756ea79029d7af5d70");
        // Wrong repository in the link, missing digest, nothing matching.
        assert!(pick_asset("someone/else", &release(), want_ge).unwrap_err().contains("not a release download"));
        let mut r = release();
        r["assets"][2]["digest"] = Value::Null;
        assert!(pick_asset(GE_REPO, &r, want_ge).unwrap_err().contains("no SHA-256"));
        assert!(pick_asset(GE_REPO, &release(), want_dxvk).is_err());
        assert!(want_umu("umu-launcher-1.4.4-zipapp.tar", "1.4.4"));
        assert!(!want_umu("umu-launcher-1.4.4.fc43.x86_64.rpm", "1.4.4"));
        assert!(want_dxvk("dxvk-3.1.1.tar.gz", "v3.1.1"));
        assert!(!want_dxvk("dxvk-native-3.1.1-steamrt-sniper.tar.gz", "v3.1.1"));
        assert!(github_download_host("https://release-assets.githubusercontent.com/x"));
        assert!(github_download_host("https://github.com/x"));
        assert!(!github_download_host("https://github.com.evil.example/x"));
        assert!(!github_download_host("http://objects.githubusercontent.com/x"));
    }

    #[test]
    fn distro_commands() {
        assert_eq!(distro_family("arch", ""), "arch");
        assert_eq!(distro_family("cachyos", "arch"), "arch");
        assert_eq!(distro_family("linuxmint", "ubuntu debian"), "debian");
        assert_eq!(distro_family("pop", "\"ubuntu debian\""), "debian");
        assert_eq!(distro_family("fedora", ""), "fedora");
        assert_eq!(distro_family("opensuse-tumbleweed", "opensuse suse"), "suse");
        assert_eq!(distro_family("nixos", ""), "");
        let c = install_commands("fedora");
        assert!(c[0].matches && c[0].command.starts_with("sudo dnf"));
        assert_eq!(c.iter().filter(|x| x.matches).count(), 1);
        assert!(c.iter().any(|x| x.command.contains("flatpak install")));
        assert!(install_commands("").iter().all(|x| !x.matches));
        assert!(install_commands("debian")[0].command.contains("wine32:i386"));
    }

    #[test]
    fn installers_and_switches() {
        let mut inno = vec![0u8; 4096];
        inno.extend_from_slice(b"<description>Inno Setup</description>");
        assert_eq!(installer_kind_of(&inno), InstallerKind::Inno);
        assert_eq!(installer_kind_of(b"MZ..Nullsoft Install System v3.09"), InstallerKind::Nsis);
        assert_eq!(installer_kind_of(b"MZ plain"), InstallerKind::Unknown);
        // Marker only at the end of a big file (TMNF's layout).
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("setup.exe");
        let mut big = vec![0u8; 20 << 20];
        big[0..2].copy_from_slice(b"MZ");
        let at = big.len() - 600_000;
        big[at..at + 21].copy_from_slice(b"Inno Setup Setup Data");
        std::fs::write(&f, &big).unwrap();
        assert_eq!(installer_kind(&f), InstallerKind::Inno);
        std::fs::write(&f, &big[..at]).unwrap();
        assert_eq!(installer_kind(&f), InstallerKind::Unknown);
        assert_eq!(setup_args(InstallerKind::Inno), ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]);
        assert!(setup_args(InstallerKind::Nsis).is_empty());
        assert!(setup_args(InstallerKind::Unknown).is_empty());
    }

    #[test]
    fn commands_inside_the_prefix() {
        let pfx = Path::new("/home/me/.local/share/app.tmhub.launcher/prefixes/tmnf");
        let w = SetupRunner::Wine { wine: "/usr/bin/wine".into() };
        let c = wineboot_cmd(&w, pfx);
        assert_eq!(c.program, PathBuf::from("/usr/bin/wine"));
        assert_eq!(c.args.iter().map(|a| a.unquoted()).collect::<Vec<_>>(), ["wineboot", "-u"]);
        for kv in [("WINEPREFIX", pfx.to_str().unwrap()), ("WINEARCH", "win64"), ("WINEDEBUG", "-all"), ("WINEDLLOVERRIDES", "mscoree,mshtml=")] {
            assert!(c.env.contains(&(kv.0.to_string(), kv.1.to_string())), "{kv:?}");
        }
        let setup = Path::new("/home/me/.cache/app.tmhub.launcher/setups/tmnationsforever_setup.exe");
        let s = prefix_cmd(&w, pfx, &setup.to_string_lossy(), &setup_args(InstallerKind::Inno));
        assert_eq!(s.args[0].unquoted(), setup.to_string_lossy());
        assert_eq!(s.args[1].unquoted(), "/SILENT");
        #[cfg(unix)]
        {
            let r = regedit_cmd(&w, pfx, &pfx.join("tmhub.reg"));
            assert_eq!(r.args.iter().map(|a| a.unquoted()).collect::<Vec<_>>(), ["regedit", "/S", r"Z:\home\me\.local\share\app.tmhub.launcher\prefixes\tmnf\tmhub.reg"]);
        }
        let u = SetupRunner::Umu { umu: "/d/runners/umu/umu-run".into(), proton: Some("/d/runners/proton/GE-Proton11-12".into()), game_id: "umu-11020".into() };
        let c = wineboot_cmd(&u, pfx);
        assert_eq!(c.program, PathBuf::from("/d/runners/umu/umu-run"));
        assert_eq!(c.args.iter().map(|a| a.unquoted()).collect::<Vec<_>>(), [""]);
        assert!(c.env.contains(&("GAMEID".into(), "umu-11020".into())));
        assert!(c.env.contains(&("PROTONPATH".into(), "/d/runners/proton/GE-Proton11-12".into())));
        assert!(!c.env.iter().any(|(k, _)| k == "WINEARCH"));
        // winetricks: plain Wine needs the binary; umu has a verb.
        let verbs = vec!["corefonts".to_string()];
        assert!(winetricks_cmd(&w, pfx, None, &verbs).is_none());
        let t = winetricks_cmd(&w, pfx, Some(Path::new("/usr/bin/winetricks")), &verbs).unwrap();
        assert_eq!(t.program, PathBuf::from("/usr/bin/winetricks"));
        assert!(t.env.contains(&("WINE".into(), "/usr/bin/wine".into())));
        let t = winetricks_cmd(&u, pfx, None, &verbs).unwrap();
        assert_eq!(t.args.iter().map(|a| a.unquoted()).collect::<Vec<_>>(), ["winetricks", "-q", "corefonts"]);
        assert!(wineserver_kill_cmd(&u, pfx).is_none());
        assert_eq!(wineserver_kill_cmd(&w, pfx).unwrap().args[0].unquoted(), "-k");
    }

    #[test]
    fn dxvk_goes_to_both_system_folders() {
        let t = tempfile::tempdir().unwrap();
        let p64 = t.path().join("p64");
        std::fs::create_dir_all(p64.join("drive_c/windows/syswow64")).unwrap();
        let c = dxvk_copies(Path::new("/x/dxvk-3.1.1"), &p64);
        assert_eq!(c.len(), 10);
        assert!(c.contains(&(PathBuf::from("/x/dxvk-3.1.1/x32/d3d9.dll"), p64.join("drive_c/windows/syswow64/d3d9.dll"))));
        assert!(c.contains(&(PathBuf::from("/x/dxvk-3.1.1/x64/d3d9.dll"), p64.join("drive_c/windows/system32/d3d9.dll"))));
        let p32 = t.path().join("p32");
        std::fs::create_dir_all(p32.join("drive_c/windows/system32")).unwrap();
        let c = dxvk_copies(Path::new("/x/d"), &p32);
        assert_eq!(c.len(), 5);
        assert!(c.contains(&(PathBuf::from("/x/d/x32/d3d9.dll"), p32.join("drive_c/windows/system32/d3d9.dll"))));
    }

    #[test]
    fn plans_steps_and_settings() {
        let mut p = SetupPlan { game: "tmnf".into(), ..Default::default() };
        assert!(validate_plan(&p).is_ok());
        assert_eq!(plan_steps(&p), ["runner", "prefix", "dxvk", "game", "tmloader", "register"]);
        p.winetricks = vec!["corefonts".into()];
        p.runner = "umu".into();
        assert_eq!(plan_steps(&p), ["runner", "prefix", "winetricks", "game", "tmloader", "register"]);
        p.repair = true;
        assert_eq!(plan_steps(&p), ["runner", "prefix", "register"]);
        for bad in [
            SetupPlan { game: "tmn-eswc".into(), ..Default::default() },
            SetupPlan { game: "tmnf".into(), runner: "dosbox".into(), ..Default::default() },
            SetupPlan { game: "tmnf".into(), get_umu: true, ..Default::default() },
            SetupPlan { game: "tmnf".into(), winetricks: vec!["vcrun2022; rm -rf".into()], ..Default::default() },
            SetupPlan { game: "tmnf".into(), proton: Some("relative".into()), ..Default::default() },
            SetupPlan { game: "tmnf".into(), options: PrefixOptions { virtual_desktop: Some("x".into()), ..Default::default() }, ..Default::default() },
            SetupPlan { game: "tmnf".into(), options: PrefixOptions { windows_version: "win95".into(), ..Default::default() }, ..Default::default() },
        ] {
            assert!(validate_plan(&bad).is_err(), "{bad:?}");
        }
        assert_eq!(game_kind("tmuf"), Some("download"));
        assert_eq!(game_kind("tm-sunrise"), Some("existing"));
        assert_eq!(game_kind("maniaplanet"), Some("steam"));
        assert_eq!(known_setup_hash("tmuf"), Some(crate::gameinstall::TMUF_SHA256));

        let mut l = wine::LinuxSettings::default();
        let pfx = Path::new("/d/prefixes/tmnf");
        register(&mut l, "tmnf", "umu", pfx, Some(Path::new("/d/runners/proton/GE-Proton11-12")));
        assert_eq!(l.games["tmnf"].runner.as_deref(), Some("umu"));
        assert_eq!(l.games["tmnf"].proton.as_deref(), Some("/d/runners/proton/GE-Proton11-12"));
        assert_eq!(l.prefix.as_deref(), Some("/d/prefixes/tmnf"));
        // A main prefix picked by the user stays.
        register(&mut l, "tmuf", "wine", Path::new("/d/prefixes/tmuf"), Some(Path::new("/ignored")));
        assert_eq!(l.prefix.as_deref(), Some("/d/prefixes/tmnf"));
        assert_eq!(l.games["tmuf"].proton, None);
        assert!(crate::linuxcmds::validate(l).is_ok());

        let old = PrefixOptions { dxvk_version: Some("3.1.1".into()), ..Default::default() };
        let new = PrefixOptions { cpu_limit: 8, ..Default::default() };
        let m = merge_options(&new, Some(&old));
        assert_eq!(m.cpu_limit, 8);
        assert_eq!(m.dxvk_version.as_deref(), Some("3.1.1"));
    }

    #[test]
    fn game_and_tmloader_in_a_prefix() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("pfx");
        std::fs::create_dir_all(p.join("drive_c/Program Files (x86)/TmNationsForever")).unwrap();
        assert!(installed_exe(&p, "tmnf").is_none());
        std::fs::write(p.join("drive_c/Program Files (x86)/TmNationsForever/TmForever.exe"), b"MZ").unwrap();
        assert!(installed_exe(&p, "tmnf").unwrap().ends_with("TmNationsForever/TmForever.exe"));
        assert!(installed_exe(&p, "tmuf").is_none());
        std::fs::create_dir_all(p.join("drive_c/users/me/AppData/Local/TMLoader")).unwrap();
        assert!(tmloader_exe(&p, Some("me")).is_none());
        std::fs::write(p.join("drive_c/users/me/AppData/Local/TMLoader/TMLoader.exe"), b"MZ").unwrap();
        assert!(tmloader_exe(&p, Some("me")).is_some());
    }
}
