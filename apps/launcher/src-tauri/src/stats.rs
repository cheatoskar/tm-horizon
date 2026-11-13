//! Statistics page: play time, sessions, saved runs and best times per game and per map, from real
//! data only (the games' own profile statistics in TMNF/TMUF are often wrong, so they are not used):
//!
//! 1. Play time and sessions: the launcher's own process tracking (playtime.rs, `playsessions.json`).
//! 2. Replays in the games' folders (headers read with gbx.rs): map uid, environment, time, driver,
//!    respawns of the saved run. Only the player's own replays count: autosaves (the game writes them
//!    for the active profile) and replays whose driver login is one of the autosaves' logins.
//!    "Runs" are saved replays, not every finish (the game only keeps what is saved).
//! 3. Horizon Host events when the host writes them (finishes, starts, respawns per map): JSON lines
//!    in `<app data>\host-stats\<game>\*.jsonl`, format in docs/design/host-stats-channel.md.
//!
//! Map names: the replay XML (ManiaPlanet, Trackmania 2020), else the local map files with that uid,
//! else the replay's file name. Parsed headers are cached by path, size and time.

use crate::fsx;
use crate::gbx;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_FILES: usize = 20_000;
const MAX_DEPTH: u32 = 4;
const HEAD_BYTES: usize = 192 * 1024;

/// Game families with their own folders. Forever = TMNF + TMUF (one Documents folder).
pub const FAMILIES: [&str; 6] = ["forever", "maniaplanet", "tm2020", "tmn-eswc", "tm-sunrise", "tm-original"];

/// Game ids of a family (play time is kept per game id).
pub fn family_games(f: &str) -> Vec<&'static str> {
    match f {
        "forever" => vec!["tmnf", "tmuf"],
        "maniaplanet" => vec!["tm2-stadium", "tm2-canyon", "tm2-valley", "tm2-lagoon", "maniaplanet"],
        "tm2020" => vec!["tm2020"],
        "tmn-eswc" => vec!["tmn-eswc"],
        "tm-sunrise" => vec!["tm-sunrise"],
        "tm-original" => vec!["tm-original"],
        _ => vec![],
    }
}

/// Family of a game id (`tmuf@copy` counts as forever).
pub fn family_of(game: &str) -> Option<&'static str> {
    let g = game.split('@').next().unwrap_or(game);
    FAMILIES.iter().copied().find(|f| family_games(f).contains(&g) || (*f == "maniaplanet" && g.starts_with("tm2")))
}

#[derive(Debug, Clone)]
pub struct Folders {
    pub family: &'static str,
    pub replays: Vec<PathBuf>,
    pub maps: Vec<PathBuf>,
    /// Copy id (copies.rs).
    pub copy: String,
}

/// Replay and map folders of each game copy (every install and instance, copies.rs).
/// `TMHUB_NO_INSTALL_DIRS=1` leaves the game folders (ESWC, Sunrise, Original) out.
pub fn folders_of(copies: &[crate::copies::GameCopy]) -> Vec<Folders> {
    let no_install = std::env::var_os("TMHUB_NO_INSTALL_DIRS").is_some();
    copies
        .iter()
        .filter(|c| !(no_install && matches!(c.family, "tmn-eswc" | "tm-sunrise" | "tm-original")))
        .map(|c| {
            let d = PathBuf::from(&c.data);
            let (replays, maps) = match c.family {
                "maniaplanet" | "tm2020" => (d.join("Replays"), d.join("Maps")),
                _ => (d.join("Tracks").join("Replays"), d.join("Tracks").join("Challenges")),
            };
            Folders { family: c.family, replays: vec![replays], maps: vec![maps], copy: c.id.clone() }
        })
        .collect()
}

/// The copies of `docs` and one install per legacy game (`install`; tests and tools).
pub fn copies_for(docs: Option<&Path>, install: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<crate::copies::GameCopy> {
    let list: Vec<crate::copies::Install> = ["tmn-eswc", "tm-sunrise", "tm-original"]
        .iter()
        .filter_map(|g| install(g).map(|dir| crate::copies::Install { game: g.to_string(), label: dir.to_string_lossy().into_owned(), dir, instance: None, user_dir: None, selected: true }))
        .collect();
    crate::copies::build(docs, &list, &|_| None)
}

/// Where each family keeps replays and maps. `install` gives a legacy game's install folder.
pub fn folders(docs: Option<&Path>, install: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<Folders> {
    folders_of(&copies_for(docs, install))
}

// ------------------------------------------------------------------ header cache

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Head {
    pub size: u64,
    pub mtime: u64,
    pub uid: Option<String>,
    pub name: Option<String>,
    pub env: Option<String>,
    pub time_ms: Option<u32>,
    pub login: Option<String>,
    pub nick: Option<String>,
    pub respawns: Option<i32>,
    /// A map file (not a replay).
    pub map: bool,
    /// The map's author login ("" = read, none in the file; None = entry from before 0.5.1-c, filled in
    /// once per map by `fill_authors`). "Nadeo" marks the games' own campaign maps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

/// Version of the cache file layout. A file with another version is ignored (and set aside), so a
/// format change never reads old entries wrongly.
/// 4: replays with the old header class id 0x2407E000 (most TMNF/TMUF replays) are read now; v3 cached them empty.
pub const CACHE_VERSION: u32 = 4;
/// Entries kept at most (about 250 bytes each: a few MB for the biggest folders).
const CACHE_MAX: usize = MAX_FILES * 2 + 4_000;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct CacheFile {
    version: u32,
    files: BTreeMap<String, Head>,
}

/// Parsed headers keyed by normalised path; an entry only counts while size and modification time
/// still match the file.
#[derive(Debug, Default)]
pub struct HeadCache {
    files: BTreeMap<String, Head>,
}

fn cache_file(cache: &Path) -> PathBuf {
    cache.join("stats-headers-v4.json")
}

impl HeadCache {
    /// Loads the cache file; a missing, unreadable, corrupted or foreign-version file gives an empty
    /// cache (a damaged file is set aside as `.bad`, never an error).
    pub fn load(dir: &Path) -> Self {
        let p = cache_file(dir);
        let Ok(b) = std::fs::read(&p) else { return Self::default() };
        match serde_json::from_slice::<CacheFile>(&b) {
            Ok(c) if c.version == CACHE_VERSION && c.files.len() <= CACHE_MAX => Self { files: c.files },
            _ => {
                let _ = std::fs::rename(&p, p.with_extension("bad"));
                Self::default()
            }
        }
    }

    /// Writes the cache atomically (temporary file, then rename).
    pub fn save(&self, dir: &Path) {
        let f = CacheFile { version: CACHE_VERSION, files: self.files.clone() };
        let _ = fsx::write(&cache_file(dir), &serde_json::to_vec(&f).unwrap_or_default());
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// The entry of a file when size and time still match.
    pub fn get(&self, f: &Listed) -> Option<&Head> {
        self.files.get(&f.key).filter(|h| h.size == f.size && h.mtime == f.mtime)
    }

    fn insert(&mut self, key: String, h: Head) {
        if self.files.len() < CACHE_MAX || self.files.contains_key(&key) {
            self.files.insert(key, h);
        }
    }

    /// Drops entries of files that are gone.
    pub fn retain_keys(&mut self, keep: &BTreeSet<&str>) {
        self.files.retain(|k, _| keep.contains(k.as_str()));
    }
}

/// Reads one replay header (first bytes only).
pub fn read_replay(bytes: &[u8]) -> Option<Head> {
    let h = gbx::replay_head(bytes)?;
    let xml = gbx::replay_xml(bytes).unwrap_or_default();
    let x = |tag: &str, key: &str| gbx::xml_attr(&xml, tag, key);
    let name = x("map", "name").or_else(|| x("challenge", "name")).filter(|s| !s.is_empty());
    let respawns = x("times", "respawns").and_then(|v| v.trim().parse::<i32>().ok()).filter(|r| *r >= 0);
    let time = h.time_ms.or_else(|| x("times", "best").and_then(|v| v.parse().ok())).filter(|t| *t > 0 && *t != u32::MAX);
    let author = Some(h.author.unwrap_or_default());
    Some(Head { uid: h.uid, name, env: h.environment, time_ms: time, login: h.login.filter(|l| !l.is_empty()), nick: h.nickname, respawns, map: false, author, ..Default::default() })
}

fn read_map(bytes: &[u8]) -> Option<Head> {
    let i = gbx::parse(bytes).ok()?;
    Some(Head { uid: i.uid, name: i.name, env: i.environment, map: true, author: Some(i.author.unwrap_or_default()), ..Default::default() })
}

/// One file found in a game folder (size and time come from the folder listing).
#[derive(Debug, Clone)]
pub struct Listed {
    pub path: PathBuf,
    pub key: String,
    pub size: u64,
    pub mtime: u64,
    pub map: bool,
}

fn walk(dir: &Path, depth: u32, out: &mut Vec<Listed>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    for e in fsx::list(dir) {
        if out.len() >= MAX_FILES {
            return;
        }
        if e.is_dir {
            walk(&e.path, depth + 1, out);
        } else if e.is_file {
            let Some(kind) = crate::maps::gbx_kind(&e.name).filter(|k| *k != crate::maps::GbxKind::Other) else { continue };
            let mtime = e.modified.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            out.push(Listed { key: fsx::norm(&e.path), path: e.path, size: e.len, mtime, map: kind == crate::maps::GbxKind::Map });
        }
    }
}

fn mtime_ms(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// The listing of one folder tree with the modification times of all its directories. Adding,
/// removing or renaming a file changes its directory's time (NTFS, ext4), so while every directory
/// keeps its time the listing is still right and 18,000 files are not listed again on each visit.
/// Files rewritten in place (the game's Autosaves) do not change the directory: those directories
/// are always listed again.
struct TreeListing {
    dirs: Vec<(PathBuf, u64)>,
    files: Vec<Listed>,
    at: std::time::Instant,
}

/// A remembered listing is used for at most this long (catches files rewritten in place elsewhere).
const LISTING_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

fn walk_stamped(dir: &Path, depth: u32, out: &mut TreeListing) {
    if depth > MAX_DEPTH || out.files.len() >= MAX_FILES {
        return;
    }
    let Some(m) = mtime_ms(dir) else { return };
    out.dirs.push((dir.to_path_buf(), m));
    let mut sub = vec![];
    for e in fsx::list(dir) {
        if e.is_dir {
            sub.push(e.path);
        } else if e.is_file && out.files.len() < MAX_FILES {
            let Some(kind) = crate::maps::gbx_kind(&e.name).filter(|k| *k != crate::maps::GbxKind::Other) else { continue };
            let mtime = e.modified.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            out.files.push(Listed { key: fsx::norm(&e.path), path: e.path, size: e.len, mtime, map: kind == crate::maps::GbxKind::Map });
        }
    }
    for s in sub {
        walk_stamped(&s, depth + 1, out);
    }
}

fn is_autosave_dir(p: &Path) -> bool {
    p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("autosaves"))
}

fn listings() -> &'static Mutex<BTreeMap<PathBuf, TreeListing>> {
    static L: OnceLock<Mutex<BTreeMap<PathBuf, TreeListing>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Drops the remembered listings (the page's Reload button: everything is listed again).
pub fn forget_listings() {
    listings().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// Files of a folder tree: from the remembered listing while no directory changed, else listed again.
fn walk_cached(dir: &Path, out: &mut Vec<Listed>) {
    let mut all = listings().lock().unwrap_or_else(|e| e.into_inner());
    let fresh = all.get(dir).is_some_and(|l| !l.dirs.is_empty() && l.at.elapsed() < LISTING_MAX_AGE && l.dirs.iter().all(|(d, m)| mtime_ms(d) == Some(*m)));
    if !fresh {
        let mut l = TreeListing { dirs: vec![], files: vec![], at: std::time::Instant::now() };
        walk_stamped(dir, 0, &mut l);
        all.insert(dir.to_path_buf(), l);
    }
    let Some(l) = all.get(dir) else { return };
    if !fresh {
        out.extend(l.files.iter().cloned());
        return;
    }
    // Autosaves are rewritten in place: their directories are read again (a few dozen files).
    let auto: Vec<&PathBuf> = l.dirs.iter().map(|(d, _)| d).filter(|d| is_autosave_dir(d)).collect();
    out.extend(l.files.iter().filter(|f| !f.path.parent().is_some_and(|p| auto.iter().any(|a| a.as_path() == p))).cloned());
    for a in auto {
        let mut fl = vec![];
        walk(a, MAX_DEPTH, &mut fl);
        out.extend(fl);
    }
}

/// Progress of the background parse (read by the page).
#[derive(Debug, Default)]
pub struct Progress {
    /// Files that needed parsing in this run, and how many are done.
    pub todo: AtomicU32,
    pub done: AtomicU32,
}

#[cfg(windows)]
fn lower_priority() {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_LOWEST};
    // Lowest CPU priority. (Background mode would also lower the disk priority, which starves the reads while
    // other programs use the disk: 70 s instead of 6 s for 12,000 replays on a busy PC.)
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
    }
}

#[cfg(not(windows))]
fn lower_priority() {}

/// Number of parse threads: half the cores, 1 to 4 (tests and tools).
pub fn default_threads() -> usize {
    (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2) / 2).clamp(1, 4)
}

/// Parse threads of the background indexer: one, two on 8 cores or more. The work is mostly disk
/// reads; more threads only fight with the game and the rest of the PC for the disk (the owner's PC
/// lagged during a 39 s first run with two threads on a busy disk).
pub fn background_threads() -> usize {
    if std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2) >= 8 { 2 } else { 1 }
}

/// Parses every listed file the cache does not know yet (or whose size or time changed) on `threads`
/// threads, saving the cache to `save_to` every 2000 files so an interrupted run keeps its work.
/// Returns (parsed, cache hits).
pub fn parse_missing(cache: &Mutex<HeadCache>, files: &[Listed], threads: usize, low_prio: bool, prog: Option<&Progress>, save_to: Option<&Path>) -> (u32, u32) {
    let misses: Vec<&Listed> = {
        let c = cache.lock().unwrap_or_else(|e| e.into_inner());
        files.iter().filter(|f| c.get(f).is_none()).collect()
    };
    let hits = (files.len() - misses.len()) as u32;
    if let Some(p) = prog {
        p.todo.store(misses.len() as u32, Ordering::Relaxed);
        p.done.store(0, Ordering::Relaxed);
    }
    if misses.is_empty() {
        return (0, hits);
    }
    let next = AtomicUsize::new(0);
    let parsed = AtomicU32::new(0);
    let work = || {
        if low_prio {
            lower_priority();
        }
        let mut batch: Vec<(String, Head)> = vec![];
        let flush = |batch: &mut Vec<(String, Head)>| {
            let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
            for (k, h) in batch.drain(..) {
                c.insert(k, h);
            }
        };
        loop {
            let i = next.fetch_add(1, Ordering::Relaxed);
            let Some(f) = misses.get(i) else { break };
            if let Some(bytes) = fsx::read_bytes_prefix(&f.path, HEAD_BYTES) {
                let mut h = if f.map { read_map(&bytes) } else { read_replay(&bytes) }.unwrap_or_default();
                h.size = f.size;
                h.mtime = f.mtime;
                h.map = f.map;
                batch.push((f.key.clone(), h));
            }
            let n = parsed.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some(p) = prog {
                p.done.store(n, Ordering::Relaxed);
            }
            // In the background: give the disk and the CPU back between files (about 1 ms per 64 files).
            if low_prio {
                if n % 64 == 0 {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                } else {
                    std::thread::yield_now();
                }
            }
            if batch.len() >= 64 {
                flush(&mut batch);
            }
            if n % 2000 == 0 {
                flush(&mut batch);
                if let Some(d) = save_to {
                    cache.lock().unwrap_or_else(|e| e.into_inner()).save(d);
                }
            }
        }
        flush(&mut batch);
    };
    let threads = threads.clamp(1, 8).min(misses.len());
    std::thread::scope(|s| {
        for _ in 1..threads {
            s.spawn(&work);
        }
        work();
    });
    (parsed.load(Ordering::Relaxed), hits)
}

/// Map authors for cache entries written before 0.5.1-c (they have none): one replay header per map uid
/// is read again and its author goes to every entry of that uid. Runs once; later entries carry it.
/// Returns the number of files read.
pub fn fill_authors(cache: &Mutex<HeadCache>, files: &[Listed]) -> u32 {
    let todo: Vec<(String, PathBuf)> = {
        let c = cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut seen = BTreeSet::new();
        files
            .iter()
            .filter_map(|f| c.get(f).filter(|h| !h.map && h.author.is_none()).and_then(|h| h.uid.clone()).map(|u| (u, f.path.clone())))
            .filter(|(u, _)| seen.insert(u.clone()))
            .collect()
    };
    let mut found: BTreeMap<String, String> = BTreeMap::new();
    for (i, (uid, path)) in todo.iter().enumerate() {
        let author = fsx::read_bytes_prefix(path, 64 * 1024).and_then(|b| gbx::replay_head(&b)).and_then(|h| h.author).unwrap_or_default();
        found.insert(uid.clone(), author);
        if i % 64 == 63 {
            std::thread::yield_now();
        }
    }
    let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
    for h in c.files.values_mut().filter(|h| !h.map && h.author.is_none()) {
        if let Some(a) = h.uid.as_ref().and_then(|u| found.get(u)) {
            h.author = Some(a.clone());
        }
    }
    todo.len() as u32
}

// ------------------------------------------------------------------ the game's own play time

fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    b.get(p..p.checked_add(4)?).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]))
}

/// Play time a TMNF/TMUF profile has counted, in seconds: chunk 0x0308C05F ("PlayTime", GBX.NET; the
/// game sorts local profiles by it) in the LZO-compressed body of `<name>.Profile.Gbx`. Seconds: the
/// owner's profile holds 1,380,263 (383 h for 46,889 started races; milliseconds would be 23 minutes).
/// None for other files, other games' profiles (no such chunk) or damaged files.
pub fn profile_play_time(f: &[u8]) -> Option<u32> {
    if f.get(..3)? != b"GBX" || f.get(3..5)? != [6, 0] || f.get(5..9)? != b"BUCR" {
        return None;
    }
    if !matches!(u32_at(f, 9)?, 0x240B_5000 | 0x0308_C000) {
        return None;
    }
    let mut p = 17usize.checked_add(u32_at(f, 13)? as usize)?;
    p += 4; // node count
    if u32_at(f, p)? != 0 {
        return None; // external references: not a profile
    }
    p += 4;
    let (usz, csz) = (u32_at(f, p)? as usize, u32_at(f, p + 4)? as usize);
    if usz > 16 << 20 {
        return None;
    }
    let body = crate::lzo1x::decompress(f.get(p + 8..p + 8 + csz)?, usz).ok()?;
    // The chunk id, its one int, then the next chunk of the same class (0x0308C060).
    (0..body.len().saturating_sub(11)).find_map(|i| {
        (u32_at(&body, i)? == 0x0308_C05F && u32_at(&body, i + 8)? & 0xFFFF_F000 == 0x0308_C000).then(|| u32_at(&body, i + 4)).flatten()
    })
}

/// Online login a TMNF/TMUF profile is linked to: the first string of header chunk 0x0308C000.
pub fn profile_login(f: &[u8]) -> Option<String> {
    let n = u32_at(f, 17)? as usize;
    if n > 32 {
        return None;
    }
    let mut data = 21 + n * 8;
    for k in 0..n {
        let (id, size) = (u32_at(f, 21 + k * 8)?, (u32_at(f, 25 + k * 8)? & 0x7FFF_FFFF) as usize);
        if id == 0x0308_C000 {
            let len = u32_at(f, data)? as usize;
            let s = f.get(data + 4..data + 4 + len.min(64))?;
            return Some(String::from_utf8_lossy(s).into_owned()).filter(|l| !l.is_empty() && len <= 64);
        }
        data += size;
    }
    None
}

/// Profiles of a Forever copy's data folder (`Profiles\<name>.Profile.Gbx`; the game's own "-e" backups
/// are skipped) with their play time, cached by size and time of the file.
pub fn profile_times(data: &Path) -> Vec<ProfileTime> {
    type Known = (u64, u64, Option<u32>, Option<String>);
    static CACHE: OnceLock<Mutex<BTreeMap<PathBuf, Known>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let Ok(rd) = std::fs::read_dir(data.join("Profiles")) else { return vec![] };
    let mut out = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.len().checked_sub(12).filter(|&n| n > 0 && name[n..].eq_ignore_ascii_case(".Profile.Gbx")).map(|n| name[..n].to_string()) else { continue };
        if stem.contains('.') {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        let (size, mtime) = (md.len(), md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0));
        if size > 16 << 20 {
            continue;
        }
        let path = e.path();
        let known = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&path).filter(|c| c.0 == size && c.1 == mtime).map(|c| (c.2, c.3.clone()));
        let (secs, login) = known.unwrap_or_else(|| {
            let b = std::fs::read(&path).unwrap_or_default();
            let (v, l) = (profile_play_time(&b), profile_login(&b));
            cache.lock().unwrap_or_else(|e| e.into_inner()).insert(path.clone(), (size, mtime, v, l.clone()));
            (v, l)
        });
        if let Some(s) = secs.filter(|s| *s > 0) {
            out.push(ProfileTime { name: stem, seconds: s as u64, login });
        }
    }
    out.sort_by(|a, b| b.seconds.cmp(&a.seconds));
    out
}

/// The games' own campaign maps: author "Nadeo" (TrackMania to ManiaPlanet), or Nadeo's account id in
/// Trackmania (2020).
pub fn is_campaign_author(author: &str) -> bool {
    author.eq_ignore_ascii_case("nadeo") || author == "d2372a08-a8a1-46cb-97fb-23a161d85ad0"
}

/// Lists all map and replay files of the given folders (replays of all families together).
pub fn list_all(folders: &[Folders]) -> Vec<Listed> {
    let mut out = vec![];
    for f in folders {
        for d in f.maps.iter().chain(f.replays.iter()) {
            walk_cached(d, &mut out);
        }
    }
    out
}

/// The background indexer: one shared cache, refreshed incrementally.
pub struct Indexer {
    pub cache: Mutex<HeadCache>,
    pub running: AtomicBool,
    pub progress: Progress,
    loaded: AtomicBool,
}

pub fn indexer() -> &'static Indexer {
    static I: OnceLock<Indexer> = OnceLock::new();
    I.get_or_init(|| Indexer { cache: Mutex::new(HeadCache::default()), running: AtomicBool::new(false), progress: Progress::default(), loaded: AtomicBool::new(false) })
}

impl Indexer {
    /// Loads the cache file once per run.
    pub fn ensure_loaded(&self, dir: &Path) {
        if !self.loaded.swap(true, Ordering::SeqCst) {
            *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = HeadCache::load(dir);
        }
    }

    /// Lists the folders and parses what is new or changed on a background thread (low priority);
    /// does nothing while a run is active. `log` gets timing lines.
    pub fn start(&'static self, folders: Vec<Folders>, dir: PathBuf, delay: std::time::Duration, log: impl Fn(&str, u128) + Send + 'static) -> bool {
        if self.running.swap(true, Ordering::SeqCst) {
            return false;
        }
        let spawned = std::thread::Builder::new().name("stats-index".into()).spawn(move || {
            struct Reset(&'static AtomicBool);
            impl Drop for Reset {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }
            let _reset = Reset(&self.running);
            lower_priority();
            std::thread::sleep(delay);
            self.ensure_loaded(&dir);
            let t0 = std::time::Instant::now();
            let files = list_all(&folders);
            log(&format!("stats: listed {} files (cache holds {})", files.len(), self.cache.lock().map(|c| c.len()).unwrap_or(0)), t0.elapsed().as_millis());
            let t1 = std::time::Instant::now();
            let (parsed, hits) = parse_missing(&self.cache, &files, background_threads(), true, Some(&self.progress), Some(&dir));
            log(&format!("stats: parsed {parsed} new, {hits} cache hits"), t1.elapsed().as_millis());
            let t2 = std::time::Instant::now();
            let filled = fill_authors(&self.cache, &files);
            if filled > 0 {
                log(&format!("stats: map authors read for {filled} maps"), t2.elapsed().as_millis());
            }
            {
                let keep: BTreeSet<&str> = files.iter().map(|f| f.key.as_str()).collect();
                let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
                // An empty listing (folder not reachable right now) must not wipe the cache.
                if !files.is_empty() {
                    c.retain_keys(&keep);
                }
                c.save(&dir);
            }
            self.progress.todo.store(0, Ordering::Relaxed);
            self.running.store(false, Ordering::SeqCst);
        });
        if spawned.is_err() {
            self.running.store(false, Ordering::SeqCst);
        }
        spawned.is_ok()
    }
}

// ------------------------------------------------------------------ report

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapRow {
    pub family: String,
    pub uid: String,
    pub name: String,
    pub env: Option<String>,
    /// Own saved replays of this map.
    pub runs: u32,
    pub best_ms: Option<u32>,
    /// Respawns in the best saved run.
    pub best_respawns: Option<i32>,
    /// Saved runs without a respawn, and the best of them.
    pub clean_runs: u32,
    pub clean_best_ms: Option<u32>,
    /// Unix ms of the best run's file and of the newest file.
    pub best_at: Option<u64>,
    pub last_at: u64,
    /// From Horizon Host events (None = no events for this map).
    pub finishes: Option<u32>,
    pub starts: Option<u32>,
    pub respawns: Option<u32>,
    pub host_best_ms: Option<u32>,
    /// One of the game's own campaign maps (author Nadeo), not a community map.
    pub campaign: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameCard {
    pub family: String,
    /// Play time per game id of the family.
    pub seconds: BTreeMap<String, u64>,
    pub sessions: u32,
    pub last_played: u64,
    pub maps: u32,
    pub runs: u32,
    pub finishes: Option<u32>,
    pub respawns: Option<u32>,
    pub folders: Vec<String>,
    pub host_events: bool,
    /// TMNF/TMUF: the play time the game itself counts in each local profile (seconds, all copies or the
    /// chosen one), their sum, and the part of it from before the launcher counted (sum minus the
    /// launcher's own seconds of this family, never below 0).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<ProfileTime>,
    pub profile_seconds: u64,
    pub before_seconds: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTime {
    pub name: String,
    pub seconds: u64,
    /// Online login of the profile (header chunk 0x0308C000), None for offline profiles.
    #[serde(skip)]
    pub login: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// YYYY-MM-DD (local time is not known here: UTC days).
    pub day: String,
    pub family: String,
    pub seconds: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub games: Vec<GameCard>,
    pub maps: Vec<MapRow>,
    pub days: Vec<Day>,
    /// Replay files read (and how many were someone else's).
    pub files: u32,
    pub foreign: u32,
    /// The same run found in more than one folder (counted once).
    pub duplicates: u32,
    /// Replay files not read yet (the background parse is still running).
    pub pending: u32,
    pub indexing: bool,
    /// Files the running parse has to read, and how many it has read.
    pub new_files: u32,
    pub parsed_files: u32,
    /// Unix ms of the first session the launcher tracked (0 = none).
    pub playtime_since: u64,
    /// Runs and new personal bests per month and game.
    pub timeline: Vec<Month>,
    /// Runs and new bests per day and family, last 371 days.
    pub run_days: Vec<RunDay>,
    /// Every game copy whose folder exists (the page's copy filter), and the one shown (None = all).
    pub copies: Vec<CopyInfo>,
    pub copy: Option<String>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CopyInfo {
    pub id: String,
    pub family: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunDay {
    pub day: String,
    pub family: String,
    pub runs: u32,
    pub pbs: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Month {
    /// YYYY-MM (UTC).
    pub month: String,
    pub family: String,
    pub runs: u32,
    pub pbs: u32,
}

/// One Horizon Host event line (docs/design/host-stats-channel.md).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct HostEvent {
    pub v: u32,
    pub t: u64,
    pub game: String,
    pub ev: String,
    pub uid: String,
    pub name: String,
    pub time_ms: Option<u32>,
    pub respawns: Option<u32>,
    pub local: Option<bool>,
}

/// Reads `<dir>\<game>\*.jsonl` (bad lines are skipped).
pub fn host_events(dir: &Path) -> Vec<HostEvent> {
    let mut out = vec![];
    for g in fsx::list(dir).into_iter().filter(|e| e.is_dir) {
        for f in fsx::list(&g.path).into_iter().filter(|e| e.is_file && e.name.to_lowercase().ends_with(".jsonl")) {
            let Some(text) = fsx::read_string(&f.path) else { continue };
            for line in text.lines() {
                if let Ok(mut e) = serde_json::from_str::<HostEvent>(line) {
                    if e.game.is_empty() {
                        e.game = g.name.clone();
                    }
                    if e.v == 1 && !e.uid.is_empty() {
                        out.push(e);
                    }
                }
            }
        }
    }
    out
}

fn day_of(ms: u64) -> String {
    fsx::iso_from_millis(ms as i64)[..10].to_string()
}

/// "nadeo_A01(00'45''23).Replay.Gbx" -> "A01".
pub fn name_from_file(file: &str, autosave: bool) -> String {
    let mut n = file.to_string();
    for ext in [".replay.gbx", ".gbx"] {
        if n.to_lowercase().ends_with(ext) {
            n.truncate(n.len() - ext.len());
        }
    }
    if autosave {
        if let Some(i) = n.find('_') {
            n = n[i + 1..].to_string();
        }
    }
    if let Some(i) = n.rfind('(') {
        if n.ends_with(')') && n[i..].contains('\'') {
            n.truncate(i);
        }
    }
    n.trim().to_string()
}

/// "Dirt cut track_cheatoskar" -> "Dirt cut track": the game names saved replays "<map>_<driver>",
/// so a name taken from the file keeps the driver's login (also "[TAS]login" from TMInterface).
pub fn strip_driver<'a>(name: &str, logins: impl Iterator<Item = &'a str>) -> String {
    let Some(i) = name.rfind('_').filter(|i| *i > 0) else { return name.to_string() };
    let tail = name[i + 1..].to_lowercase();
    for l in logins {
        if !l.is_empty() && tail.ends_with(&l.to_lowercase()) && tail.len() <= l.len() + 8 {
            return name[..i].trim_end().to_string();
        }
    }
    name.to_string()
}

fn in_downloaded(p: &Path) -> bool {
    p.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("downloaded"))
}

/// The login that saved most of the replays outside "Downloaded" folders, when it is clearly the
/// player (at least 5 files and 30% of the replays that name a login).
fn dominant_login(replays: &[(PathBuf, bool, Head)]) -> Option<String> {
    let mut count: BTreeMap<&str, u32> = BTreeMap::new();
    let mut total = 0u32;
    for (p, _, h) in replays {
        if let Some(l) = h.login.as_deref() {
            total += 1;
            if !in_downloaded(p) {
                *count.entry(l).or_default() += 1;
            }
        }
    }
    let (l, n) = count.into_iter().max_by_key(|(_, n)| *n)?;
    (n >= 5 && n * 10 >= total * 3).then(|| l.to_string())
}

pub struct Input<'a> {
    /// Folders to read (only the chosen copy's when `only` is set).
    pub folders: Vec<Folders>,
    /// All copies (names for the filter, play time without a recorded copy).
    pub copies: Vec<crate::copies::GameCopy>,
    /// Copy id the page is filtered to.
    pub only: Option<String>,
    pub cache_dir: &'a Path,
    pub playtime: crate::playtime::Store,
    pub sessions: Vec<crate::playtime::SessionRec>,
    pub host_dir: Option<PathBuf>,
    pub now_ms: u64,
}

/// Identity of a replay for de-duplication: the same run copied into several folders or installs has
/// the same map uid, finish time, driver (login, else nickname) and respawn count.
pub fn replay_key(h: &Head) -> String {
    format!("{}|{}|{}|{}", h.uid.as_deref().unwrap_or(""), h.time_ms.unwrap_or(0), h.login.as_deref().or(h.nick.as_deref()).unwrap_or(""), h.respawns.unwrap_or(-1))
}

/// Report from the files on disk. Loads the cache file, parses what is new (all at once, on a few
/// threads) and saves it: the synchronous variant used by tests and tools.
pub fn build(i: Input) -> Report {
    let cache = Mutex::new(HeadCache::load(i.cache_dir));
    let files = list_all(&i.folders);
    parse_missing(&cache, &files, default_threads(), false, None, None);
    {
        let keep: BTreeSet<&str> = files.iter().map(|f| f.key.as_str()).collect();
        let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
        c.retain_keys(&keep);
        c.save(i.cache_dir);
    }
    build_from(&i, &cache)
}

/// Report from the cached headers only (files not parsed yet are counted in `pending`).
pub fn build_from(i: &Input, cache: &Mutex<HeadCache>) -> Report {
    let cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    let mut pending = 0u32;
    let mut head = |l: &Listed| -> Option<Head> {
        let h = cache.get(l).cloned();
        if h.is_none() {
            pending += 1;
        }
        h
    };

    let mut report = Report { generated_at: fsx::now_iso(), ..Default::default() };
    let mut maps: BTreeMap<(String, String), MapRow> = BTreeMap::new();
    let mut cards: BTreeMap<String, GameCard> = BTreeMap::new();
    let mut seen_runs: BTreeSet<String> = BTreeSet::new();
    // The player's own TMNF/TMUF logins (for the profiles' play time).
    let mut own_logins: BTreeSet<String> = BTreeSet::new();
    // (family, uid, file time, finish time) of every counted run, for the timeline.
    let mut runs: Vec<(String, String, u64, Option<u32>)> = vec![];
    for f in &i.folders {
        let card = cards.entry(f.family.into()).or_insert_with(|| GameCard { family: f.family.into(), ..Default::default() });
        // Local map names by uid.
        let mut names: BTreeMap<String, String> = BTreeMap::new();
        let mut map_files = vec![];
        for d in &f.maps {
            walk_cached(d, &mut map_files);
        }
        for p in map_files.iter().filter(|p| p.map) {
            if let Some(h) = head(p) {
                if let (Some(u), Some(n)) = (h.uid, h.name) {
                    names.entry(u).or_insert(n);
                }
            }
        }
        let mut files = vec![];
        for d in &f.replays {
            if fsx::is_dir(d) {
                card.folders.push(d.to_string_lossy().into_owned());
            }
            walk_cached(d, &mut files);
        }
        let replays: Vec<(PathBuf, bool, Head)> = files
            .into_iter()
            .filter(|l| !l.map && crate::maps::gbx_kind(&l.path.to_string_lossy()) == Some(crate::maps::GbxKind::Replay))
            .filter_map(|l| {
                let auto = crate::tmxfolder::is_autosave(&l.path);
                head(&l).filter(|h| h.uid.is_some()).map(|h| (l.path, auto, h))
            })
            .collect();
        // Autosaves first: their file names give the best fallback map names.
        let mut replays = replays;
        replays.sort_by_key(|r| !r.1);
        // The player's own logins: the autosaves' (the game writes them for the active profile) and the
        // dominant driver of the other replays (the player's own login when no autosave carries it:
        // the owner of 12,000 replays saved them as "cheatoskar" while the autosaves are from other profiles).
        let mut logins: BTreeSet<String> = replays.iter().filter(|r| r.1).filter_map(|r| r.2.login.clone()).collect();
        if let Some(l) = dominant_login(&replays) {
            logins.insert(l);
        }
        if f.family == "forever" {
            own_logins.extend(logins.iter().cloned());
        }
        // Nicknames of own replays (the old formats carry a nickname but no login).
        let mut nicks: BTreeSet<String> = replays.iter().filter(|r| r.2.login.as_ref().is_some_and(|l| logins.contains(l))).filter_map(|r| r.2.nick.clone()).collect();
        nicks.extend(replays.iter().filter(|r| r.1 && r.2.login.is_none()).filter_map(|r| r.2.nick.clone()));
        for (p, auto, h) in replays {
            // The same run in another folder or install counts once.
            if !seen_runs.insert(replay_key(&h)) {
                report.duplicates += 1;
                continue;
            }
            report.files += 1;
            let own = auto
                || match (&h.login, &h.nick) {
                    (Some(l), _) => logins.contains(l),
                    (None, Some(n)) => nicks.contains(n),
                    // No driver in the header: own unless it lies in a "Downloaded" folder.
                    (None, None) => !in_downloaded(&p),
                };
            if !own {
                report.foreign += 1;
                continue;
            }
            let uid = h.uid.clone().unwrap_or_default();
            let file = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let row = maps.entry((f.family.to_string(), uid.clone())).or_insert_with(|| MapRow { family: f.family.into(), uid: uid.clone(), ..Default::default() });
            if row.name.is_empty() {
                row.name = h.name.clone().or_else(|| names.get(&uid).cloned()).unwrap_or_else(|| {
                    let n = name_from_file(&file, auto);
                    strip_driver(&n, h.login.iter().chain(logins.iter()).map(String::as_str))
                });
            }
            if row.env.is_none() {
                row.env = h.env.clone();
            }
            if h.author.as_deref().is_some_and(is_campaign_author) {
                row.campaign = true;
            }
            row.runs += 1;
            row.last_at = row.last_at.max(h.mtime);
            if h.respawns == Some(0) {
                row.clean_runs += 1;
                if let Some(t) = h.time_ms {
                    if row.clean_best_ms.is_none_or(|b| t < b) {
                        row.clean_best_ms = Some(t);
                    }
                }
            }
            if let Some(t) = h.time_ms {
                if row.best_ms.is_none_or(|b| t < b) {
                    row.best_ms = Some(t);
                    row.best_respawns = h.respawns;
                    row.best_at = Some(h.mtime);
                }
            }
            runs.push((f.family.to_string(), uid, h.mtime, h.time_ms));
            card.runs += 1;
        }
    }
    report.pending = pending;

    // Runs and new personal bests per month (by the replay files' dates).
    runs.sort_by_key(|r| r.2);
    let mut best: BTreeMap<(String, String), u32> = BTreeMap::new();
    let mut months: BTreeMap<(String, String), (u32, u32)> = BTreeMap::new();
    for (fam, uid, at, time) in &runs {
        let m = months.entry((day_of(*at)[..7].to_string(), fam.clone())).or_default();
        m.0 += 1;
        if let Some(t) = time {
            let b = best.entry((fam.clone(), uid.clone())).or_insert(u32::MAX);
            if *t < *b {
                *b = *t;
                m.1 += 1;
            }
        }
    }
    report.timeline = months.into_iter().map(|((month, family), (runs, pbs))| Month { month, family, runs, pbs }).collect();
    // Runs and new bests per day of the last year (calendar on the page).
    let year_ago = i.now_ms.saturating_sub(371 * 86_400_000);
    let mut best: BTreeMap<(String, String), u32> = BTreeMap::new();
    let mut per_day: BTreeMap<(String, String), (u32, u32)> = BTreeMap::new();
    for (fam, uid, at, time) in &runs {
        let pb = time.is_some_and(|t| {
            let b = best.entry((fam.clone(), uid.clone())).or_insert(u32::MAX);
            let new = t < *b;
            if new {
                *b = t;
            }
            new
        });
        if *at >= year_ago {
            let d = per_day.entry((day_of(*at), fam.clone())).or_default();
            d.0 += 1;
            d.1 += u32::from(pb);
        }
    }
    report.run_days = per_day.into_iter().map(|((day, family), (runs, pbs))| RunDay { day, family, runs, pbs }).collect();

    // Horizon Host events.
    if let Some(dir) = &i.host_dir {
        for e in host_events(dir) {
            let Some(fam) = family_of(&e.game) else { continue };
            let card = cards.entry(fam.into()).or_insert_with(|| GameCard { family: fam.into(), ..Default::default() });
            card.host_events = true;
            let row = maps.entry((fam.into(), e.uid.clone())).or_insert_with(|| MapRow { family: fam.into(), uid: e.uid.clone(), ..Default::default() });
            if row.name.is_empty() && !e.name.is_empty() {
                row.name = e.name.clone();
            }
            row.last_at = row.last_at.max(e.t);
            match e.ev.as_str() {
                "start" => *row.starts.get_or_insert(0) += 1,
                "respawn" => *row.respawns.get_or_insert(0) += 1,
                "finish" if e.local != Some(false) => {
                    *row.finishes.get_or_insert(0) += 1;
                    if let Some(t) = e.time_ms.filter(|t| *t > 0) {
                        if row.host_best_ms.is_none_or(|b| t < b) {
                            row.host_best_ms = Some(t);
                        }
                    }
                    *card.finishes.get_or_insert(0) += 1;
                }
                _ => {}
            }
            if e.ev == "respawn" {
                *card.respawns.get_or_insert(0) += 1;
            }
        }
    }

    // Play time: all copies from the totals; one copy from its sessions (the exe's folder, else the
    // copy the key belongs to: instance, or the game's main copy for older sessions).
    let in_copy = |s: &crate::playtime::SessionRec| match &i.only {
        None => true,
        Some(id) => s.copy.as_deref().map(|c| c == id).unwrap_or_else(|| crate::copies::of_key(&i.copies, &s.key).is_some_and(|c| &c.id == id)),
    };
    if i.only.is_none() {
        for (key, e) in &i.playtime.games {
            let Some(fam) = family_of(key) else { continue };
            let card = cards.entry(fam.into()).or_insert_with(|| GameCard { family: fam.into(), ..Default::default() });
            let g = key.split('@').next().unwrap_or(key).to_string();
            *card.seconds.entry(g).or_default() += e.seconds;
            card.sessions += e.sessions;
            card.last_played = card.last_played.max(e.last_played);
        }
    } else {
        for s in i.sessions.iter().filter(|s| in_copy(s)) {
            let Some(fam) = family_of(&s.key) else { continue };
            let card = cards.entry(fam.into()).or_insert_with(|| GameCard { family: fam.into(), ..Default::default() });
            let g = s.key.split('@').next().unwrap_or(&s.key).to_string();
            *card.seconds.entry(g).or_default() += s.seconds;
            card.sessions += 1;
            card.last_played = card.last_played.max(s.end);
        }
    }
    // The game's own play time in the TMNF/TMUF profiles (the chosen copy's, else every Forever copy's).
    let mut seen_dirs = BTreeSet::new();
    let mut profiles: Vec<ProfileTime> = vec![];
    for c in i.copies.iter().filter(|c| c.family == "forever" && i.only.as_ref().is_none_or(|id| id == &c.id)) {
        if seen_dirs.insert(c.data.to_lowercase()) {
            profiles.extend(profile_times(Path::new(&c.data)));
        }
    }
    // Only the player's own profiles count (online login seen in the own replays); without any known
    // login (offline player) all of them.
    if profiles.iter().any(|p| p.login.as_ref().is_some_and(|l| own_logins.contains(l))) {
        profiles.retain(|p| p.login.as_ref().is_some_and(|l| own_logins.contains(l)));
    }
    if !profiles.is_empty() {
        let card = cards.entry("forever".into()).or_insert_with(|| GameCard { family: "forever".into(), ..Default::default() });
        card.profile_seconds = profiles.iter().map(|p| p.seconds).sum();
        card.before_seconds = card.profile_seconds.saturating_sub(card.seconds.values().sum());
        card.profiles = profiles;
    }
    report.playtime_since = i.sessions.iter().filter(|s| in_copy(s)).map(|s| s.start).filter(|s| *s > 1_000_000_000_000).min().unwrap_or(0);
    let since = i.now_ms.saturating_sub(371 * 86_400_000);
    let mut days: BTreeMap<(String, String), u64> = BTreeMap::new();
    for s in i.sessions.iter().filter(|s| s.end >= since && in_copy(s)) {
        let Some(fam) = family_of(&s.key) else { continue };
        *days.entry((day_of(s.end), fam.to_string())).or_default() += s.seconds;
    }
    report.days = days.into_iter().map(|((day, family), seconds)| Day { day, family, seconds }).collect();

    for row in maps.values() {
        if let Some(c) = cards.get_mut(&row.family) {
            c.maps += 1;
        }
    }
    report.maps = maps.into_values().filter(|m| !m.name.is_empty() || m.runs > 0).collect();
    report.maps.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    report.games = cards.into_values().filter(|c| c.runs > 0 || !c.seconds.is_empty() || c.host_events || c.profile_seconds > 0).collect();
    report.copy = i.only.clone();
    report.copies = i
        .copies
        .iter()
        .filter(|c| fsx::is_dir(Path::new(&c.data)) || i.sessions.iter().any(|s| s.copy.as_deref() == Some(c.id.as_str())))
        .map(|c| CopyInfo { id: c.id.clone(), family: c.family.into(), label: c.label.clone(), path: c.data.clone() })
        .collect();
    report
}

// ------------------------------------------------------------------ TMX pages of maps

/// Exchange sites a family's maps can be on, in the order they are asked.
pub fn tmx_sites(family: &str) -> &'static [&'static str] {
    match family {
        "forever" => &["tmnf.exchange", "tmuf.exchange"],
        "tmn-eswc" => &["nations.tm-exchange.com"],
        "tm-sunrise" => &["sunrise.tm-exchange.com"],
        "tm-original" => &["original.tm-exchange.com"],
        // Mania Exchange (ManiaPlanet's TrackMania titles) and Trackmania Exchange (2020): same newer API.
        "maniaplanet" => &["tm.mania.exchange"],
        "tm2020" => &["trackmania.exchange"],
        _ => &[],
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TmxHit {
    pub uid: String,
    /// Exchange host and track id; None when no site knows the map.
    pub site: Option<String>,
    pub track_id: Option<i64>,
    /// Unix ms of the lookup (unknown maps are asked again after a week).
    pub at: u64,
}

const TMX_UNKNOWN_AGAIN_MS: u64 = 7 * 86_400_000;

/// Track id of a map uid on its exchange: `get` answers a TMX API URL (the network in the app, a fake in tests).
pub fn tmx_lookup(family: &str, uid: &str, now: u64, get: &dyn Fn(&str) -> Result<serde_json::Value, String>) -> Result<TmxHit, String> {
    let mut answered = false;
    for host in tmx_sites(family) {
        // The old exchanges answer /api/tracks with TrackId, Mania Exchange and Trackmania Exchange /api/maps with MapId.
        let (path, field) = if host.ends_with("tm-exchange.com") || host.ends_with("tmnf.exchange") || host.ends_with("tmuf.exchange") { ("tracks", "TrackId") } else { ("maps", "MapId") };
        let Ok(v) = get(&format!("https://{host}/api/{path}?uid={uid}&fields={field}")) else { continue };
        answered = true;
        if let Some(id) = v.get("Results").and_then(|r| r.as_array()).and_then(|r| r.first()).and_then(|t| t.get(field)).and_then(|i| i.as_i64()) {
            return Ok(TmxHit { uid: uid.into(), site: Some((*host).into()), track_id: Some(id), at: now });
        }
    }
    if answered {
        Ok(TmxHit { uid: uid.into(), site: None, track_id: None, at: now })
    } else {
        Err("TMX did not answer".into())
    }
}

pub mod cmd {
    use super::*;
    use crate::state::AppState;
    use tauri::{AppHandle, Manager};

    fn input<'a>(st: &'a AppState, only: Option<String>) -> Input<'a> {
        let copies = crate::copies::all(st);
        let mut folders = folders_of(&copies);
        let only = only.filter(|id| copies.iter().any(|c| &c.id == id));
        if let Some(id) = &only {
            folders.retain(|f| &f.copy == id);
        }
        Input {
            folders,
            copies,
            only,
            cache_dir: &st.cache_dir,
            playtime: crate::playtime::load(&st.data_dir),
            sessions: crate::playtime::load_sessions(&st.data_dir),
            host_dir: Some(st.data_dir.join("host-stats")),
            now_ms: crate::tmxupload::now_ms(),
        }
    }

    fn start(app: &AppHandle, delay: std::time::Duration) {
        let st = app.state::<AppState>();
        let app = app.clone();
        let inp = input(&st, None);
        indexer().start(inp.folders, st.cache_dir.clone(), delay, move |what, ms| crate::perf::log(&app.state::<AppState>(), what, ms));
    }

    /// Launcher start: refreshes the header cache in the background, low priority, a few seconds
    /// after start so neither the window nor a game start waits for it.
    pub fn start_background(app: &AppHandle) {
        // Not before the player opened Statistics once: the first run reads every replay (18,000 files
        // on the owner's PC) and has no business slowing down a launcher that is only used to play.
        if !cache_file(&app.state::<AppState>().cache_dir).is_file() {
            return;
        }
        start(app, std::time::Duration::from_secs(20));
    }

    /// The picture of a map from its own .Gbx (a local map file with this uid that the header cache
    /// knows): data: URL, upside down as TrackMania stores it. None for campaign maps (inside the
    /// game's packs) and maps only known from replays: the page then asks TMX (`stats_tmx`).
    #[tauri::command]
    pub async fn stats_map_thumb(app: AppHandle, uid: String) -> Option<String> {
        tauri::async_runtime::spawn_blocking(move || {
            let st = app.state::<AppState>();
            let idx = indexer();
            idx.ensure_loaded(&st.cache_dir);
            let path = {
                let c = idx.cache.lock().unwrap_or_else(|e| e.into_inner());
                c.files.iter().find(|(_, h)| h.map && h.uid.as_deref() == Some(uid.as_str())).map(|(k, _)| k.clone())
            }?;
            let p = PathBuf::from(path);
            if fsx::blocked(&p) {
                return None;
            }
            let bytes = fsx::read_bytes_prefix(&p, 1 << 20)?;
            gbx::parse(&bytes).ok()?.thumbnail
        })
        .await
        .ok()
        .flatten()
    }

    /// TMX pages of a few maps (the page's "most played" list and the map table's visible rows): from
    /// `<cache>/stats-tmx.json` (also "not on TMX", asked again after a week), else one API request per
    /// map and site through the TMX gate, at most 12 maps per call.
    #[tauri::command]
    pub async fn stats_tmx(app: AppHandle, family: String, uids: Vec<String>) -> Result<Vec<TmxHit>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let st = app.state::<AppState>();
            let file = st.cache_dir.join("stats-tmx.json");
            let mut known: BTreeMap<String, TmxHit> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let now = crate::tmxupload::now_ms();
            let mut out = vec![];
            let mut changed = false;
            let valid = |u: &str| !u.is_empty() && u.len() <= 40 && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            for uid in uids.iter().filter(|u| valid(u)).take(12) {
                let key = format!("{family}|{uid}");
                if let Some(h) = known.get(&key).filter(|h| h.track_id.is_some() || h.at + TMX_UNKNOWN_AGAIN_MS > now) {
                    out.push(h.clone());
                    continue;
                }
                if tmx_sites(&family).is_empty() {
                    continue;
                }
                // Through the launcher's TMX gate (one request per second, shared with the in-game TMX browser).
                if let Ok(h) = tmx_lookup(&family, uid, now, &|u| crate::clientbridge::Tmx::get_json(crate::clientbridge::shared_tmx(), u)) {
                    known.insert(key, h.clone());
                    changed = true;
                    out.push(h);
                }
            }
            if changed {
                let _ = fsx::write(&file, &serde_json::to_vec(&known).unwrap_or_default());
            }
            Ok(out)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// The report from the cached headers right away; with `refresh` (default) a refresh runs in the
    /// background (when none is running) and the page asks again (refresh false) while `indexing` is set.
    #[tauri::command]
    pub async fn stats_report(app: AppHandle, refresh: Option<bool>, full: Option<bool>, copy: Option<String>) -> Result<Report, String> {
        if full.unwrap_or(false) {
            forget_listings();
        }
        tauri::async_runtime::spawn_blocking(move || {
            let idx = indexer();
            {
                let st = app.state::<AppState>();
                idx.ensure_loaded(&st.cache_dir);
            }
            // A refresh run starts when the page opens or is reloaded, not on its follow-up polls.
            if refresh.unwrap_or(true) {
                start(&app, std::time::Duration::ZERO);
            }
            let st = app.state::<AppState>();
            let t0 = std::time::Instant::now();
            let mut r = build_from(&input(&st, copy.filter(|c| !c.is_empty())), &idx.cache);
            let ms = t0.elapsed().as_millis();
            r.indexing = idx.running.load(Ordering::SeqCst);
            r.new_files = idx.progress.todo.load(Ordering::Relaxed);
            r.parsed_files = idx.progress.done.load(Ordering::Relaxed);
            crate::perf::log(&st, &format!("stats: report from cache ({} replays, {} pending)", r.files, r.pending), ms);
            r
        })
        .await
        .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gbx::tests::replay_sample_run;

    fn put(p: &Path, b: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b).unwrap();
    }

    /// Timing on a sandbox (STATS_BENCH_DIR = a Documents folder with TrackMania\Tracks\Replays):
    /// `cargo test --lib stats::tests::bench_sandbox -- --ignored --nocapture`. Old way: full listing on
    /// every visit, half the cores parsing; new way: remembered listing, 1-2 background threads.
    #[test]
    #[ignore]
    fn bench_sandbox() {
        let Some(docs) = std::env::var_os("STATS_BENCH_DIR").map(PathBuf::from) else { return };
        let f = folders(Some(&docs), &|_| None);
        let ms = |t: std::time::Instant| t.elapsed().as_millis();
        for round in 0..2 {
            // old: walk everything, parse on default_threads()
            let t = std::time::Instant::now();
            let mut old = vec![];
            for x in &f {
                for d in x.maps.iter().chain(x.replays.iter()) {
                    walk(d, 0, &mut old);
                }
            }
            let list_old = ms(t);
            let c = Mutex::new(HeadCache::default());
            let t = std::time::Instant::now();
            parse_missing(&c, &old, default_threads(), true, None, None);
            let parse_old = ms(t);
            // new: remembered listing (first call lists, second call checks folder times), background threads
            forget_listings();
            let t = std::time::Instant::now();
            let first = list_all(&f);
            let list_new_first = ms(t);
            let t = std::time::Instant::now();
            let again = list_all(&f);
            let list_new_again = ms(t);
            let c2 = Mutex::new(HeadCache::default());
            let t = std::time::Instant::now();
            parse_missing(&c2, &first, background_threads(), true, None, None);
            let parse_new = ms(t);
            println!(
                "round {round}: files {} | old: list {list_old} ms, parse {parse_old} ms on {} threads | new: list {list_new_first} ms, list again {list_new_again} ms ({} files), parse {parse_new} ms on {} threads",
                old.len(),
                default_threads(),
                again.len(),
                background_threads()
            );
        }
    }

    #[test]
    fn tmx_lookup_tries_both_forever_sites() {
        let calls = std::cell::RefCell::new(vec![]);
        let get = |u: &str| -> Result<serde_json::Value, String> {
            calls.borrow_mut().push(u.to_string());
            if u.contains("tmuf.exchange") { Ok(serde_json::json!({"Results": [{"TrackId": 77}]})) } else { Ok(serde_json::json!({"Results": []})) }
        };
        let h = tmx_lookup("forever", "abc", 5, &get).unwrap();
        assert_eq!((h.site.as_deref(), h.track_id), (Some("tmuf.exchange"), Some(77)));
        assert_eq!(calls.borrow().len(), 2);
        let none = tmx_lookup("tmn-eswc", "abc", 5, &|_| Ok(serde_json::json!({"Results": []}))).unwrap();
        assert_eq!(none.track_id, None);
        assert!(tmx_lookup("forever", "abc", 5, &|_| Err("offline".into())).is_err());
    }

    #[test]
    fn tmx_lookup_of_maniaplanet_maps_uses_mania_exchange() {
        let calls = std::cell::RefCell::new(vec![]);
        let get = |u: &str| -> Result<serde_json::Value, String> {
            calls.borrow_mut().push(u.to_string());
            Ok(serde_json::json!({"Results": [{"MapId": 42084}]}))
        };
        let h = tmx_lookup("maniaplanet", "f1cOLRy8AGBdReGaRhSRiL59IY2", 5, &get).unwrap();
        assert_eq!((h.site.as_deref(), h.track_id), (Some("tm.mania.exchange"), Some(42084)));
        assert_eq!(calls.borrow()[0], "https://tm.mania.exchange/api/maps?uid=f1cOLRy8AGBdReGaRhSRiL59IY2&fields=MapId");
        assert!(tmx_sites("tmn-eswc").iter().all(|h| h.ends_with("tm-exchange.com")));
    }

    /// A profile file as the game writes it: header, one header chunk, LZO body with chunks 0x05E..0x060.
    fn profile_file(play_time: u32) -> Vec<u8> {
        let mut body = vec![];
        for (id, data) in [(0x0308_C05Eu32, vec![0u8; 8]), (0x0308_C05F, play_time.to_le_bytes().to_vec()), (0x0308_C060, vec![1, 0, 0, 0])] {
            body.extend(id.to_le_bytes());
            body.extend(data);
        }
        body.extend(0xFACA_DE01u32.to_le_bytes());
        let c = crate::syscfg::lzo_literal(&body);
        let mut f = b"GBX\x06\x00BUCR".to_vec();
        f.extend(0x240B_5000u32.to_le_bytes());
        let user = [1u32.to_le_bytes(), 0x0308_C000u32.to_le_bytes(), 4u32.to_le_bytes(), 0u32.to_le_bytes()].concat();
        f.extend((user.len() as u32).to_le_bytes());
        f.extend(user);
        f.extend(3u32.to_le_bytes()); // nodes
        f.extend(0u32.to_le_bytes()); // external refs
        f.extend((body.len() as u32).to_le_bytes());
        f.extend((c.len() as u32).to_le_bytes());
        f.extend(c);
        f
    }

    #[test]
    fn profile_play_time_from_the_game_profile() {
        assert_eq!(profile_play_time(&profile_file(1_380_263)), Some(1_380_263));
        assert_eq!(profile_play_time(b"GBX\x06\x00BUCRxxxx"), None);
        let dir = std::env::temp_dir().join(format!("tmh-prof-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Profiles")).unwrap();
        std::fs::write(dir.join("Profiles").join("osaro.Profile.Gbx"), profile_file(3600)).unwrap();
        std::fs::write(dir.join("Profiles").join("osaro.Profile-e.Gbx"), profile_file(99)).unwrap();
        std::fs::write(dir.join("Profiles").join("Gast.Profile.Gbx"), profile_file(0)).unwrap();
        assert_eq!(profile_times(&dir), vec![ProfileTime { name: "osaro".into(), seconds: 3600, login: None }]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real profiles of this PC (read only): `TMH_PROFILES=<Documents\TrackMania> cargo test real_profiles -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_profiles() {
        let dir = PathBuf::from(std::env::var("TMH_PROFILES").expect("TMH_PROFILES"));
        for p in profile_times(&dir) {
            println!("{} ({:?}): {} s = {:.1} h", p.name, p.login, p.seconds, p.seconds as f64 / 3600.0);
        }
    }

    #[test]
    fn campaign_authors() {
        assert!(is_campaign_author("Nadeo") && is_campaign_author("nadeo") && is_campaign_author("d2372a08-a8a1-46cb-97fb-23a161d85ad0"));
        assert!(!is_campaign_author("Nadeo Category Extensions") && !is_campaign_author("") && !is_campaign_author("U_D"));
    }

    #[test]
    fn cached_listing_sees_new_files() {
        let d = tempfile::tempdir().unwrap();
        put(&d.path().join("a.Replay.Gbx"), b"x");
        let mut first = vec![];
        walk_cached(d.path(), &mut first);
        assert_eq!(first.len(), 1);
        std::thread::sleep(std::time::Duration::from_millis(30));
        put(&d.path().join("sub").join("b.Replay.Gbx"), b"y");
        let mut second = vec![];
        walk_cached(d.path(), &mut second);
        assert_eq!(second.len(), 2);
        // Autosaves rewritten in place are seen without a directory change.
        std::thread::sleep(std::time::Duration::from_millis(30)); // coarse directory timestamps on Linux
        put(&d.path().join("Autosaves").join("me_A01.Replay.Gbx"), b"1");
        let mut third = vec![];
        walk_cached(d.path(), &mut third);
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(d.path().join("Autosaves").join("me_A01.Replay.Gbx"), b"12345").unwrap();
        let mut fourth = vec![];
        walk_cached(d.path(), &mut fourth);
        assert_eq!(fourth.iter().find(|f| f.path.ends_with("me_A01.Replay.Gbx")).map(|f| f.size), Some(5));
    }

    #[test]
    fn driver_suffix_is_stripped() {
        let l = ["cheatoskar".to_string()];
        assert_eq!(strip_driver("Dirt cut track_cheatoskar", l.iter().map(String::as_str)), "Dirt cut track");
        assert_eq!(strip_driver("Mini Hunt #27_[TAS]cheatoskar", l.iter().map(String::as_str)), "Mini Hunt #27");
        assert_eq!(strip_driver("Ice_Track", l.iter().map(String::as_str)), "Ice_Track");
        assert_eq!(strip_driver("_cheatoskar", l.iter().map(String::as_str)), "_cheatoskar");
        assert_eq!(strip_driver("Strecke ä_Cheatoskar", l.iter().map(String::as_str)), "Strecke ä");
    }

    #[test]
    fn names_from_files() {
        assert_eq!(name_from_file("Player_A01-Race.Replay.Gbx", true), "A01-Race");
        assert_eq!(name_from_file("A07(00'45''23).Replay.Gbx", false), "A07");
        assert_eq!(name_from_file("my run.Replay.gbx", false), "my run");
    }

    #[test]
    fn family_mapping() {
        assert_eq!(family_of("tmuf@copy"), Some("forever"));
        assert_eq!(family_of("tm2-canyon"), Some("maniaplanet"));
        assert_eq!(family_of("tm-sunrise"), Some("tm-sunrise"));
        assert_eq!(family_of("tm-turbo"), None);
    }

    #[test]
    fn report_from_replays_playtime_and_host_events() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let r = docs.path().join("TrackMania").join("Tracks").join("Replays");
        // Own autosave (PB 45.23 s) and two more own runs, one foreign replay (TMX ghost).
        put(&r.join("Autosaves").join("me_A01-Race.Replay.Gbx"), &replay_sample_run("me", "Me", "Stadium", "uidA01", 45230));
        put(&r.join("A01(00'47''00).Replay.Gbx"), &replay_sample_run("me", "Me", "Stadium", "uidA01", 47000));
        put(&r.join("Bay run.Replay.Gbx"), &replay_sample_run("me", "Me", "Bay", "uidBay", 61000));
        put(&r.join("Downloaded").join("wr.Replay.Gbx"), &replay_sample_run("someone", "WR guy", "Stadium", "uidA01", 40000));
        put(&r.join("notes.txt"), b"x");
        let mut pt = crate::playtime::Store::default();
        pt.games.insert("tmnf".into(), crate::playtime::Entry { seconds: 3600, sessions: 2, last_played: 5 });
        pt.games.insert("tmuf@copy".into(), crate::playtime::Entry { seconds: 600, sessions: 1, last_played: 9 });
        let now = 1_800_000_000_000u64;
        let sessions = vec![
            crate::playtime::SessionRec { key: "tmnf".into(), start: now - 4_000_000, end: now - 3_000_000, seconds: 1000, copy: None },
            crate::playtime::SessionRec { key: "tmnf".into(), start: 1, end: 2, seconds: 99, copy: None }, // older than 30 days
        ];
        let host = data.path().join("host-stats");
        put(
            &host.join("tmn-eswc").join("2026-11.jsonl"),
            b"{\"v\":1,\"t\":10,\"ev\":\"map\",\"uid\":\"eA\",\"name\":\"ESWC A\"}\n{\"v\":1,\"t\":11,\"ev\":\"start\",\"uid\":\"eA\"}\n{\"v\":1,\"t\":12,\"ev\":\"respawn\",\"uid\":\"eA\",\"respawns\":1}\n{\"v\":1,\"t\":13,\"ev\":\"finish\",\"uid\":\"eA\",\"time_ms\":30120,\"respawns\":1,\"local\":true}\nnot json\n{\"v\":1,\"t\":14,\"ev\":\"start\",\"uid\":\"eA\"}\n",
        );
        let cdir = cache.path().to_path_buf();
        let input = || Input {
            folders: folders(Some(docs.path()), &|_| None),
            copies: vec![],
            only: None,
            cache_dir: &cdir,
            playtime: pt.clone(),
            sessions: sessions.clone(),
            host_dir: Some(host.clone()),
            now_ms: now,
        };
        let rep = build(input());
        assert_eq!(rep.files, 4);
        assert_eq!(rep.foreign, 1);
        let a01 = rep.maps.iter().find(|m| m.uid == "uidA01").unwrap();
        assert_eq!(a01.runs, 2);
        assert_eq!(a01.best_ms, Some(45230), "the TMX ghost is not mine");
        assert_eq!(a01.name, "A01-Race");
        assert_eq!(a01.best_respawns, Some(0));
        let bay = rep.maps.iter().find(|m| m.uid == "uidBay").unwrap();
        assert_eq!((bay.name.as_str(), bay.env.as_deref()), ("Bay run", Some("Bay")));
        let fv = rep.games.iter().find(|g| g.family == "forever").unwrap();
        assert_eq!(fv.seconds["tmnf"], 3600);
        assert_eq!(fv.seconds["tmuf"], 600);
        assert_eq!(fv.sessions, 3);
        assert_eq!((fv.maps, fv.runs), (2, 3));
        let eswc = rep.maps.iter().find(|m| m.uid == "eA").unwrap();
        assert_eq!((eswc.finishes, eswc.starts, eswc.respawns, eswc.host_best_ms), (Some(1), Some(2), Some(1), Some(30120)));
        assert_eq!(eswc.name, "ESWC A");
        assert!(rep.games.iter().any(|g| g.family == "tmn-eswc" && g.host_events && g.finishes == Some(1)));
        assert_eq!(rep.days.len(), 1);
        assert_eq!(rep.days[0].seconds, 1000);
        // Second run: from the cache, same result.
        assert!(cache_file(cache.path()).is_file());
        let again = build(input());
        assert_eq!(again.maps, rep.maps);
    }

    #[test]
    fn own_replays_without_a_matching_autosave_are_found_by_the_dominant_login() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let r = docs.path().join("TrackMania").join("Tracks").join("Replays");
        // The autosave belongs to another profile; the player saved seven replays as "me".
        put(&r.join("Autosaves").join("kunde_X.Replay.Gbx"), &replay_sample_run("kunde", "Kunde", "Stadium", "uidX", 50000));
        for i in 0..7u32 {
            put(&r.join(format!("run{i}.Replay.Gbx")), &replay_sample_run("me", "Me", "Stadium", &format!("uid{i}"), 40000 + i));
        }
        put(&r.join("Downloaded").join("wr.Replay.Gbx"), &replay_sample_run("wr", "WR", "Stadium", "uid0", 30000));
        let rep = build(Input { folders: folders(Some(docs.path()), &|_| None), copies: vec![], only: None, cache_dir: cache.path(), playtime: Default::default(), sessions: vec![], host_dir: None, now_ms: 1_800_000_000_000 });
        assert_eq!(rep.foreign, 1, "only the downloaded record is someone else's");
        assert_eq!(rep.games[0].runs, 8);
    }

    // ---- cache behaviour

    fn listed(dir: &Path) -> Vec<Listed> {
        forget_listings();
        list_all(&[Folders { family: "forever", replays: vec![dir.to_path_buf()], maps: vec![], copy: String::new() }])
    }

    #[test]
    fn cache_hit_miss_invalidation_and_deleted_files() {
        let d = tempfile::tempdir().unwrap();
        let cd = tempfile::tempdir().unwrap();
        let a = d.path().join("a.Replay.Gbx");
        let b = d.path().join("b.Replay.Gbx");
        put(&a, &replay_sample_run("me", "Me", "Stadium", "uidA", 40000));
        put(&b, &replay_sample_run("me", "Me", "Stadium", "uidB", 50000));
        let cache = Mutex::new(HeadCache::default());
        // First pass: everything is a miss.
        let (parsed, hits) = parse_missing(&cache, &listed(d.path()), 2, false, None, None);
        assert_eq!((parsed, hits), (2, 0));
        // Second pass: everything is a hit, nothing is read.
        let (parsed, hits) = parse_missing(&cache, &listed(d.path()), 2, false, None, None);
        assert_eq!((parsed, hits), (0, 2));
        // A changed file (new size) is parsed again, the other stays a hit.
        std::thread::sleep(std::time::Duration::from_millis(30)); // same size: only the time differs
        put(&a, &replay_sample_run("me", "Me", "Stadium", "uidA", 39000));
        let l = listed(d.path());
        let (parsed, hits) = parse_missing(&cache, &l, 2, false, None, None);
        assert_eq!((parsed, hits), (1, 1));
        let ha = cache.lock().unwrap().get(l.iter().find(|f| f.path == a).unwrap()).cloned().unwrap();
        assert_eq!(ha.time_ms, Some(39000));
        // Same size, newer time: also invalidated.
        let mut l2 = listed(d.path());
        l2.iter_mut().for_each(|f| f.mtime += 5);
        assert_eq!(parse_missing(&cache, &l2, 2, false, None, None), (2, 0));
        // A deleted file is dropped by retain_keys and by a save/load round trip.
        std::fs::remove_file(&b).unwrap();
        let l3 = listed(d.path());
        {
            let keep: BTreeSet<&str> = l3.iter().map(|f| f.key.as_str()).collect();
            let mut c = cache.lock().unwrap();
            c.retain_keys(&keep);
            assert_eq!(c.len(), 1);
            c.save(cd.path());
        }
        assert_eq!(HeadCache::load(cd.path()).len(), 1);
    }

    #[test]
    fn corrupted_or_foreign_cache_files_are_ignored() {
        let cd = tempfile::tempdir().unwrap();
        let f = cache_file(cd.path());
        // Garbage.
        std::fs::write(&f, b"{ not json, just garbage").unwrap();
        assert!(HeadCache::load(cd.path()).is_empty());
        assert!(f.with_extension("bad").is_file(), "the damaged file is set aside");
        // Truncated valid file.
        let mut c = HeadCache::default();
        c.insert("k".into(), Head { size: 1, ..Default::default() });
        c.save(cd.path());
        let full = std::fs::read(&f).unwrap();
        std::fs::write(&f, &full[..full.len() / 2]).unwrap();
        assert!(HeadCache::load(cd.path()).is_empty());
        // Another version.
        std::fs::write(&f, br#"{"version":99,"files":{"k":{"size":1}}}"#).unwrap();
        assert!(HeadCache::load(cd.path()).is_empty());
        // Right version loads.
        std::fs::write(&f, format!(r#"{{"version":{CACHE_VERSION},"files":{{"k":{{"size":1}}}}}}"#)).unwrap();
        assert_eq!(HeadCache::load(cd.path()).len(), 1);
        // Missing file.
        assert!(HeadCache::load(&cd.path().join("nope")).is_empty());
    }

    #[test]
    fn same_replay_in_two_folders_counts_once_and_unread_files_are_pending() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let r = docs.path().join("TrackMania").join("Tracks").join("Replays");
        put(&r.join("Autosaves").join("me_A01.Replay.Gbx"), &replay_sample_run("me", "Me", "Stadium", "uidA01", 45230));
        put(&r.join("copy").join("A01 copy.Replay.Gbx"), &replay_sample_run("me", "Me", "Stadium", "uidA01", 45230));
        fn input<'a>(docs: &Path, c: &'a Path) -> Input<'a> {
            Input { folders: folders(Some(docs), &|_| None), copies: vec![], only: None, cache_dir: c, playtime: Default::default(), sessions: vec![], host_dir: None, now_ms: 1_800_000_000_000 }
        }
        let rep = build(input(docs.path(), cache.path()));
        assert_eq!((rep.files, rep.duplicates), (1, 1));
        assert_eq!(rep.games[0].runs, 1);
        // From an empty cache without parsing: nothing known yet, everything pending.
        let empty = Mutex::new(HeadCache::default());
        let rep = build_from(&input(docs.path(), cache.path()), &empty);
        assert_eq!((rep.files, rep.pending), (0, 2));
    }

    /// Timing on a real or synthetic folder (not run by default):
    /// `STATS_BENCH_DIR=<replay folder> STATS_BENCH_THREADS=1 cargo test --lib bench_folder -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_folder() {
        let dir = PathBuf::from(std::env::var("STATS_BENCH_DIR").expect("STATS_BENCH_DIR"));
        let threads: usize = std::env::var("STATS_BENCH_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or_else(default_threads);
        let cd = tempfile::tempdir().unwrap();
        let t = std::time::Instant::now();
        let files = listed(&dir);
        println!("listed {} files in {} ms", files.len(), t.elapsed().as_millis());
        let cache = Mutex::new(HeadCache::default());
        let t = std::time::Instant::now();
        let (parsed, hits) = parse_missing(&cache, &files, threads, false, None, None);
        println!("cold parse ({threads} threads): {parsed} parsed, {hits} hits in {} ms", t.elapsed().as_millis());
        let t = std::time::Instant::now();
        cache.lock().unwrap().save(cd.path());
        println!("cache saved in {} ms ({} bytes)", t.elapsed().as_millis(), std::fs::metadata(cache_file(cd.path())).map(|m| m.len()).unwrap_or(0));
        let t = std::time::Instant::now();
        let c2 = Mutex::new(HeadCache::load(cd.path()));
        println!("cache loaded in {} ms", t.elapsed().as_millis());
        let t = std::time::Instant::now();
        let files = listed(&dir);
        let (parsed, hits) = parse_missing(&c2, &files, threads, false, None, None);
        println!("warm refresh: list+check {parsed} parsed, {hits} hits in {} ms", t.elapsed().as_millis());
        let mut logins: BTreeMap<String, u32> = BTreeMap::new();
        for h in c2.lock().unwrap().files.values() {
            *logins.entry(format!("{:?}/{:?}", h.login, h.nick)).or_default() += 1;
        }
        let mut v: Vec<_> = logins.into_iter().collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1));
        for (k, n) in v.iter().take(12) {
            println!("  {n:6}  {k}");
        }
    }

    #[test]
    fn replays_of_every_copy_with_a_filter_per_copy() {
        let docs = tempfile::tempdir().unwrap();
        let games = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let main = games.path().join("ESWC");
        let next = games.path().join("ESWC-next");
        for d in [&main, &next] {
            std::fs::create_dir_all(d.join("GameData").join("Tracks").join("Replays")).unwrap();
        }
        let r = |d: &Path| d.join("GameData").join("Tracks").join("Replays");
        put(&r(&main).join("Autosaves").join("me_B02.Replay.Gbx"), &replay_sample_run("me", "Me", "Stadium", "uidB02", 50000));
        // The extra copy: one own run on another map, and the same B02 run copied over (counted once).
        put(&r(&next).join("Autosaves").join("me_B03.Replay.Gbx"), &replay_sample_run("me", "Me", "Stadium", "uidB03", 61000));
        put(&r(&next).join("copy of B02.Replay.Gbx"), &replay_sample_run("me", "Me", "Stadium", "uidB02", 50000));
        let list = vec![
            crate::copies::Install { game: "tmn-eswc".into(), dir: main.clone(), label: "ESWC".into(), instance: None, user_dir: None, selected: true },
            crate::copies::Install { game: "tmn-eswc".into(), dir: next.clone(), label: "ESWC-next".into(), instance: None, user_dir: None, selected: false },
        ];
        let copies = crate::copies::build(Some(docs.path()), &list, &|_| None);
        let next_id = copies.iter().find(|c| c.label == "ESWC-next").unwrap().id.clone();
        let main_id = copies.iter().find(|c| c.label == "ESWC").unwrap().id.clone();
        let now = 1_800_000_000_000u64;
        let sessions = vec![
            crate::playtime::SessionRec { key: "tmn-eswc".into(), start: now - 9_000_000, end: now - 8_000_000, seconds: 600, copy: Some(next_id.clone()) },
            // From before 0.5.1 (no copy): the main copy.
            crate::playtime::SessionRec { key: "tmn-eswc".into(), start: now - 7_000_000, end: now - 6_000_000, seconds: 300, copy: None },
        ];
        let mut pt = crate::playtime::Store::default();
        pt.games.insert("tmn-eswc".into(), crate::playtime::Entry { seconds: 900, sessions: 2, last_played: now });
        let input = |only: Option<String>| {
            let mut f = folders_of(&copies);
            if let Some(id) = &only {
                f.retain(|x| &x.copy == id);
            }
            Input { folders: f, copies: copies.clone(), only, cache_dir: cache.path(), playtime: pt.clone(), sessions: sessions.clone(), host_dir: None, now_ms: now }
        };
        forget_listings();
        let all = build(input(None));
        assert_eq!((all.files, all.duplicates), (2, 1), "both copies read, the copied run once");
        let eswc = all.games.iter().find(|g| g.family == "tmn-eswc").unwrap();
        assert_eq!((eswc.runs, eswc.maps, eswc.seconds["tmn-eswc"]), (2, 2, 900));
        assert!(all.copies.iter().any(|c| c.id == next_id) && all.copies.iter().any(|c| c.id == main_id));
        let only_next = build(input(Some(next_id.clone())));
        assert_eq!(only_next.copy.as_deref(), Some(next_id.as_str()));
        let g = only_next.games.iter().find(|g| g.family == "tmn-eswc").unwrap();
        assert_eq!((g.runs, g.seconds["tmn-eswc"], g.sessions), (2, 600, 1), "both runs of the next copy, its own play time");
        let only_main = build(input(Some(main_id)));
        let g = only_main.games.iter().find(|g| g.family == "tmn-eswc").unwrap();
        assert_eq!((g.runs, g.seconds["tmn-eswc"]), (1, 300), "old sessions without a copy belong to the main copy");
    }

    #[test]
    fn clean_runs_are_counted() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let r = docs.path().join("TrackMania").join("Tracks").join("Replays");
        put(&r.join("Autosaves").join("me_A01.Replay.Gbx"), &replay_sample_run("me", "Me", "Stadium", "uidA01", 45000));
        let rep = build(Input { folders: folders(Some(docs.path()), &|_| None), copies: vec![], only: None, cache_dir: cache.path(), playtime: Default::default(), sessions: vec![], host_dir: None, now_ms: 1_800_000_000_000 });
        let a = rep.maps.iter().find(|m| m.uid == "uidA01").unwrap();
        assert_eq!((a.clean_runs, a.clean_best_ms), (1, Some(45000)), "the sample run has 0 respawns");
    }
}
