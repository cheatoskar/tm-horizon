//! Media page: screenshots and clips of all TrackMania games in one list.
//!
//! Folders (only those that exist are listed, names are matched case-insensitively):
//! - Forever (TMNF/TMUF/Nations ESWC): `Documents\TrackMania\ScreenShots`, `...\Clips` (clip recorder)
//! - ManiaPlanet: `Documents\ManiaPlanet\ScreenShots`
//! - Trackmania 2020: `<user dir>\Screenshots`
//! - TM Vibrant Shaders: `Documents\TrackMania\TMVS` (`photo_NNN.png`, `screen_*.bmp`) and
//!   `...\TMVS\videos` (`video_*.mp4`); the ManiaPlanet build writes to `Documents\ManiaPlanet\TMVS`
//! - Original / Sunrise / ESWC keep user data in `<install>\GameData\ScreenShots`
//!   (ESWC sits in the protected folder: fsx lists nothing there).
//!
//! The grid shows small JPEG previews made by `thumbs` (never the originals: see there why). Deleting
//! moves files to the recycle bin; deleting and previews only work on files this listing would return.

use crate::fsx;
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_ITEMS: usize = 2000;
const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tga"];
const VIDEO_EXT: &[&str] = &["mp4", "webm", "mkv"];

#[derive(Debug, Clone)]
pub struct Spec {
    pub game: &'static str,
    pub kind: &'static str,
    pub source: &'static str,
    pub path: PathBuf,
    /// 1 = only the folder itself, 2 = one level of sub folders too.
    pub depth: usize,
    /// Only files whose name starts with one of these (lower case); empty = all media files.
    pub prefixes: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub game: String,
    pub kind: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub name: String,
    /// "image" or "video"
    pub kind: String,
    pub game: String,
    /// "game" (the game's own screenshots) or "tmvs" (TM Vibrant Shaders / clip recorder)
    pub source: String,
    pub size: u64,
    pub modified: Option<String>,
    pub folder: String,
    /// Pictures: always true now (TGA gets a JPEG copy like BMP); kept for older pages.
    pub preview: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub folders: Vec<Folder>,
    pub items: Vec<Item>,
}

/// `base/a/b`, each part matched case-insensitively against what exists (the plain name if nothing does).
fn resolve(base: &Path, parts: &[&str]) -> PathBuf {
    let mut cur = base.to_path_buf();
    for p in parts {
        let hit = fsx::list(&cur).into_iter().find(|e| e.is_dir && e.name.eq_ignore_ascii_case(p));
        cur = match hit {
            Some(e) => e.path,
            None => cur.join(p),
        };
    }
    cur
}

/// The folders to look at. `installs` are (game id, install folder) pairs.
pub fn specs(docs: Option<&Path>, installs: &[(&'static str, PathBuf)]) -> Vec<Spec> {
    let mut out = Vec::new();
    let tmvs_files: &'static [&'static str] = &["photo_", "screen_", "capture_"];
    if let Some(d) = docs {
        let tm = resolve(d, &["TrackMania"]);
        out.push(Spec { game: "forever", kind: "screenshots", source: "game", path: resolve(&tm, &["ScreenShots"]), depth: 2, prefixes: &[] });
        out.push(Spec { game: "forever", kind: "clips", source: "tmvs", path: resolve(&tm, &["Clips"]), depth: 1, prefixes: &[] });
        out.push(Spec { game: "forever", kind: "tmvs-photos", source: "tmvs", path: resolve(&tm, &["TMVS"]), depth: 1, prefixes: tmvs_files });
        out.push(Spec { game: "forever", kind: "tmvs-videos", source: "tmvs", path: resolve(&tm, &["TMVS", "videos"]), depth: 1, prefixes: &[] });
        let mp = resolve(d, &["ManiaPlanet"]);
        out.push(Spec { game: "maniaplanet", kind: "screenshots", source: "game", path: resolve(&mp, &["ScreenShots"]), depth: 2, prefixes: &[] });
        out.push(Spec { game: "maniaplanet", kind: "tmvs-photos", source: "tmvs", path: resolve(&mp, &["TMVS"]), depth: 1, prefixes: tmvs_files });
        out.push(Spec { game: "maniaplanet", kind: "tmvs-videos", source: "tmvs", path: resolve(&mp, &["TMVS", "videos"]), depth: 1, prefixes: &[] });
        let t20 = crate::maps::tm2020_user_dir(d);
        out.push(Spec { game: "tm2020", kind: "screenshots", source: "game", path: resolve(&t20, &["Screenshots"]), depth: 2, prefixes: &[] });
    }
    for (game, dir) in installs {
        out.push(Spec { game, kind: "screenshots", source: "game", path: resolve(dir, &["GameData", "ScreenShots"]), depth: 2, prefixes: &[] });
    }
    out
}

fn ext_of(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// "image" / "video" for a media file name.
fn media_kind(name: &str) -> Option<&'static str> {
    let e = ext_of(name);
    if IMAGE_EXT.contains(&e.as_str()) {
        Some("image")
    } else if VIDEO_EXT.contains(&e.as_str()) {
        Some("video")
    } else {
        None
    }
}

fn prefix_ok(spec: &Spec, name: &str) -> bool {
    spec.prefixes.is_empty() || {
        let l = name.to_ascii_lowercase();
        spec.prefixes.iter().any(|p| l.starts_with(p))
    }
}

pub fn list(specs: &[Spec]) -> Listing {
    let mut folders = Vec::new();
    let mut items: Vec<(Option<std::time::SystemTime>, Item)> = Vec::new();
    for s in specs {
        let exists = fsx::is_dir(&s.path);
        folders.push(Folder { game: s.game.into(), kind: s.kind.into(), path: s.path.to_string_lossy().into(), exists });
        if !exists {
            continue;
        }
        let mut dirs = vec![(s.path.clone(), 1usize)];
        while let Some((dir, level)) = dirs.pop() {
            for e in fsx::list(&dir) {
                if e.is_dir {
                    if level < s.depth {
                        dirs.push((e.path, level + 1));
                    }
                    continue;
                }
                let Some(kind) = media_kind(&e.name) else { continue };
                if !e.is_file || !prefix_ok(s, &e.name) {
                    continue;
                }
                // Size and time read like thumbs::stamp does (the preview cache key uses both).
                let md = std::fs::metadata(&e.path).ok();
                let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = md.and_then(|m| m.modified().ok()).or(e.modified);
                items.push((
                    modified,
                    Item {
                        path: e.path.to_string_lossy().into(),
                        preview: true,
                        name: e.name,
                        kind: kind.into(),
                        game: s.game.into(),
                        source: s.source.into(),
                        size,
                        modified: modified.map(fsx::iso),
                        folder: s.path.to_string_lossy().into(),
                    },
                ));
            }
        }
    }
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
    items.truncate(MAX_ITEMS);
    // One file may sit in two scanned folders (a sub folder of another spec); keep the first.
    let mut seen = std::collections::HashSet::new();
    let items = items.into_iter().map(|(_, i)| i).filter(|i| seen.insert(fsx::norm(Path::new(&i.path)))).collect();
    Listing { folders, items }
}

/// Is this file one the listing would show? (Checked again on the server before any delete or preview.)
fn listed(path: &Path, specs: &[Spec]) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if fsx::blocked(path) || media_kind(&name).is_none() {
        return Err(format!("Not a media file: {}", path.display()));
    }
    let md = std::fs::symlink_metadata(path).map_err(|_| format!("File not found: {}", path.display()))?;
    if !md.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    let ok = specs.iter().any(|s| {
        if !fsx::is_inside(path, &s.path) || !prefix_ok(s, &name) {
            return false;
        }
        // distance in folders below the media folder: depth 1 = directly inside
        let below = path.parent().map(|p| fsx::norm(p)).unwrap_or_default();
        let base = fsx::norm(&s.path);
        let extra = below.strip_prefix(&base).map(|r| r.split('\\').filter(|x| !x.is_empty()).count()).unwrap_or(usize::MAX);
        extra < s.depth
    });
    if ok {
        Ok(())
    } else {
        Err(format!("Not inside a media folder: {}", path.display()))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: usize,
    pub failed: Vec<DeleteFail>,
}
#[derive(Debug, Clone, Serialize)]
pub struct DeleteFail {
    pub path: String,
    pub error: String,
}

/// Validates every path first (one bad path refuses the whole call), then moves them to the trash.
pub fn delete(paths: &[String], specs: &[Spec], trash: impl Fn(&Path) -> Result<(), String>) -> Result<DeleteResult, String> {
    if paths.is_empty() {
        return Err("Nothing selected".into());
    }
    let list: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    for p in &list {
        listed(p, specs)?;
    }
    let mut res = DeleteResult { deleted: 0, failed: Vec::new() };
    for p in &list {
        match trash(p) {
            Ok(()) => res.deleted += 1,
            Err(e) => res.failed.push(DeleteFail { path: p.to_string_lossy().into(), error: e }),
        }
    }
    Ok(res)
}

// ------------------------------------------------------------------ recycle bin

#[cfg(windows)]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    let win = path.to_string_lossy().replace('/', "\\");
    let mut from: Vec<u16> = std::ffi::OsStr::new(&win).encode_wide().collect();
    from.push(0);
    from.push(0); // double NUL: the list ends with an empty string
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE as _;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI) as _;
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        Err(format!("Could not move {} to the recycle bin (code {code:#x})", path.display()))
    } else if op.fAnyOperationsAborted != 0 {
        Err(format!("Cancelled: {}", path.display()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("No home folder")?;
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join("Trash");
    move_to_trash_in(path, &base)
}

#[cfg(not(windows))]
fn move_to_trash_in(path: &Path, base: &Path) -> Result<(), String> {
    let files = base.join("files");
    let info = base.join("info");
    std::fs::create_dir_all(&files).and_then(|_| std::fs::create_dir_all(&info)).map_err(|e| e.to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    let mut target = name.clone();
    let mut n = 1;
    while files.join(&target).exists() || info.join(format!("{target}.trashinfo")).exists() {
        n += 1;
        target = format!("{stem}.{n}{ext}");
    }
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let enc: String = abs.to_string_lossy().bytes().map(|b| if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let stamp = fsx::now_iso();
    let stamp = stamp.split('.').next().unwrap_or(&stamp).trim_end_matches('Z').to_string();
    std::fs::write(info.join(format!("{target}.trashinfo")), format!("[Trash Info]\nPath={enc}\nDeletionDate={stamp}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(path, files.join(&target)).map_err(|e| {
        let _ = std::fs::remove_file(info.join(format!("{target}.trashinfo")));
        format!("Could not move {} to the trash ({e})", path.display())
    })
}

// ------------------------------------------------------------------ commands

/// Folders of the last listing, for the preview requests that follow it (each one would otherwise
/// look up the folders again).
static LAST_SPECS: std::sync::Mutex<Option<Vec<Spec>>> = std::sync::Mutex::new(None);
static THUMB_SCOPE: std::sync::Once = std::sync::Once::new();

fn thumb_scope(app: &tauri::AppHandle) {
    use tauri::Manager;
    THUMB_SCOPE.call_once(|| {
        let dir = crate::thumbs::dir(&app.state::<crate::state::AppState>().cache_dir);
        let _ = std::fs::create_dir_all(&dir);
        let _ = app.asset_protocol_scope().allow_directory(&dir, false);
    });
}

/// Cache names of every preview the listing can ask for (the rest is pruned).
fn wanted(items: &[Item]) -> std::collections::HashSet<String> {
    use crate::thumbs::{key, view_original, Variant};
    let mut keep = std::collections::HashSet::new();
    for i in items.iter().filter(|i| i.kind == "image") {
        let p = Path::new(&i.path);
        let m = i.modified.as_deref().unwrap_or("");
        keep.insert(key(p, i.size, m, Variant::Thumb));
        if !view_original(p, i.size) {
            keep.insert(key(p, i.size, m, Variant::View));
        }
    }
    keep
}

fn current_specs(app: &tauri::AppHandle) -> Vec<Spec> {
    use tauri::Manager;
    let docs = crate::tmvscontent::documents_dir();
    let mut installs: Vec<(&'static str, PathBuf)> = Vec::new();
    if std::env::var("TMHUB_NO_INSTALL_DIRS").map(|v| !v.is_empty() && v != "0").unwrap_or(false) {
        return specs(docs.as_deref(), &installs);
    }
    let st = app.state::<crate::state::AppState>();
    for g in ["tm-original", "tm-sunrise", "tmn-eswc", "tm-2003"] {
        if let Some(d) = st.install_dir(g) {
            installs.push((g, d));
        }
    }
    specs(docs.as_deref(), &installs)
}

#[tauri::command]
pub async fn media_list(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager as _;
        let sp = current_specs(&app);
        let listing = list(&sp);
        for (s, f) in sp.iter().zip(&listing.folders) {
            if f.exists {
                let _ = app.asset_protocol_scope().allow_directory(&s.path, s.depth > 1);
            }
        }
        thumb_scope(&app);
        *LAST_SPECS.lock().unwrap() = Some(sp);
        // Previews of files that are gone or changed go, and the folder stays under its cap.
        let keep = wanted(&listing.items);
        let cache = app.state::<crate::state::AppState>().cache_dir.clone();
        let _ = std::thread::spawn(move || crate::thumbs::prune(&cache, &keep, crate::thumbs::CACHE_CAP));
        serde_json::to_value(listing).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Path of the picture to show for a listed file: the small preview, or with `view` the one for the
/// viewer (the original for JPG/WebP and small PNGs). Made on a background thread; the main thread never waits.
#[tauri::command]
pub async fn media_thumb(app: tauri::AppHandle, path: String, view: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager as _;
        let sp = LAST_SPECS.lock().unwrap().clone().unwrap_or_else(|| current_specs(&app));
        let p = PathBuf::from(&path);
        listed(&p, &sp)?;
        if media_kind(&path).unwrap_or("") != "image" {
            return Err(format!("Not a picture: {path}"));
        }
        thumb_scope(&app);
        let cache = app.state::<crate::state::AppState>().cache_dir.clone();
        let v = if view.unwrap_or(false) { crate::thumbs::Variant::View } else { crate::thumbs::Variant::Thumb };
        crate::thumbs::get(&cache, &p, v).map(|o| o.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn media_delete(app: tauri::AppHandle, paths: Vec<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sp = current_specs(&app);
        let r = delete(&paths, &sp, move_to_trash)?;
        serde_json::to_value(r).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn put(p: &Path, data: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, data).unwrap();
    }

    fn docs() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        put(&d.join("TrackMania/screenshots/a.jpg"), b"1");
        std::thread::sleep(std::time::Duration::from_millis(30));
        put(&d.join("TrackMania/screenshots/2024/b.PNG"), b"22");
        put(&d.join("TrackMania/screenshots/2024/deep/c.jpg"), b"x");
        put(&d.join("TrackMania/screenshots/notes.txt"), b"x");
        put(&d.join("TrackMania/screenshots/shot.tga"), b"x");
        std::thread::sleep(std::time::Duration::from_millis(30));
        put(&d.join("TrackMania/Clips/run.mp4"), b"333");
        put(&d.join("TrackMania/TMVS/photo_001.png"), b"4");
        put(&d.join("TrackMania/TMVS/other.png"), b"4");
        put(&d.join("TrackMania/TMVS/presets/photo_x.png"), b"4");
        put(&d.join("TrackMania/TMVS/videos/video_1.mp4"), b"5");
        t
    }

    #[test]
    fn lists_sorted_and_filtered() {
        let t = docs();
        let sp = specs(Some(t.path()), &[]);
        let l = list(&sp);
        let names: Vec<_> = l.items.iter().map(|i| i.name.as_str()).collect();
        assert!(names.contains(&"a.jpg") && names.contains(&"b.PNG") && names.contains(&"run.mp4"));
        assert!(names.contains(&"photo_001.png") && names.contains(&"video_1.mp4") && names.contains(&"shot.tga"));
        assert!(!names.contains(&"notes.txt"), "not media");
        assert!(!names.contains(&"c.jpg"), "deeper than 2 levels");
        assert!(!names.contains(&"other.png") && !names.contains(&"photo_x.png"), "TMVS root: prefix and depth 1");
        // newest first
        let pos = |n: &str| names.iter().position(|x| *x == n).unwrap();
        assert!(pos("run.mp4") < pos("b.PNG") || pos("video_1.mp4") < pos("b.PNG"));
        assert!(pos("b.PNG") < pos("a.jpg"));
        assert!(l.items.iter().find(|i| i.name == "shot.tga").unwrap().preview);
        assert_eq!(l.items.iter().find(|i| i.name == "run.mp4").unwrap().kind, "video");
        // the lowercase "screenshots" folder was found
        assert!(l.folders.iter().any(|f| f.kind == "screenshots" && f.game == "forever" && f.exists));
        assert!(l.folders.iter().any(|f| f.game == "maniaplanet" && !f.exists));
    }

    #[test]
    fn listing_keys_match_preview_keys() {
        let t = docs();
        let l = list(&specs(Some(t.path()), &[]));
        let keep = wanted(&l.items);
        let p = t.path().join("TrackMania/screenshots/2024/b.PNG");
        let (size, m) = crate::thumbs::stamp(&p).unwrap();
        assert!(keep.contains(&crate::thumbs::key(&p, size, &m, crate::thumbs::Variant::Thumb)));
        let tga = t.path().join("TrackMania/screenshots/shot.tga");
        let (size, m) = crate::thumbs::stamp(&tga).unwrap();
        assert!(keep.contains(&crate::thumbs::key(&tga, size, &m, crate::thumbs::Variant::View)));
    }

    #[test]
    fn cap_applies() {
        let t = tempfile::tempdir().unwrap();
        for i in 0..(MAX_ITEMS + 5) {
            put(&t.path().join(format!("TrackMania/Clips/{i}.mp4")), b"1");
        }
        assert_eq!(list(&specs(Some(t.path()), &[])).items.len(), MAX_ITEMS);
    }

    #[test]
    fn install_dir_screenshots() {
        let t = tempfile::tempdir().unwrap();
        put(&t.path().join("gamedata/screenshots/s.jpg"), b"1");
        let l = list(&specs(None, &[("tm-original", t.path().to_path_buf())]));
        assert_eq!(l.items.len(), 1);
        assert_eq!(l.items[0].game, "tm-original");
    }

    #[test]
    fn delete_refuses_outside_and_non_media() {
        let t = docs();
        let outside = tempfile::tempdir().unwrap();
        put(&outside.path().join("x.jpg"), b"1");
        let sp = specs(Some(t.path()), &[]);
        let never = |_: &Path| -> Result<(), String> { panic!("must not delete") };
        let p = |x: PathBuf| vec![x.to_string_lossy().to_string()];
        assert!(delete(&p(outside.path().join("x.jpg")), &sp, never).is_err());
        assert!(delete(&p(t.path().join("TrackMania/screenshots/notes.txt")), &sp, never).is_err());
        assert!(delete(&p(t.path().join("TrackMania/screenshots/2024/deep/c.jpg")), &sp, never).is_err());
        assert!(delete(&p(t.path().join("TrackMania/TMVS/other.png")), &sp, never).is_err());
        assert!(delete(&p(t.path().join("TrackMania/screenshots/2024")), &sp, never).is_err());
        assert!(delete(&p(t.path().join("TrackMania/screenshots/../../../x.jpg")), &sp, never).is_err());
        assert!(delete(&[], &sp, never).is_err());
        // one bad path refuses the whole call
        let mixed = vec![t.path().join("TrackMania/Clips/run.mp4").to_string_lossy().to_string(), outside.path().join("x.jpg").to_string_lossy().to_string()];
        assert!(delete(&mixed, &sp, never).is_err());
    }

    #[test]
    fn delete_calls_trash_for_valid_files() {
        let t = docs();
        let sp = specs(Some(t.path()), &[]);
        let f = t.path().join("TrackMania/screenshots/2024/b.PNG");
        let seen = std::cell::RefCell::new(Vec::new());
        let r = delete(&[f.to_string_lossy().to_string()], &sp, |p| {
            seen.borrow_mut().push(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(r.deleted, 1);
        assert_eq!(seen.borrow().len(), 1);
    }

    /// Real recycle bin, but only with a file in a folder this test created.
    #[test]
    #[ignore]
    fn trash_temp_file() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("gone.jpg");
        fs::write(&f, b"1").unwrap();
        #[cfg(windows)]
        move_to_trash(&f).unwrap();
        #[cfg(not(windows))]
        move_to_trash_in(&f, &t.path().join("Trash")).unwrap();
        assert!(!f.exists());
    }
}
