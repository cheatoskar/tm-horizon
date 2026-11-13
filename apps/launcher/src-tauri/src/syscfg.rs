//! `Default.SystemConfig.Gbx`: the game's graphics settings file.
//!
//! Read: TMNF/TMUF write a binary GBX v6 ("BUCR", class 0x0B005000) whose body is LZO1X compressed;
//! ESWC and Sunrise write a text GBX ("TUUE", one value per line). The display settings are a node
//! inside chunk 0x0B005020 (class CSystemConfigDisplay 0x0B013000).
//!
//! Field map (chunk 0x0B013001, eight u32 / lines): width, height, window size preset, colour depth,
//! antialiasing, refresh rate, V-Sync, fullscreen. Evidence: GBX.NET's chunk list (MIT,
//! BigBang1112/gbx-net, `CSystemConfigDisplay.chunkl`, read as reference only), my own file
//! (2560 x 1440, windowed, no V-Sync), the old `Bench` config (antialiasing 5, V-Sync 1, fullscreen 1)
//! and the ESWC/Sunrise text files (the last two values are written as False/True). Chunk 0x0B013022
//! holds textures quality (index 3) and shadows (index 5); those two are shown but never written.
//!
//! Write (binary only): the three mapped fields of chunk 0x0B013001 are changed in place (the body keeps
//! its size), the body is compressed again with a literal-only LZO1X stream, the original file is copied
//! to the backup folder first and journaled, "Undo" copies it back. Not tested in the game.
//!
//! Cpu/Gpu synchro (`GpuSync`, chunk 0x0B013003, the second of six values: DisableShadowBuffer, GpuSync,
//! EmulateCursorGDI, VertexProcess, OptimizePartDyna, one more bool): 0 None, 1 "3 Frames", 2 "2 Frames &
//! Half", 3 "2 Frames", 4 "1 Frame & Half", 5 "1 Frame", 6 "Half a frame", 7 "Immediate" (the default; the CPU
//! waits for the GPU after every frame). Source: trackmania-internals rendering/gpu-sync.md (TMNF
//! `CSystemConfigDisplay::Chunk` disassembly, Sunrise's handler, the ESWC/Sunrise/Original text files). It is
//! read in both formats and written in both: binary in place like the display fields, text by replacing the
//! one-digit line (the chunk keeps its byte count). Backup, journal and undo as above; refused while the game
//! runs. A text file in a folder the user cannot write is refused (`notWritable`), nothing is elevated.

use crate::optimize::game_running;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CLASS_CONFIG: u32 = 0x0B00_5000;
const CHUNK_DISPLAY_NODE: u32 = 0x0B00_5020;
const CHUNK_DISPLAY: u32 = 0x0B01_3001;
const CHUNK_QUALITY: u32 = 0x0B01_3022;
const CHUNK_SYNC: u32 = 0x0B01_3003;
/// Highest GpuSync value (7 = Immediate).
pub const GPU_SYNC_MAX: u32 = 7;
const END: u32 = 0xFACA_DE01;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    /// "binary" | "text"
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub window_preset: u32,
    pub color_depth: u32,
    /// 0 = off, 1 = 2x, 2 = 4x, 3 = 6x, 4 = 8x, 5 = 16x
    pub antialiasing: u32,
    pub refresh: u32,
    pub vsync: bool,
    pub fullscreen: bool,
    /// 0 very low ... 3 high (from GBX.NET, not confirmed in the game)
    pub textures: Option<u32>,
    /// 0 none ... 4 very high, 5 complex (from GBX.NET, not confirmed in the game)
    pub shadows: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Edit {
    pub fullscreen: Option<bool>,
    pub vsync: Option<bool>,
    pub antialiasing: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FieldDiff {
    pub field: String,
    pub old: String,
    pub new: String,
}

fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}

// ------------------------------------------------------------------ LZO1X, literal-only writer

/// A valid LZO1X stream that only contains literals (no compression): first-run literal count, the
/// data, then the end marker. Any LZO1X decoder reads it.
pub fn lzo_literal(data: &[u8]) -> Vec<u8> {
    let n = data.len();
    let mut o = Vec::with_capacity(n + 8);
    if n == 0 {
        o.extend([0x11, 0, 0]);
        return o;
    }
    if n <= 238 {
        o.push((17 + n) as u8);
    } else {
        let rem = n - 18;
        let z = (rem - 1) / 255;
        let b = rem - 255 * z;
        o.push(0);
        o.extend(std::iter::repeat(0u8).take(z));
        o.push(b as u8);
    }
    o.extend(data);
    o.extend([0x11, 0, 0]);
    o
}

// ------------------------------------------------------------------ binary file

struct Bin {
    /// Bytes before the two size fields.
    head: Vec<u8>,
    body: Vec<u8>,
}

fn read_bin(f: &[u8]) -> Result<Bin, String> {
    let bad = || "Unknown SystemConfig layout".to_string();
    if f.get(..3) != Some(b"GBX") || f.get(3..5) != Some(&[6, 0]) {
        return Err(bad());
    }
    if f.get(5..9) != Some(b"BUCR") || u32_at(f, 9) != Some(CLASS_CONFIG) {
        return Err(bad());
    }
    let user = u32_at(f, 13).ok_or_else(bad)? as usize;
    let mut p = 17usize.checked_add(user).ok_or_else(bad)?;
    p += 4; // node count
    if u32_at(f, p).ok_or_else(bad)? != 0 {
        return Err("External references are not supported".into());
    }
    p += 4;
    let usz = u32_at(f, p).ok_or_else(bad)? as usize;
    let csz = u32_at(f, p + 4).ok_or_else(bad)? as usize;
    let data = f.get(p + 8..).ok_or_else(bad)?;
    if data.len() != csz || usz > 1 << 20 {
        return Err(bad());
    }
    let body = crate::lzo1x::decompress(data, usz)?;
    Ok(Bin { head: f[..p].to_vec(), body })
}

fn write_bin(b: &Bin) -> Vec<u8> {
    let c = lzo_literal(&b.body);
    let mut o = b.head.clone();
    o.extend((b.body.len() as u32).to_le_bytes());
    o.extend((c.len() as u32).to_le_bytes());
    o.extend(c);
    o
}

/// Skippable chunks of a list: (id, offset of the data in `d`, size). Stops at the end marker.
fn chunks(d: &[u8], mut p: usize, end: usize) -> Result<Vec<(u32, usize, usize)>, String> {
    let mut out = vec![];
    loop {
        let id = u32_at(d, p).ok_or("chunk list ends early")?;
        p += 4;
        if id == END {
            return Ok(out);
        }
        if d.get(p..p + 4) != Some(b"PIKS") {
            return Err(format!("Chunk {id:#x} is not skippable"));
        }
        let sz = u32_at(d, p + 4).ok_or("chunk list ends early")? as usize;
        p += 8;
        if p + sz > end {
            return Err("chunk is too large".into());
        }
        out.push((id, p, sz));
        p += sz;
    }
}

struct Found {
    display: Option<usize>,
    quality: Option<usize>,
    sync: Option<usize>,
}

fn locate(body: &[u8]) -> Result<Found, String> {
    let mut f = Found { display: None, quality: None, sync: None };
    for (id, off, sz) in chunks(body, 0, body.len())? {
        if id == CHUNK_DISPLAY_NODE {
            for (id2, off2, sz2) in chunks(body, off + 4, off + sz)? {
                if id2 == CHUNK_DISPLAY && sz2 == 32 {
                    f.display = Some(off2);
                }
                if id2 == CHUNK_QUALITY && sz2 == 28 {
                    f.quality = Some(off2);
                }
                if id2 == CHUNK_SYNC && sz2 == 24 {
                    f.sync = Some(off2);
                }
            }
        }
    }
    Ok(f)
}

fn display_bin(body: &[u8], f: &Found) -> Option<Display> {
    let o = f.display?;
    let g = |i: usize| u32_at(body, o + 4 * i);
    Some(Display {
        format: "binary".into(),
        width: g(0)?,
        height: g(1)?,
        window_preset: g(2)?,
        color_depth: g(3)?,
        antialiasing: g(4)?,
        refresh: g(5)?,
        vsync: g(6)? != 0,
        fullscreen: g(7)? != 0,
        textures: f.quality.and_then(|q| u32_at(body, q + 12)),
        shadows: f.quality.and_then(|q| u32_at(body, q + 20)),
    })
}

// ------------------------------------------------------------------ text file (read only)

fn display_text(f: &[u8]) -> Option<Display> {
    let text = String::from_utf8_lossy(f);
    let lines: Vec<&str> = text.split("\r\n").collect();
    let at = |id: &str| lines.iter().position(|l| *l == id);
    let num = |i: usize| lines.get(i).and_then(|l| l.trim().parse::<u32>().ok());
    let b = |i: usize| lines.get(i).map(|l| l.trim().eq_ignore_ascii_case("true"));
    let d = at("b013001")? + 3;
    let q = at("b013022").map(|i| i + 3);
    Some(Display {
        format: "text".into(),
        width: num(d)?,
        height: num(d + 1)?,
        window_preset: num(d + 2)?,
        color_depth: num(d + 3)?,
        antialiasing: num(d + 4)?,
        refresh: num(d + 5)?,
        vsync: b(d + 6)?,
        fullscreen: b(d + 7)?,
        textures: q.and_then(|q| num(q + 3)),
        shadows: q.and_then(|q| num(q + 5)),
    })
}

/// Reads the display settings of a SystemConfig file.
pub fn parse(f: &[u8]) -> Result<Display, String> {
    if f.get(5..9) == Some(b"TUUE") {
        return display_text(f).ok_or_else(|| "Display settings not found".to_string());
    }
    let bin = read_bin(f)?;
    let loc = locate(&bin.body)?;
    display_bin(&bin.body, &loc).ok_or_else(|| "Display settings not found".to_string())
}

fn aa_text(v: u32) -> String {
    ["off", "2x", "4x", "6x", "8x", "16x"].get(v as usize).map(|s| s.to_string()).unwrap_or_else(|| v.to_string())
}

fn on_off(b: bool) -> String {
    if b { "on" } else { "off" }.into()
}

/// What an edit would change (empty = nothing).
pub fn diff(d: &Display, e: &Edit) -> Vec<FieldDiff> {
    let mut v = vec![];
    if let Some(x) = e.fullscreen.filter(|x| *x != d.fullscreen) {
        v.push(FieldDiff { field: "fullscreen".into(), old: on_off(d.fullscreen), new: on_off(x) });
    }
    if let Some(x) = e.vsync.filter(|x| *x != d.vsync) {
        v.push(FieldDiff { field: "vsync".into(), old: on_off(d.vsync), new: on_off(x) });
    }
    if let Some(x) = e.antialiasing.filter(|x| *x != d.antialiasing) {
        v.push(FieldDiff { field: "antialiasing".into(), old: aa_text(d.antialiasing), new: aa_text(x) });
    }
    v
}

/// The file with the edit applied (binary files only). The result is read back and checked.
pub fn modify(f: &[u8], e: &Edit) -> Result<Vec<u8>, String> {
    if f.get(5..9) == Some(b"TUUE") {
        return Err("Text config files are read only".into());
    }
    if e.antialiasing.is_some_and(|a| a > 5) {
        return Err("Antialiasing out of range".into());
    }
    let mut bin = read_bin(f)?;
    let loc = locate(&bin.body)?;
    let o = loc.display.ok_or("Display settings not found")?;
    let before = display_bin(&bin.body, &loc).ok_or("Display settings not found")?;
    let mut put = |idx: usize, v: u32| bin.body[o + 4 * idx..o + 4 * idx + 4].copy_from_slice(&v.to_le_bytes());
    if let Some(a) = e.antialiasing {
        put(4, a);
    }
    if let Some(v) = e.vsync {
        put(6, v as u32);
    }
    if let Some(v) = e.fullscreen {
        put(7, v as u32);
    }
    let out = write_bin(&bin);
    // Round trip: the new file must read back as the old one plus the edit, nothing else changed.
    let after = parse(&out)?;
    let want = Display {
        antialiasing: e.antialiasing.unwrap_or(before.antialiasing),
        vsync: e.vsync.unwrap_or(before.vsync),
        fullscreen: e.fullscreen.unwrap_or(before.fullscreen),
        ..before
    };
    if after != want {
        return Err("Self-check failed, nothing written".into());
    }
    Ok(out)
}

// ------------------------------------------------------------------ Cpu/Gpu synchro

/// Line index of the GpuSync value in a text file: chunk id, skip marker, byte count, DisableShadowBuffer, GpuSync.
fn sync_line(lines: &[&str]) -> Option<usize> {
    let at = lines.iter().position(|l| *l == "b013003")?;
    (lines.get(at + 1) == Some(&"1397442896")).then_some(at + 4)
}

/// The Cpu/Gpu synchro value of a SystemConfig file (0..=7).
pub fn gpu_sync(f: &[u8]) -> Result<u32, String> {
    let v = if f.get(5..9) == Some(b"TUUE") {
        let text = String::from_utf8_lossy(f);
        let lines: Vec<&str> = text.split("\r\n").collect();
        sync_line(&lines).and_then(|i| lines.get(i)).and_then(|l| l.trim().parse::<u32>().ok())
    } else {
        let bin = read_bin(f)?;
        let loc = locate(&bin.body)?;
        loc.sync.and_then(|o| u32_at(&bin.body, o + 4))
    };
    v.filter(|v| *v <= GPU_SYNC_MAX).ok_or_else(|| "Cpu/Gpu synchro not found".to_string())
}

/// The file with GpuSync set to `v`. Text: the one digit is replaced (same byte count); binary: the u32 in
/// place, compressed again. The result is read back: GpuSync is `v`, the display settings are unchanged.
pub fn set_gpu_sync(f: &[u8], v: u32) -> Result<Vec<u8>, String> {
    if v > GPU_SYNC_MAX {
        return Err("Cpu/Gpu synchro out of range".into());
    }
    let before = parse(f)?;
    gpu_sync(f)?;
    let out = if f.get(5..9) == Some(b"TUUE") {
        // Byte offsets of the lines, to replace exactly one digit.
        let mut starts = vec![0usize];
        let mut i = 0;
        while let Some(k) = f[i..].windows(2).position(|w| w == b"\r\n") {
            i += k + 2;
            starts.push(i);
        }
        let text = String::from_utf8_lossy(f);
        let lines: Vec<&str> = text.split("\r\n").collect();
        let li = sync_line(&lines).ok_or("Cpu/Gpu synchro not found")?;
        let at = *starts.get(li).ok_or("Cpu/Gpu synchro not found")?;
        if f.get(at + 1..at + 3) != Some(b"\r\n") || !f[at].is_ascii_digit() {
            return Err("Unexpected Cpu/Gpu synchro line".into());
        }
        let mut o = f.to_vec();
        o[at] = b'0' + v as u8;
        o
    } else {
        let mut bin = read_bin(f)?;
        let o = locate(&bin.body)?.sync.ok_or("Cpu/Gpu synchro not found")?;
        bin.body[o + 4..o + 8].copy_from_slice(&v.to_le_bytes());
        write_bin(&bin)
    };
    if out.len() != f.len() && f.get(5..9) == Some(b"TUUE") {
        return Err("Self-check failed, nothing written".into());
    }
    if gpu_sync(&out)? != v || parse(&out)? != before {
        return Err("Self-check failed, nothing written".into());
    }
    Ok(out)
}

/// Writes GpuSync into the file at `path`: backup copy, journal entry, new content (like `apply_file`).
pub fn apply_gpu_sync(path: &Path, data: &Path, backup_dir: &Path, game: &str, v: u32) -> Result<Vec<FieldDiff>, String> {
    crate::fsx::check(path)?;
    let old = std::fs::read(path).map_err(|x| format!("{}: {x}", path.display()))?;
    let cur = gpu_sync(&old)?;
    if cur == v {
        return Ok(vec![]);
    }
    let new = set_gpu_sync(&old, v)?;
    let diffs = vec![FieldDiff { field: "gpuSync".into(), old: cur.to_string(), new: v.to_string() }];
    let backup = backup_dir.join(path.file_name().unwrap_or_default());
    crate::fsx::write(&backup, &old)?;
    let mut j = load_journal(data);
    j.entries.push(Entry { id: crate::fsx::stamp(), time: crate::fsx::now_iso(), game: game.into(), path: path.to_string_lossy().into(), backup: backup.to_string_lossy().into(), diffs: diffs.clone(), undone: false });
    save_journal(data, &j)?;
    crate::fsx::write(path, &new)?;
    Ok(diffs)
}

/// Recommendations as ids the UI translates.
pub fn tips(d: &Display) -> Vec<&'static str> {
    let mut t = vec![];
    if d.vsync {
        t.push("vsync");
    }
    if d.antialiasing > 0 {
        t.push("aa");
    }
    if d.fullscreen {
        t.push("fullscreen");
    }
    t
}

// ------------------------------------------------------------------ journal

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub time: String,
    pub game: String,
    pub path: String,
    pub backup: String,
    pub diffs: Vec<FieldDiff>,
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Journal {
    pub entries: Vec<Entry>,
}

fn journal_file(data: &Path) -> PathBuf {
    data.join("syscfg-journal.json")
}

fn load_journal(data: &Path) -> Journal {
    std::fs::read_to_string(journal_file(data)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_journal(data: &Path, j: &Journal) -> Result<(), String> {
    crate::fsx::write(&journal_file(data), serde_json::to_string_pretty(j).map_err(|e| e.to_string())?.as_bytes())
}

/// Edits the file at `path`: backup copy, journal entry, new content. Returns the diffs.
pub fn apply_file(path: &Path, data: &Path, backup_dir: &Path, game: &str, e: &Edit) -> Result<Vec<FieldDiff>, String> {
    crate::fsx::check(path)?;
    let old = std::fs::read(path).map_err(|x| format!("{}: {x}", path.display()))?;
    let d = parse(&old)?;
    let diffs = diff(&d, e);
    if diffs.is_empty() {
        return Ok(diffs);
    }
    let new = modify(&old, e)?;
    let backup = backup_dir.join(path.file_name().unwrap_or_default());
    crate::fsx::write(&backup, &old)?;
    let mut j = load_journal(data);
    j.entries.push(Entry { id: crate::fsx::stamp(), time: crate::fsx::now_iso(), game: game.into(), path: path.to_string_lossy().into(), backup: backup.to_string_lossy().into(), diffs: diffs.clone(), undone: false });
    save_journal(data, &j)?;
    crate::fsx::write(path, &new)?;
    Ok(diffs)
}

pub fn undo_file(data: &Path, game: &str) -> Result<(), String> {
    let mut j = load_journal(data);
    let Some(e) = j.entries.iter_mut().rev().find(|e| e.game == game && !e.undone) else { return Err("Nothing to undo".into()) };
    let orig = std::fs::read(&e.backup).map_err(|x| format!("Backup missing: {x}"))?;
    crate::fsx::write(Path::new(&e.path), &orig)?;
    e.undone = true;
    save_journal(data, &j)
}

// ------------------------------------------------------------------ commands

fn config_path(st: &crate::state::AppState, game: &str) -> Result<PathBuf, String> {
    crate::optimize::game_exe_name(game).ok_or("Not available for this game")?;
    any_config_path(st, game)
}

/// The game's SystemConfig file: Documents for TMNF/TMUF, next to the exe for ESWC, Sunrise and Original.
/// A copy in the user's VirtualStore wins (an old game in Program Files without admin rights reads and
/// writes that one).
fn any_config_path(st: &crate::state::AppState, game: &str) -> Result<PathBuf, String> {
    let p = match game {
        "tmnf" | "tmuf" => crate::platform::documents_dir().ok_or("Documents folder not found")?.join("TrackMania").join("Config"),
        "tmn-eswc" | "tm-sunrise" | "tm-original" => st.install_dir(game).ok_or("The game is not installed")?,
        _ => return Err("Not available for this game".into()),
    };
    let p = p.join("Default.SystemConfig.Gbx");
    let p = virtual_store(&p).filter(|v| crate::fsx::is_file(v)).unwrap_or(p);
    crate::fsx::check(&p)?;
    Ok(p)
}

/// `%LOCALAPPDATA%\VirtualStore\Program Files (x86)\...` for a file under Program Files (Windows only).
fn virtual_store(p: &Path) -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let s = p.to_string_lossy();
    let rest = s.get(3..)?;
    let lower = rest.to_ascii_lowercase();
    if !(s.get(1..3) == Some(":\\") && (lower.starts_with("program files\\") || lower.starts_with("program files (x86)\\"))) {
        return None;
    }
    Some(Path::new(&local).join("VirtualStore").join(rest))
}

// ------------------------------------------------------------------ Cpu/Gpu synchro commands

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub supported: bool,
    /// Why not (an English sentence), when not supported or not readable.
    pub reason: Option<String>,
    pub path: Option<String>,
    /// 0..=7, None when the file could not be read.
    pub value: Option<u32>,
    /// The launcher can write it (file readable, folder writable).
    pub writable: bool,
    /// The game's own launcher (TmForeverLauncher.exe, TmNationsESWCLauncher.exe) when there is one.
    pub launcher: Option<String>,
    pub can_undo: bool,
}

fn folder_writable(p: &Path) -> bool {
    p.parent().map(|d| crate::elevate::writable(d) == Ok(true)).unwrap_or(false)
}

#[tauri::command]
pub async fn gpusync_state(app: tauri::AppHandle, game_id: String) -> SyncState {
    crate::bg::run(move || -> SyncState {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let launcher = st.install(&game_id).and_then(|i| i.launcher);
        let mut o = SyncState { supported: false, reason: None, path: None, value: None, writable: false, launcher, can_undo: false };
        let p = match any_config_path(&st, &game_id) {
            Ok(p) => p,
            Err(e) => {
                o.reason = Some(e);
                return o;
            }
        };
        o.supported = true;
        o.path = Some(p.to_string_lossy().into());
        match std::fs::read(&p) {
            Err(_) => o.reason = Some("Config file not found. Start the game once.".into()),
            Ok(f) => match gpu_sync(&f) {
                Ok(v) => {
                    o.value = Some(v);
                    o.writable = set_gpu_sync(&f, if v == 5 { 6 } else { 5 }).is_ok() && folder_writable(&p);
                }
                Err(e) => o.reason = Some(e),
            },
        }
        o.can_undo = load_journal(&st.data_dir).entries.iter().any(|e| e.game == game_id && !e.undone);
        o
    })
    .await
}

#[tauri::command]
pub async fn gpusync_apply(app: tauri::AppHandle, game_id: String, value: u32) -> Result<Vec<FieldDiff>, String> {
    crate::bg::run(move || -> Result<Vec<FieldDiff>, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        if game_running(&st, &game_id) {
            return Err("Close the game first.".into());
        }
        let p = any_config_path(&st, &game_id)?;
        if !folder_writable(&p) {
            return Err("notWritable".into());
        }
        apply_gpu_sync(&p, &st.data_dir, &st.backup_dir().join("SystemConfig"), &game_id, value)
    })
    .await
}

/// Opens the game's own launcher (its advanced settings carry Cpu/Gpu synchro), when the file cannot be written.
#[tauri::command]
pub async fn gpusync_open_launcher(app: tauri::AppHandle, game_id: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        if game_running(&st, &game_id) {
            return Err("Close the game first.".into());
        }
        let l = st.install(&game_id).and_then(|i| i.launcher).ok_or("The game has no launcher")?;
        let p = PathBuf::from(&l);
        if crate::fsx::blocked(&p) || !crate::fsx::is_file(&p) {
            return Err("The game has no launcher".into());
        }
        crate::platform::spawn(&crate::launch::wrap(&crate::commands::runner(), &p, &[], p.parent())).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysState {
    pub path: String,
    pub display: Display,
    pub writable: bool,
    pub tips: Vec<&'static str>,
    pub can_undo: bool,
}

#[tauri::command]
pub async fn syscfg_state(app: tauri::AppHandle, game_id: String) -> Result<SysState, String> {
    crate::bg::run(move || -> Result<SysState, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let p = config_path(&st, &game_id)?;
        let f = std::fs::read(&p).map_err(|_| "Config file not found. Start the game once.".to_string())?;
        let display = parse(&f)?;
        let can_undo = load_journal(&st.data_dir).entries.iter().any(|e| e.game == game_id && !e.undone);
        Ok(SysState { path: p.to_string_lossy().into(), writable: display.format == "binary", tips: tips(&display), display, can_undo })
    })
    .await
}

#[tauri::command]
pub async fn syscfg_plan(app: tauri::AppHandle, game_id: String, edit: Edit) -> Result<Vec<FieldDiff>, String> {
    crate::bg::run(move || -> Result<Vec<FieldDiff>, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let p = config_path(&st, &game_id)?;
        let f = std::fs::read(&p).map_err(|e| e.to_string())?;
        let d = diff(&parse(&f)?, &edit);
        if !d.is_empty() {
            modify(&f, &edit)?; // fails for text files and out-of-range values
        }
        Ok(d)
    })
    .await
}

#[tauri::command]
pub async fn syscfg_apply(app: tauri::AppHandle, game_id: String, edit: Edit) -> Result<Vec<FieldDiff>, String> {
    crate::bg::run(move || -> Result<Vec<FieldDiff>, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        if game_running(&st, &game_id) {
            return Err("Close the game first.".into());
        }
        let p = config_path(&st, &game_id)?;
        apply_file(&p, &st.data_dir, &st.backup_dir().join("SystemConfig"), &game_id, &edit)
    })
    .await
}

#[tauri::command]
pub async fn syscfg_undo(app: tauri::AppHandle, game_id: String) -> Result<(), String> {
    crate::bg::run(move || -> Result<(), String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        if game_running(&st, &game_id) {
            return Err("Close the game first.".into());
        }
        if let Some(e) = load_journal(&st.data_dir).entries.iter().rev().find(|e| e.game == game_id && !e.undone) {
            if !folder_writable(Path::new(&e.path)) {
                return Err("notWritable".into());
            }
        }
        undo_file(&st.data_dir, &game_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: u32, data: &[u8]) -> Vec<u8> {
        let mut o = id.to_le_bytes().to_vec();
        o.extend(b"PIKS");
        o.extend((data.len() as u32).to_le_bytes());
        o.extend(data);
        o
    }

    fn words(w: &[u32]) -> Vec<u8> {
        w.iter().flat_map(|x| x.to_le_bytes()).collect()
    }

    /// A small file shaped like the game's: language chunk, display node with the display and quality chunks.
    pub fn sample(aa: u32, vsync: u32, fs: u32) -> Vec<u8> {
        let mut node = 0u32.to_le_bytes().to_vec();
        node.extend(chunk(CHUNK_DISPLAY, &words(&[2560, 1440, 0, 1, aa, 0, vsync, fs])));
        node.extend(chunk(CHUNK_QUALITY, &words(&[1, 1, 0, 3, 4, 5, 5])));
        node.extend(END.to_le_bytes());
        let mut body = chunk(0x0B00_5008, &[2, 0, 0, 0, b'd', b'e']);
        body.extend(chunk(CHUNK_DISPLAY_NODE, &node));
        body.extend(chunk(0x0B00_502B, &words(&[1, 0, 0])));
        body.extend(END.to_le_bytes());
        let mut f = b"GBX".to_vec();
        f.extend([6, 0]);
        f.extend(b"BUCR");
        f.extend(CLASS_CONFIG.to_le_bytes());
        f.extend(0u32.to_le_bytes()); // user data
        f.extend(1u32.to_le_bytes()); // nodes
        f.extend(0u32.to_le_bytes()); // refs
        f.extend((body.len() as u32).to_le_bytes());
        let c = lzo_literal(&body);
        f.extend((c.len() as u32).to_le_bytes());
        f.extend(c);
        f
    }

    /// `sample` with the Cpu/Gpu synchro chunk (six values, GpuSync second) in the display node.
    fn sample_sync(sync: u32) -> Vec<u8> {
        let mut node = 0u32.to_le_bytes().to_vec();
        node.extend(chunk(CHUNK_DISPLAY, &words(&[2560, 1440, 0, 1, 5, 0, 1, 0])));
        node.extend(chunk(CHUNK_SYNC, &words(&[0, sync, 0, 0, 0, 1])));
        node.extend(chunk(CHUNK_QUALITY, &words(&[1, 1, 0, 3, 4, 5, 5])));
        node.extend(END.to_le_bytes());
        let mut body = chunk(0x0B00_5008, &[2, 0, 0, 0, b'd', b'e']);
        body.extend(chunk(CHUNK_DISPLAY_NODE, &node));
        body.extend(END.to_le_bytes());
        let mut f = b"GBX".to_vec();
        f.extend([6, 0]);
        f.extend(b"BUCR");
        f.extend(CLASS_CONFIG.to_le_bytes());
        f.extend(0u32.to_le_bytes());
        f.extend(1u32.to_le_bytes());
        f.extend(0u32.to_le_bytes());
        f.extend((body.len() as u32).to_le_bytes());
        let c = lzo_literal(&body);
        f.extend((c.len() as u32).to_le_bytes());
        f.extend(c);
        f
    }

    const TEXT_SYNC: &str = "GBX\u{6}\0TUUEb005000\r\n0\r\n1\r\n0\r\nb013001\r\n1397442896\r\n38\r\n2560\r\n1440\r\n3\r\n1\r\n0\r\n0\r\nFalse\r\nTrue\r\nb013003\r\n1397442896\r\n33\r\nFalse\r\n7\r\nFalse\r\n0\r\nFalse\r\nTrue\r\nb013004\r\n";

    fn text_sync() -> Vec<u8> {
        let mut b = TEXT_SYNC.as_bytes().to_vec();
        b[3] = 6;
        b[4] = 0;
        b
    }

    #[test]
    fn gpu_sync_text_reads_and_writes_one_digit() {
        let f = text_sync();
        assert_eq!(gpu_sync(&f).unwrap(), 7);
        let out = set_gpu_sync(&f, 5).unwrap();
        assert_eq!(out.len(), f.len(), "same byte count");
        assert_eq!(gpu_sync(&out).unwrap(), 5);
        assert_eq!(out.iter().zip(&f).filter(|(a, b)| a != b).count(), 1, "one byte changed");
        assert_eq!(parse(&out).unwrap(), parse(&f).unwrap());
        assert!(set_gpu_sync(&f, 8).is_err());
        // A file without the chunk: not found, nothing written.
        let t = "GBX\u{6}\0TUUEb013001\r\n1397442896\r\n38\r\n2560\r\n1440\r\n3\r\n1\r\n0\r\n0\r\nFalse\r\nTrue\r\n";
        assert!(gpu_sync(t.as_bytes()).is_err());
        assert!(set_gpu_sync(t.as_bytes(), 5).is_err());
    }

    #[test]
    fn gpu_sync_binary_reads_and_writes_in_place() {
        let f = sample_sync(7);
        assert_eq!(gpu_sync(&f).unwrap(), 7);
        let out = set_gpu_sync(&f, 5).unwrap();
        assert_eq!(gpu_sync(&out).unwrap(), 5);
        assert_eq!(parse(&out).unwrap(), parse(&f).unwrap(), "display settings unchanged");
        let (a, b) = (read_bin(&f).unwrap().body, read_bin(&out).unwrap().body);
        assert_eq!(a.len(), b.len());
        assert_eq!(a.iter().zip(&b).filter(|(x, y)| x != y).count(), 1);
        // The old sample has no sync chunk.
        assert!(gpu_sync(&sample(0, 0, 0)).is_err());
        assert!(set_gpu_sync(&sample(0, 0, 0), 5).is_err());
    }

    #[test]
    fn gpu_sync_apply_backs_up_and_undoes() {
        let t = tempfile::tempdir().unwrap();
        for (name, orig) in [("bin", sample_sync(7)), ("text", text_sync())] {
            let cfg = t.path().join(name).join("Default.SystemConfig.Gbx");
            crate::fsx::write(&cfg, &orig).unwrap();
            let data = t.path().join(format!("data-{name}"));
            let bak = t.path().join(format!("bak-{name}"));
            let d = apply_gpu_sync(&cfg, &data, &bak, "tm-sunrise", 5).unwrap();
            assert_eq!((d[0].old.as_str(), d[0].new.as_str()), ("7", "5"));
            assert_eq!(gpu_sync(&std::fs::read(&cfg).unwrap()).unwrap(), 5);
            assert_eq!(std::fs::read(bak.join("Default.SystemConfig.Gbx")).unwrap(), orig);
            assert!(apply_gpu_sync(&cfg, &data, &bak, "tm-sunrise", 5).unwrap().is_empty(), "same value: nothing");
            undo_file(&data, "tm-sunrise").unwrap();
            assert_eq!(std::fs::read(&cfg).unwrap(), orig);
        }
    }

    #[test]
    fn virtual_store_only_for_program_files() {
        if std::env::var_os("LOCALAPPDATA").is_none() {
            return;
        }
        assert!(virtual_store(Path::new(r"C:\Program Files (x86)\TmSunrise\Default.SystemConfig.Gbx")).unwrap().ends_with(r"VirtualStore\Program Files (x86)\TmSunrise\Default.SystemConfig.Gbx"));
        assert!(virtual_store(Path::new(r"D:\Games\TmSunrise\Default.SystemConfig.Gbx")).is_none());
    }

    #[test]
    fn literal_lzo_roundtrips_at_all_run_lengths() {
        for n in [1usize, 17, 18, 19, 100, 238, 239, 255, 256, 272, 273, 274, 600, 5000] {
            let data: Vec<u8> = (0..n).map(|i| (i * 7 % 251) as u8).collect();
            let c = lzo_literal(&data);
            assert_eq!(crate::lzo1x::decompress(&c, n).unwrap(), data, "n = {n}");
        }
    }

    #[test]
    fn parses_binary_and_reads_fields() {
        let d = parse(&sample(5, 1, 1)).unwrap();
        assert_eq!((d.width, d.height, d.antialiasing, d.vsync, d.fullscreen), (2560, 1440, 5, true, true));
        assert_eq!((d.textures, d.shadows), (Some(3), Some(5)));
        let d = parse(&sample(0, 0, 0)).unwrap();
        assert!(!d.vsync && !d.fullscreen);
        assert_eq!(tips(&d), Vec::<&str>::new());
        assert_eq!(tips(&parse(&sample(4, 1, 0)).unwrap()), vec!["vsync", "aa"]);
        assert!(parse(b"nonsense").is_err());
        assert!(parse(&sample(0, 0, 0)[..40]).is_err());
    }

    #[test]
    fn edit_changes_only_the_asked_fields() {
        let f = sample(5, 1, 0);
        let e = Edit { vsync: Some(false), antialiasing: Some(0), ..Default::default() };
        let out = modify(&f, &e).unwrap();
        let d = parse(&out).unwrap();
        assert_eq!((d.antialiasing, d.vsync, d.fullscreen, d.width, d.textures), (0, false, false, 2560, Some(3)));
        let old_body = read_bin(&f).unwrap().body;
        let new_body = read_bin(&out).unwrap().body;
        assert_eq!(old_body.len(), new_body.len());
        let changed = old_body.iter().zip(&new_body).filter(|(a, b)| a != b).count();
        assert!(changed <= 3, "at most the two fields changed: {changed}");
        assert!(modify(&f, &Edit { antialiasing: Some(9), ..Default::default() }).is_err());
        let diffs = diff(&parse(&f).unwrap(), &e);
        assert_eq!(diffs.len(), 2);
        assert_eq!((diffs[1].old.as_str(), diffs[1].new.as_str()), ("16x", "off"));
    }

    #[test]
    fn text_file_is_read_only() {
        let t = "GBX\u{6}\0TUUEb005000\r\n0\r\n1\r\n0\r\nb013001\r\n1397442896\r\n38\r\n2560\r\n1440\r\n3\r\n1\r\n0\r\n0\r\nFalse\r\nTrue\r\nb013022\r\n1397442896\r\n10\r\n1\r\n1\r\n0\r\n3\r\n4\r\n4\r\n5\r\n";
        let mut b = t.as_bytes().to_vec();
        b[3] = 6;
        b[4] = 0;
        let d = parse(&b).unwrap();
        assert_eq!((d.format.as_str(), d.width, d.window_preset, d.vsync, d.fullscreen, d.textures, d.shadows), ("text", 2560, 3, false, true, Some(3), Some(4)));
        assert!(modify(&b, &Edit { vsync: Some(true), ..Default::default() }).is_err());
    }

    #[test]
    fn apply_backs_up_journals_and_undoes() {
        let t = tempfile::tempdir().unwrap();
        let cfg = t.path().join("Config").join("Default.SystemConfig.Gbx");
        let orig = sample(5, 1, 1);
        crate::fsx::write(&cfg, &orig).unwrap();
        let data = t.path().join("data");
        let bak = t.path().join("bak");
        let e = Edit { vsync: Some(false), ..Default::default() };
        let diffs = apply_file(&cfg, &data, &bak, "tmnf", &e).unwrap();
        assert_eq!(diffs.len(), 1);
        assert!(!parse(&std::fs::read(&cfg).unwrap()).unwrap().vsync);
        assert_eq!(std::fs::read(bak.join("Default.SystemConfig.Gbx")).unwrap(), orig);
        // Same edit again: nothing to do, nothing journaled.
        assert!(apply_file(&cfg, &data, &bak, "tmnf", &e).unwrap().is_empty());
        assert_eq!(load_journal(&data).entries.len(), 1);
        undo_file(&data, "tmnf").unwrap();
        assert_eq!(std::fs::read(&cfg).unwrap(), orig);
        assert!(undo_file(&data, "tmnf").is_err());
    }

    /// Run by hand against real files (read only): `TMH_REAL_CFG=<file> cargo test real_file -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_file() {
        let Ok(p) = std::env::var("TMH_REAL_CFG") else { return };
        let f = std::fs::read(&p).unwrap();
        let d = parse(&f).unwrap();
        println!("{d:?}");
        let g = gpu_sync(&f);
        println!("Cpu/Gpu synchro: {g:?}");
        if let Ok(g) = g {
            let out = set_gpu_sync(&f, if g == 5 { 6 } else { 5 }).unwrap();
            assert_eq!(set_gpu_sync(&out, g).unwrap().len(), out.len());
            assert_eq!(parse(&out).unwrap(), d);
        }
        if d.format == "binary" {
            let e = Edit { vsync: Some(!d.vsync), antialiasing: Some(3), fullscreen: Some(!d.fullscreen) };
            let out = modify(&f, &e).unwrap();
            let d2 = parse(&out).unwrap();
            assert_eq!((d2.vsync, d2.antialiasing, d2.fullscreen, d2.width), (!d.vsync, 3, !d.fullscreen, d.width));
            let back = modify(&out, &Edit { vsync: Some(d.vsync), antialiasing: Some(d.antialiasing), fullscreen: Some(d.fullscreen) }).unwrap();
            assert_eq!(parse(&back).unwrap(), d);
            assert_eq!(read_bin(&back).unwrap().body, read_bin(&f).unwrap().body, "body identical after the round trip");
        }
    }
}
