//! TrackMania console games through emulators: TrackMania DS and TrackMania Turbo (DS) in melonDS,
//! TrackMania Wii / Build to Race in Dolphin.
//!
//! - Emulators: an existing install (picked by hand, or Dolphin's usual install folders and the
//!   program list), or downloaded on demand from the official release with the same engine as the
//!   server controllers (`hosting::deps`: pinned SHA-256 and size, checked before unpacking, kept in
//!   the launcher's data folder, nothing installed system-wide). Dolphin is unpacked in portable mode
//!   (`portable.txt`), so its settings stay in its own folder.
//! - Games: the player's own dump (TM Horizon never downloads or links ROMs/ISOs). The file is
//!   checked by its header: DS game code (and the header CRC), Wii game id (ISO, WBFS, RVZ/WIA, CISO,
//!   GCZ).
//! - Start: `Dolphin.exe -b -e <file>` (plus `-C Graphics.Settings.InternalResolution=<n>` and
//!   `-C Graphics.Settings.HiresTextures=True` when set), `melonDS.exe <file>`.
//!   Options from Dolphin's Source/Core/UICommon/CommandLineParse.cpp and melonDS' CLI.cpp.

use crate::hosting::kinds::Package;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Emu {
    Dolphin,
    MelonDs,
}

impl Emu {
    pub fn key(self) -> &'static str {
        match self {
            Emu::Dolphin => "dolphin",
            Emu::MelonDs => "melonds",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Emu::Dolphin => "Dolphin",
            Emu::MelonDs => "melonDS",
        }
    }
    pub fn exe(self) -> &'static str {
        match self {
            Emu::Dolphin => "Dolphin.exe",
            Emu::MelonDs => "melonDS.exe",
        }
    }
    pub fn from_key(k: &str) -> Option<Emu> {
        match k {
            "dolphin" => Some(Emu::Dolphin),
            "melonds" => Some(Emu::MelonDs),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Ds,
    Wii,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleGame {
    pub id: &'static str,
    pub name: &'static str,
    pub platform: Platform,
    pub emu: Emu,
    /// DS game codes (4 letters) or the first 4 letters of the Wii game id, one per region.
    pub codes: &'static [&'static str],
    /// File extensions the picker offers.
    pub extensions: &'static [&'static str],
}

/// Codes from GameTDB (dstdb/wiitdb, read 2026-11-11): TrackMania DS CTRP/CTRE, TrackMania Turbo
/// (DS) BT2P/BT2E, TrackMania Wii R6RPHH (Europe) and TrackMania: Build to Race R6REJH (North America),
/// the same game under two regional titles.
pub const GAMES: [ConsoleGame; 3] = [
    ConsoleGame { id: "tm-ds", name: "TrackMania DS", platform: Platform::Ds, emu: Emu::MelonDs, codes: &["CTRP", "CTRE"], extensions: &["nds"] },
    ConsoleGame { id: "tm-turbo-ds", name: "TrackMania Turbo (DS)", platform: Platform::Ds, emu: Emu::MelonDs, codes: &["BT2P", "BT2E"], extensions: &["nds"] },
    ConsoleGame { id: "tm-wii", name: "TrackMania Wii / Build to Race", platform: Platform::Wii, emu: Emu::Dolphin, codes: &["R6RP", "R6RE"], extensions: &["iso", "wbfs", "rvz", "wia", "ciso", "gcz"] },
];

pub fn game(id: &str) -> Option<&'static ConsoleGame> {
    GAMES.iter().find(|g| g.id == id)
}

pub fn is_console(id: &str) -> bool {
    game(id).is_some()
}

// ------------------------------------------------------------------ emulator packages

/// Dolphin 2609b (the stable line, 2026-11-08), Windows x64. Dolphin publishes no checksum or
/// signature for its builds; the SHA-256 was taken from the file downloaded from dl.dolphin-emu.org
/// on 2026-11-11 and is pinned here, so a changed file is refused.
pub const DOLPHIN: Package = Package {
    id: "dolphin-2609b-x64",
    url: "https://dl.dolphin-emu.org/releases/2609b/dolphin-2609b-x64.7z",
    sha256: "926eb7594d885b4fba8fd9807058d90618efab4b3d75d1ef297022ba14925133",
    size: 20_028_240,
    root: "Dolphin-x64",
    note: "dl.dolphin-emu.org, no published checksum; SHA-256 pinned by TM Horizon on 2026-11-11",
};

/// melonDS 1.1 (GitHub release), Windows x64; the SHA-256 is GitHub's digest of the asset.
pub const MELONDS: Package = Package {
    id: "melonds-1.1-windows-x86_64",
    url: "https://github.com/melonDS-emu/melonDS/releases/download/1.1/melonDS-1.1-windows-x86_64.zip",
    sha256: "9f3f8a244103be20b5b657af5b0ed1b2a66bb20a7181476a6d294c9a53d4f8c8",
    size: 19_484_283,
    root: "",
    note: "github.com/melonDS-emu/melonDS release 1.1, matches GitHub's SHA-256 digest",
};

pub fn package(emu: Emu) -> &'static Package {
    match emu {
        Emu::Dolphin => &DOLPHIN,
        Emu::MelonDs => &MELONDS,
    }
}

pub fn version_of(emu: Emu) -> &'static str {
    match emu {
        Emu::Dolphin => "2609b",
        Emu::MelonDs => "1.1",
    }
}

/// `<data>/emulators/<emu>/<version>/`.
pub fn managed_dir(data: &Path, emu: Emu) -> PathBuf {
    data.join("emulators").join(emu.key()).join(version_of(emu))
}

pub fn managed_exe(data: &Path, emu: Emu) -> Option<PathBuf> {
    let d = managed_dir(data, emu);
    let p = package(emu);
    let exe = d.join(emu.exe());
    (exe.is_file() && std::fs::read_to_string(d.join(".horizon-package")).ok().as_deref() == Some(p.sha256)).then_some(exe)
}

/// Downloads (or reuses the checked cache copy) and unpacks the emulator. Returns its exe.
pub fn install(data: &Path, emu: Emu, fetch: &dyn Fn(&str, &Path) -> Result<(), String>) -> Result<PathBuf, String> {
    if let Some(e) = managed_exe(data, emu) {
        return Ok(e);
    }
    let p = package(emu);
    let archive = crate::hosting::deps::ensure_package(data, p, fetch)?;
    let dest = managed_dir(data, emu);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    match emu {
        Emu::MelonDs => {
            crate::hosting::deps::install_package(&archive, p, &dest)?;
        }
        Emu::Dolphin => {
            extract_7z(&archive, p.root, &dest)?;
            // Portable mode: Dolphin keeps its settings in <dir>\User, not in the player's Documents.
            std::fs::write(dest.join("portable.txt"), b"").map_err(|e| e.to_string())?;
            std::fs::write(dest.join(".horizon-package"), p.sha256).map_err(|e| e.to_string())?;
        }
    }
    managed_exe(data, emu).ok_or_else(|| format!("{} not found after unpacking", emu.exe()))
}

/// Unpacks a 7z archive (Dolphin's builds) into `dest`, taking the folder `root` inside it.
pub fn extract_7z(archive: &Path, root: &str, dest: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or("bad target")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".unpack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    sevenz_rust2::decompress_file(archive, &tmp).map_err(|e| format!("Unpacking failed: {e}"))?;
    let src = if root.is_empty() { tmp.clone() } else { tmp.join(root) };
    if !src.is_dir() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("{root} not found in the archive"));
    }
    std::fs::rename(&src, dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(())
}

// ------------------------------------------------------------------ settings

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConsoleSettings {
    /// Game id -> the player's dump file.
    pub dumps: BTreeMap<String, String>,
    /// Dolphin.exe / melonDS.exe picked by hand (wins over the downloaded and the found one).
    pub dolphin_exe: Option<String>,
    pub melonds_exe: Option<String>,
    /// Dolphin internal resolution: 0 = Dolphin's own setting, 1 = native (640x528), 2 = 2x (720p), 3 = 3x (1080p), 4 = 4x, 6 = 6x (4K).
    pub dolphin_resolution: u8,
    /// Load custom textures from Dolphin's `Load\Textures\<game id>` folder.
    pub dolphin_textures: bool,
}

/// Dolphin installs found without asking: the old installer's folders and the program list.
pub fn detect_dolphin() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for pf in crate::platform::program_files() {
        dirs.push(pf.join("Dolphin"));
        dirs.push(pf.join("Dolphin-x64"));
        dirs.push(pf.join("Dolphin Emulator"));
    }
    for u in crate::platform::uninstall_entries() {
        if u.name.to_lowercase().contains("dolphin") {
            if let Some(l) = u.location {
                dirs.push(l);
            }
        }
    }
    dirs.into_iter().map(|d| d.join("Dolphin.exe")).find(|e| crate::fsx::is_file(e))
}

/// Where an emulator comes from, for the card.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmuStatus {
    pub emu: Emu,
    pub name: &'static str,
    /// "picked", "downloaded", "found" or "" (none).
    pub source: &'static str,
    pub exe: Option<String>,
    pub version: &'static str,
    pub download_url: &'static str,
    pub download_size: u64,
    pub download_note: &'static str,
}

pub fn emulator(data: &Path, s: &ConsoleSettings, emu: Emu, detect: bool) -> EmuStatus {
    let picked = match emu {
        Emu::Dolphin => s.dolphin_exe.as_deref(),
        Emu::MelonDs => s.melonds_exe.as_deref(),
    }
    .map(PathBuf::from)
    .filter(|p| p.is_file());
    let (source, exe) = if let Some(p) = picked {
        ("picked", Some(p))
    } else if let Some(p) = managed_exe(data, emu) {
        ("downloaded", Some(p))
    } else if let Some(p) = (detect && emu == Emu::Dolphin).then(detect_dolphin).flatten() {
        ("found", Some(p))
    } else {
        ("", None)
    };
    let p = package(emu);
    EmuStatus {
        emu,
        name: emu.name(),
        source,
        exe: exe.map(|e| e.to_string_lossy().into_owned()),
        version: version_of(emu),
        download_url: p.url,
        download_size: p.size,
        download_note: p.note,
    }
}

/// A picked emulator exe must be the emulator's own exe name.
pub fn exe_name_ok(emu: Emu, path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(emu.exe())) && path.is_file()
}

// ------------------------------------------------------------------ dumps

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DumpInfo {
    pub path: String,
    pub format: String,
    /// DS game code (4) or Wii game id (6).
    pub code: String,
    /// DS header title (12 characters), empty for Wii.
    pub title: String,
    /// The console game this file is (None: not a TrackMania console game).
    pub game: Option<&'static str>,
    pub size: u64,
}

fn ascii(b: &[u8]) -> String {
    b.iter().take_while(|&&c| c != 0).map(|&c| if c.is_ascii_graphic() || c == b' ' { c as char } else { '?' }).collect::<String>().trim().to_string()
}

/// CRC-16 (MODBUS: poly 0xA001 reflected, init 0xFFFF), the DS header checksum at 0x15E.
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xA001 } else { crc >> 1 };
        }
    }
    crc
}

const WII_MAGIC: u32 = 0x5D1C_9EA3;
const GC_MAGIC: u32 = 0xC233_9F3D;

fn read_at(f: &mut std::fs::File, off: u64, n: usize) -> Result<Vec<u8>, String> {
    f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    let mut b = vec![0u8; n];
    f.read_exact(&mut b).map_err(|_| "The file is too short".to_string())?;
    Ok(b)
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}
fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}
fn le64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

/// A 0x20-byte disc header: the 6-character game id when the Wii (or GameCube) magic is there.
fn disc_id(h: &[u8]) -> Result<String, String> {
    if h.len() < 0x20 {
        return Err("The file is too short".into());
    }
    if be32(h, 0x18) == WII_MAGIC || be32(h, 0x1C) == GC_MAGIC {
        Ok(ascii(&h[..6]))
    } else {
        Err("Not a Wii disc image (no Wii disc header)".into())
    }
}

/// Reads the header of a dump and tells which game it is. Only the first bytes are read.
pub fn read_dump(path: &Path) -> Result<DumpInfo, String> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let head = read_at(&mut f, 0, 0x20.min(size as usize))?;
    let (format, code, title) = if ext == "nds" || ext == "dsi" || ext == "srl" {
        let h = read_at(&mut f, 0, 0x160)?;
        let want = u16::from_le_bytes([h[0x15E], h[0x15F]]);
        if crc16(&h[..0x15E]) != want {
            return Err("Not a DS game file (header checksum does not match)".into());
        }
        ("nds".to_string(), ascii(&h[0x0C..0x10]), ascii(&h[..0x0C]))
    } else if head.len() >= 4 && &head[..4] == b"WBFS" {
        // WBFS: the disc header copy sits at the first HD sector (1 << byte 8, usually 0x200).
        let shift = head[8] as u32;
        if !(9..=16).contains(&shift) {
            return Err("Damaged WBFS header".into());
        }
        let h = read_at(&mut f, 1u64 << shift, 0x20)?;
        ("wbfs".into(), disc_id(&h)?, String::new())
    } else if head.len() >= 4 && (&head[..4] == b"RVZ\x01" || &head[..4] == b"WIA\x01") {
        // WIA/RVZ: header 1 (0x48 bytes), then header 2 whose disc_header copy starts at +0x10.
        let h = read_at(&mut f, 0x58, 0x20)?;
        (if head[0] == b'R' { "rvz" } else { "wia" }.into(), disc_id(&h)?, String::new())
    } else if head.len() >= 4 && &head[..4] == b"CISO" {
        // CISO: 0x8000-byte header (block size + block map), the first block follows uncompressed.
        let h = read_at(&mut f, 0, 9)?;
        if h[8] != 1 {
            return Err("CISO without its first block".into());
        }
        let d = read_at(&mut f, 0x8000, 0x20)?;
        ("ciso".into(), disc_id(&d)?, String::new())
    } else if head.len() >= 32 && le32(&head, 0) == 0xB10B_C001 {
        // GCZ: 32-byte header, block pointers (u64) and hashes (u32), then the data; block 0 is zlib
        // unless the top bit of its pointer is set.
        let n = le32(&head, 28) as u64;
        if n == 0 || n > 1 << 24 {
            return Err("Damaged GCZ header".into());
        }
        let ptr = le64(&read_at(&mut f, 32, 8)?, 0);
        let data_start = 32 + n * 12;
        let raw = ptr & (1 << 63) != 0;
        f.seek(SeekFrom::Start(data_start + (ptr & !(1 << 63)))).map_err(|e| e.to_string())?;
        let mut d = vec![0u8; 0x20];
        if raw {
            f.read_exact(&mut d).map_err(|_| "The file is too short".to_string())?;
        } else {
            flate2::read::ZlibDecoder::new(&mut f).read_exact(&mut d).map_err(|_| "GCZ: first block not readable".to_string())?;
        }
        ("gcz".into(), disc_id(&d)?, String::new())
    } else if ext == "iso" || ext == "gcm" {
        ("iso".into(), disc_id(&read_at(&mut f, 0, 0x20)?)?, String::new())
    } else {
        return Err("Unknown file type. DS: .nds; Wii: .iso, .wbfs, .rvz, .wia, .ciso, .gcz".into());
    };
    let game = GAMES.iter().find(|g| g.codes.iter().any(|c| code.len() >= 4 && code[..4].eq_ignore_ascii_case(c))).map(|g| g.id);
    Ok(DumpInfo { path: path.to_string_lossy().into_owned(), format, code, title, game, size })
}

/// Checks that `path` is a dump of `game_id`; the error names what the file is instead.
pub fn check_dump(game_id: &str, path: &Path) -> Result<DumpInfo, String> {
    let g = game(game_id).ok_or("Not a console game")?;
    let d = read_dump(path)?;
    match d.game {
        Some(id) if id == g.id => Ok(d),
        Some(other) => Err(format!("This is {} ({}), not {}.", game(other).map(|x| x.name).unwrap_or(other), d.code, g.name)),
        None => Err(format!("Game code {} is not {}{}.", d.code, g.name, if d.title.is_empty() { String::new() } else { format!(" (title in the file: {})", d.title) })),
    }
}

// ------------------------------------------------------------------ start

/// Arguments after the emulator exe.
pub fn launch_args(emu: Emu, dump: &str, s: &ConsoleSettings) -> Vec<String> {
    match emu {
        Emu::Dolphin => {
            let mut a = vec!["-b".to_string(), "-e".into(), dump.to_string()];
            if (1..=8).contains(&s.dolphin_resolution) {
                a.push("-C".into());
                a.push(format!("Graphics.Settings.InternalResolution={}", s.dolphin_resolution));
            }
            if s.dolphin_textures {
                a.push("-C".into());
                a.push("Graphics.Settings.HiresTextures=True".into());
            }
            a
        }
        Emu::MelonDs => vec![dump.to_string()],
    }
}

/// The console games as installs for the snapshot: set up = an emulator and a dump that still exists.
pub fn installs(data: &Path, s: &ConsoleSettings) -> BTreeMap<&'static str, Vec<crate::scan::InstallInfo>> {
    let mut out = BTreeMap::new();
    let mut emus: BTreeMap<&str, EmuStatus> = BTreeMap::new();
    for g in &GAMES {
        let Some(dump) = s.dumps.get(g.id).filter(|d| Path::new(d).is_file()) else {
            out.insert(g.id, vec![]);
            continue;
        };
        let e = emus.entry(g.emu.key()).or_insert_with(|| emulator(data, s, g.emu, true)).clone();
        let list = match e.exe {
            Some(exe) => vec![crate::scan::InstallInfo {
                source: e.name.into(),
                path: Path::new(dump).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                modified: crate::fsx::mtime_iso(Path::new(dump)),
                exe: Some(exe),
                rom: Some(dump.clone()),
                extra_args: launch_args(g.emu, dump, s),
                ..Default::default()
            }],
            None => vec![],
        };
        out.insert(g.id, list);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ds_header(code: &str, title: &str) -> Vec<u8> {
        let mut h = vec![0u8; 0x200];
        h[..title.len()].copy_from_slice(title.as_bytes());
        h[0x0C..0x10].copy_from_slice(code.as_bytes());
        let c = crc16(&h[..0x15E]);
        h[0x15E..0x160].copy_from_slice(&c.to_le_bytes());
        h
    }

    fn wii_header(id: &str) -> Vec<u8> {
        let mut h = vec![0u8; 0x80];
        h[..6].copy_from_slice(id.as_bytes());
        h[0x18..0x1C].copy_from_slice(&WII_MAGIC.to_be_bytes());
        h
    }

    #[test]
    fn crc16_known_value() {
        // CRC-16/MODBUS check value of "123456789".
        assert_eq!(crc16(b"123456789"), 0x4B37);
    }

    #[test]
    fn ds_dumps_are_checked_by_code_and_crc() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("tm.nds");
        std::fs::write(&p, ds_header("CTRP", "TRACKMANIA")).unwrap();
        let d = check_dump("tm-ds", &p).unwrap();
        assert_eq!((d.code.as_str(), d.title.as_str(), d.game), ("CTRP", "TRACKMANIA", Some("tm-ds")));
        // The other DS game: named in the error.
        let e = check_dump("tm-turbo-ds", &p).unwrap_err();
        assert!(e.contains("TrackMania DS"), "{e}");
        std::fs::write(&p, ds_header("BT2E", "TRACKMANIA T")).unwrap();
        assert_eq!(check_dump("tm-turbo-ds", &p).unwrap().game, Some("tm-turbo-ds"));
        // Another game, and a broken header.
        std::fs::write(&p, ds_header("AMCE", "MARIOKART DS")).unwrap();
        assert!(check_dump("tm-ds", &p).unwrap_err().contains("AMCE"));
        let mut bad = ds_header("CTRP", "TRACKMANIA");
        bad[0] ^= 1;
        std::fs::write(&p, bad).unwrap();
        assert!(read_dump(&p).unwrap_err().contains("checksum"));
    }

    #[test]
    fn wii_formats() {
        let t = tempfile::tempdir().unwrap();
        // Plain ISO.
        let iso = t.path().join("tm.iso");
        let mut b = wii_header("R6RPHH");
        b.resize(0x1000, 0);
        std::fs::write(&iso, &b).unwrap();
        assert_eq!(check_dump("tm-wii", &iso).unwrap().code, "R6RPHH");
        // WBFS: header copy at 1 << 9.
        let wbfs = t.path().join("tm.wbfs");
        let mut b = b"WBFS\0\0\0\x10\x09\x15".to_vec();
        b.resize(0x200, 0);
        b.extend(wii_header("R6REJH"));
        std::fs::write(&wbfs, &b).unwrap();
        let d = check_dump("tm-wii", &wbfs).unwrap();
        assert_eq!((d.format.as_str(), d.code.as_str()), ("wbfs", "R6REJH"));
        // RVZ: disc header at 0x58.
        let rvz = t.path().join("tm.rvz");
        let mut b = b"RVZ\x01".to_vec();
        b.resize(0x58, 0);
        b.extend(wii_header("R6RPHH"));
        std::fs::write(&rvz, &b).unwrap();
        assert_eq!(check_dump("tm-wii", &rvz).unwrap().format, "rvz");
        // CISO: first block at 0x8000.
        let ciso = t.path().join("tm.ciso");
        let mut b = b"CISO\0\0\x20\0\x01".to_vec();
        b.resize(0x8000, 0);
        b.extend(wii_header("R6RPHH"));
        std::fs::write(&ciso, &b).unwrap();
        assert_eq!(check_dump("tm-wii", &ciso).unwrap().code, "R6RPHH");
        // GCZ with a zlib first block.
        let gcz = t.path().join("tm.gcz");
        let mut block = Vec::new();
        {
            use std::io::Write;
            let mut z = flate2::write::ZlibEncoder::new(&mut block, flate2::Compression::default());
            z.write_all(&wii_header("R6REJH")).unwrap();
            z.finish().unwrap();
        }
        let mut b = Vec::new();
        b.extend(0xB10B_C001u32.to_le_bytes());
        b.extend(1u32.to_le_bytes());
        b.extend((block.len() as u64).to_le_bytes());
        b.extend(0x80u64.to_le_bytes());
        b.extend(0x8000u32.to_le_bytes());
        b.extend(1u32.to_le_bytes());
        b.extend(0u64.to_le_bytes()); // pointer of block 0
        b.extend(0u32.to_le_bytes()); // hash of block 0
        b.extend(&block);
        std::fs::write(&gcz, &b).unwrap();
        assert_eq!(check_dump("tm-wii", &gcz).unwrap().code, "R6REJH");
        // Another Wii game, a non-disc file, an unknown extension.
        std::fs::write(&iso, wii_header("RMCP01")).unwrap();
        assert!(check_dump("tm-wii", &iso).unwrap_err().contains("RMCP01"));
        std::fs::write(&iso, vec![0u8; 0x40]).unwrap();
        assert!(read_dump(&iso).is_err());
        let txt = t.path().join("x.txt");
        std::fs::write(&txt, b"hello world, this is not a game image").unwrap();
        assert!(read_dump(&txt).is_err());
    }

    #[test]
    fn start_arguments() {
        let mut s = ConsoleSettings::default();
        assert_eq!(launch_args(Emu::Dolphin, r"D:\Wii\tm.rvz", &s), vec!["-b", "-e", r"D:\Wii\tm.rvz"]);
        s.dolphin_resolution = 3;
        s.dolphin_textures = true;
        assert_eq!(
            launch_args(Emu::Dolphin, "x.iso", &s),
            vec!["-b", "-e", "x.iso", "-C", "Graphics.Settings.InternalResolution=3", "-C", "Graphics.Settings.HiresTextures=True"]
        );
        assert_eq!(launch_args(Emu::MelonDs, r"D:\DS\tm.nds", &s), vec![r"D:\DS\tm.nds"]);
    }

    #[test]
    fn installs_need_emulator_and_dump() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        let dump = t.path().join("tm.nds");
        std::fs::write(&dump, ds_header("CTRP", "TRACKMANIA")).unwrap();
        let mut s = ConsoleSettings::default();
        s.dumps.insert("tm-ds".into(), dump.to_string_lossy().into());
        assert!(installs(&data, &s)["tm-ds"].is_empty(), "no melonDS yet");
        let exe = t.path().join("melonDS.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        s.melonds_exe = Some(exe.to_string_lossy().into());
        let i = &installs(&data, &s)["tm-ds"][0];
        assert_eq!(i.exe.as_deref(), Some(exe.to_string_lossy().as_ref()));
        assert_eq!(i.rom.as_deref(), Some(dump.to_string_lossy().as_ref()));
        assert_eq!(i.extra_args, vec![dump.to_string_lossy().to_string()]);
        assert!(installs(&data, &s)["tm-wii"].is_empty());
        assert!(exe_name_ok(Emu::MelonDs, &exe) && !exe_name_ok(Emu::Dolphin, &exe));
    }

    #[test]
    fn managed_install_from_cached_packages() {
        // The download is mocked: a zip with melonDS.exe whose hash is pinned in a test package.
        let t = tempfile::tempdir().unwrap();
        let zip = t.path().join("m.zip");
        {
            use std::io::Write;
            let mut z = zip::ZipWriter::new(std::fs::File::create(&zip).unwrap());
            z.start_file("melonDS.exe", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"MZ melon").unwrap();
            z.finish().unwrap();
        }
        let bytes = std::fs::read(&zip).unwrap();
        let sha = crate::tmloader::sha256_hex(&bytes);
        let p = Package { id: "m", url: "https://example.invalid/m.zip", sha256: Box::leak(sha.into_boxed_str()), size: bytes.len() as u64, root: "", note: "" };
        let got = crate::hosting::deps::ensure_package(t.path(), &p, &|_, dest| std::fs::copy(&zip, dest).map(|_| ()).map_err(|e| e.to_string())).unwrap();
        let dest = t.path().join("out");
        crate::hosting::deps::install_package(&got, &p, &dest).unwrap();
        assert!(dest.join("melonDS.exe").is_file());
        // A file with other bytes is refused.
        let bad = Package { sha256: "0000000000000000000000000000000000000000000000000000000000000000", ..p };
        assert!(crate::hosting::deps::ensure_package(&t.path().join("x"), &bad, &|_, dest| std::fs::copy(&zip, dest).map(|_| ()).map_err(|e| e.to_string())).is_err());
    }

    /// Unpacks the real Dolphin archive when it is at hand (TMHUB_DOLPHIN_7Z=<path>); no download.
    #[test]
    fn dolphin_7z_unpacks() {
        let Ok(a) = std::env::var("TMHUB_DOLPHIN_7Z") else { return };
        let t = tempfile::tempdir().unwrap();
        let dest = t.path().join("dolphin");
        extract_7z(Path::new(&a), DOLPHIN.root, &dest).unwrap();
        assert!(dest.join("Dolphin.exe").is_file());
    }
}
