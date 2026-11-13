//! Install, update, remove and restore proxy-DLL mods for TrackMania Nations ESWC.
//!
//! ESWC has no mod loader: TM Vibrant Shaders is its d3d9.dll, ESWC Autosave is a small
//! dinput8.dll that loads eswc_autosave.dll (+ .ini). Rules:
//! - Only the scanned ESWC install folder is written (it must hold TmNationsESWC.exe and must not
//!   be or lie in the protected StarForce folder, see fsx).
//! - dinput8.dll is the one exception to "never touch a dinput8.dll", and only here: when the
//!   user installs, updates, removes or restores ESWC Autosave through the confirmation dialog.
//! - Every file that gets replaced or removed is first copied to "TM Horizon backups" in the app's
//!   data folder (timestamped, with a manifest); a backup can be restored with one click.
//! - Files come from the mod's latest GitHub release over https (TMVS: checked against the
//!   release's SHA256SUMS.txt). The patched ESWC exe itself is never downloaded.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::{fsx, net, proxymods};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    pub id: &'static str,
    pub repo: &'static str,
    /// Files this mod puts next to the game exe.
    pub files: &'static [&'static str],
    /// Files kept on update when they already exist (user settings).
    pub keep: &'static [&'static str],
}

pub const SPECS: [Spec; 2] = [
    Spec { id: "TM Vibrant Shaders", repo: "cheatoskar/TM-Vibrant-Shaders", files: &["d3d9.dll"], keep: &[] },
    Spec { id: "ESWC Autosave", repo: "cheatoskar/eswc-autosave", files: &["dinput8.dll", "eswc_autosave.dll", "eswc_autosave.ini"], keep: &["eswc_autosave.ini"] },
];

pub fn spec(id: &str) -> Option<Spec> {
    SPECS.iter().copied().find(|s| s.id == id)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub name: String,
    /// "new" | "replace" | "keep" | "same" | "remove"
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub mod_id: String,
    pub version: String,
    pub installed: Option<String>,
    pub files: Vec<PlanFile>,
    /// Plain-language warnings: another mod or an unknown DLL uses the same file name.
    pub conflicts: Vec<String>,
    pub touches_dinput8: bool,
    pub backup_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub created: String,
    pub reason: String,
    pub files: Vec<String>,
}

/// Downloaded files waiting for the user's OK (mod id -> (version, files)).
fn staged() -> &'static Mutex<HashMap<String, (String, Vec<(String, Vec<u8>)>)>> {
    static S: OnceLock<Mutex<HashMap<String, (String, Vec<(String, Vec<u8>)>)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Every file an ESWC mod of this module may write, as single files (for the change history;
/// dinput8.dll is named on purpose: ESWC Autosave is a loader).
pub fn watches(dir: &Path) -> Vec<crate::history::Watch> {
    let mut names: Vec<&str> = SPECS.iter().flat_map(|s| s.files.iter().copied()).collect();
    names.sort_unstable();
    names.dedup();
    names.into_iter().map(|n| crate::history::Watch::File(dir.join(n))).collect()
}

/// The one place a path in the ESWC folder is opened for writing or deleting.
fn target(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if fsx::blocked(dir) {
        return Err(format!("refusing to touch {}", dir.display()));
    }
    if !dir.join("TmNationsESWC.exe").is_file() {
        return Err("Not an ESWC folder (TmNationsESWC.exe missing)".into());
    }
    if name.contains(['/', '\\', ':']) || !SPECS.iter().any(|s| s.files.contains(&name)) {
        return Err(format!("not a mod file: {name}"));
    }
    let p = dir.join(name);
    if let Ok(m) = std::fs::symlink_metadata(&p) {
        if m.file_type().is_symlink() {
            return Err(format!("refusing a link: {}", p.display()));
        }
    }
    if !fsx::is_dinput8(&p) {
        fsx::check(&p)?;
    }
    Ok(p)
}

fn exists(dir: &Path, name: &str) -> bool {
    target(dir, name).map(|p| p.is_file()).unwrap_or(false)
}

fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let p = target(dir, name)?;
    let tmp = dir.join(format!("{name}.tmhorizon-new"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", p.display())
    })
}

fn remove_file(dir: &Path, name: &str) -> Result<(), String> {
    let p = target(dir, name)?;
    if p.is_file() {
        std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(())
}

fn stamp() -> String {
    fsx::now_iso().replace([':', '-'], "").chars().take(15).collect()
}

/// Copies the named files (those that exist) into a new timestamped backup folder.
pub fn backup(dir: &Path, root: &Path, names: &[&str], reason: &str) -> Result<Option<String>, String> {
    let have: Vec<&str> = names.iter().copied().filter(|n| exists(dir, n)).collect();
    if have.is_empty() {
        return Ok(None);
    }
    let id = format!("{}-{}", stamp(), reason.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase());
    let bdir = root.join(&id);
    std::fs::create_dir_all(&bdir).map_err(|e| format!("{}: {e}", bdir.display()))?;
    for n in &have {
        let src = target(dir, n)?;
        std::fs::copy(&src, bdir.join(format!("{n}.bak"))).map_err(|e| format!("{}: {e}", src.display()))?;
    }
    let manifest = serde_json::json!({ "created": fsx::now_iso(), "reason": reason, "dir": dir.to_string_lossy(), "files": have });
    std::fs::write(bdir.join("manifest.json"), manifest.to_string()).map_err(|e| e.to_string())?;
    Ok(Some(id))
}

pub fn list_backups(root: &Path) -> Vec<Backup> {
    let mut out: Vec<Backup> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.path().join("manifest.json")).ok()?).ok()?;
            Some(Backup {
                id: e.file_name().to_string_lossy().into(),
                created: m["created"].as_str().unwrap_or("").into(),
                reason: m["reason"].as_str().unwrap_or("").into(),
                files: m["files"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

/// Puts the files of a backup back (the current files are backed up first).
pub fn restore(dir: &Path, root: &Path, id: &str) -> Result<String, String> {
    if id.contains(['/', '\\', '.']) {
        return Err("bad backup id".into());
    }
    let b = list_backups(root).into_iter().find(|b| b.id == id).ok_or("backup not found")?;
    let names: Vec<&str> = b.files.iter().map(String::as_str).collect();
    backup(dir, root, &names, "before restore")?;
    for n in &names {
        let bytes = std::fs::read(root.join(id).join(format!("{n}.bak"))).map_err(|e| e.to_string())?;
        write_file(dir, n, &bytes)?;
    }
    Ok(format!("Restored {}", names.join(", ")))
}

/// What installing/updating would do with the staged files.
pub fn plan_files(dir: &Path, s: &Spec, files: &[(String, Vec<u8>)]) -> (Vec<PlanFile>, Vec<String>) {
    let scan = proxymods::scan_dir(dir);
    let mut plan = Vec::new();
    for (name, bytes) in files {
        let action = if !exists(dir, name) {
            "new"
        } else if s.keep.contains(&name.as_str()) {
            "keep"
        } else if !fsx::is_dinput8(&dir.join(name)) && std::fs::read(dir.join(name)).map(|b| b == *bytes).unwrap_or(false) {
            "same"
        } else {
            "replace"
        };
        plan.push(PlanFile { name: name.clone(), action: action.into() });
    }
    let mut conflicts = Vec::new();
    for f in s.files {
        // Another known mod owns this proxy name, or an unknown DLL sits there.
        if let Some(other) = scan.mods.iter().find(|m| m.id != s.id && (m.file.eq_ignore_ascii_case(f) || m.files.iter().any(|x| x.eq_ignore_ascii_case(f)))) {
            conflicts.push(format!("{f} belongs to {} now; it will be replaced (backup first).", other.id));
        } else if scan.unknown.iter().any(|u| u.eq_ignore_ascii_case(f)) {
            conflicts.push(format!("{f} is an unknown DLL; it will be replaced (backup first)."));
        }
    }
    if s.id == "ESWC Autosave" && exists(dir, "dinput8.dll") && !scan.mods.iter().any(|m| m.id == "ESWC Autosave") {
        conflicts.push("dinput8.dll exists but is not ESWC Autosave; it will be replaced (backup first).".into());
    }
    (plan, conflicts)
}

fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Downloads the latest release files of a mod (into memory).
fn fetch_release(s: &Spec) -> Result<(String, Vec<(String, Vec<u8>)>), String> {
    let rel = net::get_json(&format!("https://api.github.com/repos/{}/releases/latest", s.repo))?;
    let tag = rel["tag_name"].as_str().ok_or("no release")?.trim_start_matches('v').to_string();
    let assets = rel["assets"].as_array().cloned().unwrap_or_default();
    let url = |name: &str| assets.iter().find(|a| a["name"].as_str().map(|n| n.eq_ignore_ascii_case(name) || n.to_lowercase().starts_with(&name.to_lowercase())).unwrap_or(false)).and_then(|a| a["browser_download_url"].as_str().map(String::from));
    match s.id {
        "TM Vibrant Shaders" => {
            let u = url("TMVibrantShaders.dll").ok_or("release has no TMVibrantShaders.dll")?;
            let dll = net::get_bytes(&u, 64 << 20)?;
            if let Some(su) = url("SHA256SUMS.txt") {
                let sums = String::from_utf8_lossy(&net::get_bytes(&su, 1 << 16)?).to_string();
                let want = sums.lines().find(|l| l.ends_with("TMVibrantShaders.dll")).and_then(|l| l.split_whitespace().next()).ok_or("no checksum for the DLL")?;
                if !want.eq_ignore_ascii_case(&sha256_hex(&dll)) {
                    return Err("Checksum does not match; nothing was installed".into());
                }
            }
            Ok((tag, vec![("d3d9.dll".into(), dll)]))
        }
        "ESWC Autosave" => {
            // Legacy Essentials: the assets are named eswc-autosave-*; legacy-essentials-* is accepted for a later rename.
            let u = url("eswc-autosave").or_else(|| url("legacy-essentials")).ok_or("release has no zip")?;
            let zip = net::get_bytes(&u, 16 << 20)?;
            Ok((tag, unzip_named(&zip, s.files)?))
        }
        _ => Err("unknown mod".into()),
    }
}

/// The named files from a zip (top level or one folder deep), all must be there.
pub fn unzip_named(zip: &[u8], names: &[&str]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for want in names {
        let mut found = None;
        for i in 0..z.len() {
            let mut f = z.by_index(i).map_err(|e| e.to_string())?;
            let n = f.name().replace('\\', "/");
            let base = n.rsplit('/').next().unwrap_or("");
            if base.eq_ignore_ascii_case(want) && n.matches('/').count() <= 1 && f.size() < 32 << 20 {
                let mut b = Vec::new();
                f.read_to_end(&mut b).map_err(|e| e.to_string())?;
                found = Some(b);
                break;
            }
        }
        out.push((want.to_string(), found.ok_or_else(|| format!("{want} missing in the release zip"))?));
    }
    Ok(out)
}

pub fn prepare(dir: &Path, backup_root: &Path, id: &str) -> Result<Plan, String> {
    let s = spec(id).ok_or("unknown mod")?;
    horizon_guard(dir, &s)?;
    target(dir, s.files[0])?; // folder checks before any download
    let (version, files) = fetch_release(&s)?;
    let (plan, conflicts) = plan_files(dir, &s, &files);
    let installed = proxymods::scan_dir(dir).mods.into_iter().find(|m| m.id == s.id).map(|m| m.version.unwrap_or_else(|| "?".into()));
    staged().lock().unwrap().insert(s.id.into(), (version.clone(), files));
    Ok(Plan { mod_id: s.id.into(), version, installed, files: plan, conflicts, touches_dinput8: s.files.contains(&"dinput8.dll"), backup_root: backup_root.to_string_lossy().into() })
}

/// Writes the staged files after the user's OK (backup first).
pub fn apply(dir: &Path, backup_root: &Path, id: &str) -> Result<String, String> {
    let s = spec(id).ok_or("unknown mod")?;
    let (version, files) = staged().lock().unwrap().remove(s.id).ok_or("Nothing prepared; open the dialog again")?;
    let (plan, _) = plan_files(dir, &s, &files);
    let replaced: Vec<&str> = plan.iter().filter(|p| p.action == "replace").map(|p| p.name.as_str()).collect();
    let b = backup(dir, backup_root, &replaced, &format!("before {} {}", s.id, version))?;
    for (name, bytes) in &files {
        let action = plan.iter().find(|p| &p.name == name).map(|p| p.action.as_str()).unwrap_or("new");
        if action == "new" || action == "replace" {
            write_file(dir, name, bytes)?;
        }
    }
    // Record it for update checks (data folder = two levels above the backup root).
    if let Some(data) = backup_root.parent().and_then(|p| p.parent()) {
        let _ = crate::updates::record(
            data,
            crate::updates::InstallRecord {
                entry_id: s.id.into(),
                game: "tmn-eswc".into(),
                kind: "eswc".into(),
                spec: None,
                source: format!("github:{}", s.repo),
                version: version.clone(),
                asset: String::new(),
                sha256: String::new(),
                files: files.iter().map(|(n, _)| n.clone()).collect(),
                root: dir.to_string_lossy().into(),
                installed_at: fsx::now_iso(),
                backup_id: b.clone(),
                // ESWC Autosave changes dinput8.dll: never without the user's click.
                auto_update: false,
            },
        );
    }
    Ok(match b {
        Some(id) => format!("{} {version} installed. Backup: {id}", s.id),
        None => format!("{} {version} installed.", s.id),
    })
}

/// Horizon Host's Legacy Loader owns dinput8.dll in this folder (ESWC Autosave runs chained as
/// dinput8.chain.dll): ESWC Autosave's own install/remove would overwrite or delete the loader.
fn horizon_guard(dir: &Path, s: &Spec) -> Result<(), String> {
    if s.files.contains(&"dinput8.dll") && crate::horizonhost::read_record(&dir.join(crate::horizonhost::format::HOST_DIR)).is_some() {
        return Err("Horizon Client is installed in this folder and ESWC Autosave runs through it. Change it in the Horizon Client card (switch to the Autosave plugin, or remove Horizon Client first).".into());
    }
    Ok(())
}

/// Removes a mod's files (backup first).
pub fn remove(dir: &Path, backup_root: &Path, id: &str) -> Result<String, String> {
    let s = spec(id).ok_or("unknown mod")?;
    horizon_guard(dir, &s)?;
    let b = backup(dir, backup_root, s.files, &format!("before removing {}", s.id))?;
    for f in s.files {
        remove_file(dir, f)?;
    }
    Ok(match b {
        Some(id) => format!("{} removed. Backup: {id}", s.id),
        None => format!("{} was not installed.", s.id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("tmh-eswc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let game = root.join("ESWC");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("TmNationsESWC.exe"), b"MZ dummy").unwrap();
        (game, root.join("backups"))
    }

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            for (n, b) in files {
                z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
                std::io::Write::write_all(&mut z, b).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn install_update_remove_restore_in_a_fake_eswc_folder() {
        let (game, broot) = sandbox("flow");
        let s = spec("ESWC Autosave").unwrap();
        let files = unzip_named(&zip_of(&[("dinput8.dll", b"loader v1"), ("eswc_autosave.dll", b"dll v1"), ("eswc_autosave.ini", b"[a]")]), s.files).unwrap();
        staged().lock().unwrap().insert(s.id.into(), ("1.0.0".into(), files));
        apply(&game, &broot, s.id).unwrap();
        assert_eq!(std::fs::read(game.join("eswc_autosave.dll")).unwrap(), b"dll v1");
        std::fs::write(game.join("eswc_autosave.ini"), b"[mine]").unwrap();

        // Update: the dll is replaced (with a backup), the user's ini is kept.
        let files = unzip_named(&zip_of(&[("dinput8.dll", b"loader v2"), ("eswc_autosave.dll", b"dll v2"), ("eswc_autosave.ini", b"[b]")]), s.files).unwrap();
        let (plan, _) = plan_files(&game, &s, &files);
        assert_eq!(plan.iter().find(|p| p.name == "eswc_autosave.ini").unwrap().action, "keep");
        staged().lock().unwrap().insert(s.id.into(), ("1.1.0".into(), files));
        apply(&game, &broot, s.id).unwrap();
        assert_eq!(std::fs::read(game.join("eswc_autosave.dll")).unwrap(), b"dll v2");
        assert_eq!(std::fs::read(game.join("eswc_autosave.ini")).unwrap(), b"[mine]");
        let backups = list_backups(&broot);
        assert_eq!(backups.len(), 1);
        assert!(backups[0].files.contains(&"eswc_autosave.dll".to_string()));

        // Remove, then restore the update backup.
        remove(&game, &broot, s.id).unwrap();
        assert!(!game.join("eswc_autosave.dll").exists() && !game.join("eswc_autosave.ini").exists());
        let id = list_backups(&broot).into_iter().find(|b| b.reason.contains("1.1.0")).unwrap().id;
        restore(&game, &broot, &id).unwrap();
        assert_eq!(std::fs::read(game.join("eswc_autosave.dll")).unwrap(), b"dll v1");
        let _ = std::fs::remove_dir_all(game.parent().unwrap());
    }

    #[test]
    fn refuses_other_folders_and_files() {
        let (game, _) = sandbox("refuse");
        assert!(target(&game, "tmn.exe").is_err(), "only mod files");
        assert!(target(&game, "..\\x.dll").is_err());
        let not_eswc = game.parent().unwrap().join("other");
        std::fs::create_dir_all(&not_eswc).unwrap();
        assert!(target(&not_eswc, "d3d9.dll").is_err(), "needs TmNationsESWC.exe");
        assert!(target(&fsx::eswc_protected_dir(), "d3d9.dll").is_err(), "never the StarForce folder");
        let _ = std::fs::remove_dir_all(game.parent().unwrap());
    }

    #[test]
    fn conflicts_name_unknown_dlls() {
        let (game, _) = sandbox("conflict");
        std::fs::write(game.join("d3d9.dll"), b"MZ some other wrapper").unwrap();
        let s = spec("TM Vibrant Shaders").unwrap();
        let (plan, conflicts) = plan_files(&game, &s, &[("d3d9.dll".into(), b"new".to_vec())]);
        assert_eq!(plan[0].action, "replace");
        assert_eq!(conflicts.len(), 1);
        let _ = std::fs::remove_dir_all(game.parent().unwrap());
    }

    /// `cargo test real_release_fetch -- --ignored`: downloads both releases (no writes).
    #[test]
    #[ignore]
    fn real_release_fetch() {
        for s in SPECS {
            let (v, files) = fetch_release(&s).unwrap();
            println!("{} {v}: {:?}", s.id, files.iter().map(|(n, b)| (n.clone(), b.len())).collect::<Vec<_>>());
        }
    }
}
