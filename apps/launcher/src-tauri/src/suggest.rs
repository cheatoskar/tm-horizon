//! "Recommended for your game": the ZIP install of TrackMania Highlands (a community environment for
//! United Forever, hosted on ModDB). TM Horizon never downloads it: the player downloads the ZIP on
//! ModDB, the launcher finds it in the Downloads folder (or the player picks it), checks it against the
//! catalog's expected file (`zipInstall` of `env-tm-highlands` in packages/catalog/catalog.json: name,
//! size, MD5, folder inside the ZIP) and unpacks it into the game folder with a History entry (undo).
//! While the expected values are empty, the file's own size and MD5 are shown and the player confirms.
//! Programs and scripts inside the ZIP (exe, dll, bat, ...) are refused. Only the folder named by
//! `only` (GameData/) is unpacked; text files beside it (readme, credits) are shown, not unpacked.
//! The two files Highlands overwrites (Game.FidCache.Gbx, BaseEditorSimple campaign) are kept by the
//! History entry, so Undo restores them. "Off" without uninstalling renames the environment collection
//! and the car to *.disabled, as the Highlands readme describes.

use md5::{Digest, Md5};
use sha2::Sha256;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};

const CATALOG_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/catalog.json"));
pub const HIGHLANDS_ID: &str = "env-tm-highlands";
const MAX_FILES: usize = 20_000;
const MAX_UNPACKED: u64 = 4 << 30;
const BLOCKED_EXT: [&str; 14] = ["exe", "dll", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "msi", "lnk", "reg", "sys", "asi"];

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ZipSpec {
    pub page: String,
    pub file_name: String,
    pub size: Option<u64>,
    pub md5: String,
    /// Optional, checked as well when set (64 hex characters).
    pub sha256: String,
    pub root: String,
    /// Only entries under this folder (after `root`) are unpacked, e.g. "GameData/".
    pub only: String,
}

impl ZipSpec {
    /// The expected file is known (size and MD5 filled in the catalog).
    pub fn pinned(&self) -> bool {
        self.size.is_some() && self.md5.len() == 32
    }
}

pub fn spec_from(json: &str, id: &str) -> Option<ZipSpec> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let e = v.get("entries")?.as_array()?.iter().find(|e| e.get("id").and_then(|x| x.as_str()) == Some(id))?;
    serde_json::from_value(e.get("zipInstall")?.clone()).ok()
}

pub fn highlands_spec() -> ZipSpec {
    spec_from(CATALOG_JSON, HIGHLANDS_ID).unwrap_or_default()
}

// ------------------------------------------------------------------ already done?

/// The two files that make Highlands show up in the game (environment collection and car). Both exist
/// after the ZIP and after the official installer.
pub const HIGHLANDS_KEYS: [&str; 2] = ["GameData/Collections/Highlands.TMCollection.Gbx", "GameData/Vehicles/TrackManiaVehicle/HighlandCar.ConstructionVehicle.Gbx"];
const DISABLED: &str = ".disabled";

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HighlandsState {
    pub installed: bool,
    /// Switched on (the two files under their own names).
    pub enabled: bool,
}

fn key_file(game_dir: &Path, rel: &str, off: bool) -> PathBuf {
    let p = game_dir.join(rel);
    if off { PathBuf::from(format!("{}{DISABLED}", p.display())) } else { p }
}

pub fn highlands_state(game_dir: &Path) -> HighlandsState {
    let on = HIGHLANDS_KEYS.iter().all(|r| crate::fsx::is_file(&key_file(game_dir, r, false)));
    let any = HIGHLANDS_KEYS.iter().all(|r| crate::fsx::is_file(&key_file(game_dir, r, false)) || crate::fsx::is_file(&key_file(game_dir, r, true)));
    HighlandsState { installed: any, enabled: on }
}

/// Switches Highlands on or off by renaming its two key files (no uninstall).
pub fn highlands_set_enabled(game_dir: &Path, on: bool) -> Result<HighlandsState, String> {
    if !highlands_state(game_dir).installed {
        return Err("Highlands is not installed".into());
    }
    for r in HIGHLANDS_KEYS {
        let (from, to) = (key_file(game_dir, r, on), key_file(game_dir, r, !on));
        if crate::fsx::is_file(&from) && !crate::fsx::is_file(&to) {
            std::fs::rename(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
        }
    }
    Ok(highlands_state(game_dir))
}

/// Highlands is in the United Forever folder (its two key files, also when switched off), or an
/// install through TM Horizon that was not undone.
pub fn highlands_present(game_dir: &Path, history: &[crate::history::Change]) -> bool {
    let installed_here = history.iter().any(|c| c.kind == "env-install" && c.title.contains("Highlands") && c.undone.is_none() && c.games.iter().any(|g| g == "tmuf"));
    installed_here || highlands_state(game_dir).installed
}

/// Horizon Client is on for this game: the host in the game folder (ESWC, Sunrise, Original), or the
/// TMLoader product switched on in the profile that starts the game (Forever).
pub fn horizon_on(game: &str, game_dir: Option<&Path>, tml_profiles_on: &[String], profile: Option<&str>) -> bool {
    use crate::horizonhost::format::{HOST_DIR, HOST_DLL};
    match game {
        "tmnf" | "tmuf" => match profile {
            Some(p) => tml_profiles_on.iter().any(|x| x == p),
            None => !tml_profiles_on.is_empty(),
        },
        _ => game_dir.is_some_and(|d| crate::fsx::is_file(&d.join(HOST_DIR).join(HOST_DLL))),
    }
}

/// A ZIP in the Downloads folder that may be the expected one: the catalog's file name when it is
/// set, else a .zip with "highland" in its name. Newest first, only files changed after `since`.
pub fn find_in(dir: &Path, spec: &ZipSpec, since: Option<std::time::SystemTime>) -> Vec<PathBuf> {
    let mut out: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        let want = if spec.file_name.is_empty() { name.ends_with(".zip") && name.contains("highland") } else { name == spec.file_name.to_lowercase() };
        if !want {
            continue;
        }
        let Ok(m) = e.metadata() else { continue };
        let t = m.modified().unwrap_or(std::time::UNIX_EPOCH);
        if m.is_file() && since.is_none_or(|s| t >= s) {
            out.push((t, e.path()));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|x| x.1).collect()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZipCheck {
    pub path: String,
    pub size: u64,
    pub md5: String,
    /// Matches the catalog's expected size and MD5.
    pub verified: bool,
    /// The catalog has no expected values yet: the player confirms.
    pub needs_confirm: bool,
    /// Files that will be written (relative to the game folder).
    pub files: Vec<String>,
    pub unpacked_bytes: u64,
    /// Text files in the ZIP that are not unpacked (readme, credits): name and text (first 16 KB).
    pub notes: Vec<(String, String)>,
}

/// MD5 and SHA-256 of a file in one pass.
fn hashes(p: &Path) -> Result<(String, String), String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let (mut h, mut s) = (Md5::new(), Sha256::new());
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        s.update(&buf[..n]);
    }
    Ok((hex::encode(h.finalize()), hex::encode(s.finalize())))
}

/// Text files outside `only` (readme, credits), for showing; at most 4 files, 16 KB each.
fn notes(zip: &Path, spec: &ZipSpec) -> Vec<(String, String)> {
    let Ok(f) = std::fs::File::open(zip) else { return vec![] };
    let Ok(mut z) = zip::ZipArchive::new(f) else { return vec![] };
    let mut out = vec![];
    for i in 0..z.len().min(MAX_FILES) {
        let Ok(e) = z.by_index(i) else { continue };
        let name = e.name().replace('\\', "/");
        let inside = !spec.only.is_empty() && name.trim_start_matches(&format!("{}/", spec.root.trim_matches('/'))).starts_with(spec.only.as_str());
        if e.is_dir() || inside || !name.to_lowercase().ends_with(".txt") || out.len() >= 4 {
            continue;
        }
        let mut b = Vec::new();
        let _ = e.take(16 << 10).read_to_end(&mut b);
        out.push((name.rsplit('/').next().unwrap_or(&name).to_string(), String::from_utf8_lossy(&b).into_owned()));
    }
    out
}

/// Entry names after the root folder is taken off (only those under `only`, when set); refuses
/// unsafe paths and programs.
fn plan(zip: &Path, root: &str, only: &str) -> Result<(Vec<(usize, String)>, u64), String> {
    let f = std::fs::File::open(zip).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|_| "Not a ZIP file".to_string())?;
    if z.len() > MAX_FILES {
        return Err("Too many files in the ZIP".into());
    }
    let prefix = if root.is_empty() { String::new() } else { format!("{}/", root.trim_matches('/')) };
    let mut out = Vec::new();
    let mut total = 0u64;
    for i in 0..z.len() {
        let e = z.by_index(i).map_err(|e| e.to_string())?;
        if e.is_dir() {
            continue;
        }
        let Some(rel) = e.enclosed_name() else { return Err(format!("Unsafe path in the ZIP: {}", e.name())) };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let Some(rel) = rel.strip_prefix(&prefix) else { continue };
        if !rel.starts_with(only) {
            continue;
        }
        let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
        if BLOCKED_EXT.contains(&ext.as_str()) {
            return Err(format!("The ZIP contains a program or script ({rel}); not unpacked."));
        }
        total += e.size();
        out.push((i, rel.to_string()));
    }
    if out.is_empty() {
        return Err("No files to unpack in the ZIP".into());
    }
    if total > MAX_UNPACKED {
        return Err("The ZIP unpacks to more than 4 GB".into());
    }
    Ok((out, total))
}

pub fn check(zip: &Path, spec: &ZipSpec) -> Result<ZipCheck, String> {
    let size = std::fs::metadata(zip).map_err(|e| e.to_string())?.len();
    let (md5, sha256) = hashes(zip)?;
    if spec.sha256.len() == 64 && !sha256.eq_ignore_ascii_case(&spec.sha256) {
        return Err(format!("SHA-256 {sha256} does not match the expected {}.", spec.sha256));
    }
    if spec.pinned() {
        if Some(size) != spec.size {
            return Err(format!("Size {size} bytes, expected {} (ModDB file {}).", spec.size.unwrap_or(0), spec.file_name));
        }
        if !md5.eq_ignore_ascii_case(&spec.md5) {
            return Err(format!("MD5 {md5} does not match ModDB's {}.", spec.md5));
        }
    }
    let (files, unpacked) = plan(zip, &spec.root, &spec.only)?;
    Ok(ZipCheck {
        path: zip.to_string_lossy().into_owned(),
        size,
        md5,
        verified: spec.pinned(),
        needs_confirm: !spec.pinned(),
        files: files.into_iter().map(|(_, r)| r).collect(),
        unpacked_bytes: unpacked,
        notes: notes(zip, spec),
    })
}

/// Unpacks into `game_dir` inside a History recording (undo restores or removes every file).
/// `confirmed` is needed while the catalog has no expected values. Returns the History entry id.
pub fn install(data: &Path, game: &str, game_dir: &Path, zip: &Path, spec: &ZipSpec, confirmed: bool) -> Result<Option<String>, String> {
    let c = check(zip, spec)?;
    if c.needs_confirm && !confirmed {
        return Err("Confirm the unchecked file first".into());
    }
    let (files, unpacked) = plan(zip, &spec.root, &spec.only)?;
    // Room for the files plus the History copies of the ones it overwrites, with a margin.
    if let Some(free) = crate::health::free_bytes(game_dir) {
        let need = unpacked + (256 << 20);
        if free < need {
            return Err(format!("Not enough free space: {} MB needed, {} MB free.", need >> 20, free >> 20));
        }
    }
    let rels: Vec<String> = files.iter().map(|(_, r)| r.clone()).collect();
    let rec = crate::history::Recorder::start(data, crate::history::Op::for_game(game, "env-install", "TrackMania Highlands").detail(c.md5.clone()), crate::history::files_in(game_dir, &rels));
    let res = (|| -> Result<(), String> {
        let f = std::fs::File::open(zip).map_err(|e| e.to_string())?;
        let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
        for (i, rel) in &files {
            let mut e = z.by_index(*i).map_err(|e| e.to_string())?;
            let out = game_dir.join(rel);
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut w = std::fs::File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?;
            std::io::copy(&mut e, &mut w).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    let id = rec.finish();
    res.map(|_| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(p: &Path, files: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(p).unwrap());
        for (n, b) in files {
            z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn highlands_detected_by_files_or_history() {
        let t = tempfile::tempdir().unwrap();
        let g = t.path();
        assert!(!highlands_present(g, &[]));
        // A folder named like it is not enough (texture packs for Highlands use such folders).
        std::fs::create_dir_all(g.join("GameData").join("Highlands")).unwrap();
        assert!(!highlands_present(g, &[]));
        for r in HIGHLANDS_KEYS {
            std::fs::create_dir_all(g.join(r).parent().unwrap()).unwrap();
            std::fs::write(g.join(r), b"x").unwrap();
        }
        assert!(highlands_present(g, &[]));
        assert_eq!(highlands_state(g), HighlandsState { installed: true, enabled: true });
        // Off: both renamed to *.disabled, still installed; on again restores the names.
        assert_eq!(highlands_set_enabled(g, false).unwrap(), HighlandsState { installed: true, enabled: false });
        assert!(g.join(format!("{}.disabled", HIGHLANDS_KEYS[0])).exists() && !g.join(HIGHLANDS_KEYS[0]).exists());
        assert!(highlands_present(g, &[]));
        assert_eq!(highlands_set_enabled(g, true).unwrap(), HighlandsState { installed: true, enabled: true });
        assert!(highlands_set_enabled(&t.path().join("none"), false).is_err());
        let g3 = t.path().join("third");
        let mut c: crate::history::Change = serde_json::from_value(serde_json::json!({
            "id": "1", "at": "2026-11-11T00:00:00Z", "games": ["tmuf"], "kind": "env-install", "title": "TrackMania Highlands", "files": []
        })).unwrap();
        assert!(highlands_present(&g3, std::slice::from_ref(&c)));
        c.undone = Some("2026-11-12T00:00:00Z".into());
        assert!(!highlands_present(&g3, &[c]));
    }

    #[test]
    fn horizon_detected_per_game() {
        let t = tempfile::tempdir().unwrap();
        assert!(!horizon_on("tmn-eswc", Some(t.path()), &[], None));
        std::fs::create_dir_all(t.path().join("horizon")).unwrap();
        std::fs::write(t.path().join("horizon").join("host.dll"), b"x").unwrap();
        assert!(horizon_on("tmn-eswc", Some(t.path()), &[], None));
        let on = vec!["Default".to_string()];
        assert!(horizon_on("tmuf", None, &on, Some("Default")));
        assert!(!horizon_on("tmuf", None, &on, Some("TAS")));
        assert!(!horizon_on("tmnf", None, &[], None));
    }

    #[test]
    fn catalog_has_the_highlands_entry() {
        let s = highlands_spec();
        assert!(s.page.starts_with("https://www.moddb.com/mods/trackmania-highlands"));
        assert!(s.pinned(), "TmHighlands.zip size and MD5 are pinned");
        assert_eq!((s.file_name.as_str(), s.size, s.sha256.len(), s.only.as_str()), ("TmHighlands.zip", Some(677_976_654), 64, "GameData/"));
    }

    #[test]
    fn check_and_install_with_undo() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        let game = t.path().join("TmUnitedForever");
        std::fs::create_dir_all(game.join("GameData")).unwrap();
        std::fs::write(game.join("GameData").join("old.txt"), b"old").unwrap();
        let zip = t.path().join("TrackMania_Highlands_1.0.zip");
        make_zip(&zip, &[("Highlands/GameData/Highlands/a.pak", b"aaa"), ("Highlands/GameData/old.txt", b"new"), ("readme.txt", b"r"), ("Highlands/Highlands README.txt", b"Back up two files")]);

        // Found in the Downloads folder by name.
        assert_eq!(find_in(t.path(), &ZipSpec::default(), None), vec![zip.clone()]);
        let pinned_name = ZipSpec { file_name: "other.zip".into(), ..Default::default() };
        assert!(find_in(t.path(), &pinned_name, None).is_empty());

        // Unpinned: needs confirmation, files under the root only.
        let spec = ZipSpec { root: "Highlands".into(), only: "GameData/".into(), ..Default::default() };
        let c = check(&zip, &spec).unwrap();
        assert!(c.needs_confirm && !c.verified);
        assert_eq!(c.files, vec!["GameData/Highlands/a.pak", "GameData/old.txt"]);
        assert!(c.notes.iter().any(|(n, t)| n == "Highlands README.txt" && t.contains("Back up")), "{:?}", c.notes);
        assert!(!game.join("Highlands README.txt").exists());
        let bad_sha = ZipSpec { sha256: "0".repeat(64), ..spec.clone() };
        assert!(check(&zip, &bad_sha).unwrap_err().contains("SHA-256"));
        assert!(install(&data, "tmuf", &game, &zip, &spec, false).is_err());
        let id = install(&data, "tmuf", &game, &zip, &spec, true).unwrap().expect("history entry");
        assert_eq!(std::fs::read(game.join("GameData/Highlands/a.pak")).unwrap(), b"aaa");
        assert_eq!(std::fs::read(game.join("GameData/old.txt")).unwrap(), b"new");
        // Undo through History: the old file is back, the new one gone.
        let r = crate::history::undo(&data, &id, &[]);
        assert!(r.ok, "{:?}", r);
        assert_eq!(std::fs::read(game.join("GameData/old.txt")).unwrap(), b"old");
        assert!(!game.join("GameData/Highlands/a.pak").exists());

        // Pinned: wrong MD5 refused, right one verified.
        let bad = ZipSpec { size: Some(c.size), md5: "0".repeat(32), ..spec.clone() };
        assert!(check(&zip, &bad).unwrap_err().contains("MD5"));
        let good = ZipSpec { size: Some(c.size), md5: c.md5.clone(), ..spec.clone() };
        let ok = check(&zip, &good).unwrap();
        assert!(ok.verified && !ok.needs_confirm);
        let wrong_size = ZipSpec { size: Some(1), md5: c.md5.clone(), ..spec };
        assert!(check(&zip, &wrong_size).unwrap_err().contains("Size"));
    }

    #[test]
    fn programs_in_the_zip_are_refused() {
        let t = tempfile::tempdir().unwrap();
        let zip = t.path().join("highlands.zip");
        make_zip(&zip, &[("GameData/x.pak", b"x"), ("setup.exe", b"MZ")]);
        assert!(check(&zip, &ZipSpec::default()).unwrap_err().contains("program"));
        std::fs::write(&zip, b"not a zip").unwrap();
        assert!(check(&zip, &ZipSpec::default()).is_err());
    }
}
