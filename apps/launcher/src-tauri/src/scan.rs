//! Read-only scan of this PC: installed TrackMania titles (known folders, Steam, Ubisoft
//! Connect, Epic, the system's uninstall list, folders found by "Scan drives" and folders
//! added by hand), ManiaPlanet title packs, TMLoader, Openplanet, recent replays and maps.
//! Port of scanner/scan.mjs. All file access goes through `fsx` (StarForce ESWC guard).

use crate::{fsx, platform, tmloader, vdf};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    pub source: String,
    pub path: String,
    pub exe: Option<String>,
    pub launcher: Option<String>,
    /// Store URL that starts the game (steam://, uplay://, com.epicgames.launcher://).
    pub launch: Option<String>,
    pub modified: Option<String>,
    pub note: Option<String>,
    pub steam_app_id: Option<u32>,
    /// Console games: the player's dump file the emulator (`exe`) starts (consoles.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rom: Option<String>,
    /// Console games: the emulator's arguments (consoles::launch_args).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Installs {
    pub installs: Vec<InstallInfo>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct EswcInstalls {
    pub installs: Vec<InstallInfo>,
    pub unsupported: Vec<InstallInfo>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MpInstalls {
    pub installs: Vec<InstallInfo>,
    pub title_packs: Vec<String>,
    pub ubisoft_stub: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Games {
    pub tmnf: Installs,
    pub tmuf: Installs,
    #[serde(rename = "tmn-eswc")]
    pub eswc: EswcInstalls,
    pub maniaplanet: MpInstalls,
    pub tm2020: Installs,
    #[serde(rename = "tm-turbo")]
    pub turbo: Installs,
    #[serde(rename = "tm-original")]
    pub original: Installs,
    #[serde(rename = "tm-sunrise")]
    pub sunrise: Installs,
    /// The first TrackMania (2003, also with Power Up!).
    #[serde(rename = "tm-2003")]
    pub tm2003: Installs,
    /// Console games through emulators (filled after the scan from the console settings, consoles.rs).
    #[serde(rename = "tm-ds")]
    pub ds: Installs,
    #[serde(rename = "tm-turbo-ds")]
    pub turbo_ds: Installs,
    #[serde(rename = "tm-wii")]
    pub wii: Installs,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamLibrary {
    pub path: String,
    pub exists: bool,
    pub app_count: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Openplanet {
    pub installed: bool,
    pub path: Option<String>,
    pub plugins: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecentFile {
    pub name: String,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Recent {
    pub replays: Vec<RecentFile>,
    pub maps: Vec<RecentFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub scanned_at: String,
    pub platform: String,
    pub documents: Option<String>,
    pub games: Games,
    pub steam_libraries: Vec<SteamLibrary>,
    pub epic: Vec<String>,
    pub tmloader: tmloader::TmLoaderInfo,
    pub openplanet: BTreeMap<String, Openplanet>,
    pub recent: BTreeMap<String, Recent>,
}

/// A game folder remembered from "Scan drives" or "Add folder".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundInstall {
    pub game: String,
    pub path: String,
    pub exe: String,
}

pub struct ScanInput {
    pub tmloader_root: Option<PathBuf>,
    pub found: Vec<FoundInstall>,
    pub manual: Vec<String>,
}

pub const STEAM_TMNF: u32 = 11020;
pub const STEAM_TMUF: u32 = 7200;
pub const STEAM_MP: u32 = 228760;
pub const STEAM_TM2020: u32 = 2225070;
pub const STEAM_TURBO: u32 = 375900;
pub const UBI_TM2020: u32 = 5595;
pub const UBI_MP: u32 = 275;

// ---------------------------------------------------------------- folder classification

/// Exe names the hub knows, lower case. TrackMania Original is `TMORIGINAL.EXE` (registry
/// Software\Nadeo\TmOriginal); a 32-bit `TrackMania.exe` is Original or TM 2003 by version, and is
/// left out when `TMORIGINAL.EXE` sits in the same folder.
pub const KNOWN_EXES: [&str; 8] = [
    "tmforever.exe",
    "tmnationseswc.exe",
    "maniaplanet.exe",
    "trackmania.exe",
    "tmoriginal.exe",
    "tmsunrise.exe",
    "trackmaniaturbo.exe",
    "tmnationsforever.exe",
];

/// x64 PE (Trackmania 2020) vs x86 (TrackMania Original 2003 is also "TrackMania.exe").
pub fn pe_is_x64(exe: &Path) -> Option<bool> {
    let head = fsx::read_bytes_prefix(exe, 4096)?;
    if head.len() < 0x40 || &head[0..2] != b"MZ" {
        return None;
    }
    let off = u32::from_le_bytes(head[0x3c..0x40].try_into().ok()?) as usize;
    let machine = head.get(off + 4..off + 6)?;
    if &head[off..off + 4] != b"PE\0\0" {
        return None;
    }
    Some(u16::from_le_bytes([machine[0], machine[1]]) == 0x8664)
}

/// The fixed file version (VS_FIXEDFILEINFO) of an exe as "1.2.3.4", read from its bytes (any OS).
pub fn exe_version(exe: &Path) -> Option<String> {
    let meta = std::fs::metadata(exe).ok()?;
    if fsx::blocked(exe) || meta.len() > 64 << 20 {
        return None;
    }
    let b = std::fs::read(exe).ok()?;
    version_from_bytes(&b).map(|(a, b2, c, d)| format!("{a}.{b2}.{c}.{d}"))
}

/// (major, minor, build, revision) from the first VS_FIXEDFILEINFO (signature 0xFEEF04BD).
pub fn version_from_bytes(b: &[u8]) -> Option<(u16, u16, u16, u16)> {
    let sig = [0xBD, 0x04, 0xEF, 0xFE];
    let at = b.windows(4).position(|w| w == sig)?;
    let r = |o: usize| b.get(at + o..at + o + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap()));
    let (ms, ls) = (r(8)?, r(12)?);
    Some(((ms >> 16) as u16, ms as u16, (ls >> 16) as u16, ls as u16))
}

/// A 32-bit "TrackMania.exe": the first TrackMania (2003, Power Up! included) or TrackMania Original
/// (2005, installed as an upgrade of Power Up!). Original's files are version 1.5 and later; without a
/// readable version the folder name decides, else it counts as the 2003 game.
pub fn classic_kind(exe: &Path) -> &'static str {
    let dir = exe.parent().map(|d| d.to_string_lossy().to_lowercase()).unwrap_or_default();
    match exe_version(exe).and_then(|v| v.split('.').take(2).map(|x| x.parse::<u16>().ok()).collect::<Option<Vec<_>>>()) {
        Some(v) if v.len() == 2 && (v[0], v[1]) >= (1, 5) => "tm-original",
        Some(_) => "tm-2003",
        None if dir.contains("original") => "tm-original",
        None => "tm-2003",
    }
}

/// United Forever writes WindowTitle (and Key=) into Nadeo.ini; Nations Forever has neither.
pub fn forever_kind(dir: &Path) -> &'static str {
    if let Some(ini) = fsx::read_string(&dir.join("Nadeo.ini")) {
        let l = ini.to_lowercase();
        if l.contains("windowtitle=trackmania united") || l.lines().any(|x| x.trim_start().starts_with("key=")) {
            return "tmuf";
        }
        if l.contains("windowtitle=") {
            return if l.contains("united") { "tmuf" } else { "tmnf" };
        }
    }
    if dir.to_string_lossy().to_lowercase().contains("united") {
        "tmuf"
    } else {
        "tmnf"
    }
}

/// Which games live in `dir` (directly, not in subfolders): (game id, exe path).
pub fn classify(dir: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    if fsx::blocked(dir) || fsx::is_inside(dir, &tmloader_db_marker()) {
        return out;
    }
    for e in fsx::list(dir) {
        if !e.is_file {
            continue;
        }
        let n = e.name.to_lowercase();
        let game = match n.as_str() {
            "tmforever.exe" => forever_kind(dir),
            "tmnationseswc.exe" => "tmn-eswc",
            "maniaplanet.exe" => "maniaplanet",
            "trackmania.exe" => match pe_is_x64(&e.path) {
                Some(true) => "tm2020",
                Some(false) => classic_kind(&e.path),
                None => continue,
            },
            "tmoriginal.exe" => "tm-original",
            "tmsunrise.exe" => "tm-sunrise",
            "trackmaniaturbo.exe" => "tm-turbo",
            _ => continue,
        };
        out.push((game, e.path));
    }
    // TMORIGINAL.EXE names the folder: a 32-bit TrackMania.exe next to it is not a second game.
    if out.iter().any(|(_, p)| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("tmoriginal.exe"))) {
        out.retain(|(g, p)| !(matches!(*g, "tm-original" | "tm-2003") && p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("trackmania.exe"))));
    }
    out
}

/// A folder found by "Scan drives" counts as an installation only when the game's data is there, not just an
/// exe (extracted patches, reverse-engineering copies): GameData for the 2003-2008 games and Forever, Packs for
/// ManiaPlanet and Trackmania (2020). Turbo has no reliable marker and is kept.
pub fn has_game_data(game: &str, dir: &Path) -> bool {
    match game {
        "tm2020" | "maniaplanet" => fsx::is_dir(&dir.join("Packs")),
        "tm-turbo" => true,
        _ => fsx::is_dir(&dir.join("GameData")),
    }
}

/// TMLoader keeps a modded TmForever.exe in its database; that is not a game install.
fn tmloader_db_marker() -> PathBuf {
    tmloader::default_root().map(|r| r.join("database")).unwrap_or_else(|| PathBuf::from("/nonexistent"))
}

// ---------------------------------------------------------------- Steam / Epic

pub struct SteamApp {
    pub id: u32,
    pub dir: PathBuf,
}

pub fn steam_libraries() -> (Vec<SteamLibrary>, Vec<SteamApp>) {
    let mut libs: Vec<PathBuf> = Vec::new();
    let add = |libs: &mut Vec<PathBuf>, p: PathBuf| {
        if !libs.iter().any(|q| fsx::norm(q) == fsx::norm(&p)) {
            libs.push(p);
        }
    };
    for root in platform::steam_roots() {
        let Some(text) = fsx::read_string(&root.join("steamapps").join("libraryfolders.vdf")) else { continue };
        add(&mut libs, root.clone());
        if let Some(lf) = vdf::parse(&text).get("libraryfolders") {
            for (_, e) in lf.entries() {
                if let Some(p) = e.get("path").and_then(|p| p.str()) {
                    add(&mut libs, PathBuf::from(p));
                }
            }
        }
    }
    let mut apps = Vec::new();
    let mut out = Vec::new();
    for lib in libs {
        let sa = lib.join("steamapps");
        let mut count = 0;
        for e in fsx::list(&sa) {
            let n = e.name.to_lowercase();
            if !(n.starts_with("appmanifest_") && n.ends_with(".acf")) {
                continue;
            }
            let Some(text) = fsx::read_string(&e.path) else { continue };
            let v = vdf::parse(&text);
            let Some(st) = v.get("AppState") else { continue };
            let (Some(id), Some(dir)) = (st.get("appid").and_then(|x| x.str()), st.get("installdir").and_then(|x| x.str())) else { continue };
            count += 1;
            if let Ok(id) = id.parse() {
                apps.push(SteamApp { id, dir: sa.join("common").join(dir) });
            }
        }
        out.push(SteamLibrary { path: lib.to_string_lossy().into(), exists: fsx::is_dir(&sa), app_count: count });
    }
    (out, apps)
}

pub struct EpicApp {
    pub name: String,
    pub dir: PathBuf,
    pub launch: Option<String>,
}

pub fn epic_apps() -> Vec<EpicApp> {
    let Some(dir) = platform::epic_manifest_dir() else { return vec![] };
    let mut out = Vec::new();
    for e in fsx::list(&dir) {
        if !e.name.to_lowercase().ends_with(".item") {
            continue;
        }
        let Some(j) = fsx::read_string(&e.path).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { continue };
        let g = |k: &str| j.get(k).and_then(|v| v.as_str()).map(String::from);
        let launch = match (g("CatalogNamespace"), g("CatalogItemId"), g("AppName")) {
            (Some(ns), Some(item), Some(app)) => Some(epic_launch_url(&ns, &item, &app)),
            _ => None,
        };
        out.push(EpicApp { name: g("DisplayName").unwrap_or_default(), dir: PathBuf::from(g("InstallLocation").unwrap_or_default()), launch });
    }
    out
}

pub fn epic_launch_url(namespace: &str, item: &str, app: &str) -> String {
    format!("com.epicgames.launcher://apps/{namespace}%3A{item}%3A{app}?action=launch&silent=true")
}

// ---------------------------------------------------------------- the scan

struct Collector {
    by_game: BTreeMap<&'static str, Vec<InstallInfo>>,
}

impl Collector {
    fn add(&mut self, game: &'static str, source: &str, dir: &Path, exe: Option<PathBuf>, launch: Option<String>, steam: Option<u32>) {
        if fsx::blocked(dir) {
            return;
        }
        let list = self.by_game.entry(game).or_default();
        if list.iter().any(|i| fsx::norm(Path::new(&i.path)) == fsx::norm(dir)) {
            return;
        }
        let launcher = match game {
            "tmnf" | "tmuf" => Some(dir.join("TmForeverLauncher.exe")),
            "tmn-eswc" => Some(dir.join("TmNationsESWCLauncher.exe")),
            _ => None,
        }
        .filter(|p| fsx::is_file(p));
        let note = if game == "tm-2003" { exe.as_ref().and_then(|e| exe_version(e)).map(|v| format!("Version {v}")) } else { None };
        list.push(InstallInfo {
            source: source.into(),
            path: dir.to_string_lossy().into(),
            modified: exe.as_ref().and_then(|e| fsx::mtime_iso(e)),
            exe: exe.map(|e| e.to_string_lossy().into_owned()),
            launcher: launcher.map(|p| p.to_string_lossy().into_owned()),
            launch,
            note,
            steam_app_id: steam,
            rom: None,
            extra_args: vec![],
        });
    }

    /// Adds every game found directly in `dir`.
    fn add_dir(&mut self, source: &str, dir: &Path, only: Option<&[&str]>) {
        for (game, exe) in classify(dir) {
            if only.map(|o| o.contains(&game)).unwrap_or(true) {
                self.add(game, source, dir, Some(exe), None, None);
            }
        }
    }

    fn take(&mut self, game: &str) -> Vec<InstallInfo> {
        self.by_game.remove(game).unwrap_or_default()
    }
}

pub fn game_ids_for_steam(id: u32) -> &'static [&'static str] {
    match id {
        STEAM_TMNF => &["tmnf"],
        STEAM_TMUF => &["tmuf"],
        STEAM_MP => &["maniaplanet"],
        STEAM_TM2020 => &["tm2020"],
        STEAM_TURBO => &["tm-turbo"],
        _ => &[],
    }
}

pub fn scan(input: &ScanInput) -> Snapshot {
    let docs = platform::documents_dir();
    // Debug builds only: TMHUB_SCAN_ONLY_FOLDERS=1 sees nothing but the added folders (screenshots with demo
    // data in a sandbox; the PC's own installs, Steam, Ubisoft, Epic and the program list stay out).
    let only = cfg!(debug_assertions) && std::env::var_os("TMHUB_SCAN_ONLY_FOLDERS").is_some_and(|v| !v.is_empty());
    let pfs = if only { vec![] } else { platform::program_files() };
    let pf86 = platform::program_files_x86();
    let mut c = Collector { by_game: BTreeMap::new() };

    // 1. Usual install folders.
    for pf in &pfs {
        for f in ["TmNationsForever", "TmUnitedForever", "Nadeo\\TmNationsForever", "Nadeo\\TmUnitedForever", "TrackMania Nations Forever", "TrackMania United Forever"] {
            c.add_dir("Installer", &pf.join(f), Some(&["tmnf", "tmuf"]));
        }
        c.add_dir("Installer", &pf.join("ManiaPlanet"), Some(&["maniaplanet"]));
        for f in ["TrackMania", "TmOriginal", "TrackMania Original"] {
            c.add_dir("Installer", &pf.join(f), Some(&["tm-original", "tm-2003"]));
        }
        for f in ["Nadeo\\TrackMania", "Digital Jesters\\TrackMania", "Enlight\\TrackMania", "TrackMania Power Up", "TrackMania PowerUp"] {
            c.add_dir("Installer", &pf.join(f), Some(&["tm-2003", "tm-original"]));
        }
        for f in ["TmSunrise", "TrackMania Sunrise", "TrackMania Sunrise Extreme", "TmSunriseExtreme"] {
            c.add_dir("Installer", &pf.join(f), Some(&["tm-sunrise"]));
        }
    }
    // Games folders (home, Documents, drive roots), two levels deep with the drive scan's rules (exe + game
    // data): copies of Sunrise, Original, ESWC and Forever that no installer registered, on the first start.
    if !only {
        let roots = games_roots(dirs::home_dir().as_deref(), dirs::document_dir().as_deref(), &platform::fixed_drives());
        for f in walk_for_games(&roots, 2, &AtomicBool::new(false), |_, _, _| {}) {
            if let Some(g) = classify(Path::new(&f.path)).into_iter().map(|(g, _)| g).find(|g| *g == f.game) {
                c.add_dir("Games folder", Path::new(&f.path), Some(&[g]));
            }
        }
    }

    // 2. Steam.
    let (steam_libs, steam_apps) = if only { (vec![], vec![]) } else { steam_libraries() };
    for a in &steam_apps {
        for &game in game_ids_for_steam(a.id) {
            let url = format!("steam://rungameid/{}", a.id);
            let exe = classify(&a.dir).into_iter().find(|(g, _)| *g == game || (game == "tmnf" || game == "tmuf") && (*g == "tmnf" || *g == "tmuf")).map(|(_, e)| e);
            if exe.is_none() && game != "tm-turbo" {
                continue;
            }
            // ManiaPlanet titles need /title=, so ManiaPlanet always starts through its exe.
            let launch = if game == "maniaplanet" { None } else { Some(url) };
            c.add(game, "Steam", &a.dir, exe, launch, Some(a.id));
        }
    }

    // 3. Ubisoft Connect (registry, then the default folder).
    let mut ubi: Vec<(u32, PathBuf)> = if only { vec![] } else { platform::ubisoft_installs().into_iter().map(|u| (u.id, u.dir)).collect() };
    let ug = platform::ubisoft_games_dir();
    for (id, name) in [(UBI_TM2020, "Trackmania"), (UBI_MP, "Mania Planet")] {
        if !only && !ubi.iter().any(|(i, _)| *i == id) && fsx::is_dir(&ug.join(name)) {
            ubi.push((id, ug.join(name)));
        }
    }
    let mut ubisoft_stub = false;
    for (id, dir) in &ubi {
        match *id {
            UBI_TM2020 => {
                let exe = dir.join("Trackmania.exe");
                if fsx::is_file(&exe) {
                    c.add("tm2020", "Ubisoft Connect", dir, Some(exe), Some(format!("uplay://launch/{UBI_TM2020}/0")), None);
                }
            }
            UBI_MP => {
                let exe = dir.join("ManiaPlanet.exe");
                if fsx::is_file(&exe) {
                    c.add("maniaplanet", "Ubisoft Connect", dir, Some(exe), None, None);
                } else if fsx::is_file(&dir.join("Maniaplanet_UplaySetup.exe")) {
                    ubisoft_stub = true;
                }
            }
            _ => {}
        }
    }
    for name in ["Trackmania Turbo", "TrackMania Turbo"].into_iter().filter(|_| !only) {
        c.add_dir("Ubisoft Connect", &ug.join(name), Some(&["tm-turbo"]));
    }
    // Turbo's Ubisoft Connect id is not pinned: every registered Ubisoft install folder with
    // TrackmaniaTurbo.exe counts.
    for (_, dir) in &ubi {
        c.add_dir("Ubisoft Connect", dir, Some(&["tm-turbo"]));
    }

    // 4. Epic.
    let epic = if only { vec![] } else { epic_apps() };
    for e in &epic {
        if e.name.eq_ignore_ascii_case("trackmania") {
            let exe = e.dir.join("Trackmania.exe");
            if fsx::is_file(&exe) {
                c.add("tm2020", "Epic Games", &e.dir, Some(exe), e.launch.clone(), None);
            }
        }
    }

    // 5. The system's list of installed programs.
    for u in if only { vec![] } else { platform::uninstall_entries() } {
        let n = u.name.to_lowercase();
        if !(n.contains("trackmania") || n.contains("tmnations") || n.contains("maniaplanet") || n.contains("mania planet") || n.contains("shootmania")) {
            continue;
        }
        if let Some(loc) = &u.location {
            c.add_dir("Installed program", loc, None);
        }
    }

    // 6. Found by "Scan drives" and added by hand.
    for f in &input.found {
        // Older drive scans also kept exe-only folders: those stay out now.
        let dir = Path::new(&f.path);
        let games: Vec<&str> = classify(dir).into_iter().map(|(g, _)| g).filter(|g| has_game_data(g, dir)).collect();
        c.add_dir("Found on drive", dir, Some(&games));
    }
    for m in &input.manual {
        c.add_dir("Added folder", Path::new(m), None);
    }

    // ManiaPlanet title packs.
    let mp_installs = c.take("maniaplanet");
    let mut pack_dirs: Vec<PathBuf> = mp_installs.iter().map(|i| Path::new(&i.path).join("Packs")).collect();
    if let Some(d) = &docs {
        pack_dirs.insert(0, d.join("ManiaPlanet").join("Packs"));
    }
    if let Some(pd) = platform::program_data() {
        pack_dirs.push(pd.join("ManiaPlanet").join("Packs"));
    }
    let mut packs: Vec<String> = Vec::new();
    for d in pack_dirs {
        for e in fsx::list(&d) {
            let l = e.name.to_lowercase();
            if let Some(stem) = l.strip_suffix(".title.pack.gbx") {
                let id = &e.name[..stem.len()];
                if id.contains('@') && !packs.iter().any(|p| p.eq_ignore_ascii_case(id)) {
                    packs.push(id.to_string());
                }
            }
        }
    }

    let unsupported = if !only && fsx::eswc_protected_exists() {
        vec![InstallInfo {
            source: "Original (StarForce)".into(),
            path: pf86.join("TrackMania Nations ESWC").to_string_lossy().into(),
            note: Some("Unsupported version".into()),
            ..Default::default()
        }]
    } else {
        vec![]
    };

    let games = Games {
        tmnf: Installs { installs: c.take("tmnf") },
        tmuf: Installs { installs: c.take("tmuf") },
        eswc: EswcInstalls { installs: c.take("tmn-eswc"), unsupported },
        maniaplanet: MpInstalls { installs: mp_installs, title_packs: packs, ubisoft_stub },
        tm2020: Installs { installs: c.take("tm2020") },
        turbo: Installs { installs: c.take("tm-turbo") },
        original: Installs { installs: c.take("tm-original") },
        sunrise: Installs { installs: c.take("tm-sunrise") },
        tm2003: Installs { installs: c.take("tm-2003") },
        ..Default::default()
    };

    let tml = input.tmloader_root.as_deref().map(tmloader::read_info).unwrap_or_default();

    let mut openplanet = BTreeMap::new();
    if let Some(home) = Some(crate::openplanet::user_root()).filter(|h| !h.as_os_str().is_empty()) {
        for (key, dir) in [("tm2020", home.join("OpenplanetNext")), ("maniaplanet", home.join("Openplanet4"))] {
            let op = if fsx::is_dir(&dir) {
                Openplanet {
                    installed: true,
                    path: Some(dir.to_string_lossy().into()),
                    plugins: fsx::list(&dir.join("Plugins")).into_iter().map(|e| e.name.trim_end_matches(".op").to_string()).collect(),
                }
            } else {
                Openplanet::default()
            };
            openplanet.insert(key.to_string(), op);
        }
    }

    let mut recent = BTreeMap::new();
    if let Some(d) = &docs {
        let tm = d.join("TrackMania");
        let mp = d.join("ManiaPlanet");
        let t20 = crate::maps::tm2020_user_dir(d);
        recent.insert(
            "forever".into(),
            Recent {
                replays: recent_files(&[tm.join("Tracks/Replays"), tm.join("Tracks/Replays/Autosaves")], &[".replay.gbx"]),
                maps: recent_files(&[tm.join("Tracks/Challenges/My Challenges"), tm.join("Tracks/Challenges/Downloaded")], &[".challenge.gbx"]),
            },
        );
        recent.insert(
            "maniaplanet".into(),
            Recent {
                replays: recent_files(&[mp.join("Replays"), mp.join("Replays/Autosaves")], &[".replay.gbx"]),
                maps: recent_files(&[mp.join("Maps/My Maps"), mp.join("Maps/Downloaded"), mp.join("Maps")], &[".map.gbx", ".challenge.gbx"]),
            },
        );
        recent.insert(
            "tm2020".into(),
            Recent {
                replays: recent_files(&[t20.join("Replays"), t20.join("Replays/Autosaves")], &[".replay.gbx"]),
                maps: recent_files(&[t20.join("Maps/My Maps"), t20.join("Maps/Downloaded")], &[".map.gbx"]),
            },
        );
    } else {
        for k in ["forever", "maniaplanet", "tm2020"] {
            recent.insert(k.into(), Recent::default());
        }
    }

    Snapshot {
        scanned_at: fsx::now_iso(),
        platform: platform::NAME.into(),
        documents: docs.map(|d| d.to_string_lossy().into()),
        games,
        steam_libraries: steam_libs,
        epic: epic.iter().map(|e| e.name.clone()).collect(),
        tmloader: tml,
        openplanet,
        recent,
    }
}

fn recent_files(dirs: &[PathBuf], exts: &[&str]) -> Vec<RecentFile> {
    let mut all: Vec<(Option<std::time::SystemTime>, String)> = Vec::new();
    for d in dirs {
        for e in fsx::list(d) {
            let l = e.name.to_lowercase();
            if e.is_file && exts.iter().any(|x| l.ends_with(x)) {
                all.push((e.modified, e.name));
            }
        }
    }
    all.sort_by(|a, b| b.0.cmp(&a.0));
    all.into_iter().take(6).map(|(t, name)| RecentFile { name, modified: t.map(fsx::iso) }).collect()
}

// ---------------------------------------------------------------- "Scan drives"

/// Folder names never entered while walking drives.
pub fn skip_dir(name: &str) -> bool {
    const SKIP: [&str; 27] = [
        "winsxs",
        "shadercache",
        "shader_cache",
        "depotcache",
        "dxcache",
        "glcache",
        "__pycache__",
        "site-packages",
        ".npm",
        ".cargo",
        ".rustup",
        ".gradle",
        "temp",
        "windows",
        "programdata",
        "$recycle.bin",
        "system volume information",
        "recovery",
        "perflogs",
        "$winreagent",
        "$windows.~bt",
        "$windows.~ws",
        "windowsapps",
        "appdata",
        "node_modules",
        ".git",
        "msocache",
    ];
    let l = name.to_lowercase();
    SKIP.contains(&l.as_str()) || l.starts_with("$")
}

/// Walks `roots` (all fixed drives) looking for the known game exes. Skips system folders,
/// symlinks/junctions, TMLoader's database and the protected ESWC folder.
/// Places games usually live in, scanned first (fast results): Steam libraries, Ubisoft Connect,
/// Program Files, the TMLoader folder and common "Games" folders on every drive.
/// Folders people keep game copies in: ~/Games, ~/Spiele, Documents\Games, <drive>:\Games and <drive>:\Spiele
/// (existing ones, no duplicates). The quick scan walks them two levels deep.
pub fn games_roots(home: Option<&Path>, documents: Option<&Path>, drives: &[PathBuf]) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Some(h) = home {
        v.push(h.join("Games"));
        v.push(h.join("Spiele"));
    }
    if let Some(d) = documents {
        v.push(d.join("Games"));
    }
    for d in drives {
        v.push(d.join("Games"));
        v.push(d.join("Spiele"));
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for p in v {
        if fsx::is_dir(&p) && !out.iter().any(|q| fsx::norm(q) == fsx::norm(&p)) {
            out.push(p);
        }
    }
    out
}

pub fn known_roots(drives: &[PathBuf]) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = steam_libraries().0.into_iter().filter(|l| l.exists).map(|l| PathBuf::from(l.path).join("steamapps").join("common")).collect();
    v.push(platform::ubisoft_games_dir());
    v.extend(platform::program_files());
    if let Some(h) = dirs::home_dir() {
        v.push(h.join("Games"));
    }
    for d in drives {
        for n in ["Games", "Spiele", "SteamLibrary", "Program Files (x86)", "TrackMania", "Trackmania"] {
            v.push(d.join(n));
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for p in v {
        if fsx::is_dir(&p) && !out.iter().any(|q| fsx::norm(q) == fsx::norm(&p)) {
            out.push(p);
        }
    }
    out
}

pub fn walk_for_games(roots: &[PathBuf], max_depth: usize, cancel: &AtomicBool, progress: impl FnMut(&Path, usize, usize)) -> Vec<FoundInstall> {
    walk_for_games_skipping(roots, max_depth, cancel, &[], progress)
}

/// Walks the roots; folders in `skip` (already scanned) are not entered again.
pub fn walk_for_games_skipping(roots: &[PathBuf], max_depth: usize, cancel: &AtomicBool, skip: &[PathBuf], mut progress: impl FnMut(&Path, usize, usize)) -> Vec<FoundInstall> {
    let mut found: Vec<FoundInstall> = Vec::new();
    let mut seen_dirs = 0usize;
    let skip: Vec<String> = skip.iter().map(|p| fsx::norm(p)).collect();
    let mut last = std::time::Instant::now();
    for root in roots {
        let mut stack = vec![(root.clone(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if cancel.load(Ordering::Relaxed) {
                return found;
            }
            if fsx::blocked(&dir) || fsx::is_inside(&dir, &tmloader_db_marker()) || (depth > 0 && skip.contains(&fsx::norm(&dir))) {
                continue;
            }
            seen_dirs += 1;
            if seen_dirs % 200 == 0 || last.elapsed().as_millis() > 300 {
                last = std::time::Instant::now();
                progress(&dir, seen_dirs, found.len());
            }
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            let mut has_exe = false;
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                let name = e.file_name().to_string_lossy().into_owned();
                if ft.is_file() {
                    if KNOWN_EXES.contains(&name.to_lowercase().as_str()) {
                        has_exe = true;
                    }
                } else if ft.is_dir() && !ft.is_symlink() && depth < max_depth && !skip_dir(&name) {
                    stack.push((e.path(), depth + 1));
                }
            }
            if has_exe {
                for (game, exe) in classify(&dir).into_iter().filter(|(g, _)| has_game_data(g, &dir)) {
                    let path: String = dir.to_string_lossy().into();
                    if !found.iter().any(|f| f.game == game && fsx::norm(Path::new(&f.path)) == fsx::norm(Path::new(&path))) {
                        found.push(FoundInstall { game: game.into(), path, exe: exe.to_string_lossy().into() });
                    }
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pe(machine: u16) -> Vec<u8> {
        let mut b = vec![0u8; 0x100];
        b[0..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        b[0x80..0x84].copy_from_slice(b"PE\0\0");
        b[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
        b
    }

    #[test]
    fn classifies_folders() {
        let t = tempfile::tempdir().unwrap();
        let tmuf = t.path().join("Some United");
        fsx::write(&tmuf.join("TmForever.exe"), b"MZ").unwrap();
        fsx::write(&tmuf.join("Nadeo.ini"), b"[TmForever]\r\nWindowTitle=TrackMania United Forever\r\nKey=Ask\r\n").unwrap();
        let tmnf = t.path().join("Games/Nations");
        fsx::write(&tmnf.join("TmForever.exe"), b"MZ").unwrap();
        fsx::write(&tmnf.join("Nadeo.ini"), b"[TmForever]\r\nVersion=2.11.26\r\nDistro=APIJU\r\n").unwrap();
        let t20 = t.path().join("TM2020");
        fsx::write(&t20.join("Trackmania.exe"), &pe(0x8664)).unwrap();
        // 32-bit TrackMania.exe: file version 1.5 = Original (an upgrade of Power Up!), older = the 2003 game.
        let with_version = |major: u32, minor: u32| {
            let mut b = pe(0x14c);
            b.extend([0xBD, 0x04, 0xEF, 0xFE, 0, 0, 1, 0]);
            b.extend(((major << 16) | minor).to_le_bytes());
            b.extend(0u32.to_le_bytes());
            b
        };
        let orig = t.path().join("Old/TrackMania");
        fsx::write(&orig.join("TrackMania.exe"), &with_version(1, 5)).unwrap();
        let tm1 = t.path().join("Older/TrackMania");
        fsx::write(&tm1.join("TrackMania.exe"), &with_version(1, 1)).unwrap();
        let tm1_nover = t.path().join("Oldest/TM");
        fsx::write(&tm1_nover.join("TrackMania.exe"), &pe(0x14c)).unwrap();
        let orig_nover = t.path().join("TrackMania Original");
        fsx::write(&orig_nover.join("TrackMania.exe"), &pe(0x14c)).unwrap();
        let eswc = t.path().join("ESWC");
        fsx::write(&eswc.join("TmNationsESWC.exe"), b"MZ").unwrap();

        // TMORIGINAL.EXE names the folder; the 32-bit TrackMania.exe beside it is not a second game.
        let tmo = t.path().join("TmOriginal");
        fsx::write(&tmo.join("TMORIGINAL.EXE"), &pe(0x14c)).unwrap();
        fsx::write(&tmo.join("TrackMania.exe"), &with_version(1, 1)).unwrap();
        let c = classify(&tmo);
        assert_eq!(c.len(), 1, "{c:?}");
        assert_eq!(c[0].0, "tm-original");
        assert_eq!(classify(&tmuf)[0].0, "tmuf");
        assert_eq!(classify(&tmnf)[0].0, "tmnf");
        assert_eq!(classify(&t20)[0].0, "tm2020");
        assert_eq!(classify(&orig)[0].0, "tm-original");
        assert_eq!(classify(&tm1)[0].0, "tm-2003");
        assert_eq!(exe_version(&tm1.join("TrackMania.exe")).as_deref(), Some("1.1.0.0"));
        assert_eq!(classify(&tm1_nover)[0].0, "tm-2003");
        assert_eq!(classify(&orig_nover)[0].0, "tm-original");
        assert_eq!(classify(&eswc)[0].0, "tmn-eswc");

        // Drive scan: only folders with the game's data (an exe alone is an extracted patch or a copy).
        for d in [&tmuf, &tmnf, &orig, &tm1, &tm1_nover, &orig_nover, &eswc, &tmo] {
            std::fs::create_dir_all(d.join("GameData")).unwrap();
        }
        std::fs::create_dir_all(t20.join("Packs")).unwrap();
        let exe_only = t.path().join("tools/eswc-patch/x");
        fsx::write(&exe_only.join("TmNationsESWC.exe"), b"MZ").unwrap();
        assert!(!has_game_data("tmn-eswc", &exe_only));
        let cancel = AtomicBool::new(false);
        let mut found = walk_for_games(&[t.path().to_path_buf()], 6, &cancel, |_, _, _| {});
        found.sort_by(|a, b| a.game.cmp(&b.game));
        let games: Vec<_> = found.iter().map(|f| f.game.as_str()).collect();
        assert_eq!(games, ["tm-2003", "tm-2003", "tm-original", "tm-original", "tm-original", "tm2020", "tmn-eswc", "tmnf", "tmuf"]);
    }

    #[test]
    fn games_folders_find_unregistered_copies() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let games = home.join("Games");
        for (dir, exe) in [("TMO-horizon-test", "TmOriginal.exe"), ("TMS-test", "TmSunrise.exe"), ("Trackmania Original", "TmOriginal.exe"), ("Sub/TMN-ESWC-x", "TmNationsESWC.exe")] {
            fsx::write(&games.join(dir).join(exe), b"MZ").unwrap();
            std::fs::create_dir_all(games.join(dir).join("GameData")).unwrap();
        }
        // An exe without game data (extracted patch) and a copy three levels deep stay out.
        fsx::write(&games.join("tools").join("x").join("TmSunrise.exe"), b"MZ").unwrap();
        fsx::write(&games.join("a").join("b").join("c").join("TmSunrise.exe"), b"MZ").unwrap();
        std::fs::create_dir_all(games.join("a").join("b").join("c").join("GameData")).unwrap();
        let roots = games_roots(Some(&home), None, &[t.path().join("NoDrive")]);
        assert_eq!(roots, vec![games.clone()]);
        let mut found: Vec<_> = walk_for_games(&roots, 2, &AtomicBool::new(false), |_, _, _| {}).into_iter().map(|f| (f.game, Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned())).collect();
        found.sort();
        assert_eq!(found, [("tm-original".into(), "TMO-horizon-test".into()), ("tm-original".into(), "Trackmania Original".into()), ("tm-sunrise".into(), "TMS-test".into()), ("tmn-eswc".into(), "TMN-ESWC-x".into())]);
    }

    #[test]
    fn walk_skips_system_folders() {
        assert!(skip_dir("Windows") && skip_dir("ProgramData") && skip_dir("$Recycle.Bin") && skip_dir("AppData"));
        assert!(!skip_dir("Games") && !skip_dir("Program Files (x86)"));
        let t = tempfile::tempdir().unwrap();
        fsx::write(&t.path().join("Windows/TmForever.exe"), b"MZ").unwrap();
        let cancel = AtomicBool::new(false);
        assert!(walk_for_games(&[t.path().to_path_buf()], 6, &cancel, |_, _, _| {}).is_empty());
    }

    #[test]
    fn epic_url() {
        assert_eq!(
            epic_launch_url("ns", "item", "App"),
            "com.epicgames.launcher://apps/ns%3Aitem%3AApp?action=launch&silent=true"
        );
    }

    /// Real scan of this PC (read only). Prints a summary; checks the ESWC rules.
    #[test]
    fn scan_this_pc() {
        let s = scan(&ScanInput { tmloader_root: tmloader::resolve_root(None), found: vec![], manual: vec![] });
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.to_lowercase().contains("dinput8"));
        for i in &s.games.eswc.installs {
            assert!(!fsx::blocked(Path::new(&i.path)));
        }
        eprintln!(
            "tmnf {} tmuf {} eswc {} mp {} packs {:?} tm2020 {:?} profiles {}",
            s.games.tmnf.installs.len(),
            s.games.tmuf.installs.len(),
            s.games.eswc.installs.len(),
            s.games.maniaplanet.installs.len(),
            s.games.maniaplanet.title_packs,
            s.games.tm2020.installs.iter().map(|i| &i.source).collect::<Vec<_>>(),
            s.tmloader.profiles.len()
        );
    }
}

#[cfg(test)]
mod timing {
    /// `cargo test --release time_real_scan -- --ignored --nocapture` prints how long a scan takes here.
    #[test]
    #[ignore]
    fn time_real_scan() {
        for round in 0..3 {
            let t0 = std::time::Instant::now();
            let snap = super::scan(&super::ScanInput { tmloader_root: None, found: vec![], manual: vec![] });
            println!("scan round {round}: {} ms, {} games", t0.elapsed().as_millis(), serde_json::to_value(&snap).unwrap()["games"].as_object().map(|o| o.len()).unwrap_or(0));
        }
        let t0 = std::time::Instant::now();
        let _ = super::steam_libraries();
        println!("steam libraries: {} ms", t0.elapsed().as_millis());
        let t0 = std::time::Instant::now();
        let _ = crate::platform::uninstall_entries();
        println!("uninstall list: {} ms", t0.elapsed().as_millis());
        let t0 = std::time::Instant::now();
        let _ = crate::platform::running_process_names();
        println!("process list: {} ms", t0.elapsed().as_millis());
    }
}
