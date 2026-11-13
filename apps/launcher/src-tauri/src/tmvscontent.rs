//! TM Vibrant Shaders content browser: presets (`.ini` + `.jpg`), colour looks (`.cube`) and resource
//! packs (environment mod zips) from an index (a GitHub repository or a local folder), installed into
//! the folders TMVS reads while the game runs.
//!
//! Nothing is trusted: every file is checked against the index's SHA-256, then validated for what it
//! is (known preset keys with their ranges, a real 3D cube file, a real JPEG, a zip without odd paths)
//! before anything is written. Only files this module wrote are ever removed (manifest in the app's
//! data folder, with the hash of each file).
//!
//! Folders (Documents resolved through the known-folder API, `TMHUB_DOCUMENTS_DIR` overrides it for tests):
//!   presets  Documents\TrackMania\TMVS\presets (Nations/United/ESWC), Documents\ManiaPlanet\TMVS\presets (TM2)
//!   looks    Documents\TrackMania\TMVS\luts, Documents\ManiaPlanet\TMVS\luts
//!   packs    Documents\TrackMania\Skins\<Environment>\Mod (Nations/United)

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const MAX_INI: usize = 16 * 1024;
pub const MAX_JPG: usize = 1 << 20;
pub const MAX_CUBE: usize = 8 << 20;
pub const MAX_ZIP: usize = 64 << 20;
pub const MAX_INDEX: usize = 2 << 20;
pub const MAX_CODE: usize = 4000;
pub const ENVIRONMENTS: [&str; 8] = ["Stadium", "Bay", "Coast", "Island", "Desert", "Rally", "Snow", "Alpine"];
const GAMES: [&str; 4] = ["tmnf", "tmuf", "tmn-eswc", "tm2"];
const BUILTIN_NAMES: [&str; 14] = [
    "vibrant", "realistic", "golden hour", "dreamy", "neon", "horizon", "aurora", "competition", "performance", "rainy", "replay cinema", "storm", "snowstorm", "horror",
];

// ------------------------------------------------------------------ the index

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Preset,
    Lut,
    Pack,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    /// "ini", "jpg" (presets); "cube", "preview" (looks); "zip", "preview" (packs).
    pub role: String,
    /// Relative to the index, or an https address on the index's host.
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub author: String,
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub games: Vec<String>,
    /// Packs: the environment whose Mod folder the zip goes to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    pub files: Vec<FileRef>,
    /// A sample entry, shown with a badge.
    #[serde(default)]
    pub example: bool,
}

#[derive(Debug, Deserialize)]
struct RawIndex {
    format: u32,
    #[serde(default)]
    items: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Index {
    pub items: Vec<Item>,
    /// One line per entry that was skipped and why.
    pub skipped: Vec<String>,
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_id(s: &str) -> bool {
    let b = s.as_bytes();
    (2..=48).contains(&b.len()) && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A path as written in an index: relative, no `..`, no drive, no backslash.
pub fn safe_rel(p: &str) -> bool {
    !p.is_empty() && p.len() <= 200 && !p.starts_with('/') && !p.contains(['\\', ':', '?', '#']) && !p.split('/').any(|s| s.is_empty() || s == "." || s == "..") && !p.chars().any(|c| c.is_control())
}

/// The file name a preset / look / pack is stored under: what TMVS accepts as a preset name (no `\/:*?"<>|`, no
/// control characters, no trailing dot or space, at most 40 characters) and not a Windows device name.
pub fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 || n.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) || n.ends_with('.') {
        return Err(format!("\"{name}\" is not a usable name (1 to 40 characters, none of \\ / : * ? \" < > |)"));
    }
    let up = n.to_uppercase();
    let stem = up.split('.').next().unwrap_or("");
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem) || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit()) {
        return Err(format!("\"{name}\" is a reserved Windows name"));
    }
    Ok(n.to_string())
}

fn check_item(it: &Item) -> Result<(), String> {
    if !valid_id(&it.id) {
        return Err("id: a-z, 0-9 and dashes, 2 to 48 characters".into());
    }
    clean_name(&it.name)?;
    if it.kind == Kind::Preset && BUILTIN_NAMES.contains(&it.name.trim().to_lowercase().as_str()) {
        return Err("the name is a built-in preset's".into());
    }
    if it.author.trim().is_empty() || it.author.chars().count() > 60 || it.author.chars().any(|c| c.is_control()) {
        return Err("author: 1 to 60 characters".into());
    }
    if it.description.trim().is_empty() || it.description.chars().count() > 200 || it.description.chars().any(|c| c.is_control()) {
        return Err("description: 1 to 200 characters".into());
    }
    if it.tags.len() > 8 || it.tags.iter().any(|t| t.is_empty() || t.len() > 24 || !t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')) {
        return Err("tags: up to 8 lowercase words".into());
    }
    if it.games.is_empty() || it.games.iter().any(|g| !GAMES.contains(&g.as_str())) {
        return Err(format!("games: at least one of {}", GAMES.join(", ")));
    }
    let need: &[&str] = match it.kind {
        Kind::Preset => &["ini", "jpg"],
        Kind::Lut => &["cube"],
        Kind::Pack => &["zip"],
    };
    let optional: &[&str] = if it.kind == Kind::Preset { &[] } else { &["preview"] };
    for f in &it.files {
        if !need.contains(&f.role.as_str()) && !optional.contains(&f.role.as_str()) {
            return Err(format!("file role \"{}\" does not belong here", f.role));
        }
        if !is_hex64(&f.sha256) {
            return Err(format!("{}: sha256 is not 64 hex digits", f.role));
        }
        if !(safe_rel(&f.path) || f.path.starts_with("https://")) {
            return Err(format!("{}: unusable path", f.role));
        }
    }
    for r in need {
        if it.files.iter().filter(|f| f.role == *r).count() != 1 {
            return Err(format!("needs exactly one \"{r}\" file"));
        }
    }
    if it.files.iter().filter(|f| f.role == "preview").count() > 1 {
        return Err("more than one preview".into());
    }
    if it.kind == Kind::Pack {
        match &it.env {
            Some(e) if ENVIRONMENTS.contains(&e.as_str()) => {}
            _ => return Err(format!("env: one of {}", ENVIRONMENTS.join(", "))),
        }
        if it.games.iter().any(|g| g != "tmnf" && g != "tmuf") {
            return Err("packs are for tmnf and tmuf".into());
        }
    }
    Ok(())
}

/// Parses an index. Entries that break a rule are skipped (and listed), the rest is kept.
pub fn parse_index(bytes: &[u8]) -> Result<Index, String> {
    if bytes.len() > MAX_INDEX {
        return Err("The index is larger than 2 MB".into());
    }
    let raw: RawIndex = serde_json::from_slice(bytes).map_err(|e| format!("The index is not valid JSON: {e}"))?;
    if raw.format != 1 {
        return Err(format!("The index has format {}, this version reads format 1", raw.format));
    }
    let mut out = Index::default();
    if raw.items.len() > 2000 {
        return Err("The index lists more than 2000 entries".into());
    }
    for (i, v) in raw.items.into_iter().enumerate() {
        let label = v.get("id").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| format!("#{}", i + 1));
        match serde_json::from_value::<Item>(v) {
            Ok(it) => match check_item(&it) {
                Ok(()) if out.items.iter().any(|x| x.id == it.id && x.kind == it.kind) => out.skipped.push(format!("{label}: listed twice")),
                Ok(()) => out.items.push(it),
                Err(e) => out.skipped.push(format!("{label}: {e}")),
            },
            Err(e) => out.skipped.push(format!("{label}: {e}")),
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ validation of the files

#[derive(Debug, Deserialize)]
struct FieldDef {
    key: String,
    kind: String,
    min: f64,
    max: f64,
    machine: bool,
}

/// Every preset key of TMVS (generated from src/config.cpp by tools/gen-tmvs-data.py).
fn fields() -> &'static Vec<FieldDef> {
    static F: std::sync::OnceLock<Vec<FieldDef>> = std::sync::OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("../data/tmvs-fields.json")).expect("tmvs-fields.json"))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IniInfo {
    pub description: String,
    pub keys: usize,
}

/// A preset file: at most 16 KB of UTF-8 text, sections `[Preset]` (known look keys, values inside their slider ranges;
/// installation settings such as video export or render scale are refused) and `[Info]` (`Description`).
pub fn validate_ini(bytes: &[u8]) -> Result<IniInfo, String> {
    if bytes.len() > MAX_INI {
        return Err(format!("The preset file is {} bytes, the limit is 16 KB", bytes.len()));
    }
    if bytes.contains(&0) {
        return Err("The preset file is not plain text (NUL bytes; UTF-16 is not accepted)".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "The preset file is not UTF-8 text".to_string())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut section = String::new();
    let mut seen = std::collections::HashSet::new();
    let mut description = String::new();
    let mut keys = 0usize;
    for (n, line) in text.lines().enumerate() {
        let at = |m: String| format!("line {}: {m}", n + 1);
        let l = line.trim();
        if l.is_empty() || l.starts_with(';') || l.starts_with('#') {
            continue;
        }
        if l.len() > 300 {
            return Err(at("longer than 300 characters".into()));
        }
        if let Some(rest) = l.strip_prefix('[') {
            let name = rest.strip_suffix(']').ok_or_else(|| at("broken section header".into()))?;
            if !name.eq_ignore_ascii_case("Preset") && !name.eq_ignore_ascii_case("Info") {
                return Err(at(format!("section [{name}] is not allowed (only [Preset] and [Info])")));
            }
            section = name.to_ascii_lowercase();
            continue;
        }
        let (k, v) = l.split_once('=').ok_or_else(|| at("not a Key=Value line".into()))?;
        let (k, v) = (k.trim(), v.trim());
        if section.is_empty() {
            return Err(at("a setting before any section".into()));
        }
        if !seen.insert((section.clone(), k.to_ascii_lowercase())) {
            return Err(at(format!("{k} twice")));
        }
        if section == "info" {
            if !k.eq_ignore_ascii_case("Description") {
                return Err(at(format!("[Info] only has Description, not {k}")));
            }
            if v.chars().count() > 255 || v.chars().any(|c| c.is_control()) {
                return Err(at("Description: at most 255 characters, no control characters".into()));
            }
            description = v.to_string();
            continue;
        }
        let f = fields().iter().find(|f| f.key.eq_ignore_ascii_case(k)).ok_or_else(|| at(format!("unknown setting {k}")))?;
        if f.machine {
            return Err(at(format!("{} belongs to your installation, not to a look", f.key)));
        }
        let inside = |x: f64| x.is_finite() && x >= f.min - 1e-3 && x <= f.max + 1e-3;
        match f.kind.as_str() {
            "bool" => {
                if v != "0" && v != "1" {
                    return Err(at(format!("{}: 0 or 1", f.key)));
                }
            }
            "int" => {
                let x: i64 = v.parse().map_err(|_| at(format!("{}: a whole number", f.key)))?;
                if !inside(x as f64) {
                    return Err(at(format!("{}: {} to {}", f.key, f.min, f.max)));
                }
            }
            "color" => {
                let parts: Vec<&str> = v.split(',').map(str::trim).collect();
                if parts.len() != 3 {
                    return Err(at(format!("{}: three numbers, r,g,b", f.key)));
                }
                for p in parts {
                    let x: f64 = p.parse().map_err(|_| at(format!("{}: not a number", f.key)))?;
                    if !inside(x) {
                        return Err(at(format!("{}: each part {} to {}", f.key, f.min, f.max)));
                    }
                }
            }
            _ => {
                let x: f64 = v.parse().map_err(|_| at(format!("{}: not a number", f.key)))?;
                if !inside(x) {
                    return Err(at(format!("{}: {} to {}", f.key, f.min, f.max)));
                }
            }
        }
        keys += 1;
    }
    if keys == 0 {
        return Err("The preset file has no [Preset] settings".into());
    }
    Ok(IniInfo { description, keys })
}

/// A real JPEG picture: at most 1 MB, starts and ends like a JPEG, a frame header inside, 16:9 (within 6 %), at least 160 x 90.
pub fn validate_jpeg(b: &[u8]) -> Result<(u32, u32), String> {
    if b.len() > MAX_JPG {
        return Err(format!("The picture is {} bytes, the limit is 1 MB", b.len()));
    }
    if b.len() < 4 || b[..3] != [0xff, 0xd8, 0xff] {
        return Err("The picture is not a JPEG".into());
    }
    let end = b.iter().rposition(|x| *x != 0).unwrap_or(0);
    if end < 1 || b[end - 1..=end] != [0xff, 0xd9] {
        return Err("The JPEG is cut off (no end marker)".into());
    }
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xff {
            return Err("The JPEG is damaged".into());
        }
        let m = b[i + 1];
        if m == 0xff {
            i += 1;
            continue;
        }
        if m == 0xd8 || (0xd0..=0xd7).contains(&m) || m == 0x01 {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if (0xc0..=0xcf).contains(&m) && m != 0xc4 && m != 0xc8 && m != 0xcc {
            if i + 9 > b.len() {
                break;
            }
            let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            if w < 160 || h < 90 || w > 4096 || h > 4096 {
                return Err(format!("The picture is {w} x {h}, it should be 16:9 and between 160 x 90 and 4096 x 4096"));
            }
            let ratio = w as f64 / h as f64;
            if (ratio / (16.0 / 9.0) - 1.0).abs() > 0.06 {
                return Err(format!("The picture is {w} x {h}: it should be 16:9"));
            }
            return Ok((w, h));
        }
        if m == 0xda {
            break;
        }
        i += 2 + len;
    }
    Err("The JPEG has no frame header".into())
}

/// A 3D `.cube` look-up table up to 64 x 64 x 64 and 8 MB, input range 0..1; 1D tables and other domains are refused (TMVS cannot load them).
pub fn validate_cube(b: &[u8]) -> Result<usize, String> {
    if b.len() > MAX_CUBE {
        return Err(format!("The look is {} bytes, the limit is 8 MB", b.len()));
    }
    let text = std::str::from_utf8(b).map_err(|_| "The look is not text".to_string())?;
    let mut size = 0usize;
    let mut rows = 0usize;
    let triple = |s: &str| -> Option<[f64; 3]> {
        let v: Vec<f64> = s.split_whitespace().map(|x| x.parse::<f64>().ok().filter(|f| f.is_finite())).collect::<Option<Vec<_>>>()?;
        if v.len() == 3 { Some([v[0], v[1], v[2]]) } else { None }
    };
    for (n, line) in text.lines().enumerate() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let first = l.split_whitespace().next().unwrap_or("");
        if first.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            let rest = l[first.len()..].trim();
            match first {
                "TITLE" => {}
                "LUT_3D_SIZE" => {
                    size = rest.parse().map_err(|_| format!("line {}: LUT_3D_SIZE is not a number", n + 1))?;
                    if !(2..=64).contains(&size) {
                        return Err(format!("LUT_3D_SIZE {size}: TMVS reads 2 to 64"));
                    }
                }
                "LUT_1D_SIZE" => return Err("1D look-up tables are not supported (a 3D .cube is needed)".into()),
                "DOMAIN_MIN" => {
                    if triple(rest) != Some([0.0, 0.0, 0.0]) {
                        return Err("DOMAIN_MIN other than 0 0 0 is not supported".into());
                    }
                }
                "DOMAIN_MAX" => {
                    if triple(rest) != Some([1.0, 1.0, 1.0]) {
                        return Err("DOMAIN_MAX other than 1 1 1 is not supported".into());
                    }
                }
                other => return Err(format!("line {}: unknown keyword {other}", n + 1)),
            }
            continue;
        }
        if size == 0 {
            return Err(format!("line {}: table values before LUT_3D_SIZE", n + 1));
        }
        triple(l).ok_or_else(|| format!("line {}: not three numbers", n + 1))?;
        rows += 1;
        if rows > size * size * size {
            return Err("More table rows than SIZE^3".into());
        }
    }
    if size == 0 {
        return Err("No LUT_3D_SIZE: not a 3D .cube file".into());
    }
    if rows != size * size * size {
        return Err(format!("{rows} table rows, {} expected for size {size}", size * size * size));
    }
    Ok(size)
}

/// An environment mod zip: at most 64 MB, a readable zip with no odd paths, nothing that runs, at most 5000 files and 256 MB unpacked.
pub fn validate_zip(b: &[u8]) -> Result<usize, String> {
    if b.len() > MAX_ZIP {
        return Err("The pack is larger than 64 MB".into());
    }
    if b.len() < 22 || &b[..2] != b"PK" {
        return Err("The pack is not a zip".into());
    }
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(b)).map_err(|e| format!("The pack is not a readable zip: {e}"))?;
    if z.len() == 0 || z.len() > 5000 {
        return Err(format!("The zip holds {} entries (1 to 5000 are accepted)", z.len()));
    }
    let mut total: u64 = 0;
    let mut images = 0usize;
    for i in 0..z.len() {
        let f = z.by_index_raw(i).map_err(|e| format!("The zip is damaged: {e}"))?;
        let name = f.name().replace('\\', "/");
        if name.starts_with('/') || name.contains(':') || name.split('/').any(|s| s == "..") || name.chars().any(|c| c.is_control()) {
            return Err(format!("The zip holds an unsafe path: {name}"));
        }
        total += f.size();
        if f.is_dir() {
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if ["exe", "dll", "bat", "cmd", "ps1", "vbs", "js", "jse", "msi", "scr", "lnk", "com", "jar", "sh", "py", "hta", "reg", "zip", "7z", "rar"].contains(&ext.as_str()) {
            return Err(format!("The zip holds a .{ext} file ({name}); a mod pack only has textures and sounds"));
        }
        if ["dds", "tga", "png", "jpg", "jpeg", "bmp"].contains(&ext.as_str()) {
            images += 1;
        }
    }
    if total > 256 << 20 {
        return Err("The zip unpacks to more than 256 MB".into());
    }
    if images == 0 {
        return Err("The zip holds no textures".into());
    }
    Ok(z.len())
}

/// Share codes (`TMVS1:...`): the code inside a chat message or a clipboard text, whitespace removed. Only the shape is checked here,
/// decoding is TMVS's own (its Shaders page: Paste share code).
pub fn share_code(text: &str) -> Result<String, String> {
    let is_code = |c: char| c.is_ascii_alphanumeric() || "+/=_-".contains(c);
    let at = text.find("TMVS1:").ok_or("No share code: it starts with TMVS1:")?;
    let mut lines = text[at..].lines();
    let first = lines.next().unwrap_or("");
    let mut code: String = first.split_whitespace().next().unwrap_or("").chars().take_while(|c| *c == ':' || is_code(*c)).collect();
    // A code broken over lines: the following lines that are one single token of code characters.
    if first.trim_end() == code || first.split_whitespace().count() == 1 {
        for l in lines {
            let t = l.trim();
            if t.is_empty() || t.contains(char::is_whitespace) || !t.chars().all(is_code) {
                break;
            }
            code.push_str(t);
        }
    }
    let body = &code["TMVS1:".len()..];
    if body.len() < 8 {
        return Err("The share code is too short".into());
    }
    if code.len() > MAX_CODE {
        return Err("The share code is longer than 4000 characters".into());
    }
    Ok(code)
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

// ------------------------------------------------------------------ where the files go

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Target {
    /// "forever" (Nations, United, ESWC: Documents\TrackMania) or "maniaplanet" (TM2: Documents\ManiaPlanet).
    pub id: &'static str,
    pub dir: PathBuf,
}

pub fn documents_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("TMHUB_DOCUMENTS_DIR") {
        if !d.trim().is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    crate::platform::documents_dir()
}

pub fn family(game: &str) -> Option<&'static str> {
    match game {
        "tmnf" | "tmuf" | "tmn-eswc" => Some("forever"),
        "tm2" => Some("maniaplanet"),
        g if g.starts_with("tm2-") => Some("maniaplanet"),
        _ => None,
    }
}

pub fn target_dir(docs: &Path, kind: Kind, family: &str, env: Option<&str>) -> Option<PathBuf> {
    let root = docs.join(if family == "maniaplanet" { "ManiaPlanet" } else { "TrackMania" });
    match (kind, family) {
        (Kind::Preset, _) => Some(root.join("TMVS").join("presets")),
        (Kind::Lut, _) => Some(root.join("TMVS").join("luts")),
        (Kind::Pack, "forever") => env.filter(|e| ENVIRONMENTS.contains(e)).map(|e| root.join("Skins").join(e).join("Mod")),
        _ => None,
    }
}

pub fn targets_for(docs: &Path, item: &Item) -> Vec<Target> {
    let mut out: Vec<Target> = vec![];
    for g in &item.games {
        if let Some(f) = family(g) {
            if out.iter().any(|t| t.id == f) {
                continue;
            }
            if let Some(dir) = target_dir(docs, item.kind, f, item.env.as_deref()) {
                out.push(Target { id: if f == "forever" { "forever" } else { "maniaplanet" }, dir });
            }
        }
    }
    out
}

// ------------------------------------------------------------------ manifest

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rec {
    pub kind: Kind,
    pub name: String,
    pub item_id: String,
    pub target: String,
    pub files: Vec<RecFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecFile {
    pub path: String,
    pub sha256: String,
}

pub fn load_manifest(path: &Path) -> Vec<Rec> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_manifest(path: &Path, recs: &[Rec]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(recs).map_err(|e| e.to_string())?;
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, json).map_err(|e| format!("{}: {e}", path.display()))
}

// ------------------------------------------------------------------ install / remove

#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub target: String,
    pub ok: bool,
    pub message: String,
}

/// Files of an item as downloaded: role -> bytes (hash already checked by the caller).
pub type Files = Vec<(String, Vec<u8>)>;

/// Validates everything, then writes. Returns one outcome per target; a target whose file exists but was not installed
/// here is skipped (never overwritten).
pub fn install(manifest: &Path, item: &Item, files: &Files, targets: &[Target]) -> Result<Vec<Outcome>, String> {
    let get = |r: &str| files.iter().find(|(role, _)| role == r).map(|(_, b)| b.as_slice());
    let name = clean_name(&item.name)?;
    // What gets written: (extension, bytes).
    let mut write: Vec<(&str, &[u8])> = vec![];
    match item.kind {
        Kind::Preset => {
            let ini = get("ini").ok_or("The preset's .ini is missing")?;
            let jpg = get("jpg").ok_or("The preset's picture is missing")?;
            validate_ini(ini)?;
            validate_jpeg(jpg)?;
            write.push(("ini", ini));
            write.push(("jpg", jpg));
        }
        Kind::Lut => {
            let cube = get("cube").ok_or("The .cube is missing")?;
            validate_cube(cube)?;
            write.push(("cube", cube));
        }
        Kind::Pack => {
            let z = get("zip").ok_or("The zip is missing")?;
            validate_zip(z)?;
            write.push(("zip", z));
        }
    }
    let mut recs = load_manifest(manifest);
    let mut out = vec![];
    for t in targets {
        let paths: Vec<PathBuf> = write.iter().map(|(ext, _)| t.dir.join(format!("{name}.{ext}"))).collect();
        let key = |p: &PathBuf| crate::fsx::norm(p);
        let mine = recs.iter().position(|r| r.kind == item.kind && r.target == t.id && r.files.iter().any(|f| paths.iter().any(|p| key(p) == crate::fsx::norm(Path::new(&f.path)))));
        let blocker = paths.iter().find(|p| p.exists() && mine.is_none());
        if let Some(p) = blocker {
            out.push(Outcome { target: t.id.into(), ok: false, message: format!("{} exists and was not installed by TM Horizon: left alone", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) });
            continue;
        }
        let mut done: Vec<RecFile> = vec![];
        let mut failed = None;
        for (p, (_, bytes)) in paths.iter().zip(&write) {
            match crate::fsx::write(p, bytes) {
                Ok(()) => done.push(RecFile { path: p.to_string_lossy().into_owned(), sha256: sha256_hex(bytes) }),
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        if let Some(e) = failed {
            for f in &done {
                let _ = std::fs::remove_file(&f.path);
            }
            out.push(Outcome { target: t.id.into(), ok: false, message: e });
            continue;
        }
        if let Some(i) = mine {
            recs.remove(i);
        }
        recs.push(Rec { kind: item.kind, name: name.clone(), item_id: item.id.clone(), target: t.id.into(), files: done });
        out.push(Outcome { target: t.id.into(), ok: true, message: format!("Installed {name}") });
    }
    save_manifest(manifest, &recs)?;
    Ok(out)
}

/// Removes what `install` wrote for this name (all targets, or one). A file changed since the install stays.
pub fn remove(manifest: &Path, kind: Kind, name: &str, target: Option<&str>) -> Result<Vec<Outcome>, String> {
    let mut recs = load_manifest(manifest);
    let mut out = vec![];
    let mut keep = vec![];
    for r in recs.drain(..) {
        if r.kind != kind || r.name != name || target.is_some_and(|t| t != r.target) {
            keep.push(r);
            continue;
        }
        let mut left = vec![];
        for f in &r.files {
            let p = Path::new(&f.path);
            match std::fs::read(p) {
                Err(_) => {}
                Ok(b) if sha256_hex(&b) == f.sha256 => {
                    if let Err(e) = crate::fsx::check(p).and_then(|_| std::fs::remove_file(p).map_err(|e| e.to_string())) {
                        out.push(Outcome { target: r.target.clone(), ok: false, message: e });
                        left.push(f.clone());
                    }
                }
                Ok(_) => {
                    out.push(Outcome { target: r.target.clone(), ok: false, message: format!("{} was changed after the install: left alone", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) });
                }
            }
        }
        if left.is_empty() && !out.iter().any(|o| o.target == r.target && !o.ok) {
            out.push(Outcome { target: r.target.clone(), ok: true, message: format!("Removed {name}") });
        } else if !left.is_empty() {
            keep.push(Rec { files: left, ..r });
        }
    }
    save_manifest(manifest, &keep)?;
    if out.is_empty() {
        return Err(format!("{name} was not installed by TM Horizon"));
    }
    Ok(out)
}

// ------------------------------------------------------------------ local files

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Local {
    pub kind: Kind,
    pub name: String,
    pub target: String,
    pub file: String,
    pub picture: Option<String>,
    pub description: String,
    pub installed_here: bool,
}

/// The presets / looks / packs lying in the folders, with the ones this module installed marked.
pub fn list_local(manifest: &Path, docs: &Path, kind: Kind) -> Vec<Local> {
    let recs = load_manifest(manifest);
    let ext = match kind {
        Kind::Preset => "ini",
        Kind::Lut => "cube",
        Kind::Pack => "zip",
    };
    let mut dirs: Vec<(String, PathBuf)> = vec![];
    for f in ["forever", "maniaplanet"] {
        if kind == Kind::Pack {
            for e in ENVIRONMENTS {
                if let Some(d) = target_dir(docs, kind, f, Some(e)) {
                    dirs.push((f.into(), d));
                }
            }
        } else if let Some(d) = target_dir(docs, kind, f, None) {
            dirs.push((f.into(), d));
        }
    }
    let mut out = vec![];
    for (t, dir) in dirs {
        for e in crate::fsx::list(&dir) {
            if !e.is_file || !e.name.to_lowercase().ends_with(&format!(".{ext}")) || e.name.starts_with('.') {
                continue;
            }
            let name = e.name[..e.name.len() - ext.len() - 1].to_string();
            let pic = dir.join(format!("{name}.jpg"));
            let description = if kind == Kind::Preset {
                std::fs::read(&e.path).ok().and_then(|b| validate_ini(&b).ok()).map(|i| i.description).unwrap_or_default()
            } else {
                String::new()
            };
            let here = recs.iter().any(|r| r.kind == kind && r.target == t && r.files.iter().any(|f| crate::fsx::norm(Path::new(&f.path)) == crate::fsx::norm(&e.path)));
            out.push(Local {
                kind,
                name,
                target: t.clone(),
                file: e.path.to_string_lossy().into_owned(),
                picture: if kind == Kind::Preset && pic.is_file() { Some(pic.to_string_lossy().into_owned()) } else { None },
                description,
                installed_here: here,
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// ------------------------------------------------------------------ sources

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    Url(String),
    Dir(PathBuf),
}

pub fn parse_source(s: &str) -> Result<Source, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("No source".into());
    }
    if s.to_ascii_lowercase().starts_with("https://") {
        let u = url::Url::parse(s).map_err(|e| format!("{s}: {e}"))?;
        let mut u = u;
        if !u.path().ends_with(".json") {
            let p = format!("{}/index.json", u.path().trim_end_matches('/'));
            u.set_path(&p);
        }
        return Ok(Source::Url(u.to_string()));
    }
    if s.to_ascii_lowercase().starts_with("http://") {
        return Err("Only https addresses are accepted".into());
    }
    Ok(Source::Dir(PathBuf::from(s)))
}

/// Where a file named in the index lives: next to the index, or an https address on the index's own host.
pub fn resolve(src: &Source, path: &str) -> Result<String, String> {
    match src {
        Source::Dir(d) => {
            if !safe_rel(path) {
                return Err(format!("{path}: a folder source takes relative paths inside the folder"));
            }
            Ok(d.join(path).to_string_lossy().into_owned())
        }
        Source::Url(base) => {
            let b = url::Url::parse(base).map_err(|e| e.to_string())?;
            let u = if path.starts_with("https://") { url::Url::parse(path).map_err(|e| e.to_string())? } else if safe_rel(path) { b.join(path).map_err(|e| e.to_string())? } else { return Err(format!("{path}: unusable path")) };
            if u.scheme() != "https" || u.host_str() != b.host_str() {
                return Err(format!("{path}: files must come from the index's own host ({})", b.host_str().unwrap_or("?")));
            }
            Ok(u.to_string())
        }
    }
}

pub fn read_source(src: &Source, path_or_url: &str, max: usize) -> Result<Vec<u8>, String> {
    match src {
        Source::Dir(_) => {
            let p = Path::new(path_or_url);
            let meta = std::fs::metadata(p).map_err(|e| format!("{path_or_url}: {e}"))?;
            if meta.len() as usize > max {
                return Err(format!("{path_or_url}: larger than {max} bytes"));
            }
            std::fs::read(p).map_err(|e| format!("{path_or_url}: {e}"))
        }
        Source::Url(_) => crate::net::get_bytes(path_or_url, max as u64),
    }
}

pub fn index_location(src: &Source) -> String {
    match src {
        Source::Dir(d) => d.join("index.json").to_string_lossy().into_owned(),
        Source::Url(u) => u.clone(),
    }
}

pub fn fetch_index(src: &Source) -> Result<Index, String> {
    let bytes = read_source(src, &index_location(src), MAX_INDEX)?;
    parse_index(&bytes)
}

fn max_for(role: &str) -> usize {
    match role {
        "ini" => MAX_INI,
        "cube" => MAX_CUBE,
        "zip" => MAX_ZIP,
        _ => MAX_JPG,
    }
}

/// Downloads (or reads) the item's files and checks each against the index's SHA-256. `preview` is not needed to install.
pub fn fetch_files(src: &Source, item: &Item) -> Result<Files, String> {
    let mut out = vec![];
    for f in item.files.iter().filter(|f| f.role != "preview") {
        let loc = resolve(src, &f.path)?;
        let b = read_source(src, &loc, max_for(&f.role))?;
        if !sha256_hex(&b).eq_ignore_ascii_case(&f.sha256) {
            return Err(format!("{}: the file does not match the index's SHA-256, nothing was installed", f.path));
        }
        out.push((f.role.clone(), b));
    }
    Ok(out)
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8];
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&[1, 1, 0x11, 0]);
        v.extend_from_slice(&[0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9]);
        v
    }

    const GOOD_INI: &str = "[Info]\nDescription=Test\n[Preset]\nShadowStrength=0.5\nAOStrength=1.2\nSkyColor=0.1,0.2,0.3\nSMAA=1\n";

    #[test]
    fn ini_rules() {
        assert_eq!(validate_ini(GOOD_INI.as_bytes()).unwrap(), IniInfo { description: "Test".into(), keys: 4 });
        assert!(validate_ini(b"[Preset]\nNoSuchKey=1\n").unwrap_err().contains("unknown setting"));
        assert!(validate_ini(b"[Preset]\nShadowStrength=7\n").unwrap_err().contains("0 to 1"));
        assert!(validate_ini(b"[Preset]\nShadowStrength=abc\n").is_err());
        assert!(validate_ini(b"[Preset]\nShadowStrength=NaN\n").is_err());
        assert!(validate_ini(b"[Preset]\nSkyColor=0.1,0.2\n").is_err());
        assert!(validate_ini(b"[Preset]\nSMAA=2\n").is_err());
        assert!(validate_ini(b"[Preset]\nVideoCodec=1\n").unwrap_err().contains("installation"));
        assert!(validate_ini(b"[Preset]\nRenderScale=0.5\n").is_err());
        assert!(validate_ini(b"[Settings]\nShadowStrength=0.5\n").unwrap_err().contains("not allowed"));
        assert!(validate_ini(b"ShadowStrength=0.5\n").is_err());
        assert!(validate_ini(b"[Preset]\nShadowStrength=0.5\nshadowstrength=0.4\n").unwrap_err().contains("twice"));
        assert!(validate_ini(b"[Info]\nDescription=x\n").unwrap_err().contains("no [Preset]"));
        assert!(validate_ini(b"[Preset]\nShadowStrength=0.5\n[Info]\nOther=1\n").is_err());
        assert!(validate_ini(&[b'['; 17000]).unwrap_err().contains("16 KB"));
        assert!(validate_ini(b"\xff\xfe[\0P\0").is_err());
        assert!(validate_ini(b"; comment\n\n[Preset]\r\nShadowStrength = 0.5\r\n").is_ok());
    }

    #[test]
    fn jpeg_rules() {
        assert_eq!(validate_jpeg(&jpeg(384, 216)).unwrap(), (384, 216));
        assert!(validate_jpeg(&jpeg(400, 400)).unwrap_err().contains("16:9"));
        assert!(validate_jpeg(&jpeg(100, 56)).is_err());
        assert!(validate_jpeg(b"\x89PNG\r\n\x1a\n").unwrap_err().contains("not a JPEG"));
        let mut cut = jpeg(384, 216);
        cut.truncate(cut.len() - 2);
        assert!(validate_jpeg(&cut).is_err());
        assert!(validate_jpeg(&vec![0xff; 2_000_000]).unwrap_err().contains("1 MB"));
    }

    fn cube(n: usize, extra: &str) -> String {
        let mut s = format!("TITLE \"t\"\n# c\nLUT_3D_SIZE {n}\n{extra}");
        for _ in 0..n * n * n {
            s.push_str("0.1 0.2 0.3\n");
        }
        s
    }

    #[test]
    fn cube_rules() {
        assert_eq!(validate_cube(cube(4, "").as_bytes()).unwrap(), 4);
        assert_eq!(validate_cube(cube(2, "DOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n").as_bytes()).unwrap(), 2);
        assert!(validate_cube(cube(2, "DOMAIN_MAX 2 2 2\n").as_bytes()).is_err());
        assert!(validate_cube(b"LUT_1D_SIZE 16\n0 0 0\n").unwrap_err().contains("1D"));
        assert!(validate_cube(b"LUT_3D_SIZE 65\n").unwrap_err().contains("2 to 64"));
        assert!(validate_cube(b"LUT_3D_SIZE 2\n0 0 0\n").unwrap_err().contains("expected"));
        assert!(validate_cube(b"0 0 0\n").is_err());
        assert!(validate_cube(b"hello\n").is_err());
        assert!(validate_cube(cube(2, "").replace("0.2", "x").as_bytes()).is_err());
        assert!(validate_cube(&vec![b'#'; 9 << 20]).unwrap_err().contains("8 MB"));
    }

    fn zip_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (n, d) in files {
            w.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(d).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn zip_rules() {
        assert_eq!(validate_zip(&zip_with(&[("Image/Stadium/Road.dds", b"x"), ("preview.png", b"y")])).unwrap(), 2);
        assert!(validate_zip(&zip_with(&[("../evil.dds", b"x")])).unwrap_err().contains("unsafe"));
        assert!(validate_zip(&zip_with(&[("a.dds", b"x"), ("run.exe", b"x")])).unwrap_err().contains(".exe"));
        assert!(validate_zip(&zip_with(&[("readme.txt", b"x")])).unwrap_err().contains("no textures"));
        assert!(validate_zip(b"not a zip at all, but long enough......").is_err());
    }

    #[test]
    fn share_codes() {
        assert_eq!(share_code("look: TMVS1:abcdEFGH12\n34ab==\nthanks a lot").unwrap(), "TMVS1:abcdEFGH1234ab==");
        assert_eq!(share_code("TMVS1:abcdEFGH12 thanks").unwrap(), "TMVS1:abcdEFGH12");
        assert!(share_code("TMVS1:ab").is_err());
        assert!(share_code("hello").is_err());
        assert!(share_code(&format!("TMVS1:{}", "a".repeat(5000))).is_err());
    }

    fn item(kind: Kind, name: &str, games: &[&str], env: Option<&str>, files: &[(&str, &str)]) -> Item {
        Item {
            id: "test-item".into(), kind, name: name.into(), author: "me".into(), description: "d".into(), tags: vec!["day".into()],
            games: games.iter().map(|g| g.to_string()).collect(), env: env.map(String::from),
            files: files.iter().map(|(r, p)| FileRef { role: (*r).into(), path: (*p).into(), sha256: "0".repeat(64) }).collect(), example: false,
        }
    }

    #[test]
    fn index_rules() {
        let ok = serde_json::json!({"format": 1, "items": [
            {"id":"a-1","kind":"preset","name":"Alpha","author":"x","description":"d","tags":["night"],"games":["tmnf","tm2"],"files":[{"role":"ini","path":"p/a.ini","sha256":"0".repeat(64)},{"role":"jpg","path":"p/a.jpg","sha256":"1".repeat(64)}]},
            {"id":"a-1","kind":"preset","name":"Dup","author":"x","description":"d","games":["tmnf"],"files":[{"role":"ini","path":"p/a.ini","sha256":"0".repeat(64)},{"role":"jpg","path":"p/a.jpg","sha256":"1".repeat(64)}]},
            {"id":"b","kind":"preset","name":"Vibrant","author":"x","description":"d","games":["tmnf"],"files":[]},
            {"id":"c-1","kind":"preset","name":"Gamma","author":"x","description":"d","games":["tmnf"],"files":[{"role":"ini","path":"../x.ini","sha256":"0".repeat(64)},{"role":"jpg","path":"x.jpg","sha256":"1".repeat(64)}]},
            {"id":"d-1","kind":"lut","name":"Delta","author":"x","description":"d","games":["tm2"],"files":[{"role":"cube","path":"l/d.cube","sha256":"0".repeat(64)}]},
            {"id":"e-1","kind":"pack","name":"Eps","author":"x","description":"d","games":["tm2"],"env":"Stadium","files":[{"role":"zip","path":"e.zip","sha256":"0".repeat(64)}]},
            {"id":"f-1","kind":"pack","name":"Zeta","author":"x","description":"d","games":["tmnf"],"env":"Mars","files":[{"role":"zip","path":"e.zip","sha256":"0".repeat(64)}]},
            {"id":"g-1","kind":"preset","name":"Eta","author":"x","description":"d","games":["tmnf"],"files":[{"role":"ini","path":"a.ini","sha256":"zz"},{"role":"jpg","path":"a.jpg","sha256":"1".repeat(64)}]},
            {"nonsense": true}
        ]});
        let idx = parse_index(ok.to_string().as_bytes()).unwrap();
        assert_eq!(idx.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["a-1", "d-1"]);
        assert_eq!(idx.skipped.len(), 7, "{:?}", idx.skipped);
        assert!(parse_index(br#"{"format":2,"items":[]}"#).is_err());
        assert!(parse_index(b"nope").is_err());
    }

    #[test]
    fn names() {
        assert!(clean_name("Night Drive (v2)").is_ok());
        for bad in ["", "a/b", "a:b", "CON", "com1", "x.", &"x".repeat(41), "tab\tname"] {
            assert!(clean_name(bad).is_err(), "{bad}");
        }
        assert!(safe_rel("presets/a/a.ini"));
        for bad in ["../a", "/a", "a//b", "a\\b", "C:/a", "a?b", ""] {
            assert!(!safe_rel(bad), "{bad}");
        }
    }

    #[test]
    fn install_and_remove_in_temp_folders() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("Documents");
        let manifest = t.path().join("data").join("tmvs-content.json");
        let it = item(Kind::Preset, "Test Look", &["tmnf", "tmuf", "tm2"], None, &[("ini", "a.ini"), ("jpg", "a.jpg")]);
        let files: Files = vec![("ini".into(), GOOD_INI.as_bytes().to_vec()), ("jpg".into(), jpeg(384, 216))];
        let targets = targets_for(&docs, &it);
        assert_eq!(targets.iter().map(|x| x.id).collect::<Vec<_>>(), ["forever", "maniaplanet"]);
        assert!(targets[0].dir.ends_with("TrackMania/TMVS/presets") || targets[0].dir.ends_with("TrackMania\\TMVS\\presets"));

        let r = install(&manifest, &it, &files, &targets).unwrap();
        assert!(r.iter().all(|o| o.ok), "{r:?}");
        assert!(targets[0].dir.join("Test Look.ini").is_file() && targets[0].dir.join("Test Look.jpg").is_file());
        assert!(targets[1].dir.join("Test Look.ini").is_file());
        assert_eq!(load_manifest(&manifest).len(), 2);

        // Installing again (an update) replaces; a foreign file with the same name is never touched.
        assert!(install(&manifest, &it, &files, &targets).unwrap().iter().all(|o| o.ok));
        assert_eq!(load_manifest(&manifest).len(), 2);
        std::fs::write(targets[0].dir.join("Mine.ini"), "[Preset]\nBloom=1\n").unwrap();
        let mine = item(Kind::Preset, "Mine", &["tmnf"], None, &[("ini", "a.ini"), ("jpg", "a.jpg")]);
        let r = install(&manifest, &mine, &files, &targets[..1]).unwrap();
        assert!(!r[0].ok && r[0].message.contains("left alone"));
        assert_eq!(std::fs::read_to_string(targets[0].dir.join("Mine.ini")).unwrap(), "[Preset]\nBloom=1\n");

        // Bad content writes nothing.
        let bad: Files = vec![("ini".into(), b"[Preset]\nNope=1\n".to_vec()), ("jpg".into(), jpeg(384, 216))];
        let other = item(Kind::Preset, "Other", &["tmnf"], None, &[("ini", "a.ini"), ("jpg", "a.jpg")]);
        assert!(install(&manifest, &other, &bad, &targets[..1]).is_err());
        assert!(!targets[0].dir.join("Other.ini").exists());

        let listed = list_local(&manifest, &docs, Kind::Preset);
        assert_eq!(listed.iter().filter(|l| l.installed_here).count(), 2);
        assert!(listed.iter().any(|l| l.name == "Mine" && !l.installed_here));
        assert!(listed.iter().find(|l| l.name == "Test Look" && l.target == "forever").unwrap().picture.is_some());

        // Remove: only ours; a changed file stays.
        let r = remove(&manifest, Kind::Preset, "Test Look", Some("maniaplanet")).unwrap();
        assert!(r[0].ok && !targets[1].dir.join("Test Look.ini").exists());
        std::fs::write(targets[0].dir.join("Test Look.ini"), "[Preset]\nBloom=0.3\n").unwrap();
        let r = remove(&manifest, Kind::Preset, "Test Look", None).unwrap();
        assert!(r.iter().any(|o| !o.ok && o.message.contains("changed")));
        assert!(targets[0].dir.join("Test Look.ini").exists());
        assert!(!targets[0].dir.join("Test Look.jpg").exists());
        assert!(remove(&manifest, Kind::Preset, "Mine", None).is_err());
        assert!(targets[0].dir.join("Mine.ini").exists());
    }

    #[test]
    fn looks_and_packs_go_to_their_folders() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("D");
        let manifest = t.path().join("m.json");
        let lut = item(Kind::Lut, "Warm", &["tmnf", "tm2"], None, &[("cube", "w.cube")]);
        let tg = targets_for(&docs, &lut);
        let r = install(&manifest, &lut, &vec![("cube".into(), cube(2, "").into_bytes())], &tg).unwrap();
        assert!(r.iter().all(|o| o.ok));
        assert!(docs.join("TrackMania").join("TMVS").join("luts").join("Warm.cube").is_file());
        assert!(docs.join("ManiaPlanet").join("TMVS").join("luts").join("Warm.cube").is_file());

        let pack = item(Kind::Pack, "DarkBlue", &["tmnf", "tmuf"], Some("Stadium"), &[("zip", "p.zip")]);
        let tp = targets_for(&docs, &pack);
        assert_eq!(tp.len(), 1);
        let z = zip_with(&[("Image/Stadium/Road.dds", b"x")]);
        assert!(install(&manifest, &pack, &vec![("zip".into(), z)], &tp).unwrap()[0].ok);
        assert!(docs.join("TrackMania").join("Skins").join("Stadium").join("Mod").join("DarkBlue.zip").is_file());
        assert!(remove(&manifest, Kind::Pack, "DarkBlue", None).unwrap()[0].ok);
        assert!(!docs.join("TrackMania").join("Skins").join("Stadium").join("Mod").join("DarkBlue.zip").exists());
        // A pack for TM2 has no target.
        assert!(targets_for(&docs, &item(Kind::Pack, "X", &["tm2"], Some("Stadium"), &[("zip", "p.zip")])).is_empty());
    }

    /// With TMVS_PRESETS_REPO=<folder of the tmvs-presets repository>: every entry of its index passes the same checks the launcher applies.
    #[test]
    fn the_presets_repository_installs() {
        let Ok(repo) = std::env::var("TMVS_PRESETS_REPO") else { return };
        let src = parse_source(&repo).unwrap();
        let idx = fetch_index(&src).unwrap();
        assert!(idx.skipped.is_empty(), "{:?}", idx.skipped);
        assert!(!idx.items.is_empty());
        let t = tempfile::tempdir().unwrap();
        for it in &idx.items {
            let files = fetch_files(&src, it).unwrap();
            let tg = targets_for(&t.path().join("D"), it);
            let r = install(&t.path().join("m.json"), it, &files, &tg).unwrap();
            assert!(r.iter().all(|o| o.ok), "{}: {r:?}", it.id);
        }
    }

    #[test]
    fn folder_and_url_sources() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("presets")).unwrap();
        let ini = GOOD_INI.as_bytes();
        std::fs::write(t.path().join("presets").join("a.ini"), ini).unwrap();
        std::fs::write(t.path().join("presets").join("a.jpg"), jpeg(384, 216)).unwrap();
        let mut it = item(Kind::Preset, "Alpha", &["tmnf"], None, &[("ini", "presets/a.ini"), ("jpg", "presets/a.jpg")]);
        it.files[0].sha256 = sha256_hex(ini);
        it.files[1].sha256 = sha256_hex(&jpeg(384, 216));
        let idx = serde_json::json!({"format": 1, "items": [it]});
        std::fs::write(t.path().join("index.json"), idx.to_string()).unwrap();
        let src = parse_source(&t.path().to_string_lossy()).unwrap();
        let got = fetch_index(&src).unwrap();
        assert_eq!(got.items.len(), 1);
        let files = fetch_files(&src, &got.items[0]).unwrap();
        assert_eq!(files.len(), 2);
        // A changed file fails the hash check.
        std::fs::write(t.path().join("presets").join("a.ini"), b"[Preset]\nBloom=0.5\n").unwrap();
        assert!(fetch_files(&src, &got.items[0]).unwrap_err().contains("SHA-256"));

        let u = parse_source("https://raw.githubusercontent.com/cheatoskar/tmvs-presets/main/").unwrap();
        assert_eq!(u, Source::Url("https://raw.githubusercontent.com/cheatoskar/tmvs-presets/main/index.json".into()));
        assert_eq!(resolve(&u, "presets/a/a.ini").unwrap(), "https://raw.githubusercontent.com/cheatoskar/tmvs-presets/main/presets/a/a.ini");
        assert!(resolve(&u, "https://evil.example/a.ini").is_err());
        assert!(resolve(&u, "../a.ini").is_err());
        assert!(parse_source("http://example.com/").is_err());
    }
}

// ------------------------------------------------------------------ Tauri commands

pub mod app {
    use super::*;
    use crate::state::AppState;
    use serde_json::{json, Value};
    use tauri::{AppHandle, Manager};

    fn manifest(st: &AppState) -> PathBuf {
        st.data_dir.join("tmvs-content.json")
    }

    fn docs() -> Result<PathBuf, String> {
        documents_dir().ok_or_else(|| "The Documents folder was not found".to_string())
    }

    fn allow(app: &AppHandle, dir: &Path) {
        if dir.is_dir() {
            let _ = app.asset_protocol_scope().allow_directory(dir, true);
        }
    }

    /// Folders, what lies in them, and which of it TM Horizon installed.
    #[tauri::command]
    pub async fn tmvs_content_state(app: AppHandle, kind: Kind) -> Value {
        crate::bg::run(move || -> Value {
            let st = tauri::Manager::state::<AppState>(&app);
            let Ok(docs) = docs() else { return json!({ "docs": null, "dirs": [], "local": [] }) };
            let mut dirs = vec![];
            for f in ["forever", "maniaplanet"] {
                if kind == Kind::Pack && f == "maniaplanet" {
                    continue;
                }
                let d = if kind == Kind::Pack { docs.join("TrackMania").join("Skins") } else { target_dir(&docs, kind, f, None).unwrap_or_default() };
                dirs.push(json!({ "id": f, "path": d, "exists": d.is_dir() }));
            }
            let local = list_local(&manifest(&st), &docs, kind);
            if kind == Kind::Preset {
                for l in &local {
                    if let Some(p) = Path::new(&l.file).parent() {
                        allow(&app, p);
                    }
                }
            }
            json!({ "docs": docs, "dirs": dirs, "local": local })
        })
        .await
    }

    /// The index of a source (https address or folder), with where each entry's picture is.
    #[tauri::command]
    pub async fn tmvs_content_index(app: AppHandle, source: String) -> Result<Value, String> {
        crate::bg::run(move || -> Result<Value, String> {
            let src = parse_source(&source)?;
            let idx = fetch_index(&src)?;
            if let Source::Dir(d) = &src {
                allow(&app, d);
            }
            let items: Vec<Value> = idx
                .items
                .iter()
                .map(|it| {
                    let pic = it.files.iter().find(|f| f.role == "jpg" || f.role == "preview").and_then(|f| resolve(&src, &f.path).ok());
                    let mut v = serde_json::to_value(it).unwrap_or(Value::Null);
                    v["preview"] = json!(pic);
                    v["previewLocal"] = json!(matches!(src, Source::Dir(_)));
                    v
                })
                .collect();
            Ok(json!({ "items": items, "skipped": idx.skipped, "local": matches!(src, Source::Dir(_)), "location": index_location(&src) }))
        })
        .await
    }

    #[tauri::command]
    pub async fn tmvs_content_install(app: tauri::AppHandle, source: String, kind: Kind, item_id: String, targets: Vec<String>) -> Result<Vec<Outcome>, String> {
        crate::bg::run(move || -> Result<Vec<Outcome>, String> {
            let st = tauri::Manager::state::<AppState>(&app);
            let src = parse_source(&source)?;
            let idx = fetch_index(&src)?;
            let item = idx.items.iter().find(|i| i.id == item_id && i.kind == kind).ok_or("That entry is not in the index (any more)")?;
            let docs = docs()?;
            let all = targets_for(&docs, item);
            let chosen: Vec<Target> = all.into_iter().filter(|t| targets.iter().any(|x| x == t.id)).collect();
            if chosen.is_empty() {
                return Err("Nothing to install for the games you picked".into());
            }
            let files = fetch_files(&src, item)?;
            let name = clean_name(&item.name)?;
            let watch: Vec<crate::history::Watch> = chosen.iter().flat_map(|t| ["ini", "jpg", "cube", "zip"].map(|e| crate::history::Watch::File(t.dir.join(format!("{name}.{e}"))))).collect();
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::new(&history_games(&chosen), "tmvs-install", &item.name).detail(format!("{kind:?}").to_lowercase()), watch);
            install(&manifest(&st), item, &files, &chosen)
        })
        .await
    }

    #[tauri::command]
    pub async fn tmvs_content_remove(app: tauri::AppHandle, kind: Kind, name: String, target: Option<String>) -> Result<Vec<Outcome>, String> {
        crate::bg::run(move || -> Result<Vec<Outcome>, String> {
            let st = tauri::Manager::state::<AppState>(&app);
            let watch: Vec<crate::history::Watch> = load_manifest(&manifest(&st))
                .into_iter()
                .filter(|r| r.kind == kind && r.name == name && target.as_deref().is_none_or(|t| t == r.target))
                .flat_map(|r| r.files.into_iter().map(|f| crate::history::Watch::File(PathBuf::from(f.path))))
                .collect();
            let games: Vec<&str> = if target.as_deref() == Some("maniaplanet") { vec!["tm2-stadium", "tm2-canyon", "tm2-valley", "tm2-lagoon"] } else { vec!["tmnf", "tmuf", "tmn-eswc"] };
            let _history = crate::history::Recorder::start(&st.data_dir, crate::history::Op::new(&games, "tmvs-remove", &name).detail(format!("{kind:?}").to_lowercase()), watch);
            remove(&manifest(&st), kind, &name, target.as_deref())
        })
        .await
    }

    /// Game ids a TMVS install belongs to (for the change history).
    fn history_games(targets: &[Target]) -> Vec<&'static str> {
        let mut v = vec![];
        for t in targets {
            if t.id == "maniaplanet" {
                v.extend(["tm2-stadium", "tm2-canyon", "tm2-valley", "tm2-lagoon"]);
            } else {
                v.extend(["tmnf", "tmuf", "tmn-eswc"]);
            }
        }
        v
    }

    #[tauri::command]
    pub fn tmvs_share_code(text: String) -> Result<String, String> {
        share_code(&text)
    }

    /// Folder picker for a local preset source.
    #[tauri::command]
    pub async fn tmvs_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("Preset folder (with index.json)").blocking_pick_folder()).await.map_err(|e| e.to_string())?;
        Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
    }
}
