//! Optional DXVK (Vulkan) for the classic games: puts the 32-bit `d3d9.dll` of a pinned DXVK release
//! plus a small `dxvk.conf` next to the game exe. Off removes exactly those two files again.
//!
//! - Pinned: DXVK 3.1.1, archive SHA-256 checked, else nothing is written. Only
//!   `dxvk-3.1.1/x32/d3d9.dll` is read out of the archive (own minimal ustar reader, bounds checked).
//! - Refused (nothing written): game running, folder protected, a `d3d9.dll` is already there (TM Vibrant
//!   Shaders or the Sunrise repack's proxy load the system d3d9 by full path, DXVK cannot sit behind them),
//!   a `dxvk.conf` that I did not write.
//! - A game folder only an administrator may write (TMNF/TMUF default to `C:\Program Files (x86)`): the
//!   normal path answers `needAdmin`; "Install with admin rights" stages the two verified files in the
//!   launcher's data folder and copies exactly them with one UAC prompt (`elevate.rs`), then checks their
//!   hashes from the normal side. Off works the same way (elevated `del` of my unchanged files only).
//! - Every written file is recorded in `dxvk-journal.json` (launcher data folder) with its SHA-256 and
//!   what was there before (always nothing, because existing files are refused). Off removes a file only
//!   while its hash still matches.
//! - Errors are short codes (`running`, `foreignDll`, ...), the UI turns them into texts.
//!
//! Experimental: not tested in the game. Docs: docs/optimize.md.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const VERSION: &str = "3.1.1";
pub const URL: &str = "https://github.com/doitsujin/dxvk/releases/download/v3.1.1/dxvk-3.1.1.tar.gz";
pub const ARCHIVE_SHA256: &str = "40565b4a724aadc4433fa4e010b4b23916d9b1f1baeee64e17186db94f54e608";
pub const ENTRY: &str = "dxvk-3.1.1/x32/d3d9.dll";
pub const DLL: &str = "d3d9.dll";
pub const CONF: &str = "dxvk.conf";
pub const CONF_TEXT: &str = "# TM Horizon: DXVK for TrackMania (written by the launcher, removed when DXVK is switched off)\r\nd3d9.maxFrameLatency = 1\r\n# dxvk.hud = fps,frametimes\r\n";
const MAX_ARCHIVE: u64 = 64 * 1024 * 1024;
const MAX_DLL: u64 = 32 * 1024 * 1024;

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

// ------------------------------------------------------------------ tar reader

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).into_owned()
}

fn octal(b: &[u8]) -> Option<u64> {
    let s = cstr(b);
    let s = s.trim_matches(|c: char| c == ' ' || c == '\0');
    if s.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(s, 8).ok()
}

fn skip<R: Read>(r: &mut R, n: u64) -> Result<(), String> {
    let got = std::io::copy(&mut r.by_ref().take(n), &mut std::io::sink()).map_err(|e| e.to_string())?;
    if got == n {
        Ok(())
    } else {
        Err("tar: archive is cut off".into())
    }
}

/// Reads the content of the regular file `want` out of a (plain, not gzipped) tar stream.
/// Supports ustar prefixes and GNU long names, skips pax headers; refuses a bad header checksum,
/// base-256 sizes and entries above `max` bytes.
pub fn untar_entry<R: Read>(mut r: R, want: &str, max: u64) -> Result<Vec<u8>, String> {
    let mut long: Option<String> = None;
    loop {
        let mut h = [0u8; 512];
        let mut n = 0;
        while n < 512 {
            let k = r.read(&mut h[n..]).map_err(|e| e.to_string())?;
            if k == 0 {
                break;
            }
            n += k;
        }
        if n == 0 || h.iter().all(|&b| b == 0) {
            return Err("tar: file not in archive".into());
        }
        if n < 512 {
            return Err("tar: archive is cut off".into());
        }
        let sum: u64 = h.iter().enumerate().map(|(i, &b)| if (148..156).contains(&i) { 32 } else { b as u64 }).sum();
        if octal(&h[148..156]) != Some(sum) {
            return Err("tar: bad header checksum".into());
        }
        if h[124] & 0x80 != 0 {
            return Err("tar: unsupported size field".into());
        }
        let size = octal(&h[124..136]).ok_or("tar: bad size")?;
        let padded = size.checked_add(511).ok_or("tar: bad size")? / 512 * 512;
        let mut name = cstr(&h[0..100]);
        if &h[257..262] == b"ustar" {
            let prefix = cstr(&h[345..500]);
            if !prefix.is_empty() {
                name = format!("{prefix}/{name}");
            }
        }
        if let Some(l) = long.take() {
            name = l;
        }
        match h[156] {
            b'L' => {
                if size > 4096 {
                    return Err("tar: long name too long".into());
                }
                let mut buf = vec![0u8; size as usize];
                r.read_exact(&mut buf).map_err(|_| "tar: archive is cut off".to_string())?;
                skip(&mut r, padded - size)?;
                long = Some(cstr(&buf));
            }
            b'0' | 0 => {
                if name == want {
                    if size > max {
                        return Err("tar: entry too large".into());
                    }
                    let mut buf = vec![0u8; size as usize];
                    r.read_exact(&mut buf).map_err(|_| "tar: archive is cut off".to_string())?;
                    return Ok(buf);
                }
                skip(&mut r, padded)?;
            }
            _ => skip(&mut r, padded)?,
        }
    }
}

/// Checks the pinned hash of the downloaded archive and extracts `d3d9.dll` (x32).
pub fn dll_from_archive(archive: &[u8]) -> Result<Vec<u8>, String> {
    if sha256_hex(archive) != ARCHIVE_SHA256 {
        return Err("hash".into());
    }
    untar_entry(flate2::read::GzDecoder::new(archive), ENTRY, MAX_DLL).map_err(|e| format!("archive: {e}"))
}

// ------------------------------------------------------------------ journal

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileRec {
    pub path: String,
    pub sha256: String,
    /// What was there before: always "nothing" (existing files are refused).
    pub before: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    pub id: String,
    pub time: String,
    pub game: String,
    pub dir: String,
    pub version: String,
    pub files: Vec<FileRec>,
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Journal {
    pub entries: Vec<Entry>,
}

pub fn journal_path(data: &Path) -> PathBuf {
    data.join("dxvk-journal.json")
}

pub fn load_journal(data: &Path) -> Journal {
    std::fs::read_to_string(journal_path(data)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_journal(data: &Path, j: &Journal) -> Result<(), String> {
    crate::fsx::write(&journal_path(data), serde_json::to_string_pretty(j).map_err(|e| e.to_string())?.as_bytes())
}

fn same_dir(a: &str, b: &Path) -> bool {
    crate::fsx::norm(Path::new(a)) == crate::fsx::norm(b)
}

fn sha_of_file(p: &Path) -> Option<String> {
    std::fs::read(&*crate::platform::ci(p)).ok().map(|b| sha256_hex(&b))
}

// ------------------------------------------------------------------ state / checks

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// My files are there and unchanged.
    On,
    /// Nothing of DXVK.
    Off,
    /// A d3d9.dll (or my files in a changed state) that I cannot account for.
    Foreign,
}

fn my_entry<'a>(j: &'a Journal, game: &str, dir: &Path) -> Option<&'a Entry> {
    j.entries.iter().rev().find(|e| e.game == game && !e.undone && same_dir(&e.dir, dir))
}

pub fn status(dir: &Path, data: &Path, game: &str) -> Status {
    let dll = dir.join(DLL);
    if !crate::fsx::exists(&dll) {
        return Status::Off;
    }
    let j = load_journal(data);
    if let Some(e) = my_entry(&j, game, dir) {
        let intact = !e.files.is_empty() && e.files.iter().all(|f| sha_of_file(Path::new(&f.path)).as_deref() == Some(f.sha256.as_str()));
        if intact {
            return Status::On;
        }
    }
    Status::Foreign
}

/// How DXVK can be written into a folder.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// The user can write the folder.
    Direct,
    /// Only an administrator can: one UAC prompt for the copy (`elevate.rs`).
    Admin,
}

/// Whether the user can write `dir`: Direct, Admin (access denied) or an error code.
pub fn write_mode(dir: &Path) -> Result<Mode, String> {
    match crate::elevate::writable(dir) {
        Ok(true) => Ok(Mode::Direct),
        Ok(false) => Ok(Mode::Admin),
        Err(e) => Err(format!("notWritable:{e}")),
    }
}

/// Why DXVK cannot be written into `dir` (nothing is touched), else how. The checks that need no write
/// access come first, so an existing d3d9.dll (TMVS) is named even in a Program Files folder.
pub fn check_apply(dir: &Path, data: &Path, game: &str) -> Result<Mode, String> {
    if crate::fsx::blocked(dir) || crate::fsx::blocked(&dir.join(DLL)) || crate::fsx::blocked(&dir.join(CONF)) {
        return Err("blocked".into());
    }
    if !crate::fsx::is_dir(dir) {
        return Err("notInstalled".into());
    }
    if status(dir, data, game) == Status::On {
        return Err("alreadyOn".into());
    }
    if crate::fsx::exists(&dir.join(DLL)) {
        return Err("foreignDll".into());
    }
    if crate::fsx::exists(&dir.join(CONF)) {
        return Err("foreignConf".into());
    }
    write_mode(dir)
}

// ------------------------------------------------------------------ apply / undo

/// Writes `d3d9.dll` (the bytes of the verified DXVK dll) and `dxvk.conf`, journal first.
pub fn apply_in(dir: &Path, data: &Path, game: &str, dll: &[u8]) -> Result<Vec<FileRec>, String> {
    if check_apply(dir, data, game)? == Mode::Admin {
        return Err("needAdmin".into());
    }
    let files = vec![
        FileRec { path: dir.join(DLL).to_string_lossy().into(), sha256: sha256_hex(dll), before: "nothing".into() },
        FileRec { path: dir.join(CONF).to_string_lossy().into(), sha256: sha256_hex(CONF_TEXT.as_bytes()), before: "nothing".into() },
    ];
    let mut j = load_journal(data);
    // Older entries of this game and folder whose files are gone (check_apply saw no d3d9.dll) are stale.
    for e in j.entries.iter_mut().filter(|e| e.game == game && !e.undone && same_dir(&e.dir, dir)) {
        e.undone = true;
    }
    let id = crate::fsx::stamp();
    j.entries.push(Entry { id: id.clone(), time: crate::fsx::now_iso(), game: game.into(), dir: dir.to_string_lossy().into(), version: VERSION.into(), files: files.clone(), undone: false });
    save_journal(data, &j)?;
    let r = crate::fsx::write(&dir.join(DLL), dll).and_then(|_| crate::fsx::write(&dir.join(CONF), CONF_TEXT.as_bytes()));
    if let Err(e) = r {
        for f in &files {
            let _ = std::fs::remove_file(&f.path);
        }
        if let Some(en) = j.entries.iter_mut().find(|x| x.id == id) {
            en.undone = true;
        }
        let _ = save_journal(data, &j);
        return Err(format!("write:{e}"));
    }
    Ok(files)
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub removed: Vec<String>,
    /// Changed since I wrote them: left alone.
    pub kept: Vec<String>,
}

/// Removes the files of the newest open entry of this game and folder, each only while its hash matches.
pub fn undo_in(dir: &Path, data: &Path, game: &str) -> Result<Report, String> {
    let mut j = load_journal(data);
    let Some(e) = j.entries.iter_mut().rev().find(|e| e.game == game && !e.undone && same_dir(&e.dir, dir)) else { return Err("nothingToUndo".into()) };
    let mut rep = Report::default();
    for f in &e.files {
        let p = PathBuf::from(&f.path);
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match sha_of_file(&p) {
            None => {}
            Some(h) if h == f.sha256 => {
                crate::fsx::check(&p)?;
                std::fs::remove_file(&*crate::platform::ci(&p)).map_err(|er| format!("write:{}: {er}", p.display()))?;
                rep.removed.push(name);
            }
            Some(_) => rep.kept.push(name),
        }
    }
    e.undone = true;
    save_journal(data, &j)?;
    Ok(rep)
}

// ------------------------------------------------------------------ with admin rights

/// The journal entry for `files` in `dir` (older open entries of the folder are closed). Returns its id.
fn journal_open(data: &Path, game: &str, dir: &Path, files: &[FileRec]) -> Result<String, String> {
    let mut j = load_journal(data);
    for e in j.entries.iter_mut().filter(|e| e.game == game && !e.undone && same_dir(&e.dir, dir)) {
        e.undone = true;
    }
    let id = crate::fsx::stamp();
    j.entries.push(Entry { id: id.clone(), time: crate::fsx::now_iso(), game: game.into(), dir: dir.to_string_lossy().into(), version: VERSION.into(), files: files.to_vec(), undone: false });
    save_journal(data, &j)?;
    Ok(id)
}

fn journal_close(data: &Path, id: &str) {
    let mut j = load_journal(data);
    if let Some(en) = j.entries.iter_mut().find(|x| x.id == id) {
        en.undone = true;
    }
    let _ = save_journal(data, &j);
}

/// The elevated step: `elevate::run` in the app, a plain copy in tests.
pub type Elevated<'a> = &'a dyn Fn(&[crate::elevate::Op]) -> Result<(), String>;

/// Like `apply_in` for a folder only an administrator can write: the two files are staged under
/// `<data>\dxvk\stage\<time>\`, `elevated` copies them (one UAC prompt), then both hashes are checked from
/// here. Cancelled: journal entry closed, nothing changed. A file that did not arrive intact: `verify`;
/// whatever arrived intact stays journaled so Off can remove it.
pub fn apply_admin(dir: &Path, data: &Path, game: &str, dll: &[u8], elevated: Elevated) -> Result<Vec<FileRec>, String> {
    check_apply(dir, data, game)?;
    let stage = data.join("dxvk").join("stage").join(crate::fsx::stamp());
    let (s_dll, s_conf) = (stage.join(DLL), stage.join(CONF));
    let files = vec![
        FileRec { path: dir.join(DLL).to_string_lossy().into(), sha256: sha256_hex(dll), before: "nothing".into() },
        FileRec { path: dir.join(CONF).to_string_lossy().into(), sha256: sha256_hex(CONF_TEXT.as_bytes()), before: "nothing".into() },
    ];
    let r = (|| {
        crate::fsx::write(&s_dll, dll)?;
        crate::fsx::write(&s_conf, CONF_TEXT.as_bytes())?;
        // The staged copies sit in a user folder: checked again right before the step.
        if sha_of_file(&s_dll).as_deref() != Some(files[0].sha256.as_str()) || sha_of_file(&s_conf).as_deref() != Some(files[1].sha256.as_str()) {
            return Err("verify".to_string());
        }
        let id = journal_open(data, game, dir, &files)?;
        let ops = [crate::elevate::Op::Copy { from: s_dll.clone(), to: dir.join(DLL) }, crate::elevate::Op::Copy { from: s_conf.clone(), to: dir.join(CONF) }];
        let ran = elevated(&ops);
        let intact: Vec<bool> = files.iter().map(|f| sha_of_file(Path::new(&f.path)).as_deref() == Some(f.sha256.as_str())).collect();
        if ran.is_ok() && intact.iter().all(|x| *x) {
            return Ok(files.clone());
        }
        if !intact.iter().any(|x| *x) {
            journal_close(data, &id);
        }
        match ran {
            Err(e) if !intact.iter().any(|x| *x) => Err(e),
            _ => Err("verify".into()),
        }
    })();
    let _ = std::fs::remove_dir_all(&stage);
    r
}

/// Like `undo_in` for a folder only an administrator can write: my unchanged files are deleted in one
/// elevated step, then checked from here. Cancelled or not gone: the journal stays as it was.
pub fn undo_admin(dir: &Path, data: &Path, game: &str, elevated: Elevated) -> Result<Report, String> {
    let j = load_journal(data);
    let Some(e) = j.entries.iter().rev().find(|e| e.game == game && !e.undone && same_dir(&e.dir, dir)).cloned() else { return Err("nothingToUndo".into()) };
    let mut rep = Report::default();
    let mut del = vec![];
    for f in &e.files {
        let p = PathBuf::from(&f.path);
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match sha_of_file(&p) {
            None => {}
            Some(h) if h == f.sha256 => {
                crate::fsx::check(&p)?;
                del.push(p);
                rep.removed.push(name);
            }
            Some(_) => rep.kept.push(name),
        }
    }
    if !del.is_empty() {
        let ops: Vec<crate::elevate::Op> = del.iter().cloned().map(crate::elevate::Op::Delete).collect();
        elevated(&ops)?;
        if del.iter().any(|p| crate::fsx::exists(p)) {
            return Err("verify".into());
        }
    }
    journal_close(data, &e.id);
    Ok(rep)
}

// ------------------------------------------------------------------ commands

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DxState {
    pub supported: bool,
    pub reason: Option<String>,
    pub dir: Option<String>,
    pub status: Status,
    pub version: &'static str,
    /// The game folder needs admin rights to write (Program Files).
    pub admin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DxPlan {
    pub dir: String,
    pub files: Vec<String>,
    pub conf: &'static str,
    pub version: &'static str,
    pub cached: bool,
    /// Writing needs one UAC prompt.
    pub admin: bool,
}

fn dir_of(st: &crate::state::AppState, game: &str) -> Result<PathBuf, String> {
    let want = crate::optimize::game_exe_name(game).ok_or("unsupported")?;
    let exe = st.install(game).and_then(|i| i.exe).ok_or("notInstalled")?;
    let p = Path::new(&exe);
    if crate::fsx::blocked(p) {
        return Err("blocked".into());
    }
    if !p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(want)).unwrap_or(false) {
        return Err("notInstalled".into());
    }
    p.parent().map(|d| d.to_path_buf()).ok_or_else(|| "notInstalled".into())
}

fn cache_path(data: &Path) -> PathBuf {
    data.join("dxvk").join(format!("dxvk-{VERSION}.tar.gz"))
}

fn cached(data: &Path) -> bool {
    std::fs::read(cache_path(data)).map(|b| sha256_hex(&b) == ARCHIVE_SHA256).unwrap_or(false)
}

/// The archive from the cache, or downloaded (https, size capped) and cached after the hash check.
fn archive(data: &Path) -> Result<Vec<u8>, String> {
    if let Ok(b) = std::fs::read(cache_path(data)) {
        if sha256_hex(&b) == ARCHIVE_SHA256 {
            return Ok(b);
        }
    }
    let b = crate::net::get_bytes(URL, MAX_ARCHIVE).map_err(|e| format!("net:{e}"))?;
    if sha256_hex(&b) != ARCHIVE_SHA256 {
        return Err("hash".into());
    }
    let _ = crate::fsx::write(&cache_path(data), &b);
    Ok(b)
}

fn ensure_stopped(st: &crate::state::AppState, game: &str) -> Result<(), String> {
    if crate::optimize::game_running(st, game) {
        Err("running".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn dxvk_state(app: tauri::AppHandle, game_id: String) -> DxState {
    crate::bg::run(move || -> DxState {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let mut o = DxState { supported: false, reason: None, dir: None, status: Status::Off, version: VERSION, admin: false };
        #[cfg(not(windows))]
        {
            let _ = (&st, &game_id);
            o.reason = Some("unsupported".into());
            o
        }
        #[cfg(windows)]
        {
            match dir_of(&st, &game_id) {
                Ok(d) => {
                    o.supported = true;
                    o.status = status(&d, &st.data_dir, &game_id);
                    o.admin = write_mode(&d) == Ok(Mode::Admin);
                    o.dir = Some(d.to_string_lossy().into());
                }
                Err(e) => o.reason = Some(e),
            }
            o
        }
    })
    .await
}

#[tauri::command]
pub async fn dxvk_plan(app: tauri::AppHandle, game_id: String) -> Result<DxPlan, String> {
    crate::bg::run(move || -> Result<DxPlan, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        #[cfg(not(windows))]
        {
            let _ = (&st, &game_id);
            Err("unsupported".into())
        }
        #[cfg(windows)]
        {
            let dir = dir_of(&st, &game_id)?;
            ensure_stopped(&st, &game_id)?;
            let mode = check_apply(&dir, &st.data_dir, &game_id)?;
            Ok(DxPlan { dir: dir.to_string_lossy().into(), files: vec![DLL.into(), CONF.into()], conf: CONF_TEXT, version: VERSION, cached: cached(&st.data_dir), admin: mode == Mode::Admin })
        }
    })
    .await
}

#[tauri::command]
pub async fn dxvk_on(app: tauri::AppHandle, game_id: String, admin: Option<bool>) -> Result<Vec<FileRec>, String> {
    crate::bg::run(move || -> Result<Vec<FileRec>, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        #[cfg(not(windows))]
        {
            let _ = (&st, &game_id, admin);
            Err("unsupported".into())
        }
        #[cfg(windows)]
        {
            let dir = dir_of(&st, &game_id)?;
            ensure_stopped(&st, &game_id)?;
            let mode = check_apply(&dir, &st.data_dir, &game_id)?;
            if mode == Mode::Admin && admin != Some(true) {
                return Err("needAdmin".into());
            }
            let dll = dll_from_archive(&archive(&st.data_dir)?)?;
            match mode {
                Mode::Direct => apply_in(&dir, &st.data_dir, &game_id, &dll),
                Mode::Admin => apply_admin(&dir, &st.data_dir, &game_id, &dll, &crate::elevate::run),
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn dxvk_off(app: tauri::AppHandle, game_id: String, admin: Option<bool>) -> Result<Report, String> {
    crate::bg::run(move || -> Result<Report, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        #[cfg(not(windows))]
        {
            let _ = (&st, &game_id, admin);
            Err("unsupported".into())
        }
        #[cfg(windows)]
        {
            let dir = dir_of(&st, &game_id)?;
            ensure_stopped(&st, &game_id)?;
            match (write_mode(&dir)?, admin == Some(true)) {
                (Mode::Direct, _) => undo_in(&dir, &st.data_dir, &game_id),
                (Mode::Admin, true) => undo_admin(&dir, &st.data_dir, &game_id, &crate::elevate::run),
                (Mode::Admin, false) => Err("needAdmin".into()),
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, size: usize, typeflag: u8, prefix: &str) -> [u8; 512] {
        let mut h = [0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..107].copy_from_slice(b"0000644");
        h[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        h[156] = typeflag;
        h[257..262].copy_from_slice(b"ustar");
        h[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
        h[148..156].copy_from_slice(b"        ");
        let sum: u64 = h.iter().map(|&b| b as u64).sum();
        h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        h
    }

    fn add(tar: &mut Vec<u8>, name: &str, data: &[u8], typeflag: u8, prefix: &str) {
        tar.extend_from_slice(&header(name, data.len(), typeflag, prefix));
        tar.extend_from_slice(data);
        tar.resize(tar.len().div_ceil(512) * 512, 0);
    }

    fn small_tar() -> Vec<u8> {
        let mut t = vec![];
        add(&mut t, "dxvk-3.1.1/", b"", b'5', "");
        add(&mut t, "dxvk-3.1.1/x64/d3d9.dll", b"WRONG64", b'0', "");
        add(&mut t, "d3d9.dll", b"DXVK32", b'0', "dxvk-3.1.1/x32");
        add(&mut t, "dxvk-3.1.1/x32/d3d9.txt", b"nope", b'0', "");
        t.extend_from_slice(&[0u8; 1024]);
        t
    }

    struct Env {
        _t: tempfile::TempDir,
        game: PathBuf,
        data: PathBuf,
    }

    fn env() -> Env {
        let t = tempfile::tempdir().unwrap();
        let game = t.path().join("game");
        let data = t.path().join("data");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        Env { _t: t, game, data }
    }

    #[test]
    fn tar_reads_one_entry_with_prefix() {
        let t = small_tar();
        assert_eq!(untar_entry(&t[..], ENTRY, 1000).unwrap(), b"DXVK32");
        assert!(untar_entry(&t[..], "dxvk-3.1.1/x32/missing.dll", 1000).unwrap_err().contains("not in archive"));
        assert!(untar_entry(&t[..], ENTRY, 3).unwrap_err().contains("too large"));
    }

    #[test]
    fn tar_refuses_bad_input() {
        let mut t = small_tar();
        t[10] ^= 0xff; // damages the first header
        assert!(untar_entry(&t[..], ENTRY, 1000).unwrap_err().contains("checksum"));
        let t = small_tar();
        assert!(untar_entry(&t[..700], ENTRY, 1000).is_err(), "cut off inside an entry");
        let mut t = small_tar();
        let mut h = header("big", 0, b'0', "");
        h[124] = 0x80;
        t.splice(0..0, h);
        assert!(untar_entry(&t[..], ENTRY, 1000).is_err(), "base-256 size");
        assert!(untar_entry(&b""[..], ENTRY, 10).is_err());
    }

    #[test]
    fn tar_gnu_long_name() {
        let mut t = vec![];
        let long = format!("dxvk-3.1.1/x32/{}", "d".repeat(120));
        add(&mut t, "././@LongLink", format!("{long}\0").as_bytes(), b'L', "");
        add(&mut t, "truncated", b"LONGDATA", b'0', "");
        assert_eq!(untar_entry(&t[..], &long, 100).unwrap(), b"LONGDATA");
    }

    #[test]
    fn archive_hash_is_pinned() {
        assert_eq!(dll_from_archive(b"not the real archive").unwrap_err(), "hash");
        assert_eq!(ARCHIVE_SHA256.len(), 64);
    }

    #[test]
    fn gzip_roundtrip_through_reader() {
        use std::io::Write;
        let mut e = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
        e.write_all(&small_tar()).unwrap();
        let gz = e.finish().unwrap();
        assert_eq!(untar_entry(flate2::read::GzDecoder::new(&gz[..]), ENTRY, 1000).unwrap(), b"DXVK32");
    }

    #[test]
    fn apply_journal_and_undo() {
        let e = env();
        assert_eq!(status(&e.game, &e.data, "tmnf"), Status::Off);
        let f = apply_in(&e.game, &e.data, "tmnf", b"DXVK32").unwrap();
        assert_eq!(f.len(), 2);
        assert_eq!(std::fs::read(e.game.join(DLL)).unwrap(), b"DXVK32");
        assert_eq!(std::fs::read_to_string(e.game.join(CONF)).unwrap(), CONF_TEXT);
        assert_eq!(status(&e.game, &e.data, "tmnf"), Status::On);
        let j = load_journal(&e.data);
        assert_eq!(j.entries.len(), 1);
        assert_eq!(j.entries[0].files[0].sha256, sha256_hex(b"DXVK32"));
        assert_eq!(j.entries[0].files[0].before, "nothing");
        assert_eq!(apply_in(&e.game, &e.data, "tmnf", b"DXVK32").unwrap_err(), "alreadyOn");
        let r = undo_in(&e.game, &e.data, "tmnf").unwrap();
        assert_eq!(r.removed, vec!["d3d9.dll", "dxvk.conf"]);
        assert!(r.kept.is_empty());
        assert!(!e.game.join(DLL).exists() && !e.game.join(CONF).exists());
        assert_eq!(status(&e.game, &e.data, "tmnf"), Status::Off);
        assert_eq!(undo_in(&e.game, &e.data, "tmnf").unwrap_err(), "nothingToUndo");
        // can be switched on again
        apply_in(&e.game, &e.data, "tmnf", b"DXVK32").unwrap();
    }

    #[test]
    fn undo_keeps_changed_files() {
        let e = env();
        apply_in(&e.game, &e.data, "tmnf", b"DXVK32").unwrap();
        std::fs::write(e.game.join(CONF), "d3d9.maxFrameLatency = 2\r\n").unwrap();
        let r = undo_in(&e.game, &e.data, "tmnf").unwrap();
        assert_eq!(r.removed, vec!["d3d9.dll"]);
        assert_eq!(r.kept, vec!["dxvk.conf"]);
        assert!(e.game.join(CONF).exists());
        // the leftover conf is not mine any more: switching on again is refused
        assert_eq!(apply_in(&e.game, &e.data, "tmnf", b"DXVK32").unwrap_err(), "foreignConf");
    }

    #[test]
    fn changed_dll_is_foreign() {
        let e = env();
        apply_in(&e.game, &e.data, "tmnf", b"DXVK32").unwrap();
        std::fs::write(e.game.join(DLL), b"something else").unwrap();
        assert_eq!(status(&e.game, &e.data, "tmnf"), Status::Foreign);
        let r = undo_in(&e.game, &e.data, "tmnf").unwrap();
        assert_eq!(r.kept, vec!["d3d9.dll"]);
        assert_eq!(r.removed, vec!["dxvk.conf"]);
    }

    #[test]
    fn refuses_foreign_dll_and_conf_and_writes_nothing() {
        let e = env();
        std::fs::write(e.game.join(DLL), b"TM Vibrant Shaders").unwrap();
        assert_eq!(apply_in(&e.game, &e.data, "tmnf", b"X").unwrap_err(), "foreignDll");
        assert_eq!(status(&e.game, &e.data, "tmnf"), Status::Foreign);
        assert!(!e.game.join(CONF).exists());
        assert!(load_journal(&e.data).entries.is_empty(), "nothing journaled");
        assert_eq!(std::fs::read(e.game.join(DLL)).unwrap(), b"TM Vibrant Shaders");

        let e = env();
        std::fs::write(e.game.join(CONF), "mine = 1").unwrap();
        assert_eq!(apply_in(&e.game, &e.data, "tmnf", b"X").unwrap_err(), "foreignConf");
        assert!(!e.game.join(DLL).exists());
        assert_eq!(std::fs::read_to_string(e.game.join(CONF)).unwrap(), "mine = 1");
        assert!(load_journal(&e.data).entries.is_empty());
    }

    #[test]
    fn refuses_missing_folder_and_protected_folder() {
        let e = env();
        assert_eq!(apply_in(&e.game.join("nope"), &e.data, "tmnf", b"X").unwrap_err(), "notInstalled");
        let eswc = crate::fsx::eswc_protected_dir();
        assert_eq!(check_apply(&eswc, &e.data, "tmn-eswc").unwrap_err(), "blocked");
        assert_eq!(check_apply(&eswc.join("sub"), &e.data, "tmn-eswc").unwrap_err(), "blocked");
    }

    #[test]
    #[cfg(unix)]
    fn refuses_read_only_folder() {
        use std::os::unix::fs::PermissionsExt;
        let e = env();
        std::fs::set_permissions(&e.game, std::fs::Permissions::from_mode(0o555)).unwrap();
        let r = apply_in(&e.game, &e.data, "tmnf", b"X");
        std::fs::set_permissions(&e.game, std::fs::Permissions::from_mode(0o755)).unwrap();
        // root ignores the mode bits
        if let Err(c) = r {
            assert_eq!(c, "needAdmin");
        }
    }

    #[test]
    fn journal_survives_garbage() {
        let e = env();
        std::fs::write(journal_path(&e.data), "{ nope").unwrap();
        assert!(load_journal(&e.data).entries.is_empty());
        apply_in(&e.game, &e.data, "tmnf", b"DXVK32").unwrap();
        assert_eq!(status(&e.game, &e.data, "tmnf"), Status::On);
    }

    /// Stand-in for the UAC step: does the copies and deletes itself.
    fn fake_elevated(ops: &[crate::elevate::Op]) -> Result<(), String> {
        crate::elevate::cmd_params(ops)?;
        for op in ops {
            match op {
                crate::elevate::Op::Copy { from, to } => {
                    std::fs::copy(from, to).map_err(|e| e.to_string())?;
                }
                crate::elevate::Op::Delete(p) => std::fs::remove_file(p).map_err(|e| e.to_string())?,
            }
        }
        Ok(())
    }

    #[test]
    fn admin_apply_stages_copies_verifies_and_undoes() {
        let e = env();
        let f = apply_admin(&e.game, &e.data, "tmuf", b"DXVK32", &fake_elevated).unwrap();
        assert_eq!(f.len(), 2);
        assert_eq!(std::fs::read(e.game.join(DLL)).unwrap(), b"DXVK32");
        assert_eq!(status(&e.game, &e.data, "tmuf"), Status::On);
        assert_eq!(std::fs::read_dir(e.data.join("dxvk").join("stage")).map(|d| d.count()).unwrap_or(0), 0, "stage cleaned up");
        let r = undo_admin(&e.game, &e.data, "tmuf", &fake_elevated).unwrap();
        assert_eq!(r.removed, vec!["d3d9.dll", "dxvk.conf"]);
        assert_eq!(status(&e.game, &e.data, "tmuf"), Status::Off);
        assert_eq!(undo_admin(&e.game, &e.data, "tmuf", &fake_elevated).unwrap_err(), "nothingToUndo");
    }

    #[test]
    fn admin_cancelled_changes_nothing() {
        let e = env();
        let cancel = |_: &[crate::elevate::Op]| -> Result<(), String> { Err("cancelled".into()) };
        assert_eq!(apply_admin(&e.game, &e.data, "tmuf", b"DXVK32", &cancel).unwrap_err(), "cancelled");
        assert!(!e.game.join(DLL).exists() && !e.game.join(CONF).exists());
        assert!(load_journal(&e.data).entries.iter().all(|x| x.undone), "no open entry");
        assert_eq!(status(&e.game, &e.data, "tmuf"), Status::Off);
        // Switched on, then a cancelled Off: still on, journal still open.
        apply_admin(&e.game, &e.data, "tmuf", b"DXVK32", &fake_elevated).unwrap();
        assert_eq!(undo_admin(&e.game, &e.data, "tmuf", &cancel).unwrap_err(), "cancelled");
        assert_eq!(status(&e.game, &e.data, "tmuf"), Status::On);
        assert!(undo_admin(&e.game, &e.data, "tmuf", &fake_elevated).is_ok());
    }

    #[test]
    fn admin_copy_that_does_not_verify() {
        let e = env();
        // The step "succeeds" but other bytes arrive: refused, nothing of it counts as mine.
        let bad = |ops: &[crate::elevate::Op]| -> Result<(), String> {
            for op in ops {
                if let crate::elevate::Op::Copy { to, .. } = op {
                    std::fs::write(to, b"tampered").unwrap();
                }
            }
            Ok(())
        };
        assert_eq!(apply_admin(&e.game, &e.data, "tmuf", b"DXVK32", &bad).unwrap_err(), "verify");
        assert_eq!(status(&e.game, &e.data, "tmuf"), Status::Foreign);
        // Only the dll arrives: it stays journaled, so Off can remove it.
        let e = env();
        let half = |ops: &[crate::elevate::Op]| -> Result<(), String> {
            if let crate::elevate::Op::Copy { from, to } = &ops[0] {
                std::fs::copy(from, to).unwrap();
            }
            Err("failed:1".into())
        };
        assert_eq!(apply_admin(&e.game, &e.data, "tmuf", b"DXVK32", &half).unwrap_err(), "verify");
        let r = undo_admin(&e.game, &e.data, "tmuf", &fake_elevated).unwrap();
        assert_eq!(r.removed, vec!["d3d9.dll"]);
        assert!(!e.game.join(DLL).exists());
    }

    #[test]
    fn existing_dll_is_named_before_write_access() {
        let e = env();
        std::fs::write(e.game.join(DLL), b"TMVS").unwrap();
        assert_eq!(apply_admin(&e.game, &e.data, "tmuf", b"DXVK32", &fake_elevated).unwrap_err(), "foreignDll");
        assert_eq!(std::fs::read(e.game.join(DLL)).unwrap(), b"TMVS");
        assert_eq!(check_apply(&crate::fsx::eswc_protected_dir(), &e.data, "tmn-eswc").unwrap_err(), "blocked");
    }

    /// Real download, hash check and extraction. Run with TMHUB_NET_TESTS=1.
    #[test]
    fn real_download() {
        if std::env::var("TMHUB_NET_TESTS").is_err() {
            return;
        }
        let b = crate::net::get_bytes(URL, MAX_ARCHIVE).unwrap();
        let dll = dll_from_archive(&b).unwrap();
        assert_eq!(&dll[..2], b"MZ");
    }
}
