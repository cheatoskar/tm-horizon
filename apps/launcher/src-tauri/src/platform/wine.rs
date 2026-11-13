//! Wine and Proton prefixes: finding them, mapping Windows paths into them, choosing how a
//! Windows exe is started on Linux. Pure file-system logic without any Linux-only API, so it
//! compiles and is unit tested on every OS (the tests build fake prefixes in a temp folder).
//! `platform::linux` uses it with the real home folder and the settings.
//!
//! Where prefixes come from (first wins when one folder is found twice):
//! 1. Settings (main prefix, extra prefixes, per-game prefixes)
//! 2. `$WINEPREFIX`
//! 3. Steam (native and Flatpak): `steamapps/compatdata/<appid>/pfx` for the TrackMania app ids
//! 4. TM Horizon's own `~/.local/share/app.tmhub.launcher/prefixes/*`
//! 5. Lutris game configs (`game: prefix:`), Bottles, Heroic (`~/Games/Heroic/Prefixes`)
//! 6. `~/Games/*` (Lutris' default install place) and `~/.wine`

use crate::launch::{Arg, CommandSpec, Runner};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// Steam app ids whose Proton prefixes may hold a TrackMania game (and TMLoader).
pub const STEAM_IDS: &[(u32, &str)] = &[
    (11020, "tmnf"),
    (7200, "tmuf"),
    (228760, "maniaplanet"),
    (232910, "tm2-stadium"),
    (243360, "tm2-valley"),
    (600720, "tm2-lagoon"),
    (229870, "sm-storm"),
    (2225070, "tm2020"),
    (375900, "tm-turbo"),
];

// ------------------------------------------------------------------ settings

/// Linux part of the settings (saved on every OS, used only on Linux).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LinuxSettings {
    /// "auto" (default, also when empty), "wine", "umu" or "proton".
    pub runner: String,
    /// wine binary; empty = `wine` from PATH.
    pub wine: Option<String>,
    /// Proton folder (the one that holds the `proton` script) for "proton" and "umu"; empty =
    /// the newest Proton Steam has installed.
    pub proton: Option<String>,
    /// The prefix whose Documents and AppData (TMLoader) the launcher uses; empty = found.
    pub prefix: Option<String>,
    /// More prefixes to look into.
    pub prefixes: Vec<String>,
    /// Per game id ("tmnf", "tmuf", "tmn-eswc", "maniaplanet", "tm2020", ...).
    pub games: BTreeMap<String, LinuxGame>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LinuxGame {
    pub runner: Option<String>,
    pub prefix: Option<String>,
    /// Proton folder for this game (umu-run / Proton); empty = the global choice.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proton: Option<String>,
}

fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

// ------------------------------------------------------------------ case-insensitive paths

/// The path as it exists on disk when only the letter case differs (Windows games and mods
/// write `GameData`, `Skins`, `TrackMania` in whatever case; Linux file systems care). Each
/// missing component is looked up case-insensitively in its parent; from the first one that
/// does not exist at all the rest is kept as given (so new files can still be written).
pub fn resolve_ci(p: &Path) -> Cow<'_, Path> {
    if !p.is_absolute() || p.exists() {
        return Cow::Borrowed(p);
    }
    let mut cur = PathBuf::new();
    let mut missing = false;
    for c in p.components() {
        match c {
            Component::Normal(name) if !missing => {
                let direct = cur.join(name);
                if direct.symlink_metadata().is_ok() {
                    cur = direct;
                    continue;
                }
                let want = name.to_string_lossy().to_lowercase();
                let found = std::fs::read_dir(&cur)
                    .ok()
                    .and_then(|rd| rd.flatten().find(|e| e.file_name().to_string_lossy().to_lowercase() == want))
                    .map(|e| e.path());
                match found {
                    Some(f) => cur = f,
                    None => {
                        missing = true;
                        cur.push(name);
                    }
                }
            }
            other => cur.push(other.as_os_str()),
        }
    }
    Cow::Owned(cur)
}

// ------------------------------------------------------------------ prefixes

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefix {
    pub path: PathBuf,
    /// "Settings", "WINEPREFIX", "Steam (Proton)", "TM Horizon", "Lutris", "Bottles", "Heroic",
    /// "Games folder", "Wine".
    pub source: String,
    /// Steam app id for `compatdata/<id>/pfx`.
    pub steam_app_id: Option<u32>,
}

/// A folder is a prefix when it has `drive_c`.
pub fn is_prefix(dir: &Path) -> bool {
    dir.join("drive_c").is_dir()
}

/// The prefix an exe (or any path) lives in: the nearest parent with `drive_c` right below it
/// whose `drive_c` is part of the path.
pub fn prefix_of(path: &Path) -> Option<PathBuf> {
    let mut cur = path;
    while let Some(parent) = cur.parent() {
        if cur.file_name().map(|n| n.eq_ignore_ascii_case("drive_c")).unwrap_or(false) && is_prefix(parent) {
            return Some(parent.to_path_buf());
        }
        cur = parent;
    }
    None
}

/// A Steam game's own Proton prefix: for `<lib>/steamapps/common/<dir>/...` the app whose
/// manifest has `installdir` = `<dir>`, then `<lib>/steamapps/compatdata/<id>/pfx` if it exists.
pub fn steam_prefix_for(exe: &Path) -> Option<PathBuf> {
    let mut cur = exe;
    while let Some(parent) = cur.parent() {
        if parent.file_name().map(|n| n == "common").unwrap_or(false) && parent.parent().and_then(|p| p.file_name()).map(|n| n == "steamapps").unwrap_or(false) {
            let dir = cur.file_name()?.to_string_lossy().to_string();
            let steamapps = parent.parent()?;
            for e in std::fs::read_dir(steamapps).ok()?.flatten() {
                let n = e.file_name().to_string_lossy().to_lowercase();
                if !(n.starts_with("appmanifest_") && n.ends_with(".acf")) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
                let v = crate::vdf::parse(&text);
                let Some(st) = v.get("AppState") else { continue };
                if st.get("installdir").and_then(|x| x.str()).map(|d| d.eq_ignore_ascii_case(&dir)).unwrap_or(false) {
                    let id = st.get("appid").and_then(|x| x.str())?;
                    let pfx = steamapps.join("compatdata").join(id).join("pfx");
                    return is_prefix(&pfx).then_some(pfx);
                }
            }
            return None;
        }
        cur = parent;
    }
    None
}

/// `compatdata/<id>/pfx` -> id.
pub fn steam_app_of_prefix(prefix: &Path) -> Option<u32> {
    if prefix.file_name()? != "pfx" {
        return None;
    }
    let id_dir = prefix.parent()?;
    if id_dir.parent()?.file_name()? != "compatdata" {
        return None;
    }
    id_dir.file_name()?.to_str()?.parse().ok()
}

/// Inputs for the prefix search (the real values come from `platform::linux`).
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: PathBuf,
    pub wineprefix: Option<PathBuf>,
    /// Steam library folders (each has `steamapps/`).
    pub steam_libraries: Vec<PathBuf>,
    /// TM Horizon's own prefix folder (`<data dir>/prefixes`).
    pub hub_prefixes: Option<PathBuf>,
    /// User name inside prefixes (`$USER`).
    pub user: Option<String>,
}

fn subdirs(d: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(d).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
    v.sort();
    v
}

/// Lutris keeps one YAML per game (`~/.config/lutris/games/*.yml`, newer versions
/// `~/.local/share/lutris/games/*.yml`) with `game: { prefix: ..., exe: ... }`.
pub fn lutris_prefixes(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for d in [home.join(".config/lutris/games"), home.join(".local/share/lutris/games"), home.join(".var/app/net.lutris.Lutris/config/lutris/games")] {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "yml" || x == "yaml").unwrap_or(false)).collect();
        files.sort();
        for f in files {
            let Ok(text) = std::fs::read_to_string(&f) else { continue };
            let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(&text) else { continue };
            if let Some(p) = v.get("game").and_then(|g| g.get("prefix")).and_then(|p| p.as_str()) {
                let p = p.trim();
                let p = if let Some(rest) = p.strip_prefix("~/") { home.join(rest) } else { PathBuf::from(p) };
                out.push(p);
            }
        }
    }
    out
}

/// Every prefix found, in the order of the module comment, without duplicates.
pub fn find_prefixes(env: &Env, cfg: &LinuxSettings) -> Vec<Prefix> {
    let mut out: Vec<Prefix> = Vec::new();
    let mut add = |p: PathBuf, source: &str| {
        if !is_prefix(&p) {
            return;
        }
        let key = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
        if out.iter().any(|q| std::fs::canonicalize(&q.path).unwrap_or_else(|_| q.path.clone()) == key) {
            return;
        }
        let steam_app_id = steam_app_of_prefix(&p);
        out.push(Prefix { path: p, source: source.into(), steam_app_id });
    };
    let expand = |s: &str| -> PathBuf {
        match s.strip_prefix("~/") {
            Some(rest) => env.home.join(rest),
            None => PathBuf::from(s),
        }
    };
    if let Some(p) = nonempty(&cfg.prefix) {
        add(expand(p), "Settings");
    }
    for g in cfg.games.values() {
        if let Some(p) = nonempty(&g.prefix) {
            add(expand(p), "Settings");
        }
    }
    for p in &cfg.prefixes {
        if !p.trim().is_empty() {
            add(expand(p.trim()), "Settings");
        }
    }
    if let Some(p) = &env.wineprefix {
        add(p.clone(), "WINEPREFIX");
    }
    for lib in &env.steam_libraries {
        for (id, _) in STEAM_IDS {
            add(lib.join("steamapps").join("compatdata").join(id.to_string()).join("pfx"), "Steam (Proton)");
        }
    }
    if let Some(h) = &env.hub_prefixes {
        for d in subdirs(h) {
            add(d, "TM Horizon");
        }
    }
    for p in lutris_prefixes(&env.home) {
        add(p, "Lutris");
    }
    for b in [env.home.join(".local/share/bottles/bottles"), env.home.join(".var/app/com.usebottles.bottles/data/bottles/bottles")] {
        for d in subdirs(&b) {
            add(d, "Bottles");
        }
    }
    let heroic = env.home.join("Games/Heroic/Prefixes");
    for d in subdirs(&heroic).into_iter().chain(subdirs(&heroic.join("default"))) {
        add(d, "Heroic");
    }
    for d in subdirs(&env.home.join("Games")) {
        add(d.clone(), "Games folder");
        // Some installers put the prefix one level down (~/Games/<game>/prefix or /pfx).
        for sub in ["prefix", "pfx", "wine"] {
            add(d.join(sub), "Games folder");
        }
    }
    add(env.home.join(".wine"), "Wine");
    out
}

// ------------------------------------------------------------------ folders inside a prefix

/// `drive_c/users/<user>`: `$USER` when it exists there, then `steamuser` (Proton), then the
/// first one that is not `Public`.
pub fn user_dir(prefix: &Path, user: Option<&str>) -> Option<PathBuf> {
    let users = prefix.join("drive_c").join("users");
    if let Some(u) = user {
        let p = resolve_ci(&users.join(u)).into_owned();
        if p.is_dir() {
            return Some(p);
        }
    }
    let p = users.join("steamuser");
    if p.is_dir() {
        return Some(p);
    }
    subdirs(&users).into_iter().find(|d| d.file_name().map(|n| !n.eq_ignore_ascii_case("public")).unwrap_or(false))
}

fn first_existing(base: &Path, names: &[&str]) -> PathBuf {
    for n in names {
        let p = resolve_ci(&base.join(n)).into_owned();
        if p.exists() {
            return p;
        }
    }
    base.join(names[0])
}

/// Documents of the prefix user (old prefixes: "My Documents"; often a link to ~/Documents).
pub fn documents(prefix: &Path, user: Option<&str>) -> Option<PathBuf> {
    user_dir(prefix, user).map(|u| first_existing(&u, &["Documents", "My Documents"]))
}

/// %LOCALAPPDATA% of the prefix user (Wine before 5.0: "Local Settings/Application Data").
pub fn local_app_data(prefix: &Path, user: Option<&str>) -> Option<PathBuf> {
    user_dir(prefix, user).map(|u| first_existing(&u, &["AppData/Local", "Local Settings/Application Data"]))
}

pub fn program_files(prefix: &Path) -> Vec<PathBuf> {
    let c = prefix.join("drive_c");
    ["Program Files (x86)", "Program Files"].iter().map(|n| c.join(n)).filter(|p| p.is_dir()).collect()
}

pub fn program_data(prefix: &Path) -> PathBuf {
    prefix.join("drive_c").join("ProgramData")
}

// ------------------------------------------------------------------ path mapping

/// `C:\users\me\Documents\x` -> `<prefix>/drive_c/users/me/Documents/x` (case-insensitive),
/// `Z:\home\me\x` -> `/home/me/x`, other letters through `dosdevices/<x>:`.
pub fn windows_to_host(prefix: &Path, win: &str) -> Option<PathBuf> {
    let w = win.trim().trim_matches('"').replace('/', "\\");
    let b = w.as_bytes();
    if b.len() < 2 || b[1] != b':' || !b[0].is_ascii_alphabetic() {
        return None;
    }
    let letter = (b[0] as char).to_ascii_lowercase();
    let rest: Vec<&str> = w[2..].split('\\').filter(|s| !s.is_empty() && *s != ".").collect();
    if rest.contains(&"..") {
        return None;
    }
    let mut base = match letter {
        'c' => prefix.join("drive_c"),
        'z' => PathBuf::from("/"),
        _ => {
            let link = prefix.join("dosdevices").join(format!("{letter}:"));
            let t = std::fs::read_link(&link).ok()?;
            if t.is_absolute() {
                t
            } else {
                prefix.join("dosdevices").join(t)
            }
        }
    };
    for r in rest {
        base.push(r);
    }
    Some(resolve_ci(&base).into_owned())
}

/// The Windows spelling of a host path for programs inside the prefix: below `drive_c` it is
/// `C:\...`, everything else goes through Wine's `Z:` drive (the whole file system).
pub fn host_to_windows(prefix: &Path, host: &Path) -> String {
    let c = prefix.join("drive_c");
    let parts = |p: &Path| p.components().filter_map(|c| match c {
        Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
        _ => None,
    }).collect::<Vec<_>>().join("\\");
    match host.strip_prefix(&c) {
        Ok(rest) => format!("C:\\{}", parts(rest)),
        Err(_) => format!("Z:\\{}", parts(host)),
    }
}

/// Arguments handed to a Windows program: host paths in them become Windows paths
/// (`/file=/home/me/.wine/drive_c/x.Gbx` -> `/file=C:\x.Gbx`). Switches like `/useexedir`
/// stay as they are (only absolute paths that exist, or follow `/file=`, are changed).
pub fn winify_arg(prefix: &Path, arg: &str) -> String {
    if let Some(rest) = arg.strip_prefix("/file=") {
        let rest = rest.trim_matches('"');
        if rest.starts_with('/') {
            return format!("/file={}", host_to_windows(prefix, Path::new(rest)));
        }
        return arg.to_string();
    }
    if arg.starts_with('/') && arg.len() > 1 && arg[1..].contains('/') && Path::new(arg).exists() {
        return host_to_windows(prefix, Path::new(arg));
    }
    arg.to_string()
}

// ------------------------------------------------------------------ registry files

fn reg_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            if let Some(n) = it.next() {
                out.push(n);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Keys of a Wine registry file (`system.reg` = HKLM, `user.reg` = HKCU): key path in lower
/// case with single backslashes, and its string values (REG_SZ and REG_EXPAND_SZ).
pub fn parse_reg(text: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let mut out: Vec<(String, BTreeMap<String, String>)> = Vec::new();
    for line in text.lines() {
        let l = line.trim_end_matches('\r');
        if let Some(rest) = l.strip_prefix('[') {
            if let Some(end) = rest.rfind(']') {
                out.push((reg_unescape(&rest[..end]).to_lowercase(), BTreeMap::new()));
            }
            continue;
        }
        let Some((_, vals)) = out.last_mut() else { continue };
        let Some(rest) = l.strip_prefix('"') else { continue };
        // "Name"="value"  or  "Name"=str(2):"value"
        let Some(eq) = rest.find("\"=") else { continue };
        let name = reg_unescape(&rest[..eq]);
        let v = &rest[eq + 2..];
        let v = v.strip_prefix("str(2):").unwrap_or(v);
        if let Some(inner) = v.strip_prefix('"').and_then(|x| x.strip_suffix('"')) {
            vals.insert(name.to_lowercase(), reg_unescape(inner));
        }
    }
    out
}

/// "Installed programs" of a prefix (name, Windows install folder) from its `system.reg`.
pub fn uninstall_entries(prefix: &Path) -> Vec<(String, Option<String>)> {
    let Ok(text) = std::fs::read_to_string(prefix.join("system.reg")) else { return vec![] };
    parse_reg(&text)
        .into_iter()
        .filter(|(k, _)| {
            k.starts_with(r"software\microsoft\windows\currentversion\uninstall\") || k.starts_with(r"software\wow6432node\microsoft\windows\currentversion\uninstall\")
        })
        .filter_map(|(_, v)| Some((v.get("displayname")?.clone(), v.get("installlocation").cloned())))
        .collect()
}

/// Ubisoft Connect installs of a prefix: (launcher game id, Windows folder).
pub fn ubisoft_installs(prefix: &Path) -> Vec<(u32, String)> {
    let Ok(text) = std::fs::read_to_string(prefix.join("system.reg")) else { return vec![] };
    parse_reg(&text)
        .into_iter()
        .filter_map(|(k, v)| {
            let id = k.strip_prefix(r"software\wow6432node\ubisoft\launcher\installs\").or_else(|| k.strip_prefix(r"software\ubisoft\launcher\installs\"))?;
            Some((id.parse().ok()?, v.get("installdir")?.clone()))
        })
        .collect()
}

// ------------------------------------------------------------------ runners

/// What is installed to run Windows programs.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub wine: Option<PathBuf>,
    pub umu: Option<PathBuf>,
    /// Proton folders (each holds a `proton` script), newest first.
    pub protons: Vec<PathBuf>,
    pub steam_root: Option<PathBuf>,
}

/// Proton folders in Steam libraries (`steamapps/common/Proton*`) and in
/// `compatibilitytools.d` (GE-Proton and friends), newest first.
pub fn find_protons(steam_roots: &[PathBuf], libraries: &[PathBuf]) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut look = |d: PathBuf| {
        for s in subdirs(&d) {
            if s.join("proton").is_file() && !found.contains(&s) {
                found.push(s);
            }
        }
    };
    for r in steam_roots {
        look(r.join("compatibilitytools.d"));
    }
    for l in libraries {
        look(l.join("steamapps").join("common"));
    }
    found.sort_by(|a, b| version_key(b).cmp(&version_key(a)));
    found
}

/// Sort key: GE-Proton first, then numbered Proton by version, "Experimental" after those.
fn version_key(p: &Path) -> (u8, Vec<u32>) {
    let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let nums: Vec<u32> = n.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
    let rank = if n.to_lowercase().contains("ge-proton") {
        3
    } else if n.to_lowercase().contains("experimental") {
        1
    } else if nums.is_empty() {
        0
    } else {
        2
    };
    (rank, nums)
}

/// Game ids an exe can belong to (to find its per-game settings).
pub fn games_for_exe(exe: &Path) -> &'static [&'static str] {
    let n = exe.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    match n.as_str() {
        "tmloader.exe" | "tmforever.exe" | "tmforeverlauncher.exe" | "tminterface.exe" => &["tmuf", "tmnf"],
        "tmnationseswc.exe" | "tmnationseswclauncher.exe" => &["tmn-eswc"],
        "maniaplanet.exe" | "maniaplanetlauncher.exe" => &["maniaplanet", "tm2-stadium", "tm2-canyon", "tm2-valley", "tm2-lagoon"],
        "trackmania.exe" => &["tm2020", "tm-original"],
        "tmsunrise.exe" => &["tm-sunrise"],
        "tmoriginal.exe" => &["tm-original"],
        "trackmaniaturbo.exe" => &["tm-turbo"],
        _ => &[],
    }
}

/// umu's GAMEID: `umu-<steam app id>` where the game has one (protonfixes apply), else
/// `umu-default`.
pub fn umu_game_id(game: Option<&str>, prefix: &Path) -> String {
    if let Some(id) = steam_app_of_prefix(prefix) {
        return format!("umu-{id}");
    }
    game.and_then(|g| STEAM_IDS.iter().find(|(_, x)| *x == g)).map(|(id, _)| format!("umu-{id}")).unwrap_or_else(|| "umu-default".into())
}

/// Chooses how `exe` runs. `fallback_prefix` is the main prefix (used for exes outside any
/// prefix, e.g. a game copied to ~/Games/TMNF).
pub fn plan_runner(cfg: &LinuxSettings, tools: &Tools, exe: &Path, fallback_prefix: Option<&Path>) -> Result<Runner, String> {
    let games = games_for_exe(exe);
    let game = games.iter().find(|g| cfg.games.contains_key(**g)).copied();
    let gcfg = game.and_then(|g| cfg.games.get(g));
    let prefix = prefix_of(exe)
        .or_else(|| steam_prefix_for(exe))
        .or_else(|| gcfg.and_then(|g| nonempty(&g.prefix)).map(PathBuf::from))
        .or_else(|| nonempty(&cfg.prefix).map(PathBuf::from))
        .or_else(|| fallback_prefix.map(Path::to_path_buf))
        .ok_or("No Wine prefix found. Pick one in Settings > Linux.")?;
    let kind = gcfg.and_then(|g| nonempty(&g.runner)).or_else(|| Some(cfg.runner.trim()).filter(|s| !s.is_empty())).unwrap_or("auto").to_lowercase();
    let proton = gcfg.and_then(|g| nonempty(&g.proton)).or_else(|| nonempty(&cfg.proton)).map(PathBuf::from).or_else(|| tools.protons.first().cloned());
    let wine = || Runner::Wine { wine: nonempty(&cfg.wine).map(PathBuf::from).or_else(|| tools.wine.clone()).unwrap_or_else(|| PathBuf::from("wine")), prefix: prefix.clone() };
    let game_for_id = game.or_else(|| games.first().copied());
    let umu = || Runner::Umu { prefix: prefix.clone(), game_id: umu_game_id(game_for_id, &prefix), proton: proton.as_ref().map(|p| p.to_string_lossy().into_owned()) };
    let steam_pfx = steam_app_of_prefix(&prefix).is_some();
    let proton_runner = |p: &PathBuf| Runner::Proton {
        proton: p.join("proton"),
        compat_data: prefix.parent().unwrap_or(&prefix).to_path_buf(),
        steam_root: tools.steam_root.clone(),
        app_id: steam_app_of_prefix(&prefix),
    };
    Ok(match kind.as_str() {
        "wine" => wine(),
        "umu" => {
            if tools.umu.is_none() {
                return Err("umu-run is not installed".into());
            }
            umu()
        }
        "proton" => match (&proton, steam_pfx) {
            (Some(p), true) => proton_runner(p),
            // Proton wants <compat data>/pfx; other prefixes go through umu-run with that Proton.
            (Some(_), false) if tools.umu.is_some() => umu(),
            (Some(_), false) => return Err("Proton needs a Steam prefix (compatdata/<id>/pfx) or umu-run".into()),
            (None, _) => return Err("No Proton found. Install it in Steam or pick its folder in Settings.".into()),
        },
        // auto: Steam prefixes keep using Proton, everything else uses Wine (umu when only it exists).
        _ => {
            if steam_pfx {
                match &proton {
                    Some(p) => proton_runner(p),
                    None if tools.umu.is_some() => umu(),
                    None => wine(),
                }
            } else if tools.wine.is_none() && tools.umu.is_some() {
                umu()
            } else {
                wine()
            }
        }
    })
}

/// The final command for a Windows exe: runner + exe + arguments with host paths turned into
/// Windows paths. `spec.program` is the exe.
pub fn wrap_spec(runner: &Runner, spec: &CommandSpec) -> CommandSpec {
    let prefix = match runner {
        Runner::Wine { prefix, .. } | Runner::Umu { prefix, .. } => Some(prefix.clone()),
        Runner::Proton { compat_data, .. } => Some(compat_data.join("pfx")),
        Runner::Native => None,
    };
    let args: Vec<Arg> = match &prefix {
        Some(p) => spec.args.iter().map(|a| Arg::plain(winify_arg(p, &a.unquoted()))).collect(),
        None => spec.args.clone(),
    };
    let mut out = crate::launch::wrap(runner, &spec.program, &args, spec.cwd.as_deref());
    out.env.extend(spec.env.iter().cloned());
    out
}

// ------------------------------------------------------------------ per-prefix fixes

/// File in the prefix root (next to `drive_c`) that holds the fixes chosen in the Linux game
/// setup. Prefixes without it run exactly as before.
pub const OPTIONS_FILE: &str = "tmhub.json";

/// DLLs DXVK replaces (all of them, as DXVK's own setup script does; TMNF/TMUF only use d3d9).
pub const DXVK_DLLS: &[&str] = &["d3d8", "d3d9", "d3d10core", "d3d11", "dxgi"];

/// Fixes for TrackMania Forever under Wine/Proton, chosen per prefix (see docs/linux.md,
/// "Guided game setup", for sources). Defaults: DXVK and fast sync on, mouse kept in fullscreen, the rest off.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PrefixOptions {
    /// D3D9 through DXVK (Vulkan) instead of wined3d (OpenGL). Wine: DLLs copied into the
    /// prefix + DLL override; Proton/umu: their own DXVK, off = `PROTON_USE_WINED3D=1`.
    pub dxvk: bool,
    /// esync/fsync (Proton/umu, wine-staging); off = `PROTON_NO_ESYNC/FSYNC=1`.
    pub sync: bool,
    /// Show the game only this many CPU cores (0 = all). Wine: `taskset`; Proton/umu:
    /// `WINE_CPU_TOPOLOGY`. For CPUs with many cores.
    pub cpu_limit: u32,
    /// Run in a Wine virtual desktop of this size ("1920x1080"); plain Wine only.
    pub virtual_desktop: Option<String>,
    /// Keep the mouse inside the window in fullscreen (X11 driver `GrabFullscreen`).
    pub grab_mouse: bool,
    /// Force the PulseAudio/PipeWire audio driver (registry `Drivers\Audio=pulse`).
    pub pulse_audio: bool,
    /// Windows version the prefix reports ("win10", "win7", "winxp").
    pub windows_version: String,
    /// DXVK version copied into the prefix (set by the setup, empty = none).
    pub dxvk_version: Option<String>,
}

impl Default for PrefixOptions {
    fn default() -> Self {
        PrefixOptions { dxvk: true, sync: true, cpu_limit: 0, virtual_desktop: None, grab_mouse: true, pulse_audio: false, windows_version: "win10".into(), dxvk_version: None }
    }
}

pub fn read_options(prefix: &Path) -> Option<PrefixOptions> {
    let text = std::fs::read_to_string(prefix.join(OPTIONS_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_options(prefix: &Path, o: &PrefixOptions) -> std::io::Result<()> {
    std::fs::write(prefix.join(OPTIONS_FILE), serde_json::to_string_pretty(o).unwrap_or_default())
}

/// "1920x1080" with sane numbers, else None.
pub fn desktop_size(s: &str) -> Option<(u32, u32)> {
    let (w, h) = s.trim().split_once(['x', 'X'])?;
    let (w, h): (u32, u32) = (w.trim().parse().ok()?, h.trim().parse().ok()?);
    ((320..=16384).contains(&w) && (200..=16384).contains(&h)).then_some((w, h))
}

pub const WINDOWS_VERSIONS: &[&str] = &["win10", "win7", "winxp"];

/// The registry part of the fixes as a REGEDIT4 file for `wine regedit /S` (values that are
/// off are deleted, so turning a fix off really undoes it).
pub fn registry_text(o: &PrefixOptions) -> String {
    let ver = if WINDOWS_VERSIONS.contains(&o.windows_version.as_str()) { o.windows_version.as_str() } else { "win10" };
    let mut s = String::from("REGEDIT4\n\n[HKEY_CURRENT_USER\\Software\\Wine]\n");
    s += &format!("\"Version\"=\"{ver}\"\n\n[HKEY_CURRENT_USER\\Software\\Wine\\X11 Driver]\n");
    s += &format!("\"GrabFullscreen\"=\"{}\"\n\n[HKEY_CURRENT_USER\\Software\\Wine\\Drivers]\n", if o.grab_mouse { "Y" } else { "N" });
    s += if o.pulse_audio { "\"Audio\"=\"pulse\"\n" } else { "\"Audio\"=-\n" };
    s += "\n[HKEY_CURRENT_USER\\Software\\Wine\\DllOverrides]\n";
    let dxvk_on = o.dxvk && o.dxvk_version.is_some();
    for d in DXVK_DLLS {
        s += &if dxvk_on { format!("\"{d}\"=\"native,builtin\"\n") } else { format!("\"{d}\"=-\n") };
    }
    s
}

/// The fixes applied to a finished launch command (`spec` from `wrap_spec`). `taskset` is the
/// taskset binary (CPU limit under plain Wine), `staging` whether the Wine build reads
/// WINEESYNC/WINEFSYNC.
pub fn apply_options(spec: CommandSpec, runner: &Runner, o: &PrefixOptions, taskset: Option<&Path>, staging: bool) -> CommandSpec {
    let mut out = spec;
    let set = |out: &mut CommandSpec, k: &str, v: String| {
        out.env.retain(|(x, _)| x != k);
        out.env.push((k.to_string(), v));
    };
    let cores = |n: u32| (0..n).map(|i| i.to_string()).collect::<Vec<_>>();
    match runner {
        Runner::Wine { prefix, .. } => {
            let dlls = DXVK_DLLS.join(",");
            if o.dxvk && o.dxvk_version.is_some() {
                set(&mut out, "WINEDLLOVERRIDES", format!("{dlls}=n,b"));
            } else if o.dxvk_version.is_some() {
                set(&mut out, "WINEDLLOVERRIDES", format!("{dlls}=b"));
            }
            if o.sync && staging {
                set(&mut out, "WINEESYNC", "1".into());
                set(&mut out, "WINEFSYNC", "1".into());
            }
            // wine <exe> args  ->  wine explorer /desktop=TMHorizon,WxH C:\...\exe args
            if let Some((w, h)) = o.virtual_desktop.as_deref().and_then(desktop_size) {
                if let Some(first) = out.args.first().cloned() {
                    let exe = first.unquoted();
                    let win = if Path::new(&exe).is_absolute() { host_to_windows(prefix, Path::new(&exe)) } else { exe };
                    out.args[0] = Arg::plain(win);
                    out.args.insert(0, Arg::plain(format!("/desktop=TMHorizon,{w}x{h}")));
                    out.args.insert(0, Arg::plain("explorer"));
                }
            }
            if let (n @ 1.., Some(ts)) = (o.cpu_limit, taskset) {
                let wine = out.program.to_string_lossy().into_owned();
                out.args.insert(0, Arg::plain(wine));
                out.args.insert(0, Arg::plain(format!("0-{}", n - 1)));
                out.args.insert(0, Arg::plain("-c"));
                out.program = ts.to_path_buf();
            }
        }
        Runner::Umu { .. } | Runner::Proton { .. } => {
            if !o.dxvk {
                set(&mut out, "PROTON_USE_WINED3D", "1".into());
            }
            if !o.sync {
                set(&mut out, "PROTON_NO_ESYNC", "1".into());
                set(&mut out, "PROTON_NO_FSYNC", "1".into());
            }
            if o.cpu_limit > 0 {
                set(&mut out, "WINE_CPU_TOPOLOGY", format!("{}:{}", o.cpu_limit, cores(o.cpu_limit).join(",")));
            }
        }
        Runner::Native => {}
    }
    out
}

/// `wine --version` output -> ("10.0", staging).
pub fn parse_wine_version(out: &str) -> Option<(String, bool)> {
    let l = out.lines().next()?.trim();
    let rest = l.strip_prefix("wine-")?;
    let ver = rest.split_whitespace().next()?.to_string();
    Some((ver, l.to_lowercase().contains("staging")))
}

/// The name of a Proton build from its `version` file ("1700000000 GE-Proton10-4"), else the
/// folder name.
pub fn proton_name(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("version"))
        .ok()
        .and_then(|t| t.split_whitespace().nth(1).map(str::to_string))
        .unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// A Windows program (by extension).
pub fn is_windows_program(p: &Path) -> bool {
    p.extension().map(|e| ["exe", "bat", "msi", "com"].iter().any(|x| e.eq_ignore_ascii_case(x))).unwrap_or(false)
}

/// `steam://rungameid/<id>` -> the id.
pub fn steam_rungame_id(url: &str) -> Option<u32> {
    let l = url.to_ascii_lowercase();
    let rest = l.strip_prefix("steam://rungameid/").or_else(|| l.strip_prefix("steam://run/"))?;
    rest.trim_end_matches('/').split(['/', '?']).next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn mkprefix(p: &Path, user: &str) {
        fs::create_dir_all(p.join("drive_c/users").join(user).join("Documents/TrackMania/Tracks")).unwrap();
        fs::create_dir_all(p.join("drive_c/users/Public")).unwrap();
        fs::create_dir_all(p.join("drive_c/users").join(user).join("AppData/Local/TMLoader")).unwrap();
        fs::create_dir_all(p.join("drive_c/Program Files (x86)/TmNationsForever")).unwrap();
        fs::write(p.join("drive_c/Program Files (x86)/TmNationsForever/TmForever.exe"), b"MZ").unwrap();
        fs::write(p.join("system.reg"), b"WINE REGISTRY Version 2\n").unwrap();
    }

    fn env(home: &Path) -> Env {
        Env { home: home.to_path_buf(), user: Some("me".into()), ..Default::default() }
    }

    #[test]
    fn finds_prefixes_everywhere() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        mkprefix(&home.join(".wine"), "me");
        let lib = home.join(".local/share/Steam");
        mkprefix(&lib.join("steamapps/compatdata/11020/pfx"), "steamuser");
        mkprefix(&lib.join("steamapps/compatdata/999999/pfx"), "steamuser"); // not a TrackMania app
        mkprefix(&home.join("Games/trackmania-united-forever"), "me");
        mkprefix(&home.join(".local/share/bottles/bottles/TM"), "me");
        mkprefix(&home.join("Games/Heroic/Prefixes/default/Trackmania"), "me");
        mkprefix(&home.join("Lutris/tmuf"), "me");
        fs::create_dir_all(home.join(".config/lutris/games")).unwrap();
        fs::write(home.join(".config/lutris/games/tmuf-123.yml"), "game:\n  exe: drive_c/x.exe\n  prefix: ~/Lutris/tmuf\nwine:\n  version: lutris-GE\n").unwrap();
        fs::create_dir_all(home.join("Games/not-a-prefix")).unwrap();
        let mut e = env(&home);
        e.steam_libraries = vec![lib.clone()];
        e.wineprefix = Some(home.join(".wine"));
        let found = find_prefixes(&e, &LinuxSettings::default());
        let src: Vec<(String, String)> = found.iter().map(|p| (p.source.clone(), p.path.strip_prefix(&home).unwrap().to_string_lossy().replace('\\', "/"))).collect();
        assert_eq!(
            src,
            vec![
                ("WINEPREFIX".to_string(), ".wine".to_string()),
                ("Steam (Proton)".into(), ".local/share/Steam/steamapps/compatdata/11020/pfx".into()),
                ("Lutris".into(), "Lutris/tmuf".into()),
                ("Bottles".into(), ".local/share/bottles/bottles/TM".into()),
                ("Heroic".into(), "Games/Heroic/Prefixes/default/Trackmania".into()),
                ("Games folder".into(), "Games/trackmania-united-forever".into()),
            ]
        );
        assert_eq!(found[1].steam_app_id, Some(11020));
    }

    #[test]
    fn folders_inside_a_prefix() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("pfx");
        mkprefix(&p, "steamuser");
        assert_eq!(user_dir(&p, Some("me")).unwrap(), p.join("drive_c/users/steamuser"));
        assert_eq!(documents(&p, None).unwrap(), p.join("drive_c/users/steamuser/Documents"));
        assert_eq!(local_app_data(&p, None).unwrap().join("TMLoader"), p.join("drive_c/users/steamuser/AppData/Local/TMLoader"));
        assert_eq!(program_files(&p), vec![p.join("drive_c/Program Files (x86)")]);
        // Old prefix layout.
        let q = t.path().join("old");
        fs::create_dir_all(q.join("drive_c/users/me/My Documents")).unwrap();
        fs::create_dir_all(q.join("drive_c/users/me/Local Settings/Application Data")).unwrap();
        assert_eq!(documents(&q, Some("me")).unwrap(), q.join("drive_c/users/me/My Documents"));
        assert_eq!(local_app_data(&q, Some("me")).unwrap(), q.join("drive_c/users/me/Local Settings/Application Data"));
    }

    // Case-insensitive lookups only matter (and only differ) on case-sensitive file systems.
    #[cfg(unix)]
    #[test]
    fn paths_map_both_ways_and_ignore_case() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("pfx");
        mkprefix(&p, "me");
        let host = windows_to_host(&p, r"c:\USERS\me\documents\trackmania\tracks").unwrap();
        assert_eq!(host, p.join("drive_c/users/me/Documents/TrackMania/Tracks"));
        // Missing tail is kept as written (new files), the existing part is found.
        let new = windows_to_host(&p, r"C:\users\me\Documents\TRACKMANIA\Skins\Vehicles\x.zip").unwrap();
        assert_eq!(new, p.join("drive_c/users/me/Documents/TrackMania/Skins/Vehicles/x.zip"));
        assert!(windows_to_host(&p, r"C:\..\etc").is_none());
        assert!(windows_to_host(&p, "relative").is_none());
        assert_eq!(windows_to_host(&p, r"Z:\").unwrap(), PathBuf::from("/"));
        assert_eq!(host_to_windows(&p, &p.join("drive_c/users/me/Documents/a b.Gbx")), r"C:\users\me\Documents\a b.Gbx");
        assert!(host_to_windows(&p, Path::new("/home/me/x.Gbx")).ends_with(r"home\me\x.Gbx"));
        assert_eq!(winify_arg(&p, "/useexedir"), "/useexedir");
        assert_eq!(winify_arg(&p, &format!("/file={}", p.join("drive_c/m.Gbx").to_string_lossy())), r"/file=C:\m.Gbx");
        assert_eq!(winify_arg(&p, "TmForever"), "TmForever");
        // Case-insensitive lookup through resolve_ci.
        let r = resolve_ci(&p.join("DRIVE_C/program files (x86)/tmnationsforever/tmforever.EXE")).into_owned();
        assert_eq!(r, p.join("drive_c/Program Files (x86)/TmNationsForever/TmForever.exe"));
        assert_eq!(prefix_of(&r).unwrap(), p);
        assert!(prefix_of(&t.path().join("elsewhere/TmForever.exe")).is_none());
    }

    #[test]
    fn registry_files() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("pfx");
        mkprefix(&p, "me");
        let reg = concat!(
            "WINE REGISTRY Version 2\n",
            ";; All keys relative to \\\\Machine\n\n",
            "[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\TmNationsForever_is1] 1700000000\n",
            "#time=1da0000\n",
            "\"DisplayName\"=\"TrackMania Nations Forever\"\n",
            "\"InstallLocation\"=\"C:\\\\Program Files (x86)\\\\TmNationsForever\\\\\"\n",
            "\"NoModify\"=dword:00000001\n\n",
            "[Software\\\\Wow6432Node\\\\Ubisoft\\\\Launcher\\\\Installs\\\\5595] 1700000001\n",
            "\"InstallDir\"=str(2):\"C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Trackmania/\"\n",
        );
        fs::write(p.join("system.reg"), reg).unwrap();
        let u = uninstall_entries(&p);
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].0, "TrackMania Nations Forever");
        let loc = u[0].1.clone().unwrap();
        assert_eq!(loc, "C:\\Program Files (x86)\\TmNationsForever\\");
        assert_eq!(windows_to_host(&p, &loc).unwrap(), p.join("drive_c").join("Program Files (x86)").join("TmNationsForever"));
        assert_eq!(ubisoft_installs(&p), vec![(5595, "C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Trackmania/".to_string())]);
    }

    #[test]
    fn runner_choice() {
        let t = tempfile::tempdir().unwrap();
        let lib = t.path().join("Steam");
        let pfx = lib.join("steamapps/compatdata/7200/pfx");
        mkprefix(&pfx, "steamuser");
        fs::create_dir_all(lib.join("steamapps/common/Proton 9.0")).unwrap();
        fs::write(lib.join("steamapps/common/Proton 9.0/proton"), b"#!").unwrap();
        fs::create_dir_all(lib.join("steamapps/common/Proton 10.0")).unwrap();
        fs::write(lib.join("steamapps/common/Proton 10.0/proton"), b"#!").unwrap();
        fs::create_dir_all(lib.join("steamapps/common/Proton - Experimental")).unwrap();
        fs::write(lib.join("steamapps/common/Proton - Experimental/proton"), b"#!").unwrap();
        let protons = find_protons(&[lib.clone()], &[lib.clone()]);
        assert_eq!(protons[0].file_name().unwrap(), "Proton 10.0");
        assert_eq!(protons.last().unwrap().file_name().unwrap(), "Proton - Experimental");
        let tools = Tools { wine: Some("/usr/bin/wine".into()), umu: None, protons, steam_root: Some(lib.clone()) };
        let tml = pfx.join("drive_c/users/steamuser/AppData/Local/TMLoader/TMLoader.exe");
        let cfg = LinuxSettings::default();
        // Steam prefix + auto = that game's Proton.
        match plan_runner(&cfg, &tools, &tml, None).unwrap() {
            Runner::Proton { proton, compat_data, app_id, .. } => {
                assert_eq!(proton, lib.join("steamapps/common/Proton 10.0/proton"));
                assert_eq!(compat_data, lib.join("steamapps/compatdata/7200"));
                assert_eq!(app_id, Some(7200));
            }
            r => panic!("{r:?}"),
        }
        // The Steam game's own exe (outside the prefix) also runs in its Proton prefix.
        let game_exe = lib.join("steamapps/common/TrackMania United/TmForever.exe");
        fs::create_dir_all(game_exe.parent().unwrap()).unwrap();
        fs::write(&game_exe, b"MZ").unwrap();
        fs::write(lib.join("steamapps/appmanifest_7200.acf"), "\"AppState\"\n{\n\t\"appid\"\t\t\"7200\"\n\t\"installdir\"\t\t\"TrackMania United\"\n}\n").unwrap();
        assert_eq!(steam_prefix_for(&game_exe), Some(pfx.clone()));
        assert!(matches!(plan_runner(&cfg, &tools, &game_exe, None).unwrap(), Runner::Proton { app_id: Some(7200), .. }));
        // Per-game choice wins.
        let mut cfg2 = LinuxSettings::default();
        cfg2.games.insert("tmuf".into(), LinuxGame { runner: Some("wine".into()), prefix: None, proton: None });
        assert!(matches!(plan_runner(&cfg2, &tools, &tml, None).unwrap(), Runner::Wine { .. }));
        // umu wanted but not installed.
        cfg2.games.get_mut("tmuf").unwrap().runner = Some("umu".into());
        assert!(plan_runner(&cfg2, &tools, &tml, None).is_err());
        let tools_umu = Tools { umu: Some("/usr/bin/umu-run".into()), ..tools.clone() };
        match plan_runner(&cfg2, &tools_umu, &tml, None).unwrap() {
            Runner::Umu { game_id, prefix, .. } => {
                assert_eq!(game_id, "umu-7200");
                assert_eq!(prefix, pfx);
            }
            r => panic!("{r:?}"),
        }
        // An exe outside any prefix uses the game's prefix, then the main one.
        let loose = t.path().join("Games/TMNF/TmForever.exe");
        let plain = t.path().join("plain");
        mkprefix(&plain, "me");
        match plan_runner(&LinuxSettings::default(), &tools, &loose, Some(&plain)).unwrap() {
            Runner::Wine { wine, prefix } => {
                assert_eq!(wine, PathBuf::from("/usr/bin/wine"));
                assert_eq!(prefix, plain);
            }
            r => panic!("{r:?}"),
        }
        assert!(plan_runner(&LinuxSettings::default(), &tools, &loose, None).is_err());
    }

    #[test]
    fn wrapped_commands() {
        let t = tempfile::tempdir().unwrap();
        let pfx = t.path().join("compatdata/11020/pfx");
        mkprefix(&pfx, "steamuser");
        let exe = pfx.join("drive_c/users/steamuser/AppData/Local/TMLoader/TMLoader.exe");
        let map = pfx.join("drive_c/users/steamuser/Documents/TrackMania/Tracks/a b.Challenge.Gbx");
        let spec = CommandSpec {
            program: exe.clone(),
            args: vec![Arg::plain("run"), Arg::plain("TmForever"), Arg::plain("My Profile"), Arg::plain(format!("/file={}", map.to_string_lossy()))],
            cwd: exe.parent().map(Path::to_path_buf),
            env: vec![],
        };
        let r = Runner::Proton { proton: "/s/Proton 10.0/proton".into(), compat_data: t.path().join("compatdata/11020"), steam_root: Some("/s".into()), app_id: Some(11020) };
        let out = wrap_spec(&r, &spec);
        assert_eq!(out.program, PathBuf::from("/s/Proton 10.0/proton"));
        let a: Vec<String> = out.args.iter().map(|a| a.unquoted()).collect();
        assert_eq!(a[0], "run");
        assert_eq!(a[1], exe.to_string_lossy());
        assert_eq!(&a[2..5], ["run", "TmForever", "My Profile"]);
        #[cfg(unix)]
        assert_eq!(a[5], r"/file=C:\users\steamuser\Documents\TrackMania\Tracks\a b.Challenge.Gbx");
        assert!(out.env.contains(&("STEAM_COMPAT_DATA_PATH".into(), t.path().join("compatdata/11020").to_string_lossy().into_owned())));
        assert!(out.env.contains(&("SteamAppId".into(), "11020".into())));
        let w = wrap_spec(&Runner::Wine { wine: "wine".into(), prefix: pfx.clone() }, &spec);
        assert_eq!(w.program, PathBuf::from("wine"));
        assert!(w.env.contains(&("WINEPREFIX".into(), pfx.to_string_lossy().into_owned())));
        assert!(is_windows_program(Path::new("/x/TMLoader.EXE")));
        assert!(!is_windows_program(Path::new("/usr/bin/steam")));
        assert_eq!(steam_rungame_id("steam://rungameid/11020"), Some(11020));
        assert_eq!(steam_rungame_id("uplay://launch/5595/0"), None);
        assert_eq!(umu_game_id(Some("tmnf"), Path::new("/x/plain")), "umu-11020");
        assert_eq!(umu_game_id(Some("tmn-eswc"), Path::new("/x/plain")), "umu-default");
    }

    #[test]
    fn per_game_proton_wins() {
        let t = tempfile::tempdir().unwrap();
        let pfx = t.path().join("pfx");
        mkprefix(&pfx, "me");
        let exe = pfx.join("drive_c/Program Files (x86)/TmNationsForever/TmForever.exe");
        let tools = Tools { wine: None, umu: Some("/u/umu-run".into()), protons: vec!["/s/Proton 10.0".into()], steam_root: None };
        let mut cfg = LinuxSettings::default();
        cfg.games.insert("tmnf".into(), LinuxGame { runner: Some("umu".into()), prefix: None, proton: Some("/data/runners/proton/GE-Proton10-4".into()) });
        match plan_runner(&cfg, &tools, &exe, None).unwrap() {
            Runner::Umu { proton, game_id, .. } => {
                assert_eq!(proton.as_deref(), Some("/data/runners/proton/GE-Proton10-4"));
                assert_eq!(game_id, "umu-11020");
            }
            r => panic!("{r:?}"),
        }
    }

    #[test]
    fn prefix_options_registry_and_launch() {
        let t = tempfile::tempdir().unwrap();
        let pfx = t.path().join("pfx");
        mkprefix(&pfx, "me");
        assert!(read_options(&pfx).is_none());
        let mut o = PrefixOptions::default();
        assert!(o.dxvk && o.sync && o.grab_mouse && !o.pulse_audio && o.cpu_limit == 0);
        write_options(&pfx, &o).unwrap();
        assert_eq!(read_options(&pfx).unwrap(), o);
        // Unknown fields and missing ones load with defaults (older/newer launcher versions).
        fs::write(pfx.join(OPTIONS_FILE), r#"{"cpuLimit":4,"future":1}"#).unwrap();
        let r = read_options(&pfx).unwrap();
        assert_eq!(r.cpu_limit, 4);
        assert!(r.dxvk);

        // Registry: DXVK overrides only when DXVK is really in the prefix.
        let reg = registry_text(&o);
        assert!(reg.starts_with("REGEDIT4\n"));
        assert!(reg.contains("\"Version\"=\"win10\""));
        assert!(reg.contains("\"GrabFullscreen\"=\"Y\""));
        assert!(reg.contains("\"Audio\"=-"));
        assert!(reg.contains("\"d3d9\"=-"));
        o.dxvk_version = Some("3.1.1".into());
        o.pulse_audio = true;
        o.windows_version = "bogus".into();
        let reg = registry_text(&o);
        assert!(reg.contains("\"d3d9\"=\"native,builtin\"") && reg.contains("\"dxgi\"=\"native,builtin\""));
        assert!(reg.contains("\"Audio\"=\"pulse\""));
        assert!(reg.contains("\"Version\"=\"win10\""));

        // Launch: Wine with DXVK, virtual desktop and 4 cores.
        let exe = pfx.join("drive_c/users/me/AppData/Local/TMLoader/TMLoader.exe");
        let spec = CommandSpec { program: exe.clone(), args: vec![Arg::plain("run"), Arg::plain("TmForever"), Arg::plain("Default")], cwd: None, env: vec![] };
        let wr = Runner::Wine { wine: "/usr/bin/wine".into(), prefix: pfx.clone() };
        let base = wrap_spec(&wr, &spec);
        o.virtual_desktop = Some("1600x900".into());
        o.cpu_limit = 4;
        let out = apply_options(base.clone(), &wr, &o, Some(Path::new("/usr/bin/taskset")), true);
        assert_eq!(out.program, PathBuf::from("/usr/bin/taskset"));
        let a: Vec<String> = out.args.iter().map(|a| a.unquoted()).collect();
        assert_eq!(&a[..5], ["-c", "0-3", "/usr/bin/wine", "explorer", "/desktop=TMHorizon,1600x900"]);
        assert_eq!(a[5], r"C:\users\me\AppData\Local\TMLoader\TMLoader.exe");
        assert_eq!(&a[6..], ["run", "TmForever", "Default"]);
        assert!(out.env.contains(&("WINEDLLOVERRIDES".into(), "d3d8,d3d9,d3d10core,d3d11,dxgi=n,b".into())));
        assert!(out.env.contains(&("WINEFSYNC".into(), "1".into())));
        assert!(out.env.contains(&("WINEPREFIX".into(), pfx.to_string_lossy().into_owned())));
        // DXVK off (but installed): builtin wined3d; no taskset binary: no CPU limit; not staging: no sync env.
        o.dxvk = false;
        o.virtual_desktop = Some("huge".into());
        let out = apply_options(base.clone(), &wr, &o, None, false);
        assert_eq!(out.program, PathBuf::from("/usr/bin/wine"));
        assert_eq!(out.args[0].unquoted(), exe.to_string_lossy());
        assert!(out.env.contains(&("WINEDLLOVERRIDES".into(), "d3d8,d3d9,d3d10core,d3d11,dxgi=b".into())));
        assert!(!out.env.iter().any(|(k, _)| k == "WINEFSYNC"));
        // Proton/umu: env switches only.
        let ur = Runner::Umu { prefix: pfx.clone(), game_id: "umu-11020".into(), proton: None };
        o.sync = false;
        let out = apply_options(wrap_spec(&ur, &spec), &ur, &o, Some(Path::new("/usr/bin/taskset")), false);
        assert_eq!(out.program, PathBuf::from("umu-run"));
        for kv in [("PROTON_USE_WINED3D", "1"), ("PROTON_NO_ESYNC", "1"), ("PROTON_NO_FSYNC", "1"), ("WINE_CPU_TOPOLOGY", "4:0,1,2,3")] {
            assert!(out.env.contains(&(kv.0.to_string(), kv.1.to_string())), "{kv:?}");
        }
        assert!(!out.args.iter().any(|a| a.unquoted().starts_with("/desktop")));
    }

    #[test]
    fn versions_and_sizes() {
        assert_eq!(parse_wine_version("wine-10.0\n"), Some(("10.0".into(), false)));
        assert_eq!(parse_wine_version("wine-9.22 (Staging)"), Some(("9.22".into(), true)));
        assert_eq!(parse_wine_version("bash: wine: not found"), None);
        assert_eq!(desktop_size("1920x1080"), Some((1920, 1080)));
        assert_eq!(desktop_size(" 800 X 600 "), Some((800, 600)));
        assert_eq!(desktop_size("1x1"), None);
        assert_eq!(desktop_size("big"), None);
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("GE-Proton10-4");
        fs::create_dir_all(&p).unwrap();
        assert_eq!(proton_name(&p), "GE-Proton10-4");
        fs::write(p.join("version"), "1746000000 GE-Proton10-4\n").unwrap();
        assert_eq!(proton_name(&p), "GE-Proton10-4");
    }
}
