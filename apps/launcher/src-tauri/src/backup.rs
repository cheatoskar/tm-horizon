//! Backup of the player's Forever data (`Documents\TrackMania`) into one zip, and restore.
//!
//! Always in: `Profiles` (the local profiles, keys, favourites), `Config` (game settings), `Scores`
//! (local records), `Scripts`, `ParameterSets`. Optional: `Tracks` (own challenges and replays; the
//! `Downloaded` folders are left out, TMX has those). The zip holds `tmhorizon-backup.json` (what
//! it contains with SHA-256 per file) and the files below `TrackMania/`.
//!
//! Restore is two steps: `restore_plan` says what would be new, replaced or the same (nothing is
//! written), `restore` then writes. Before a file is replaced, the old one is copied to an undo
//! folder. Paths from the zip are checked (no `..`, no drive, no streams); a zip that does not
//! match its manifest is refused before anything is written.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const MANIFEST: &str = "tmhorizon-backup.json";
const ROOT: &str = "TrackMania";
/// Folders that are always in, relative to the TrackMania folder.
pub const CORE: [&str; 5] = ["Profiles", "Config", "Scores", "Scripts", "ParameterSets"];
pub const TRACKS: &str = "Tracks";
const MAX_FILE: u64 = 1 << 30;
const MAX_TOTAL: u64 = 16 << 30;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// Own challenges and replays (`Tracks`, without `Downloaded`).
    pub tracks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub format: u32,
    pub created: String,
    pub options: Options,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub files: usize,
    pub bytes: u64,
}

/// Files a backup would contain: (relative path with `/`, absolute path, size).
pub fn collect(tm: &Path, o: Options) -> Vec<(String, PathBuf, u64)> {
    fn walk(base: &Path, dir: &Path, skip_downloaded: bool, out: &mut Vec<(String, PathBuf, u64)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if skip_downloaded && e.file_name().to_string_lossy().eq_ignore_ascii_case("downloaded") {
                    continue;
                }
                walk(base, &p, skip_downloaded, out);
            } else if ft.is_file() {
                let Ok(rel) = p.strip_prefix(base) else { continue };
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push((rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"), p, size));
            }
        }
    }
    let mut out = vec![];
    for d in CORE {
        walk(tm, &tm.join(d), false, &mut out);
    }
    if o.tracks {
        walk(tm, &tm.join(TRACKS), true, &mut out);
    }
    out
}

pub fn plan(tm: &Path, o: Options) -> Summary {
    let c = collect(tm, o);
    Summary { files: c.len(), bytes: c.iter().map(|x| x.2).sum() }
}

/// Writes the backup zip. The destination must not be inside the folder that is saved.
pub fn create(tm: &Path, dest: &Path, o: Options, created: &str) -> Result<Summary, String> {
    if !tm.is_dir() {
        return Err("The TrackMania folder was not found".into());
    }
    if let (Ok(a), Ok(b)) = (dest.parent().unwrap_or(Path::new(".")).canonicalize(), tm.canonicalize()) {
        if a.starts_with(&b) {
            return Err("Save the backup outside the TrackMania folder".into());
        }
    }
    let files = collect(tm, o);
    let total: u64 = files.iter().map(|f| f.2).sum();
    if total > MAX_TOTAL {
        return Err("The data is bigger than a backup may be (16 GB); leave the tracks out".into());
    }
    let tmp = dest.with_extension("zip.part");
    let f = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let mut z = zip::ZipWriter::new(std::io::BufWriter::new(f));
    let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    let mut items = vec![];
    for (rel, abs, size) in &files {
        if *size > MAX_FILE {
            continue;
        }
        let bytes = std::fs::read(abs).map_err(|e| format!("{}: {e}", abs.display()))?;
        z.start_file(format!("{ROOT}/{rel}"), opt).map_err(|e| e.to_string())?;
        z.write_all(&bytes).map_err(|e| e.to_string())?;
        items.push(Item { path: rel.clone(), size: bytes.len() as u64, sha256: hex::encode(Sha256::digest(&bytes)) });
    }
    let m = Manifest { format: 1, created: created.into(), options: o, items };
    z.start_file(MANIFEST, opt).map_err(|e| e.to_string())?;
    z.write_all(&serde_json::to_vec_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    z.finish().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(Summary { files: m.items.len(), bytes: m.items.iter().map(|i| i.size).sum() })
}

/// A path from the zip: `/`-separated, no `..`, no drive, no stream, no empty or dot parts.
pub fn safe_rel(rel: &str) -> Result<String, String> {
    let ok = !rel.is_empty() && !rel.starts_with('/') && !rel.contains(['\\', ':']) && rel.split('/').all(|p| !p.is_empty() && p != "." && p != "..");
    if ok { Ok(rel.to_string()) } else { Err(format!("Unsafe path in the backup: {rel}")) }
}

/// Reads and checks a backup zip: manifest, every file's SHA-256 and size. Returns the files.
pub fn read(zip_path: &Path) -> Result<(Manifest, Vec<(String, Vec<u8>)>), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    let mut z = zip::ZipArchive::new(std::io::BufReader::new(f)).map_err(|e| format!("Not a backup zip: {e}"))?;
    let m: Manifest = {
        let mut mf = z.by_name(MANIFEST).map_err(|_| "Not a TM Horizon backup (no manifest)".to_string())?;
        let mut s = String::new();
        mf.take(8 << 20).read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| format!("Backup manifest: {e}"))?
    };
    if m.format != 1 {
        return Err("This backup comes from a newer TM Horizon".into());
    }
    let mut files = vec![];
    let mut total = 0u64;
    for item in &m.items {
        let rel = safe_rel(&item.path)?;
        let mut e = z.by_name(&format!("{ROOT}/{rel}")).map_err(|_| format!("{rel} is listed but missing in the zip"))?;
        let mut buf = vec![];
        (&mut e).take(MAX_FILE + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        total += buf.len() as u64;
        if buf.len() as u64 != item.size || hex::encode(Sha256::digest(&buf)) != item.sha256.to_lowercase() || total > MAX_TOTAL {
            return Err(format!("{rel} does not match the backup's list; nothing was restored"));
        }
        files.push((rel, buf));
    }
    Ok((m, files))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreLine {
    pub path: String,
    /// "new" | "replace" | "same"
    pub action: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub created: String,
    pub tracks: bool,
    pub lines: Vec<RestoreLine>,
}

fn action(target: &Path, bytes: &[u8]) -> &'static str {
    match std::fs::read(target) {
        Ok(old) if old == bytes => "same",
        Ok(_) => "replace",
        Err(_) => "new",
    }
}

/// What a restore into `tm` would do. Writes nothing.
pub fn restore_plan(zip_path: &Path, tm: &Path) -> Result<RestorePlan, String> {
    let (m, files) = read(zip_path)?;
    let lines = files.iter().map(|(rel, b)| RestoreLine { path: rel.clone(), action: action(&tm.join(rel), b).into(), size: b.len() as u64 }).collect();
    Ok(RestorePlan { created: m.created, tracks: m.options.tracks, lines })
}

/// Restores into `tm`. Files that differ are copied to `undo_dir` first (same relative path).
/// With `dry_run` nothing is written and the plan's counts are returned.
pub fn restore(zip_path: &Path, tm: &Path, undo_dir: &Path, dry_run: bool) -> Result<Summary, String> {
    let (_, files) = read(zip_path)?;
    let mut n = 0;
    let mut bytes = 0;
    for (rel, b) in &files {
        let target = tm.join(rel);
        let act = action(&target, b);
        if act == "same" {
            continue;
        }
        n += 1;
        bytes += b.len() as u64;
        if dry_run {
            continue;
        }
        if act == "replace" {
            let u = undo_dir.join(rel);
            if let Some(p) = u.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&target, &u).map_err(|e| format!("{}: {e}", u.display()))?;
        }
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, b).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(Summary { files: n, bytes })
}

// ------------------------------------------------------------------ commands

fn tm_dir() -> Result<PathBuf, String> {
    crate::platform::documents_dir().map(|d| d.join("TrackMania")).ok_or_else(|| "Documents folder not found".to_string())
}

#[tauri::command]
pub async fn backup_plan(tracks: bool) -> Result<Summary, String> {
    crate::bg::run(move || -> Result<Summary, String> {
        Ok(plan(&tm_dir()?, Options { tracks }))
    })
    .await
}

/// Save dialog, then the zip. None = cancelled.
#[tauri::command]
pub async fn backup_create(app: tauri::AppHandle, tracks: bool) -> Result<Option<(String, Summary)>, String> {
    use tauri_plugin_dialog::DialogExt;
    let name = format!("TM-Horizon-backup-{}.zip", crate::fsx::stamp());
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("Save backup").set_file_name(&name).add_filter("Backup", &["zip"]).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(dest) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let tm = tm_dir()?;
    let d2 = dest.clone();
    let s = tauri::async_runtime::spawn_blocking(move || create(&tm, &d2, Options { tracks }, &crate::fsx::stamp())).await.map_err(|e| e.to_string())??;
    Ok(Some((dest.to_string_lossy().into_owned(), s)))
}

/// File dialog for the backup to restore. None = cancelled.
#[tauri::command]
pub async fn backup_pick(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("Backup to restore").add_filter("Backup", &["zip"]).blocking_pick_file()).await.map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn backup_restore_plan(path: String) -> Result<RestorePlan, String> {
    crate::bg::run(move || -> Result<RestorePlan, String> {
        restore_plan(Path::new(&path), &tm_dir()?)
    })
    .await
}

/// Restores after the user saw the plan. Refused while a Forever game runs.
#[tauri::command]
pub async fn backup_restore(app: tauri::AppHandle, path: String) -> Result<Summary, String> {
    crate::bg::run(move || -> Result<Summary, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        if crate::platform::running_process_names().iter().any(|p| p.eq_ignore_ascii_case("tmforever.exe") || p.eq_ignore_ascii_case("tmloader.exe")) {
            return Err("Close the game and TMLoader first.".into());
        }
        let undo = st.data_dir.join("restore-undo").join(crate::fsx::stamp());
        restore(Path::new(&path), &tm_dir()?, &undo, false)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(root: &Path) -> PathBuf {
        let tm = root.join("Documents").join("TrackMania");
        for (p, c) in [
            ("Profiles/me.Profile.Gbx", "profile"),
            ("Config/Default.Config.Gbx", "cfg"),
            ("Scores/me/A01.Score.Gbx", "score"),
            ("Tracks/Replays/mine.Replay.Gbx", "replay"),
            ("Tracks/Replays/Downloaded/theirs.Replay.Gbx", "dl"),
            ("Tracks/Challenges/My Challenges/A01.Challenge.Gbx", "map"),
            ("Skins/x.zip", "not saved"),
        ] {
            let f = tm.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, c).unwrap();
        }
        tm
    }

    #[test]
    fn what_goes_in() {
        let t = tempfile::tempdir().unwrap();
        let tm = data(t.path());
        let names = |o| collect(&tm, o).into_iter().map(|x| x.0).collect::<Vec<_>>();
        assert_eq!(names(Options::default()), ["Profiles/me.Profile.Gbx", "Config/Default.Config.Gbx", "Scores/me/A01.Score.Gbx"]);
        let all = names(Options { tracks: true });
        assert!(all.contains(&"Tracks/Replays/mine.Replay.Gbx".to_string()) && all.contains(&"Tracks/Challenges/My Challenges/A01.Challenge.Gbx".to_string()));
        assert!(!all.iter().any(|n| n.contains("Downloaded") || n.starts_with("Skins")));
        assert_eq!(plan(&tm, Options::default()).files, 3);
    }

    #[test]
    fn backup_dry_run_and_restore_into_temp_folders() {
        let t = tempfile::tempdir().unwrap();
        let tm = data(t.path());
        let zip = t.path().join("out").join("b.zip");
        std::fs::create_dir_all(zip.parent().unwrap()).unwrap();
        let s = create(&tm, &zip, Options { tracks: true }, "2026-11-11").unwrap();
        assert_eq!(s.files, 5);
        assert!(!zip.with_extension("zip.part").exists());

        // A fresh PC: everything is new. Dry run writes nothing.
        let fresh = t.path().join("fresh").join("TrackMania");
        let p = restore_plan(&zip, &fresh).unwrap();
        assert!(p.tracks && p.lines.len() == 5 && p.lines.iter().all(|l| l.action == "new"));
        let dry = restore(&zip, &fresh, &t.path().join("undo0"), true).unwrap();
        assert_eq!(dry.files, 5);
        assert!(!fresh.exists());
        restore(&zip, &fresh, &t.path().join("undo1"), false).unwrap();
        assert_eq!(std::fs::read_to_string(fresh.join("Profiles/me.Profile.Gbx")).unwrap(), "profile");
        assert!(!t.path().join("undo1").exists(), "nothing was replaced");

        // Changed since: only that file is replaced, the old one goes to the undo folder.
        std::fs::write(fresh.join("Profiles/me.Profile.Gbx"), "changed").unwrap();
        let p = restore_plan(&zip, &fresh).unwrap();
        assert_eq!(p.lines.iter().filter(|l| l.action == "replace").count(), 1);
        assert_eq!(p.lines.iter().filter(|l| l.action == "same").count(), 4);
        let r = restore(&zip, &fresh, &t.path().join("undo2"), false).unwrap();
        assert_eq!(r.files, 1);
        assert_eq!(std::fs::read_to_string(fresh.join("Profiles/me.Profile.Gbx")).unwrap(), "profile");
        assert_eq!(std::fs::read_to_string(t.path().join("undo2/Profiles/me.Profile.Gbx")).unwrap(), "changed");
    }

    #[test]
    fn refuses_inside_the_data_tampered_zips_and_unsafe_paths() {
        let t = tempfile::tempdir().unwrap();
        let tm = data(t.path());
        assert!(create(&tm, &tm.join("Config").join("b.zip"), Options::default(), "x").unwrap_err().contains("outside"));
        assert!(create(&t.path().join("nope"), &t.path().join("b.zip"), Options::default(), "x").is_err());

        let zip = t.path().join("b.zip");
        create(&tm, &zip, Options::default(), "x").unwrap();
        // A file that is not what the manifest says: refused before anything is written.
        let bad = t.path().join("bad.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&bad).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            let m = Manifest { format: 1, created: "x".into(), options: Options::default(), items: vec![Item { path: "Profiles/me.Profile.Gbx".into(), size: 7, sha256: hex::encode(Sha256::digest(b"profile")) }] };
            z.start_file("TrackMania/Profiles/me.Profile.Gbx", o).unwrap();
            z.write_all(b"PROFILE").unwrap();
            z.start_file(MANIFEST, o).unwrap();
            z.write_all(&serde_json::to_vec(&m).unwrap()).unwrap();
            z.finish().unwrap();
        }
        let target = t.path().join("target");
        assert!(restore(&bad, &target, &t.path().join("u"), false).is_err());
        assert!(!target.exists());
        assert!(restore_plan(&t.path().join("missing.zip"), &target).is_err());
        std::fs::write(t.path().join("junk.zip"), b"not a zip").unwrap();
        assert!(read(&t.path().join("junk.zip")).unwrap_err().contains("Not a backup"));

        for bad in ["../x", "a/../b", "/abs", "C:/x", "a\\b", "a//b", "a/./b", "a/b:stream", ""] {
            assert!(safe_rel(bad).is_err(), "{bad}");
        }
        assert!(safe_rel("Profiles/me.Profile.Gbx").is_ok());

        // A manifest that names a path outside is refused.
        let evil = t.path().join("evil.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&evil).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            let m = Manifest { format: 1, created: "x".into(), options: Options::default(), items: vec![Item { path: "../../evil.txt".into(), size: 1, sha256: hex::encode(Sha256::digest(b"x")) }] };
            z.start_file(MANIFEST, o).unwrap();
            z.write_all(&serde_json::to_vec(&m).unwrap()).unwrap();
            z.finish().unwrap();
        }
        assert!(read(&evil).unwrap_err().contains("Unsafe"));
    }
}
