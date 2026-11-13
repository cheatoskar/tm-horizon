//! Steam fix for Nations/United Forever installed through Steam (only installs below `steamapps`):
//!
//! 1. `Nadeo.ini`: `Distro=MILIN` (the value of the stand-alone Forever release). The original file
//!    is kept as `Nadeo.ini.horizon-backup` next to it and the change is recorded in History; undo puts
//!    the original back as long as nobody changed the file since.
//! 2. Nadeo's official update `TmUnitedForever_Update_2010-03-15_Setup.exe`, downloaded from Nadeo's
//!    own server only after the click, checked against its known size and SHA-256 (it is served over
//!    plain http and not signed), then run with `/SILENT /SUPPRESSMSGBOXES /DIR="<game folder>"`
//!    (Inno Setup 5.2.3; Windows asks for admin rights when it needs them). TM Horizon never ships it.
//!    The update itself has no undo in TM Horizon: Steam > Properties > Installed files > Verify
//!    restores Steam's files.

use crate::gameinstall::{sha256_file, Fetch};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const DISTRO: &str = "MILIN";
pub const BACKUP_NAME: &str = "Nadeo.ini.horizon-backup";

pub const UPDATE_URL: &str = "http://files2.trackmaniaforever.com/TmUnitedForever_Update_2010-03-15_Setup.exe";
pub const UPDATE_FILE: &str = "TmUnitedForever_Update_2010-03-15_Setup.exe";
/// Checked by the owner on 2026-11-11 (Inno Setup 5.2.3, not code-signed).
pub const UPDATE_SHA256: &str = "f410ba92219f993ab224a4a672d0637649e2d5d36d003c9f1ce7f84f889fc9c5";
pub const UPDATE_SIZE: u64 = 22_430_056;

/// Only Steam installs get the fix: the game folder lies below a `steamapps` folder.
pub fn is_steam_install(dir: &Path) -> bool {
    dir.to_string_lossy().split(['\\', '/']).any(|c| c.eq_ignore_ascii_case("steamapps"))
}

fn is_distro_line(line: &str) -> bool {
    let l = line.trim_start();
    l.len() >= 7 && l[..7].eq_ignore_ascii_case("distro=")
}

/// The `Distro=` value of a Nadeo.ini text (first one), trimmed.
pub fn distro_of(text: &str) -> Option<String> {
    text.lines().find(|l| is_distro_line(l)).map(|l| l.trim_start()[7..].trim().to_string())
}

/// `text` with `Distro=<value>`: the first Distro line is replaced, otherwise one is added after the
/// first `[section]` line (or at the top). Line endings (CRLF or LF) and every other line stay.
pub fn set_distro(text: &str, value: &str) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(text.len() + 16);
    let mut done = false;
    for piece in text.split_inclusive('\n') {
        if !done && is_distro_line(piece) {
            let ending = if piece.ends_with("\r\n") { "\r\n" } else if piece.ends_with('\n') { "\n" } else { "" };
            let indent = &piece[..piece.len() - piece.trim_start().len()];
            out.push_str(&format!("{indent}Distro={value}{ending}"));
            done = true;
        } else {
            out.push_str(piece);
        }
    }
    if done {
        return out;
    }
    // No Distro line: after the first section header, else at the top.
    let mut out = String::with_capacity(text.len() + 16);
    let mut inserted = false;
    for piece in text.split_inclusive('\n') {
        out.push_str(piece);
        if !inserted && piece.trim_start().starts_with('[') {
            if !piece.ends_with('\n') {
                out.push_str(nl);
            }
            out.push_str(&format!("Distro={value}{nl}"));
            inserted = true;
        }
    }
    if !inserted {
        out = format!("Distro={value}{nl}{text}");
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The install lies below `steamapps`.
    pub steam: bool,
    pub ini_found: bool,
    pub distro: Option<String>,
    /// Distro is MILIN already.
    pub ini_fixed: bool,
    /// Our backup of the original Nadeo.ini exists (undo possible).
    pub backup: bool,
    /// The update file is in the download cache and matches.
    pub update_ready: bool,
    pub update_url: &'static str,
    pub update_size: u64,
}

pub fn status(dir: &Path, cache: &Path) -> Status {
    let ini = std::fs::read(dir.join("Nadeo.ini")).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let distro = ini.as_deref().and_then(distro_of);
    Status {
        steam: is_steam_install(dir),
        ini_found: ini.is_some(),
        ini_fixed: distro.as_deref().is_some_and(|d| d.eq_ignore_ascii_case(DISTRO)),
        distro,
        backup: dir.join(BACKUP_NAME).is_file(),
        update_ready: verify_file(&cache.join(UPDATE_FILE), UPDATE_SHA256, UPDATE_SIZE).is_ok(),
        update_url: UPDATE_URL,
        update_size: UPDATE_SIZE,
    }
}

/// Sets `Distro=MILIN` in `<dir>\Nadeo.ini`. The original is copied to `Nadeo.ini.horizon-backup`
/// first (an older backup is kept: it holds the first original). Nothing happens when it is set already.
pub fn apply_ini(dir: &Path) -> Result<bool, String> {
    let ini = dir.join("Nadeo.ini");
    let bytes = std::fs::read(&ini).map_err(|_| "Nadeo.ini not found in the game folder".to_string())?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if distro_of(&text).is_some_and(|d| d.eq_ignore_ascii_case(DISTRO)) {
        return Ok(false);
    }
    let backup = dir.join(BACKUP_NAME);
    if !backup.is_file() {
        std::fs::write(&backup, &bytes).map_err(|e| format!("Backup not written: {e}"))?;
    }
    let new = set_distro(&text, DISTRO);
    let tmp = dir.join("Nadeo.ini.horizon-new");
    std::fs::write(&tmp, new.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &ini).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(true)
}

/// Puts the original Nadeo.ini back from the backup. Refused when Nadeo.ini changed in another way
/// since (then the backup stays for the player to look at).
pub fn undo_ini(dir: &Path) -> Result<(), String> {
    let ini = dir.join("Nadeo.ini");
    let backup = dir.join(BACKUP_NAME);
    let orig = std::fs::read(&backup).map_err(|_| "No backup of Nadeo.ini from TM Horizon".to_string())?;
    let now = std::fs::read(&ini).unwrap_or_default();
    let orig_text = String::from_utf8_lossy(&orig);
    let now_text = String::from_utf8_lossy(&now);
    if now == orig {
        // Already the original (e.g. undone in History): only the backup goes.
        let _ = std::fs::remove_file(&backup);
        return Ok(());
    }
    if now_text != set_distro(&orig_text, DISTRO) {
        return Err(format!("Nadeo.ini changed since the fix. The original is kept as {BACKUP_NAME}."));
    }
    std::fs::write(&ini, &orig).map_err(|e| e.to_string())?;
    std::fs::remove_file(&backup).map_err(|e| e.to_string())?;
    Ok(())
}

/// Size and SHA-256 of a downloaded file against the expected values.
pub fn verify_file(p: &Path, sha256: &str, size: u64) -> Result<(), String> {
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    if len != size {
        return Err(format!("Size {len} bytes, expected {size}"));
    }
    let got = sha256_file(p)?;
    if !got.eq_ignore_ascii_case(sha256) {
        return Err(format!("SHA-256 {got} does not match {sha256}"));
    }
    Ok(())
}

/// Downloads `url` into `cache/<file>` (reused when a checked copy is there) and checks size and
/// SHA-256. A file that does not match is deleted.
pub fn download_checked(url: &str, file: &str, sha256: &str, size: u64, cache: &Path, fetch: &dyn Fetch, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<PathBuf, String> {
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let dest = cache.join(file);
    if verify_file(&dest, sha256, size).is_ok() {
        return Ok(dest);
    }
    fetch.fetch(url, &dest, progress)?;
    if let Err(e) = verify_file(&dest, sha256, size) {
        let _ = std::fs::remove_file(&dest);
        return Err(format!("{file}: {e}. Deleted, not run."));
    }
    Ok(dest)
}

/// Nadeo's update, checked.
pub fn download_update(cache: &Path, fetch: &dyn Fetch, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<PathBuf, String> {
    download_checked(UPDATE_URL, UPDATE_FILE, UPDATE_SHA256, UPDATE_SIZE, cache, fetch, progress)
}

/// Inno Setup parameters for the silent update into `dir`.
pub fn installer_params(dir: &Path) -> Result<String, String> {
    let d = dir.to_string_lossy();
    if d.is_empty() || d.contains('"') || d.chars().any(|c| c.is_control()) {
        return Err("Unusable game folder path".into());
    }
    Ok(format!("/SILENT /SUPPRESSMSGBOXES /DIR=\"{}\"", d.trim_end_matches(['\\', '/'])))
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEAM_INI: &str = "# Nadeo.ini\r\n\r\n[TmForever]\r\nWindowTitle=TmForever\r\nDistro=AGOBM\r\nLanguage=en\r\n";

    #[test]
    fn steam_folder_detection() {
        assert!(is_steam_install(Path::new(r"D:\SteamLibrary\steamapps\common\TrackMania United")));
        assert!(is_steam_install(Path::new(r"C:\Program Files (x86)\Steam\SteamApps\common\TrackMania Nations Forever")));
        assert!(!is_steam_install(Path::new(r"C:\Program Files (x86)\TmNationsForever")));
        assert!(!is_steam_install(Path::new(r"C:\Games\steamapps-copy\TMNF")));
    }

    #[test]
    fn distro_is_replaced_and_everything_else_kept() {
        assert_eq!(distro_of(STEAM_INI).as_deref(), Some("AGOBM"));
        let fixed = set_distro(STEAM_INI, DISTRO);
        assert_eq!(fixed, STEAM_INI.replace("Distro=AGOBM", "Distro=MILIN"));
        assert_eq!(distro_of(&fixed).as_deref(), Some("MILIN"));
        // LF file without a Distro line: added after the section header, LF kept.
        let lf = "[TmForever]\nLanguage=de\n";
        assert_eq!(set_distro(lf, DISTRO), "[TmForever]\nDistro=MILIN\nLanguage=de\n");
        // No section at all: at the top.
        assert_eq!(set_distro("Language=de\r\n", DISTRO), "Distro=MILIN\r\nLanguage=de\r\n");
        // Key case-insensitive, only the first one changes.
        assert_eq!(set_distro("distro=x\ndistro=y\n", DISTRO), "Distro=MILIN\ndistro=y\n");
    }

    #[test]
    fn ini_apply_and_undo_with_backup() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path();
        std::fs::write(dir.join("Nadeo.ini"), STEAM_INI).unwrap();
        assert!(apply_ini(dir).unwrap());
        assert_eq!(std::fs::read_to_string(dir.join(BACKUP_NAME)).unwrap(), STEAM_INI);
        assert_eq!(distro_of(&std::fs::read_to_string(dir.join("Nadeo.ini")).unwrap()).as_deref(), Some("MILIN"));
        // Twice: nothing changes, the first backup stays.
        assert!(!apply_ini(dir).unwrap());
        let st = status(dir, &dir.join("cache"));
        assert!(st.ini_fixed && st.backup && !st.update_ready && !st.steam);
        undo_ini(dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("Nadeo.ini")).unwrap(), STEAM_INI);
        assert!(!dir.join(BACKUP_NAME).exists());
        assert!(undo_ini(dir).is_err(), "no backup, no undo");

        // Changed by hand after the fix: undo refuses and keeps the backup.
        apply_ini(dir).unwrap();
        std::fs::write(dir.join("Nadeo.ini"), "[TmForever]\r\nDistro=MILIN\r\nLanguage=fr\r\n").unwrap();
        assert!(undo_ini(dir).is_err());
        assert!(dir.join(BACKUP_NAME).is_file());

        // Missing Nadeo.ini: refused, nothing written.
        let empty = t.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(apply_ini(&empty).is_err());
        assert!(!empty.join(BACKUP_NAME).exists());
    }

    struct Mock(Vec<u8>, std::cell::Cell<u32>);
    impl Fetch for Mock {
        fn fetch(&self, url: &str, dest: &Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<u64, String> {
            assert!(url.starts_with("http"));
            self.1.set(self.1.get() + 1);
            std::fs::write(dest, &self.0).map_err(|e| e.to_string())?;
            progress(self.0.len() as u64, Some(self.0.len() as u64));
            Ok(self.0.len() as u64)
        }
    }

    #[test]
    fn download_is_checked_by_size_and_hash() {
        let t = tempfile::tempdir().unwrap();
        let good = b"MZ fake update".to_vec();
        let sha = crate::tmloader::sha256_hex(&good);
        let m = Mock(good.clone(), 0.into());
        let p = download_checked("http://x/u.exe", "u.exe", &sha, good.len() as u64, t.path(), &m, &mut |_, _| {}).unwrap();
        assert!(p.is_file());
        // A checked copy is reused without a second download.
        download_checked("http://x/u.exe", "u.exe", &sha, good.len() as u64, t.path(), &m, &mut |_, _| {}).unwrap();
        assert_eq!(m.1.get(), 1);
        // Other bytes (same size): refused and deleted.
        let evil = Mock(b"MZ evil updat".to_vec(), 0.into());
        std::fs::remove_file(&p).unwrap();
        assert!(download_checked("http://x/u.exe", "u.exe", &sha, 13, t.path(), &evil, &mut |_, _| {}).is_err());
        assert!(!t.path().join("u.exe").exists());
        // Wrong size: refused before hashing.
        assert!(download_checked("http://x/u.exe", "u.exe", &sha, 999, t.path(), &m, &mut |_, _| {}).is_err());
        assert!(!t.path().join("u.exe").exists());
        // The real constants describe Nadeo's file.
        assert_eq!(UPDATE_SHA256.len(), 64);
        assert!(UPDATE_URL.ends_with(UPDATE_FILE));
    }

    #[test]
    fn silent_installer_arguments() {
        assert_eq!(
            installer_params(Path::new(r"D:\SteamLibrary\steamapps\common\TrackMania United\")).unwrap(),
            r#"/SILENT /SUPPRESSMSGBOXES /DIR="D:\SteamLibrary\steamapps\common\TrackMania United""#
        );
        assert!(installer_params(Path::new("C:\\a\"b")).is_err());
    }
}
