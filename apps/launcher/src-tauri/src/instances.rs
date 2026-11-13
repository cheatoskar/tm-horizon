//! Separate installations ("instances") for a profile, like Modrinth's instances.
//!
//! An instance is a folder of its own under `<app data>/instances/<id>`, built from the original
//! game folder:
//! - big read-only files (packs, exe, dll, music) become NTFS hard links to the original's files,
//!   so the instance costs almost no disk space;
//! - small files and files a game or mod writes (ini, txt, cfg, logs, ESWC's profiles and tracks)
//!   are real copies;
//! - the instance's Nadeo.ini points the game at a user folder of its own (Forever:
//!   `UserSubDir=TrackMania_<id>`, ManiaPlanet: `UserDir={userdocs}\ManiaPlanet_<id>`).
//!
//! Copy-on-write: a hard link is the same file under a second name, so writing into it in place
//! would change the original game too. Everything that writes into an instance calls
//! [`break_link`] first, which swaps the link for a real copy inside the instance. `fsx::write`
//! (temp file + rename) never writes through a link either; `break_link` keeps writers that open
//! files in place safe as well.
//!
//! When hard links are not possible (game on another drive, FAT/exFAT, network share) the
//! instance is a full copy; [`check`] says so with the size before anything is written.
//! Deleting an instance only removes its folder inside the instances root; removing a hard link
//! never touches the original file.
//!
//! See docs/design/instances.md for the Nadeo.ini and TMLoader findings.

use crate::launch::{self, Family};
use crate::{fsx, scan::InstallInfo};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Files smaller than this are always copied (configs, profiles, small GameData files).
const SMALL: u64 = 64 * 1024;
/// File types a game or mod may write in place.
const COPY_EXT: [&str; 14] = ["ini", "cfg", "txt", "log", "xml", "json", "yaml", "yml", "cache", "dat", "sav", "bak", "tmp", "sffs"];
/// ESWC keeps its user data in the game folder: these folders are always real copies.
const ESWC_USER_DIRS: [&str; 5] = ["gamedata/profiles", "gamedata/tracks", "gamedata/scores", "gamedata/cache", "gamedata/races"];
const MAX_FILES: usize = 200_000;
const ROOT_NAME: &str = "instances";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub name: String,
    /// Game id of the original (tmnf, tmuf, tmn-eswc, tm2-stadium, ...).
    pub game: String,
    /// The folder it was built from.
    pub source: String,
    /// The instances root it lives in.
    pub root: String,
    pub path: String,
    /// Exe and (ESWC) Nadeo launcher, relative to `path`.
    pub exe: Option<String>,
    pub launcher: Option<String>,
    /// What the instance's Nadeo.ini sets as user folder (None: the game keeps its data in the
    /// game folder, as ESWC does, or the original had no Nadeo.ini).
    pub user_dir: Option<String>,
    /// Built with hard links (false = full copy).
    pub linked: bool,
    pub created: String,
    /// Forever: TMLoader profile whose mods this instance starts with (through its own TMLoader
    /// copy, instancetml.rs). None = the instance's exe without TMLoader.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tml_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub game: String,
    pub source: String,
    pub root: String,
    pub files: u64,
    /// Size of the original folder.
    pub bytes: u64,
    /// Hard links work between the game folder and the instances root.
    pub can_link: bool,
    /// Bytes the new folder takes on disk (copies only when linking, everything otherwise).
    pub need_bytes: u64,
    /// Why links are not possible: "other-drive", "no-links" or "unreadable".
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub files: u64,
    /// Bytes only this instance holds (copies, mod files).
    pub real_bytes: u64,
    /// Bytes shared with the original (or another instance) through hard links.
    pub linked_bytes: u64,
    pub linked_files: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub instance: Instance,
    pub warnings: Vec<String>,
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static L: Mutex<()> = Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

// ------------------------------------------------------------------ games

/// Which games can have an instance, and the Nadeo.ini key that moves their user data.
pub fn supported(game: &str) -> Result<Family, String> {
    match launch::family(game) {
        Some(f @ (Family::Forever | Family::Eswc | Family::ManiaPlanet)) => Ok(f),
        Some(Family::Tm2020) => Err("Not available for Trackmania (2020): Ubisoft Connect, Steam or Epic start it from their own folder.".into()),
        Some(_) => Err("Not available for this game yet.".into()),
        None => Err(format!("Unknown game {game}")),
    }
}

/// (section, key, value) the instance's Nadeo.ini gets, verified against the installed games'
/// Nadeo.ini files (see docs/design/instances.md).
pub fn user_dir_setting(family: Family, id: &str) -> Option<(&'static str, &'static str, String)> {
    match family {
        Family::Forever => Some(("TmForever", "UserSubDir", format!("TrackMania_{id}"))),
        Family::ManiaPlanet => Some(("ManiaPlanet", "UserDir", format!("{{userdocs}}\\ManiaPlanet_{id}"))),
        _ => None,
    }
}

/// Sets `key=value` in `[section]` of an ini text (case-insensitive), keeping every other line and
/// the line endings. A missing key goes after the section's last entry, a missing section at the end.
pub fn set_ini_key(text: &str, section: &str, key: &str, value: &str) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    let is_header = |l: &str| l.trim_start().starts_with('[');
    let header_of = |l: &str| l.trim().trim_start_matches('[').split(']').next().unwrap_or("").trim().to_string();
    let key_of = |l: &str| l.split_once('=').map(|(k, _)| k.trim().to_string());
    let start = lines.iter().position(|l| is_header(l) && header_of(l).eq_ignore_ascii_case(section));
    let new_line = format!("{key}={value}");
    match start {
        Some(s) => {
            let end = lines[s + 1..].iter().position(|l| is_header(l)).map(|e| s + 1 + e).unwrap_or(lines.len());
            if let Some(i) = (s + 1..end).find(|&i| key_of(&lines[i]).is_some_and(|k| k.eq_ignore_ascii_case(key)) && !lines[i].trim_start().starts_with(';')) {
                lines[i] = new_line;
            } else {
                let last = (s + 1..end).rev().find(|&i| !lines[i].trim().is_empty()).unwrap_or(s);
                lines.insert(last + 1, new_line);
            }
        }
        None => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(format!("[{section}]"));
            lines.push(new_line);
        }
    }
    let mut out = lines.join(eol);
    out.push_str(eol);
    out
}

// ------------------------------------------------------------------ links, file ids

/// (volume, file id, link count) of a file or folder, without following links.
#[cfg(windows)]
pub fn file_id(p: &Path) -> Option<(u64, u64, u32)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
    // Access 0: attributes only, no read or write access to the file's data.
    let f = std::fs::OpenOptions::new().access_mode(0).custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(p).ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) } == 0 {
        return None;
    }
    Some((info.dwVolumeSerialNumber as u64, ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64, info.nNumberOfLinks))
}

#[cfg(unix)]
pub fn file_id(p: &Path) -> Option<(u64, u64, u32)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(p).ok()?;
    Some((m.dev(), m.ino(), m.nlink() as u32))
}

pub fn link_count(p: &Path) -> u32 {
    file_id(p).map(|(_, _, n)| n).unwrap_or(1)
}

/// Copy-on-write: when `p` is a file with more than one name (a hard link into the original game
/// or another instance), it is replaced by a real copy, so a following write changes only this
/// name. The other names keep their content. true = a link was broken. Missing files and plain
/// files are left alone.
pub fn break_link(p: &Path) -> Result<bool, String> {
    fsx::check(p)?;
    let Ok(m) = std::fs::symlink_metadata(p) else { return Ok(false) };
    if !m.is_file() || link_count(p) <= 1 {
        return Ok(false);
    }
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = p.with_file_name(format!(".{name}.{}.tmhub-cow", std::process::id()));
    std::fs::copy(p, &tmp).map_err(|e| format!("{}: {e}", p.display()))?;
    // Rename replaces the name `p` only; the file behind the other names is not opened for writing.
    if let Err(e) = std::fs::rename(&tmp, p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {e}", p.display()));
    }
    Ok(true)
}

/// Can files under `source` be hard-linked into `root`? (same volume, file system with links).
/// Creates `root` and a short-lived probe file in it (never anything in `source`).
pub fn can_link(source: &Path, root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    // Reason codes; the UI words them ("inst.why.*").
    let (Some((vs, _, _)), Some((vr, _, _))) = (file_id(source), file_id(root)) else { return Err("unreadable".into()) };
    if vs != vr {
        return Err("other-drive".into());
    }
    let a = root.join(format!(".probe-{}", std::process::id()));
    let b = root.join(format!(".probe-{}-link", std::process::id()));
    let _ = std::fs::remove_file(&b);
    std::fs::write(&a, b"probe").map_err(|e| e.to_string())?;
    let r = std::fs::hard_link(&a, &b);
    let _ = std::fs::remove_file(&b);
    let _ = std::fs::remove_file(&a);
    r.map_err(|_| "no-links".to_string())
}

// ------------------------------------------------------------------ tree

struct Item {
    rel: String,
    src: PathBuf,
    size: u64,
    dir: bool,
}

fn walk(dir: &Path, rel: &str, out: &mut Vec<Item>) -> Result<(), String> {
    // fsx::list leaves out dinput8.dll and the protected ESWC folder. Symbolic links and junctions
    // are neither files nor folders there and are not followed.
    for e in fsx::list(dir) {
        if out.len() > MAX_FILES {
            return Err("The game folder has too many files".into());
        }
        let r = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
        if e.is_dir {
            out.push(Item { rel: r.clone(), src: e.path.clone(), size: 0, dir: true });
            walk(&e.path, &r, out)?;
        } else if e.is_file {
            let size = std::fs::symlink_metadata(&e.path).map(|m| m.len()).unwrap_or(0);
            out.push(Item { rel: r, src: e.path, size, dir: false });
        }
    }
    Ok(())
}

/// Copied even when links are possible: small files, files games write, ESWC's user folders.
pub fn must_copy(rel: &str, size: u64, family: Family) -> bool {
    let l = rel.to_lowercase().replace('\\', "/");
    let ext = l.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    size < SMALL || COPY_EXT.contains(&ext) || (family == Family::Eswc && ESWC_USER_DIRS.iter().any(|d| l.starts_with(&format!("{d}/"))))
}

fn sizes(items: &[Item], family: Family) -> (u64, u64, u64) {
    let files = items.iter().filter(|i| !i.dir).count() as u64;
    let bytes = items.iter().map(|i| i.size).sum();
    let copy = items.iter().filter(|i| !i.dir && must_copy(&i.rel, i.size, family)).map(|i| i.size).sum();
    (files, bytes, copy)
}

fn build(items: &[Item], dest: &Path, link: bool, family: Family) -> Result<bool, String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut all_linked = link;
    for i in items {
        let to = dest.join(i.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        fsx::check(&to)?;
        if i.dir {
            std::fs::create_dir_all(&to).map_err(|e| format!("{}: {e}", to.display()))?;
            continue;
        }
        if link && !must_copy(&i.rel, i.size, family) && std::fs::hard_link(&i.src, &to).is_ok() {
            continue;
        }
        if link && !must_copy(&i.rel, i.size, family) {
            all_linked = false;
        }
        fsx::copy(&i.src, &to)?;
    }
    Ok(all_linked)
}

// ------------------------------------------------------------------ registry

pub fn registry_file(data: &Path) -> PathBuf {
    data.join("instances.json")
}

pub fn list(data: &Path) -> Vec<Instance> {
    std::fs::read_to_string(registry_file(data)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub(crate) fn save(data: &Path, l: &[Instance]) -> Result<(), String> {
    fsx::write(&registry_file(data), serde_json::to_string_pretty(l).map_err(|e| e.to_string())?.as_bytes())
}

pub fn get(data: &Path, id: &str) -> Result<Instance, String> {
    valid_id(id)?;
    list(data).into_iter().find(|i| i.id == id).ok_or_else(|| "Separate installation not found".to_string())
}

pub fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 48 || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') || id.starts_with('-') {
        Err(format!("Invalid id: {id}"))
    } else {
        Ok(())
    }
}

fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 || n.chars().any(char::is_control) {
        return Err("Use a name of 1 to 40 characters".into());
    }
    Ok(n.to_string())
}

fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
    }
    let s: String = s.trim_end_matches('-').chars().take(24).collect();
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "instance".into()
    } else {
        s
    }
}

fn new_id(name: &str, taken: &[Instance], root: &Path) -> String {
    let base = slug(name);
    let mut id = base.clone();
    let mut n = 2;
    while taken.iter().any(|i| i.id == id) || root.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

/// Where instances of a game in `source` go. Windows: `<app data>/instances`. Linux: inside the
/// game's Wine/Proton prefix when it has one (`<prefix>/drive_c/TM Horizon instances`), so the
/// links stay on the same file system and the instance uses the same prefix; otherwise the app
/// data folder.
pub fn root_for(data: &Path, source: &Path) -> PathBuf {
    #[cfg(not(windows))]
    if let Some(prefix) = crate::platform::wine::prefix_of(source) {
        return prefix.join("drive_c").join("TM Horizon instances");
    }
    let _ = source;
    data.join(ROOT_NAME)
}

/// The instances roots TM Horizon may delete in.
fn allowed_root(data: &Path, root: &Path) -> Result<(), String> {
    if fsx::norm(root) == fsx::norm(&data.join(ROOT_NAME)) {
        return Ok(());
    }
    #[cfg(not(windows))]
    if root.file_name().is_some_and(|n| n == "TM Horizon instances") && root.parent().and_then(|d| d.file_name()).is_some_and(|n| n.eq_ignore_ascii_case("drive_c")) {
        return Ok(());
    }
    Err(format!("{} is not an instances folder", root.display()))
}

/// `path` is a real folder directly inside `root` (no junction or link leads elsewhere).
fn directly_inside(path: &Path, root: &Path) -> Result<(), String> {
    let lex_ok = path.parent().is_some_and(|p| fsx::norm(p) == fsx::norm(root)) && fsx::norm(path) != fsx::norm(root);
    let real_ok = match (fsx::resolve(path), fsx::resolve(root)) {
        (Some(p), Some(r)) => fsx::is_inside(&p, &r) && fsx::norm(&p) != fsx::norm(&r),
        _ => false,
    };
    let plain_dir = std::fs::symlink_metadata(path).map(|m| m.is_dir() && !m.file_type().is_symlink()).unwrap_or(false);
    if lex_ok && real_ok && plain_dir {
        Ok(())
    } else {
        Err(format!("refusing to touch {}", path.display()))
    }
}

// ------------------------------------------------------------------ operations

/// What creating an instance of `source` would take. Writes only the probe in the root.
pub fn check(data: &Path, game: &str, source: &Path) -> Result<Check, String> {
    let family = supported(game)?;
    fsx::check(source)?;
    if !fsx::is_dir(source) {
        return Err(format!("Folder not found: {}", source.display()));
    }
    let root = root_for(data, source);
    if fsx::is_inside(&root, source) {
        return Err("TM Horizon's data folder is inside the game folder".into());
    }
    let mut items = Vec::new();
    walk(source, "", &mut items)?;
    let (files, bytes, copy) = sizes(&items, family);
    let link = can_link(source, &root);
    Ok(Check {
        game: game.into(),
        source: source.to_string_lossy().into(),
        root: root.to_string_lossy().into(),
        files,
        bytes,
        can_link: link.is_ok(),
        need_bytes: if link.is_ok() { copy } else { bytes },
        note: link.err(),
    })
}

pub struct NewInstance<'a> {
    pub name: &'a str,
    pub game: &'a str,
    pub source: &'a Path,
    /// Exe and launcher as found by the scan (absolute, inside `source`).
    pub exe: Option<&'a str>,
    pub launcher: Option<&'a str>,
    /// Full copy is fine when links are not possible (the user saw the size).
    pub allow_copy: bool,
    /// Never link (tests; also a later "independent copy" option).
    pub force_copy: bool,
}

fn rel_in(base: &Path, file: Option<&str>) -> Option<String> {
    let f = Path::new(file?);
    let r = f.strip_prefix(base).ok().map(|r| r.to_string_lossy().into_owned()).or_else(|| f.file_name().map(|n| n.to_string_lossy().into_owned()))?;
    (!r.is_empty()).then_some(r)
}

/// Builds a new instance from `n.source` (the original game or, for Duplicate, another instance).
pub fn create(data: &Path, n: &NewInstance) -> Result<Created, String> {
    let family = supported(n.game)?;
    let name = clean_name(n.name)?;
    fsx::check(n.source)?;
    if !fsx::is_dir(n.source) {
        return Err(format!("Folder not found: {}", n.source.display()));
    }
    let root = root_for(data, n.source);
    if fsx::is_inside(&root, n.source) {
        return Err("TM Horizon's data folder is inside the game folder".into());
    }
    let link = if n.force_copy { Err("copy".to_string()) } else { can_link(n.source, &root) };
    if link.is_err() && !n.allow_copy {
        return Err(format!("needs-copy: {}", link.err().unwrap_or_default()));
    }
    let mut items = Vec::new();
    walk(n.source, "", &mut items)?;
    let _g = lock();
    let mut all = list(data);
    let id = new_id(&name, &all, &root);
    let dest = root.join(&id);
    let mut warnings = Vec::new();
    let linked = match build(&items, &dest, link.is_ok(), family) {
        Ok(l) => l,
        Err(e) => {
            // Half-built folder: only ever removed inside our own root.
            if directly_inside(&dest, &root).is_ok() {
                let _ = std::fs::remove_dir_all(&dest);
            }
            return Err(e);
        }
    };
    if link.is_ok() && !linked {
        warnings.push("Some files could not be linked and were copied.".into());
    }
    // Own user folder through the instance's Nadeo.ini.
    let mut user_dir = None;
    if let Some((section, key, value)) = user_dir_setting(family, &id) {
        let ini = dest.join("Nadeo.ini");
        match fsx::read_string(&ini) {
            Some(text) => {
                break_link(&ini)?;
                fsx::write(&ini, set_ini_key(&text, section, key, &value).as_bytes())?;
                user_dir = Some(value);
            }
            None => warnings.push("The game has no Nadeo.ini: this installation shares the user folder with the original.".into()),
        }
    }
    let mut exe = rel_in(n.source, n.exe);
    let launcher = rel_in(n.source, n.launcher);
    // TMLoader's "integration" swaps the game's TmForever.exe for its ShimRun (which starts
    // TMLoader with the default profile, i.e. the original folder) and keeps the game as
    // TmForever.bak.exe (name from TMLoader.exe's strings; not tried here).
    if family == Family::Forever {
        if let Some(e) = exe.clone().filter(|e| e.to_lowercase().ends_with(".exe")) {
            let bak = format!("{}.bak.exe", &e[..e.len() - 4]);
            if dest.join(&bak).is_file() {
                warnings.push(format!("TMLoader integration found: this installation starts {bak}."));
                exe = Some(bak);
            }
        }
    }
    let inst = Instance {
        id,
        name,
        game: n.game.into(),
        source: n.source.to_string_lossy().into(),
        root: root.to_string_lossy().into(),
        path: dest.to_string_lossy().into(),
        exe,
        launcher,
        user_dir,
        linked: link.is_ok(),
        created: fsx::now_iso(),
        tml_profile: None,
    };
    all.push(inst.clone());
    save(data, &all)?;
    Ok(Created { instance: inst, warnings })
}

/// A new instance built from an existing one (its mod files included). User data in Documents is
/// not copied: the copy starts with a fresh user folder.
pub fn duplicate(data: &Path, id: &str, name: &str, allow_copy: bool) -> Result<Created, String> {
    let src = get(data, id)?;
    let p = PathBuf::from(&src.path);
    let exe = src.exe.as_ref().map(|e| p.join(e).to_string_lossy().into_owned());
    let launcher = src.launcher.as_ref().map(|e| p.join(e).to_string_lossy().into_owned());
    let mut c = create(data, &NewInstance { name, game: &src.game, source: &p, exe: exe.as_deref(), launcher: launcher.as_deref(), allow_copy, force_copy: false })?;
    // Keep pointing at the original game, not at the instance it was copied from.
    let _g = lock();
    let mut all = list(data);
    if let Some(i) = all.iter_mut().find(|i| i.id == c.instance.id) {
        i.source = src.source.clone();
        c.instance = i.clone();
    }
    save(data, &all)?;
    Ok(c)
}

/// Removes an instance folder (only inside an instances root) and its registry entry. The user
/// folder in Documents stays.
pub fn delete(data: &Path, id: &str) -> Result<(), String> {
    valid_id(id)?;
    let _g = lock();
    let mut all = list(data);
    let pos = all.iter().position(|i| i.id == id).ok_or("Separate installation not found")?;
    let inst = all[pos].clone();
    let root = PathBuf::from(&inst.root);
    let path = PathBuf::from(&inst.path);
    allowed_root(data, &root)?;
    if fsx::norm(&path) != fsx::norm(&root.join(&inst.id)) {
        return Err(format!("refusing to touch {}", path.display()));
    }
    if std::fs::symlink_metadata(&path).is_ok() {
        directly_inside(&path, &root)?;
        // Renaming first fails while the game still runs from the folder, before anything is gone.
        let trash = root.join(format!(".deleting-{id}-{}", std::process::id()));
        std::fs::rename(&path, &trash).map_err(|e| format!("Close the game first ({e})"))?;
        std::fs::remove_dir_all(&trash).map_err(|e| format!("{}: {e}", trash.display()))?;
    }
    all.remove(pos);
    save(data, &all)
}

/// Real and linked bytes of a folder. A file with more than one name counts as linked; each file
/// is counted once.
pub fn usage(path: &Path) -> Usage {
    fn go(dir: &Path, u: &mut Usage, seen: &mut std::collections::HashSet<(u64, u64)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let p = e.path();
            if ft.is_dir() {
                go(&p, u, seen);
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            let (key, links) = match file_id(&p) {
                Some((v, i, n)) => (Some((v, i)), n),
                None => (None, 1),
            };
            if let Some(k) = key {
                if !seen.insert(k) {
                    continue;
                }
            }
            u.files += 1;
            if links > 1 {
                u.linked_bytes += size;
                u.linked_files += 1;
            } else {
                u.real_bytes += size;
            }
        }
    }
    let mut u = Usage::default();
    go(path, &mut u, &mut Default::default());
    u
}

/// Install data for starting an instance: its own folder and exe, no store URL.
pub fn install_info(i: &Instance) -> InstallInfo {
    let p = Path::new(&i.path);
    InstallInfo {
        source: "Instance".into(),
        path: i.path.clone(),
        exe: i.exe.as_ref().map(|e| p.join(e).to_string_lossy().into_owned()),
        launcher: i.launcher.as_ref().map(|e| p.join(e).to_string_lossy().into_owned()),
        launch: None,
        modified: None,
        note: None,
        steam_app_id: None,
        rom: None,
        extra_args: vec![],
    }
}

/// `game` or `game@instance` (install targets of catalog mods).
pub fn split_target(target: &str) -> (&str, Option<&str>) {
    match target.split_once('@') {
        Some((g, i)) => (g, Some(i)),
        None => (target, None),
    }
}

// ------------------------------------------------------------------ Tauri commands

use crate::state::AppState;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    #[serde(flatten)]
    pub instance: Instance,
    pub exists: bool,
}

#[tauri::command(async)]
pub fn instance_list(st: State<AppState>) -> Vec<InstanceView> {
    list(&st.data_dir).into_iter().map(|i| InstanceView { exists: Path::new(&i.path).is_dir(), instance: i }).collect()
}

fn source_of(st: &AppState, game: &str) -> Result<InstallInfo, String> {
    supported(game)?;
    st.install(game).ok_or_else(|| "Game not found".to_string())
}

/// Sets (or clears) the TMLoader profile a Forever instance starts with.
#[tauri::command(async)]
pub fn instance_set_tml_profile(st: State<AppState>, id: String, profile: Option<String>) -> Result<Instance, String> {
    valid_id(&id)?;
    let profile = profile.filter(|p| !p.trim().is_empty());
    if let Some(p) = &profile {
        if !crate::instancetml::valid_profile(p) {
            return Err(format!("Invalid TMLoader profile name: {p}"));
        }
    }
    let mut all = list(&st.data_dir);
    let i = all.iter_mut().find(|i| i.id == id).ok_or("Separate installation not found")?;
    if profile.is_some() && supported(&i.game)? != Family::Forever {
        return Err("TMLoader profiles are for Nations and United Forever".into());
    }
    i.tml_profile = profile;
    let out = i.clone();
    save(&st.data_dir, &all)?;
    Ok(out)
}

#[tauri::command(async)]
pub fn instance_check(st: State<AppState>, game: String) -> Result<Check, String> {
    let i = source_of(&st, &game)?;
    check(&st.data_dir, &game, Path::new(&i.path))
}

#[tauri::command(async)]
pub fn instance_create(st: State<AppState>, name: String, game: String, allow_copy: bool) -> Result<Created, String> {
    let i = source_of(&st, &game)?;
    create(
        &st.data_dir,
        &NewInstance { name: &name, game: &game, source: Path::new(&i.path), exe: i.exe.as_deref(), launcher: i.launcher.as_deref(), allow_copy, force_copy: false },
    )
}

#[tauri::command(async)]
pub fn instance_duplicate(st: State<AppState>, id: String, name: String, allow_copy: bool) -> Result<Created, String> {
    duplicate(&st.data_dir, &id, &name, allow_copy)
}

#[tauri::command(async)]
pub fn instance_delete(st: State<AppState>, id: String) -> Result<(), String> {
    delete(&st.data_dir, &id)
}

#[tauri::command(async)]
pub fn instance_usage(st: State<AppState>, id: String) -> Result<Usage, String> {
    let i = get(&st.data_dir, &id)?;
    Ok(usage(Path::new(&i.path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake Forever install: big pack (linked), exe, Nadeo.ini, small GameData file.
    fn fake_game(base: &Path) -> PathBuf {
        let g = base.join("TmUnitedForever");
        std::fs::create_dir_all(g.join("GameData").join("Skins")).unwrap();
        std::fs::create_dir_all(g.join("Packs")).unwrap();
        std::fs::write(g.join("TmForever.exe"), vec![b'M'; 200 * 1024]).unwrap();
        std::fs::write(g.join("Packs").join("Stadium.pak"), vec![7u8; 300 * 1024]).unwrap();
        std::fs::write(g.join("GameData").join("Skins").join("small.dds"), b"tiny").unwrap();
        std::fs::write(g.join("Nadeo.ini"), "; WARNING\r\n\r\n[TmForever]\r\nVersion=2.11.26\r\nUserSubDir=TrackMania\r\nDistro=ASPUR\r\n").unwrap();
        g
    }

    fn new<'a>(name: &'a str, src: &'a Path, exe: &'a str) -> NewInstance<'a> {
        NewInstance { name, game: "tmuf", source: src, exe: Some(exe), launcher: None, allow_copy: false, force_copy: false }
    }

    #[test]
    fn ini_keys() {
        let t = "[TmForever]\r\nVersion=2.11.26\r\nUserSubDir=TrackMania\r\nDistro=ASPUR\r\n";
        let o = set_ini_key(t, "TmForever", "UserSubDir", "TrackMania_a");
        assert_eq!(o, "[TmForever]\r\nVersion=2.11.26\r\nUserSubDir=TrackMania_a\r\nDistro=ASPUR\r\n");
        // TMNF has no UserSubDir line: added to its section.
        let o = set_ini_key("; c\n[TmForever]\nVersion=2.11.26\nDistro=APIJU\n\n[Other]\nx=1\n", "tmforever", "UserSubDir", "TrackMania_b");
        assert_eq!(o, "; c\n[TmForever]\nVersion=2.11.26\nDistro=APIJU\nUserSubDir=TrackMania_b\n\n[Other]\nx=1\n");
        let mp = "[ManiaPlanet]\nWindowTitle=ManiaPlanet\nUserDir={userdocs}\\ManiaPlanet\nCommonDir={commondata}\\ManiaPlanet\n";
        let o = set_ini_key(mp, "ManiaPlanet", "UserDir", "{userdocs}\\ManiaPlanet_x");
        assert!(o.contains("UserDir={userdocs}\\ManiaPlanet_x\n") && o.contains("CommonDir={commondata}\\ManiaPlanet\n"));
        assert_eq!(set_ini_key("", "S", "k", "v"), "[S]\nk=v\n");
    }

    #[test]
    fn games_and_ids() {
        assert!(supported("tmnf").is_ok() && supported("tmn-eswc").is_ok() && supported("tm2-canyon").is_ok());
        assert!(supported("tm2020").is_err() && supported("tm-sunrise").is_err());
        assert_eq!(slug("My Race / Setup!"), "my-race-setup");
        assert_eq!(slug("..."), "instance");
        assert!(valid_id("my-race-2").is_ok() && valid_id("../x").is_err() && valid_id("A").is_err());
        assert_eq!(split_target("tmuf@speed"), ("tmuf", Some("speed")));
        assert_eq!(split_target("tmuf"), ("tmuf", None));
        assert!(must_copy("Nadeo.ini", 1 << 20, Family::Forever));
        assert!(!must_copy("Packs/Stadium.pak", 1 << 20, Family::Forever));
        assert!(must_copy("GameData/Profiles/x.Gbx", 1 << 20, Family::Eswc));
        assert!(!must_copy("GameData/Profiles/x.Gbx", 1 << 20, Family::Forever));
    }

    #[test]
    fn create_links_break_link_usage_and_delete() {
        let t = tempfile::tempdir().unwrap();
        let game = fake_game(t.path());
        let data = t.path().join("data");
        let exe = game.join("TmForever.exe").to_string_lossy().into_owned();
        let c = check(&data, "tmuf", &game).unwrap();
        assert_eq!(c.files, 4);
        assert!(c.can_link, "temp folders are on one drive: {:?}", c.note);
        assert!(c.need_bytes < 1024, "only the small files are copied");

        let made = create(&data, &new("Speed Setup", &game, &exe)).unwrap();
        let i = made.instance;
        assert_eq!(i.id, "speed-setup");
        assert_eq!(i.exe.as_deref(), Some("TmForever.exe"));
        assert!(i.linked);
        let ip = PathBuf::from(&i.path);
        assert!(fsx::is_inside(&ip, &data.join("instances")));
        // Big files are links to the original, small ones copies.
        let pak = ip.join("Packs").join("Stadium.pak");
        assert_eq!(link_count(&pak), 2);
        assert_eq!(file_id(&pak).unwrap().1, file_id(&game.join("Packs").join("Stadium.pak")).unwrap().1);
        assert_eq!(link_count(&ip.join("GameData").join("Skins").join("small.dds")), 1);
        // Own user folder; the original's Nadeo.ini is unchanged.
        let ini = std::fs::read_to_string(ip.join("Nadeo.ini")).unwrap();
        assert!(ini.contains("UserSubDir=TrackMania_speed-setup\r\n"), "{ini}");
        assert!(std::fs::read_to_string(game.join("Nadeo.ini")).unwrap().contains("UserSubDir=TrackMania\r\n"));
        assert_eq!(i.user_dir.as_deref(), Some("TrackMania_speed-setup"));

        let u = usage(&ip);
        assert_eq!(u.files, 4);
        assert_eq!(u.linked_files, 2);
        assert_eq!(u.linked_bytes, 500 * 1024);
        assert!(u.real_bytes < 1024);

        // Copy-on-write: a mod writes into the instance; the original keeps its bytes.
        assert!(break_link(&pak).unwrap());
        assert_eq!(link_count(&pak), 1);
        std::fs::write(&pak, b"modded pack").unwrap();
        assert_eq!(std::fs::read(game.join("Packs").join("Stadium.pak")).unwrap(), vec![7u8; 300 * 1024]);
        assert_eq!(link_count(&game.join("Packs").join("Stadium.pak")), 1);
        assert!(!break_link(&pak).unwrap(), "already a real file");
        assert!(!break_link(&ip.join("missing.txt")).unwrap());
        // fsx::write (temp file + rename) does not write through a link either.
        let exe_i = ip.join("TmForever.exe");
        assert_eq!(link_count(&exe_i), 2);
        fsx::write(&exe_i, b"patched").unwrap();
        assert_eq!(std::fs::read(game.join("TmForever.exe")).unwrap().len(), 200 * 1024);
        let u2 = usage(&ip);
        assert_eq!(u2.linked_files, 0);
        assert_eq!(list(&data).len(), 1);

        // Delete: the instance folder goes, the original stays complete.
        delete(&data, &i.id).unwrap();
        assert!(!ip.exists());
        assert!(list(&data).is_empty());
        assert_eq!(std::fs::read(game.join("Packs").join("Stadium.pak")).unwrap().len(), 300 * 1024);
        assert_eq!(std::fs::read(game.join("TmForever.exe")).unwrap().len(), 200 * 1024);
        assert!(game.join("Nadeo.ini").is_file());
        assert!(delete(&data, &i.id).is_err(), "unknown id");
    }

    #[test]
    fn delete_stays_inside_the_root() {
        let t = tempfile::tempdir().unwrap();
        let game = fake_game(t.path());
        let data = t.path().join("data");
        let exe = game.join("TmForever.exe").to_string_lossy().into_owned();
        let i = create(&data, &new("A", &game, &exe)).unwrap().instance;
        // A tampered registry pointing at the game folder is refused, nothing is removed.
        let mut l = list(&data);
        l[0].path = game.to_string_lossy().into();
        save(&data, &l).unwrap();
        assert!(delete(&data, &i.id).is_err());
        assert!(game.join("TmForever.exe").is_file());
        // Same with a foreign root.
        let mut l = list(&data);
        l[0].root = t.path().to_string_lossy().into();
        l[0].path = game.to_string_lossy().into();
        l[0].id = "tmunitedforever".into();
        save(&data, &l).unwrap();
        assert!(delete(&data, "tmunitedforever").is_err());
        assert!(game.join("Packs").join("Stadium.pak").is_file());
        assert!(delete(&data, "../x").is_err());
    }

    #[test]
    fn copy_fallback_and_duplicate() {
        let t = tempfile::tempdir().unwrap();
        let game = fake_game(t.path());
        let data = t.path().join("data");
        let exe = game.join("TmForever.exe").to_string_lossy().into_owned();
        // Links refused (as on another drive): without allow_copy nothing is created.
        let mut n = new("Copy", &game, &exe);
        n.force_copy = true;
        let e = create(&data, &n).unwrap_err();
        assert!(e.starts_with("needs-copy"), "{e}");
        assert!(list(&data).is_empty());
        n.allow_copy = true;
        let i = create(&data, &n).unwrap().instance;
        assert!(!i.linked);
        let ip = PathBuf::from(&i.path);
        assert_eq!(link_count(&ip.join("Packs").join("Stadium.pak")), 1);
        let u = usage(&ip);
        assert_eq!(u.linked_files, 0);
        assert_eq!(u.real_bytes, 500 * 1024 + 4 + std::fs::metadata(ip.join("Nadeo.ini")).unwrap().len());

        // Duplicate a linked instance: links again, own Nadeo.ini, source stays the original.
        let a = create(&data, &new("Base", &game, &exe)).unwrap().instance;
        std::fs::write(PathBuf::from(&a.path).join("GameData").join("mod.txt"), b"mod").unwrap();
        let b = duplicate(&data, &a.id, "Base", false).unwrap().instance;
        assert_eq!(b.id, "base-2");
        assert_eq!(b.source, game.to_string_lossy());
        let bp = PathBuf::from(&b.path);
        assert_eq!(std::fs::read(bp.join("GameData").join("mod.txt")).unwrap(), b"mod");
        assert_eq!(link_count(&bp.join("Packs").join("Stadium.pak")), 3);
        assert!(std::fs::read_to_string(bp.join("Nadeo.ini")).unwrap().contains("UserSubDir=TrackMania_base-2"));
        assert!(std::fs::read_to_string(PathBuf::from(&a.path).join("Nadeo.ini")).unwrap().contains("UserSubDir=TrackMania_base\r\n"));
        assert_eq!(list(&data).len(), 3);
    }

    #[test]
    fn eswc_user_folders_are_copies_and_starforce_is_refused() {
        let t = tempfile::tempdir().unwrap();
        let g = t.path().join("TMN-ESWC");
        std::fs::create_dir_all(g.join("GameData").join("Profiles")).unwrap();
        std::fs::write(g.join("TmNationsESWC.exe"), vec![1u8; 100 * 1024]).unwrap();
        std::fs::write(g.join("GameData").join("Profiles").join("p.Gbx"), vec![2u8; 100 * 1024]).unwrap();
        std::fs::write(g.join("Nadeo.ini"), "[TmNationsESWC]\r\nVersion=0.1.7.9\r\n").unwrap();
        let data = t.path().join("data");
        let exe = g.join("TmNationsESWC.exe").to_string_lossy().into_owned();
        let n = NewInstance { name: "E", game: "tmn-eswc", source: &g, exe: Some(&exe), launcher: None, allow_copy: false, force_copy: false };
        let i = create(&data, &n).unwrap().instance;
        let ip = PathBuf::from(&i.path);
        assert_eq!(link_count(&ip.join("TmNationsESWC.exe")), 2);
        assert_eq!(link_count(&ip.join("GameData").join("Profiles").join("p.Gbx")), 1);
        assert_eq!(i.user_dir, None, "ESWC keeps its data in the (copied) game folder");
        assert_eq!(std::fs::read_to_string(ip.join("Nadeo.ini")).unwrap(), "[TmNationsESWC]\r\nVersion=0.1.7.9\r\n");
        assert!(check(&data, "tmn-eswc", &fsx::eswc_protected_dir()).is_err(), "never the StarForce folder");
    }

    #[test]
    fn instance_starts_its_own_exe() {
        let i = Instance {
            id: "a".into(), name: "A".into(), game: "tmuf".into(), source: r"C:\TMUF".into(), root: r"C:\d\instances".into(), path: r"C:\d\instances\a".into(),
            exe: Some("TmForever.exe".into()), launcher: None, user_dir: None, linked: true, created: String::new(), tml_profile: None,
        };
        let info = install_info(&i);
        let p = launch::plan_launch(&launch::PlanInput { game_id: "tmuf", install: &info, tmloader_exe: None, profile: None, eswc_use_launcher: false, join: None }).unwrap();
        match p {
            launch::LaunchTarget::Exe { exe, cwd, .. } => {
                assert_eq!(exe, Path::new(r"C:\d\instances\a").join("TmForever.exe"));
                assert_eq!(cwd.as_deref(), Some(Path::new(r"C:\d\instances\a")));
            }
            other => panic!("{other:?}"),
        }
    }
}
