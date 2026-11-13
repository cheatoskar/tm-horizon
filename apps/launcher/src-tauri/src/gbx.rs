//! Minimal reader for the header of TrackMania Forever .Gbx map files (Challenge and Map): name,
//! author, environment, medal times and the thumbnail. Only the user-data header chunks are read,
//! never the body, and every length is checked, so damaged or hostile files give an error and
//! never a panic. Reference for the file layout and the chunk ids: GBX.NET by BigBang1112
//! (MIT, https://github.com/BigBang1112/gbx-net); this is an independent implementation, no code
//! was taken from it.
//!
//! Layout (version 3-6): "GBX", u16 version, format/compression bytes ("B" "U|C" "U|C" and, from
//! version 4, "R"), u32 class id, u32 user data size, then (when > 0) u32 chunk count, per chunk
//! u32 id + u32 size (top bit = "heavy" flag), then the chunk data in the same order.

use base64::Engine;
use serde::Serialize;

/// Largest file part read (the header sits at the start).
const MAX_HEADER: usize = 8 * 1024 * 1024;
const MAX_CHUNKS: u32 = 64;
const MAX_XML: usize = 64 * 1024;
const MAX_THUMB: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GbxInfo {
    pub version: u16,
    pub class_id: u32,
    pub uid: Option<String>,
    pub name: Option<String>,
    pub author: Option<String>,
    pub environment: Option<String>,
    pub mood: Option<String>,
    /// Medal times in milliseconds.
    pub bronze: Option<u32>,
    pub silver: Option<u32>,
    pub gold: Option<u32>,
    pub author_time: Option<u32>,
    /// data: URL of the thumbnail JPEG. TrackMania stores it upside down; the UI flips it.
    pub thumbnail: Option<String>,
    pub comments: Option<String>,
}

struct Cur<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Cur<'a> {
    fn new(d: &'a [u8]) -> Self {
        Cur { d, p: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.p.checked_add(n)?;
        let s = self.d.get(self.p..end)?;
        self.p = end;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn string(&mut self, max: usize) -> Option<String> {
        let n = self.u32()? as usize;
        if n > max {
            return None;
        }
        Some(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
}

/// A "lookback string" (chunk 0x03043003): the first one in a chunk is preceded by a u32 version;
/// an index with flag bits 0x40000000 / 0x80000000 and nothing else announces a new string, other
/// indices refer to earlier strings of the same chunk, 0xFFFFFFFF is empty.
struct Lookback {
    started: bool,
    seen: Vec<String>,
}

impl Lookback {
    fn read(&mut self, c: &mut Cur) -> Option<Option<String>> {
        if !self.started {
            c.u32()?;
            self.started = true;
        }
        let idx = c.u32()?;
        if idx == 0xFFFF_FFFF {
            return Some(None);
        }
        let low = idx & 0x3FFF_FFFF;
        match idx >> 30 {
            0 => Some(Some(format!("#{idx}"))), // numeric collection id
            1 | 2 if low == 0 => {
                let s = c.string(1024)?;
                if self.seen.len() < 64 {
                    self.seen.push(s.clone());
                }
                Some(Some(s))
            }
            _ => Some(self.seen.get(low.checked_sub(1)? as usize).cloned()),
        }
    }
}

/// Value of attribute `key` inside the first `<tag ...>` element of `xml` (tolerant, no full XML parser).
fn attr(xml: &str, tag: &str, key: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag} "))? + tag.len() + 2;
    let end = start + xml[start..].find('>')?;
    let el = &xml[start..end];
    let pat = format!("{key}=\"");
    let mut from = 0;
    while let Some(i) = el[from..].find(&pat) {
        let at = from + i;
        // Whole attribute names only ("name" must not match inside "xname").
        if at == 0 || el.as_bytes()[at - 1] == b' ' {
            let v = at + pat.len();
            let e = el[v..].find('"')?;
            return Some(unescape(&el[v..v + e]));
        }
        from = at + pat.len();
    }
    None
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn num(xml: &str, tag: &str, key: &str) -> Option<u32> {
    attr(xml, tag, key)?.trim().parse::<u32>().ok()
}

/// Parses the header of the file contents `data` (only the first bytes are needed).
pub fn parse(data: &[u8]) -> Result<GbxInfo, String> {
    let bad = || "Not a readable .Gbx file".to_string();
    let mut c = Cur::new(data);
    if c.take(3).ok_or_else(bad)? != b"GBX" {
        return Err("Not a .Gbx file".into());
    }
    let version = c.u16().ok_or_else(bad)?;
    if !(3..=6).contains(&version) {
        return Err(format!("Unsupported .Gbx version {version}"));
    }
    if c.u8().ok_or_else(bad)? != b'B' {
        return Err("Text .Gbx files are not supported".into());
    }
    c.take(if version >= 4 { 3 } else { 2 }).ok_or_else(bad)?;
    let class_id = c.u32().ok_or_else(bad)?;
    let mut info = GbxInfo { version, class_id, ..Default::default() };
    let user = c.u32().ok_or_else(bad)? as usize;
    if user == 0 {
        return Ok(info);
    }
    let count = c.u32().ok_or_else(bad)?;
    if count > MAX_CHUNKS {
        return Err(bad());
    }
    let mut table = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let id = c.u32().ok_or_else(bad)?;
        let size = (c.u32().ok_or_else(bad)? & 0x7FFF_FFFF) as usize;
        table.push((id, size));
    }
    let mut xml: Option<String> = None;
    for (id, size) in table {
        let Some(raw) = c.take(size) else { break };
        // Both id ranges exist: 0x03043xxx (TMF/older) and 0x24003xxx (newer builds).
        match id & 0x00FF_FFFF {
            0x043002 | 0x003002 => times(raw, &mut info),
            0x043003 | 0x003003 => map_info(raw, &mut info),
            0x043005 | 0x003005 => xml = Cur::new(raw).string(MAX_XML),
            0x043007 | 0x003007 => thumbnail(raw, &mut info),
            _ => {}
        }
    }
    // The XML chunk is the most complete source; it wins over the binary chunks.
    if let Some(x) = xml {
        let set = |dst: &mut Option<String>, v: Option<String>| {
            if v.is_some() {
                *dst = v;
            }
        };
        set(&mut info.uid, attr(&x, "ident", "uid"));
        set(&mut info.name, attr(&x, "ident", "name"));
        set(&mut info.author, attr(&x, "ident", "author"));
        set(&mut info.environment, attr(&x, "desc", "envir"));
        set(&mut info.mood, attr(&x, "desc", "mood"));
        for (dst, key) in [(&mut info.bronze, "bronze"), (&mut info.silver, "silver"), (&mut info.gold, "gold"), (&mut info.author_time, "authortime")] {
            if let Some(v) = num(&x, "times", key) {
                *dst = Some(v);
            }
        }
    }
    Ok(info)
}

/// Chunk 0x...002: version byte, a u32, then bronze, silver, gold, author time (ms) and the price.
fn times(raw: &[u8], info: &mut GbxInfo) {
    let mut c = Cur::new(raw);
    let (Some(v), Some(_)) = (c.u8(), c.u32()) else { return };
    if v < 3 {
        return;
    }
    let t = |c: &mut Cur| c.u32().filter(|x| *x != 0xFFFF_FFFF);
    if let (Some(b), Some(s), Some(g), Some(a)) = (t(&mut c), t(&mut c), t(&mut c), t(&mut c)) {
        info.bronze = Some(b);
        info.silver = Some(s);
        info.gold = Some(g);
        info.author_time = Some(a);
    }
}

/// Chunk 0x...003: version byte, uid, environment, author login (lookback strings), map name.
fn map_info(raw: &[u8], info: &mut GbxInfo) {
    let mut c = Cur::new(raw);
    let mut lb = Lookback { started: false, seen: Vec::new() };
    let Some(v) = c.u8() else { return };
    if v < 3 {
        return;
    }
    let (Some(uid), Some(env), Some(author)) = (lb.read(&mut c), lb.read(&mut c), lb.read(&mut c)) else { return };
    info.uid = uid;
    info.environment = env;
    info.author = author;
    info.name = c.string(1024);
}

/// Chunk 0x...007: u32 version, u32 size, "<Thumbnail.jpg>" JPEG "</Thumbnail.jpg>" "<Comments>" text "</Comments>".
fn thumbnail(raw: &[u8], info: &mut GbxInfo) {
    let mut c = Cur::new(raw);
    let (Some(v), Some(size)) = (c.u32(), c.u32()) else { return };
    let size = size as usize;
    if v == 0 || size == 0 || size > MAX_THUMB || c.take(15) != Some(b"<Thumbnail.jpg>") {
        return;
    }
    let Some(jpg) = c.take(size) else { return };
    if jpg.starts_with(&[0xFF, 0xD8]) {
        info.thumbnail = Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpg)));
    }
    if c.take(16) == Some(b"</Thumbnail.jpg>") && c.take(10) == Some(b"<Comments>") {
        info.comments = c.string(4096).filter(|s| !s.is_empty());
    }
}

/// Who drove a replay (header chunk 0x03093000 of a Forever .Replay.Gbx).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReplayHead {
    pub uid: Option<String>,
    /// "Stadium", "Snow", ...
    pub environment: Option<String>,
    pub time_ms: Option<u32>,
    pub nickname: Option<String>,
    /// The driver's login (empty for guests and offline profiles).
    pub login: Option<String>,
    /// The map's author login from the map ident ("Nadeo" for the games' own campaign maps).
    pub author: Option<String>,
}

/// Class id of a replay in the file header: 0x03093000, or the old id 0x2407E000 that most TMNF/TMUF
/// replays carry (their header chunks still use 0x03093000/0x03093001).
fn is_replay_class(id: u32) -> bool {
    id == 0x0309_3000 || id == 0x2407_E000
}

/// Reads the driver of a Forever replay: chunk 0x03093000 = version, map ident (lookback strings:
/// uid, environment, author), time, nickname and (from version 1) login. None when the file is no
/// replay or the chunk is damaged.
pub fn replay_head(data: &[u8]) -> Option<ReplayHead> {
    let mut c = Cur::new(data);
    if c.take(3)? != b"GBX" {
        return None;
    }
    let version = c.u16()?;
    if !(3..=6).contains(&version) || c.u8()? != b'B' {
        return None;
    }
    c.take(if version >= 4 { 3 } else { 2 })?;
    if !is_replay_class(c.u32()?) {
        return None;
    }
    if c.u32()? == 0 {
        return None;
    }
    let count = c.u32()?;
    if count > MAX_CHUNKS {
        return None;
    }
    let mut table = Vec::with_capacity(count as usize);
    for _ in 0..count {
        table.push((c.u32()?, (c.u32()? & 0x7FFF_FFFF) as usize));
    }
    for (id, size) in table {
        let raw = c.take(size)?;
        if id & 0x00FF_FFFF != 0x093000 {
            continue;
        }
        let mut c = Cur::new(raw);
        let v = c.u32()?;
        let mut lb = Lookback { started: false, seen: Vec::new() };
        let uid = lb.read(&mut c)?;
        let environment = lb.read(&mut c)?;
        let author = lb.read(&mut c)?;
        let time = c.u32().filter(|t| *t != 0xFFFF_FFFF);
        let nickname = c.string(256);
        let login = if v >= 1 { c.string(256) } else { None };
        return Some(ReplayHead { uid, environment, time_ms: time, nickname, login, author });
    }
    None
}

/// The XML header chunk of a replay (0x03093001: `<header type="replay" ...><map|challenge uid=".." name=".."/>
/// <times best=".." respawns=".." .../></header>`), None when the file has none.
pub fn replay_xml(data: &[u8]) -> Option<String> {
    let mut c = Cur::new(data);
    if c.take(3)? != b"GBX" {
        return None;
    }
    let version = c.u16()?;
    if !(3..=6).contains(&version) || c.u8()? != b'B' {
        return None;
    }
    c.take(if version >= 4 { 3 } else { 2 })?;
    if !is_replay_class(c.u32()?) || c.u32()? == 0 {
        return None;
    }
    let count = c.u32()?;
    if count > MAX_CHUNKS {
        return None;
    }
    let mut table = Vec::with_capacity(count as usize);
    for _ in 0..count {
        table.push((c.u32()?, (c.u32()? & 0x7FFF_FFFF) as usize));
    }
    for (id, size) in table {
        let raw = c.take(size)?;
        if id & 0x00FF_FFFF == 0x093001 {
            return Cur::new(raw).string(MAX_XML);
        }
    }
    None
}

/// Attribute of the first `<tag ...>` element of a header XML.
pub fn xml_attr(xml: &str, tag: &str, key: &str) -> Option<String> {
    attr(xml, tag, key)
}

/// Reads the header of the .Gbx file at `path` (at most the first 8 MB).
pub fn read_file(path: &str) -> Result<GbxInfo, String> {
    use std::io::Read;
    let f = std::fs::File::open(path).map_err(|e| format!("Cannot open the file: {e}"))?;
    let mut buf = Vec::new();
    f.take(MAX_HEADER as u64).read_to_end(&mut buf).map_err(|e| format!("Cannot read the file: {e}"))?;
    parse(&buf)
}

#[tauri::command]
pub async fn gbx_info(path: String) -> Result<GbxInfo, String> {
    tauri::async_runtime::spawn_blocking(move || read_file(&path)).await.map_err(|e| e.to_string())?
}

/// Lets the user pick a .Gbx file; returns its path, or None when the dialog was cancelled.
#[tauri::command]
pub async fn gbx_pick(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Map file").add_filter("TrackMania maps", &["Gbx", "gbx"]).blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn lb_new(out: &mut Vec<u8>, flag: u32, s: &str) {
        out.extend(flag.to_le_bytes());
        out.extend((s.len() as u32).to_le_bytes());
        out.extend(s.as_bytes());
    }

    /// A header like the ones TMNF writes: times, map info, xml and thumbnail chunks.
    pub(crate) fn sample() -> Vec<u8> {
        let mut c2 = vec![11u8, 0, 0, 0, 0];
        for t in [703000u32, 562000, 497000, 468200, 2873] {
            c2.extend(t.to_le_bytes());
        }
        let mut c3 = vec![5u8];
        c3.extend(3u32.to_le_bytes());
        lb_new(&mut c3, 0x8000_0000, "7GK45NEyMOif7S9jicImvQNz7gf");
        lb_new(&mut c3, 0x4000_0000, "Stadium");
        lb_new(&mut c3, 0x4000_0000, "JensTas");
        c3.extend(3u32.to_le_bytes());
        c3.extend(b"3aM");
        let xml = r#"<header type="challenge" version="TMc.6"><ident uid="U1" name="3aM &amp; co" author="JensTas"/><desc envir="Stadium" mood="Day" type="Race"/><times bronze="703000" silver="562000" gold="497000" authortime="468200"/></header>"#;
        let mut c5 = (xml.len() as u32).to_le_bytes().to_vec();
        c5.extend(xml.as_bytes());
        let jpg = [0xFFu8, 0xD8, 0xFF, 0xE0, 1, 2, 3];
        let mut c7 = 1u32.to_le_bytes().to_vec();
        c7.extend((jpg.len() as u32).to_le_bytes());
        c7.extend(b"<Thumbnail.jpg>");
        c7.extend(jpg);
        c7.extend(b"</Thumbnail.jpg><Comments>");
        c7.extend(2u32.to_le_bytes());
        c7.extend(b"hi");
        c7.extend(b"</Comments>");
        let chunks: [(u32, Vec<u8>); 4] = [(0x03043002, c2), (0x03043003, c3), (0x03043005, c5), (0x03043007, c7)];
        let mut d = b"GBX".to_vec();
        d.extend(6u16.to_le_bytes());
        d.extend(b"BUCR");
        d.extend(0x03043000u32.to_le_bytes());
        let user = 4 + chunks.len() * 8 + chunks.iter().map(|c| c.1.len()).sum::<usize>();
        d.extend((user as u32).to_le_bytes());
        d.extend((chunks.len() as u32).to_le_bytes());
        for (id, b) in &chunks {
            d.extend(id.to_le_bytes());
            d.extend((b.len() as u32 | 0x8000_0000).to_le_bytes());
        }
        for (_, b) in &chunks {
            d.extend(b);
        }
        d.extend([0u8; 16]); // start of the body
        d
    }

    /// A Forever replay header as the game writes it (chunk 0x03093000 + XML chunk 0x03093001).
    pub fn replay_sample(login: &str, nick: &str) -> Vec<u8> {
        replay_sample_run(login, nick, "Stadium", "7GK45NEyMOif7S9jicImvQNz7gf", 9370)
    }

    pub fn replay_sample_run(login: &str, nick: &str, env: &str, uid: &str, time: u32) -> Vec<u8> {
        let mut c0 = 7u32.to_le_bytes().to_vec();
        c0.extend(3u32.to_le_bytes());
        lb_new(&mut c0, 0x8000_0000, uid);
        lb_new(&mut c0, 0x4000_0000, env);
        lb_new(&mut c0, 0x4000_0000, "JensTas");
        c0.extend(time.to_le_bytes());
        for s in [nick, login] {
            c0.extend((s.len() as u32).to_le_bytes());
            c0.extend(s.as_bytes());
        }
        let xml = format!(r#"<header type="replay" version="TMr.7" exever="2.11.26"><challenge uid="{uid}"/><times best="{time}" respawns="0" stuntscore="11" validable="1"/></header>"#);
        let mut c1 = (xml.len() as u32).to_le_bytes().to_vec();
        c1.extend(xml.as_bytes());
        let chunks: [(u32, Vec<u8>); 2] = [(0x03093000, c0), (0x03093001, c1)];
        let mut d = b"GBX".to_vec();
        d.extend(6u16.to_le_bytes());
        d.extend(b"BUCR");
        d.extend(0x03093000u32.to_le_bytes());
        let user = 4 + chunks.len() * 8 + chunks.iter().map(|c| c.1.len()).sum::<usize>();
        d.extend((user as u32).to_le_bytes());
        d.extend((chunks.len() as u32).to_le_bytes());
        for (id, b) in &chunks {
            d.extend(id.to_le_bytes());
            d.extend((b.len() as u32).to_le_bytes());
        }
        for (_, b) in &chunks {
            d.extend(b);
        }
        d.extend([0u8; 16]);
        d
    }

    #[test]
    fn replay_driver_and_damage() {
        let h = replay_head(&replay_sample("cheatoskar", "[TAS]cheatoskar")).unwrap();
        assert_eq!(h.login.as_deref(), Some("cheatoskar"));
        assert_eq!(h.nickname.as_deref(), Some("[TAS]cheatoskar"));
        assert_eq!(h.uid.as_deref(), Some("7GK45NEyMOif7S9jicImvQNz7gf"));
        assert_eq!(h.time_ms, Some(9370));
        assert_eq!(h.environment.as_deref(), Some("Stadium"));
        // A map is no replay; cut-off and random bytes never panic.
        assert!(replay_head(&sample()).is_none());
        let full = replay_sample("a", "b");
        for n in 0..full.len() {
            let _ = replay_head(&full[..n]);
        }
        assert!(replay_head(b"nonsense").is_none());
    }

    /// Most TMNF/TMUF replays carry the old class id 0x2407E000 in the file header (chunks stay 0x03093xxx).
    #[test]
    fn replay_with_old_class_id() {
        let mut d = replay_sample_run("cheatoskar", "nick", "Stadium", "E_4PSiHl5e_JimWxfCiMheksQc4", 52930);
        d[9..13].copy_from_slice(&0x2407_E000u32.to_le_bytes());
        let h = replay_head(&d).unwrap();
        assert_eq!(h.login.as_deref(), Some("cheatoskar"));
        assert_eq!(h.time_ms, Some(52930));
        assert!(replay_xml(&d).unwrap().contains("E_4PSiHl5e_JimWxfCiMheksQc4"));
        // any other class id is still no replay
        d[9..13].copy_from_slice(&0x0304_3000u32.to_le_bytes());
        assert!(replay_head(&d).is_none());
    }

    #[test]
    fn reads_a_synthetic_header() {
        let i = parse(&sample()).unwrap();
        assert_eq!(i.version, 6);
        assert_eq!(i.class_id, 0x03043000);
        assert_eq!(i.name.as_deref(), Some("3aM & co"));
        assert_eq!(i.author.as_deref(), Some("JensTas"));
        assert_eq!(i.environment.as_deref(), Some("Stadium"));
        assert_eq!(i.mood.as_deref(), Some("Day"));
        assert_eq!((i.bronze, i.silver, i.gold, i.author_time), (Some(703000), Some(562000), Some(497000), Some(468200)));
        assert!(i.thumbnail.unwrap().starts_with("data:image/jpeg;base64,"));
        assert_eq!(i.comments.as_deref(), Some("hi"));
    }

    #[test]
    fn binary_chunks_work_without_xml() {
        let mut i = GbxInfo::default();
        let s = sample();
        // chunk data begins after magic(3)+ver(2)+fmt(4)+class(4)+user(4)+count(4)+4*8 table
        let start = 21 + 32;
        times(&s[start..start + 25], &mut i);
        assert_eq!(i.author_time, Some(468200));
        map_info(&s[start + 25..start + 25 + 160], &mut i);
        assert_eq!(i.name.as_deref(), Some("3aM"));
        assert_eq!(i.environment.as_deref(), Some("Stadium"));
    }

    #[test]
    fn lookback_reference_resolves() {
        let mut d = 3u32.to_le_bytes().to_vec();
        lb_new(&mut d, 0x4000_0000, "A");
        d.extend(0xC000_0001u32.to_le_bytes());
        d.extend(0xFFFF_FFFFu32.to_le_bytes());
        let mut c = Cur::new(&d);
        let mut lb = Lookback { started: false, seen: vec![] };
        assert_eq!(lb.read(&mut c), Some(Some("A".into())));
        assert_eq!(lb.read(&mut c), Some(Some("A".into())));
        assert_eq!(lb.read(&mut c), Some(None));
    }

    #[test]
    fn truncated_data_never_panics() {
        let s = sample();
        for n in 0..s.len() {
            let _ = parse(&s[..n]);
        }
    }

    #[test]
    fn garbage_never_panics() {
        let mut x: u32 = 12345;
        let s = sample();
        for round in 0..2000 {
            let mut d = s.clone();
            for _ in 0..(1 + round % 8) {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                let at = (x >> 8) as usize % d.len();
                d[at] = (x >> 24) as u8;
            }
            let _ = parse(&d);
        }
        assert!(parse(b"").is_err());
        assert!(parse(b"GBX").is_err());
        assert!(parse(&[0xFFu8; 64]).is_err());
        // huge declared sizes
        let mut d = b"GBX".to_vec();
        d.extend(6u16.to_le_bytes());
        d.extend(b"BUCR");
        d.extend(0u32.to_le_bytes());
        d.extend(u32::MAX.to_le_bytes());
        d.extend(u32::MAX.to_le_bytes());
        assert!(parse(&d).is_err());
    }
}

#[cfg(test)]
mod real_file {
    /// Optional: GBX_SAMPLE=<path of a real map> prints what the reader finds (cargo test -- --nocapture).
    #[test]
    fn sample_from_env() {
        if let Ok(p) = std::env::var("GBX_SAMPLE") {
            let mut i = super::read_file(&p).unwrap();
            i.thumbnail = i.thumbnail.map(|t| format!("{} bytes", t.len()));
            println!("{i:#?}");
        }
    }
}
