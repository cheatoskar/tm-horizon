//! Map files for a server: only real maps go on it. A file counts as a map when its name ends in
//! `.Challenge.Gbx` or `.Map.Gbx` AND its GBX header says class CGameCtnChallenge (0x03043000, or
//! the old id 0x24003000). Replays (0x03093000), ghosts and anything else are refused, whatever
//! their name. Only the header (user data) is read, never the body.
//!
//! Also: the header facts the map picker shows (name with format codes, author, environment,
//! author time, "validated"), cached per file, and the embedded thumbnail on request.

use super::model::MapRef;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// CGameCtnChallenge, current and old class id.
pub const MAP_CLASSES: [u32; 2] = [0x0304_3000, 0x2400_3000];
/// Largest header we read (the thumbnail sits in it, ~20-60 KB).
const MAX_HEAD: u64 = 2 << 20;

pub fn is_map_class(class_id: u32) -> bool {
    MAP_CLASSES.contains(&class_id)
}

/// `.Challenge.Gbx` / `.Map.Gbx` (any case).
pub fn has_map_ext(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    l.ends_with(".challenge.gbx") || l.ends_with(".map.gbx")
}

/// A name a map may have: `.Challenge.Gbx` / `.Map.Gbx`, or our own TMX copy `tmx-<id>.Gbx`.
pub fn map_name_ok(path: &str) -> bool {
    let n = path.rsplit(['\\', '/']).next().unwrap_or(path).to_ascii_lowercase();
    has_map_ext(&n) || n.strip_prefix("tmx-").and_then(|x| x.strip_suffix(".gbx")).is_some_and(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit()))
}

/// File name without the map extension.
pub fn stem(path: &str) -> String {
    let n = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let l = n.to_ascii_lowercase();
    for ext in [".challenge.gbx", ".map.gbx", ".gbx"] {
        if l.ends_with(ext) {
            return n[..n.len() - ext.len()].to_string();
        }
    }
    n.to_string()
}

/// The header part of a .Gbx file: magic, version, format, class, user data size + the user data.
pub fn read_head(path: &Path) -> Result<Vec<u8>, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 17];
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    if buf.len() < 17 || &buf[..3] != b"GBX" {
        return Err("not a .Gbx file".into());
    }
    let version = u16::from_le_bytes([buf[3], buf[4]]);
    let at = if version >= 4 { 13 } else { 12 };
    let user = u32::from_le_bytes(buf[at..at + 4].try_into().unwrap()) as u64;
    let want = (at as u64 + 4 + 4 + user).min(MAX_HEAD);
    let mut rest = Vec::new();
    f.take(want.saturating_sub(buf.len() as u64)).read_to_end(&mut rest).map_err(|e| e.to_string())?;
    buf.extend(rest);
    Ok(buf)
}

/// Header facts of a map file; Err for anything that is not a map (by name or by class).
pub fn check_map(path: &Path) -> Result<crate::gbx::GbxInfo, String> {
    let p = path.to_string_lossy();
    if !map_name_ok(&p) {
        return Err(format!("host.err.notMap:{}", stem(&p)));
    }
    let head = read_head(path).map_err(|_| format!("host.err.notMap:{}", stem(&p)))?;
    let info = crate::gbx::parse(&head).map_err(|_| format!("host.err.notMap:{}", stem(&p)))?;
    if !is_map_class(info.class_id) {
        return Err(format!("host.err.notMap:{}", stem(&p)));
    }
    Ok(info)
}

/// Same check on bytes already in memory (a TMX download).
pub fn check_map_bytes(bytes: &[u8]) -> Result<crate::gbx::GbxInfo, String> {
    let info = crate::gbx::parse(bytes)?;
    if !is_map_class(info.class_id) {
        return Err("not a map".into());
    }
    Ok(info)
}

/// What the picker shows per map.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MapMeta {
    pub path: String,
    /// Map name from the header (format codes kept), else the file name.
    pub name: String,
    pub folder: String,
    pub author: String,
    pub environment: String,
    /// Author time in ms (None: not validated or a stunts map).
    pub author_time: Option<u32>,
    /// Has an author time: someone drove it to the finish in the editor.
    pub validated: bool,
    pub uid: String,
    pub has_thumb: bool,
}

pub fn meta_from(path: &str, folder: &str, i: &crate::gbx::GbxInfo) -> MapMeta {
    let at = i.author_time.filter(|t| *t > 0 && *t != u32::MAX);
    MapMeta {
        path: path.to_string(),
        name: i.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| stem(path)),
        folder: folder.to_string(),
        author: i.author.clone().unwrap_or_default(),
        environment: i.environment.clone().unwrap_or_default(),
        author_time: at,
        validated: at.is_some(),
        uid: i.uid.clone().unwrap_or_default(),
        has_thumb: i.thumbnail.is_some(),
    }
}

type Cache = Mutex<HashMap<PathBuf, (u64, u64, Option<MapMeta>)>>;

fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn stamp(p: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(p).ok()?;
    let t = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some((t, m.len()))
}

/// Header facts of a map file, cached by (path, mtime, size). None: missing or not a map.
pub fn meta(path: &Path, folder: &str) -> Option<MapMeta> {
    let (t, len) = stamp(path)?;
    if let Some((ct, cl, m)) = cache().lock().unwrap().get(path) {
        if *ct == t && *cl == len {
            return m.clone().map(|mut m| {
                m.folder = folder.to_string();
                m
            });
        }
    }
    let m = check_map(path).ok().map(|i| meta_from(&path.to_string_lossy(), folder, &i));
    let mut c = cache().lock().unwrap();
    if c.len() > 20_000 {
        c.clear();
    }
    c.insert(path.to_path_buf(), (t, len, m.clone()));
    m
}

/// The embedded thumbnail (data: URL, JPEG stored upside down; the UI flips it).
pub fn thumbnail(path: &Path) -> Option<String> {
    check_map(path).ok()?.thumbnail
}

/// All maps under `root` (sub folders too), header facts included; non-maps are left out.
pub fn list_maps(root: &Path, max: usize) -> Vec<MapMeta> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if out.len() >= max {
                break;
            }
            let p = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(p);
                continue;
            }
            let n = e.file_name().to_string_lossy().to_string();
            if !has_map_ext(&n) {
                continue;
            }
            let folder = p.parent().and_then(|x| x.strip_prefix(root).ok()).map(|x| x.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            if let Some(m) = meta(&p, &folder) {
                out.push(m);
            }
        }
    }
    out.sort_by(|a, b| (a.folder.as_str(), crate::serverquery::strip_format(&a.name).to_lowercase()).cmp(&(b.folder.as_str(), crate::serverquery::strip_format(&b.name).to_lowercase())));
    out
}

/// Where a TMX map of server `dir` lives once added (the server's own folder).
pub fn tmx_file(dir: &Path, id: u64) -> PathBuf {
    dir.join("maps").join(format!("tmx-{id}.Gbx"))
}

/// Deletes TMX downloads in the server's folder that are no longer on its list (after a save).
pub fn prune_tmx(dir: &Path, maps: &[MapRef]) {
    let Ok(rd) = std::fs::read_dir(dir.join("maps")) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        let id = n.strip_prefix("tmx-").and_then(|x| x.strip_suffix(".Gbx").or_else(|| x.strip_suffix(".part"))).and_then(|x| x.parse::<u64>().ok());
        if let Some(id) = id {
            if !maps.iter().any(|m| matches!(m, MapRef::Tmx { id: x, .. } if *x == id)) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// The file behind a map entry, if there is one on disk (TMX: the server's copy, else the old cache).
pub fn file_of(data: &Path, dir: &Path, site: Option<&str>, m: &MapRef) -> Option<PathBuf> {
    match m {
        MapRef::File { path, .. } => Some(PathBuf::from(path)).filter(|p| p.is_file()),
        MapRef::Tmx { id, .. } => {
            let own = tmx_file(dir, *id);
            if own.is_file() {
                return Some(own);
            }
            let old = data.join("servers").join("_tmx").join(site?).join(format!("{id}.Gbx"));
            old.is_file().then_some(old)
        }
    }
}

/// Migration for server.json files written before the class check: drops entries that are not maps
/// (replays and other .Gbx). Returns the names that were dropped. Missing files stay (they may sit
/// on a drive that is not plugged in); the start reports them.
pub fn drop_non_maps(maps: &mut Vec<MapRef>) -> Vec<String> {
    let mut dropped = vec![];
    maps.retain(|m| match m {
        MapRef::Tmx { .. } => true,
        MapRef::File { path, name } => {
            let p = Path::new(path);
            let ok = has_map_ext(path) && (!p.exists() || meta(p, "").is_some());
            if !ok {
                dropped.push(if name.is_empty() { stem(path) } else { name.clone() });
            }
            ok
        }
    });
    dropped
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A minimal map header (class 0x03043000) with the XML chunk, as TMNF writes it.
    pub fn map_bytes(name: &str, author: &str, author_time: i64) -> Vec<u8> {
        gbx_with(0x0304_3000, &format!(r#"<header type="challenge" version="TMc.6"><ident uid="U{name}" name="{name}" author="{author}"/><desc envir="Stadium" mood="Day" type="Race"/><times bronze="1" silver="1" gold="1" authortime="{author_time}"/></header>"#), 0x0304_3005)
    }

    pub fn replay_bytes() -> Vec<u8> {
        gbx_with(0x0309_3000, r#"<header type="replay"/>"#, 0x0309_3001)
    }

    fn gbx_with(class: u32, xml: &str, chunk: u32) -> Vec<u8> {
        let mut c = (xml.len() as u32).to_le_bytes().to_vec();
        c.extend(xml.as_bytes());
        let mut d = b"GBX".to_vec();
        d.extend(6u16.to_le_bytes());
        d.extend(b"BUCR");
        d.extend(class.to_le_bytes());
        d.extend(((4 + 8 + c.len()) as u32).to_le_bytes());
        d.extend(1u32.to_le_bytes());
        d.extend(chunk.to_le_bytes());
        d.extend((c.len() as u32 | 0x8000_0000).to_le_bytes());
        d.extend(&c);
        d.extend(b"BODY-NOT-READ");
        d
    }

    #[test]
    fn class_and_extension_decide() {
        let t = tempfile::tempdir().unwrap();
        let map = t.path().join("A01.Challenge.Gbx");
        std::fs::write(&map, map_bytes("$f00A01", "nadeo", 23_450)).unwrap();
        let i = check_map(&map).unwrap();
        assert_eq!(i.name.as_deref(), Some("$f00A01"));
        // a replay, also when renamed to look like a map
        let rep = t.path().join("summer mornings - FIXED_[TAS]x(00'52''93).Replay.Gbx");
        std::fs::write(&rep, replay_bytes()).unwrap();
        assert_eq!(check_map(&rep).unwrap_err(), "host.err.notMap:summer mornings - FIXED_[TAS]x(00'52''93).Replay");
        let fake = t.path().join("fake.Challenge.Gbx");
        std::fs::write(&fake, replay_bytes()).unwrap();
        assert!(check_map(&fake).is_err(), "class wins over the name");
        let junk = t.path().join("junk.Map.Gbx");
        std::fs::write(&junk, b"hello").unwrap();
        assert!(check_map(&junk).is_err());
        // a map file renamed to .Gbx only: the name must say map too
        let odd = t.path().join("odd.Gbx");
        std::fs::write(&odd, map_bytes("x", "y", 1)).unwrap();
        assert!(check_map(&odd).is_err());
        assert!(has_map_ext("x.MAP.GBX") && !has_map_ext("x.Replay.Gbx"));
        assert!(map_name_ok("C:\\s\\maps\\tmx-123.Gbx") && !map_name_ok("tmx-.Gbx") && !map_name_ok("tmx-1.Replay.Gbx") && !has_map_ext("tmx-1.Gbx"));
        let tmx = t.path().join("tmx-9.Gbx");
        std::fs::write(&tmx, map_bytes("T", "me", 5)).unwrap();
        assert_eq!(meta(&tmx, "TMX").unwrap().author, "me", "our TMX copies are read too");
        assert_eq!(stem("C:\\a\\b c.Challenge.Gbx"), "b c");
    }

    #[test]
    fn header_only_and_meta() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("Tpl.Challenge.Gbx");
        let mut b = map_bytes("Template", "me", -1);
        b.extend(vec![0u8; 4 << 20]); // a big body is never read
        std::fs::write(&p, &b).unwrap();
        let head = read_head(&p).unwrap();
        assert!(head.len() < 4096);
        let m = meta(&p, "My").unwrap();
        assert_eq!((m.name.as_str(), m.author.as_str(), m.environment.as_str(), m.folder.as_str()), ("Template", "me", "Stadium", "My"));
        assert!(!m.validated && m.author_time.is_none(), "no author time: not validated");
        let v = t.path().join("V.Map.Gbx");
        std::fs::write(&v, map_bytes("V", "me", 41_000)).unwrap();
        assert_eq!(meta(&v, "").unwrap().author_time, Some(41_000));
    }

    #[test]
    fn listing_skips_replays() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("My/Sub")).unwrap();
        std::fs::write(t.path().join("My/b.Challenge.Gbx"), map_bytes("b", "x", 1000)).unwrap();
        std::fs::write(t.path().join("My/Sub/A.Challenge.Gbx"), map_bytes("A", "x", 1000)).unwrap();
        std::fs::write(t.path().join("My/x.Replay.Gbx"), replay_bytes()).unwrap();
        std::fs::write(t.path().join("My/fake.Challenge.Gbx"), replay_bytes()).unwrap();
        let m = list_maps(t.path(), 100);
        assert_eq!(m.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["b", "A"]);
        assert_eq!(m[1].folder, "My/Sub");
        assert_eq!(list_maps(t.path(), 1).len(), 1);
    }

    #[test]
    fn migration_drops_replays() {
        let t = tempfile::tempdir().unwrap();
        let map = t.path().join("ok.Challenge.Gbx");
        std::fs::write(&map, map_bytes("ok", "x", 1)).unwrap();
        let rep = t.path().join("r.Replay.Gbx");
        std::fs::write(&rep, replay_bytes()).unwrap();
        let disguised = t.path().join("d.Challenge.Gbx");
        std::fs::write(&disguised, replay_bytes()).unwrap();
        let s = |p: &Path| p.to_string_lossy().to_string();
        let mut maps = vec![
            MapRef::File { path: s(&map), name: "ok".into() },
            MapRef::File { path: s(&rep), name: "r.Replay.Gbx".into() },
            MapRef::File { path: s(&disguised), name: "d".into() },
            MapRef::File { path: "Z:\\gone\\missing.Challenge.Gbx".into(), name: "missing".into() },
            MapRef::File { path: "Z:\\gone\\missing.Replay.Gbx".into(), name: "".into() },
            MapRef::Tmx { id: 5, name: "t".into() },
        ];
        let dropped = drop_non_maps(&mut maps);
        assert_eq!(dropped, vec!["r.Replay.Gbx", "d", "missing.Replay"]);
        assert_eq!(maps.len(), 3);
        assert!(drop_non_maps(&mut maps).is_empty(), "second run changes nothing");
        // TMX copies that left the list are deleted on save, others and foreign files stay
        let dir = t.path().join("srv");
        std::fs::create_dir_all(dir.join("maps")).unwrap();
        for f in ["tmx-5.Gbx", "tmx-6.Gbx", "tmx-7.part", "notes.txt"] {
            std::fs::write(dir.join("maps").join(f), b"x").unwrap();
        }
        prune_tmx(&dir, &maps);
        let mut left: Vec<String> = std::fs::read_dir(dir.join("maps")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        left.sort();
        assert_eq!(left, vec!["notes.txt", "tmx-5.Gbx"]);
    }
}
