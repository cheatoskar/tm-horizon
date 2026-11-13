//! Installed skins and mods (Skins page, "Installed" tab): what sits in the folders skins.rs writes
//! ManiaPark downloads to, per game. ManiaPark has no public API, so the store stays the embedded
//! page; this is the native half around it.
//!
//! - List: zips and folders in `skins::all_dirs(game)`, plus the ones switched off.
//! - Source: the ManiaPark asset (type + id) when the launcher installed it, recorded at download
//!   time in `<data>\skins\sources.json` (older downloads have none).
//! - Off: the file moves to `<data>\skins\off\<id>\<name>`, a folder the launcher owns and the game
//!   never reads; `<data>\skins\off.json` remembers where it came from. On moves it back.
//! - Remove: recycle bin (media.rs), never a hard delete.
//! - Preview: a picture inside the zip/folder (jpg/png/webp/tga/bmp, the one named icon/preview
//!   first), 256 px JPEG data URL; none = the page shows a neutral tile.
//!
//! Every path a command gets must be an entry this listing returns for that game.

use crate::fsx;
use crate::skins;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Source {
    /// ManiaPark asset type: "skin" | "model" | "mod".
    pub park_type: String,
    pub park_id: String,
    pub url: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OffEntry {
    pub id: String,
    /// Where it was (and goes back to).
    pub from: String,
    pub moved_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Where the file is now (the game folder, or the launcher's off folder).
    pub path: String,
    pub name: String,
    /// "skin" | "mod".
    pub kind: String,
    /// Car (skins) or environment (mods) folder.
    pub folder: String,
    /// The game folder it belongs in.
    pub dir: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: Option<String>,
    pub enabled: bool,
    pub source: Option<Source>,
}

pub fn root(data: &Path) -> PathBuf {
    data.join("skins")
}
fn sources_file(data: &Path) -> PathBuf {
    root(data).join("sources.json")
}
fn off_file(data: &Path) -> PathBuf {
    root(data).join("off.json")
}
fn off_dir(data: &Path) -> PathBuf {
    root(data).join("off")
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(p: &Path) -> T {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn write_json<T: Serialize>(p: &Path, v: &T) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

/// One lock for both files: the download hook and the page's commands can run at the same time.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// Sources are keyed by the normalised path of the file in the game folder.
fn key(p: &Path) -> String {
    fsx::norm(p)
}

/// A ManiaPark download is about to be saved at `path` (web.rs): remember which asset it is.
pub fn note_source(data: &Path, path: &Path, url: &str) {
    let Some((park_type, park_id)) = skins::park_asset(url) else { return };
    let _g = lock();
    let mut all: BTreeMap<String, Source> = read_json(&sources_file(data));
    all.insert(key(path), Source { park_type, park_id, url: url.to_string(), installed_at: fsx::iso(std::time::SystemTime::now()) });
    let _ = write_json(&sources_file(data), &all);
}

fn size_of(p: &Path, budget: &mut usize) -> u64 {
    let Ok(m) = std::fs::symlink_metadata(p) else { return 0 };
    if m.is_file() {
        return m.len();
    }
    if !m.is_dir() || *budget == 0 {
        return 0;
    }
    let mut total = 0;
    for e in fsx::list(p) {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        total += if e.is_dir { size_of(&e.path, budget) } else { e.len };
    }
    total
}

fn is_item(name: &str, is_dir: bool) -> bool {
    !name.starts_with('.') && (is_dir || name.to_ascii_lowercase().ends_with(".zip"))
}

/// Everything installed for `game`, switched off ones included. Off entries whose file is gone are dropped.
pub fn list(game: &str, docs: &Path, data: &Path) -> Vec<Item> {
    let dirs = skins::all_dirs(game, docs);
    let _g = lock();
    let sources: BTreeMap<String, Source> = read_json(&sources_file(data));
    let mut out = vec![];
    for (kind, label, dir) in &dirs {
        if fsx::blocked(dir) {
            continue;
        }
        for e in fsx::list(dir) {
            if !is_item(&e.name, e.is_dir) {
                continue;
            }
            let mut budget = 4000;
            out.push(Item {
                path: e.path.to_string_lossy().into(),
                name: e.name.clone(),
                kind: kind.as_str().into(),
                folder: (*label).into(),
                dir: dir.to_string_lossy().into(),
                size: if e.is_dir { size_of(&e.path, &mut budget) } else { e.len },
                is_dir: e.is_dir,
                modified: e.modified.map(fsx::iso),
                enabled: true,
                source: sources.get(&key(&e.path)).cloned(),
            });
        }
    }
    let mut off: Vec<OffEntry> = read_json(&off_file(data));
    let before = off.len();
    off.retain(|o| off_dir(data).join(&o.id).join(file_name(&o.from)).exists());
    if off.len() != before {
        let _ = write_json(&off_file(data), &off);
    }
    for o in &off {
        let from = PathBuf::from(&o.from);
        let Some((kind, label, dir)) = dirs.iter().find(|(_, _, d)| from.parent().is_some_and(|p| fsx::norm(p) == fsx::norm(d))) else { continue };
        let now = off_dir(data).join(&o.id).join(file_name(&o.from));
        let m = std::fs::metadata(&now).ok();
        let mut budget = 4000;
        out.push(Item {
            path: now.to_string_lossy().into(),
            name: file_name(&o.from),
            kind: kind.as_str().into(),
            folder: (*label).into(),
            dir: dir.to_string_lossy().into(),
            size: size_of(&now, &mut budget),
            is_dir: m.as_ref().is_some_and(|m| m.is_dir()),
            modified: m.and_then(|m| m.modified().ok()).map(fsx::iso),
            enabled: false,
            source: sources.get(&key(&from)).cloned(),
        });
    }
    out.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The listed entry for `path`, or an error: commands never act on anything else.
fn entry(game: &str, docs: &Path, data: &Path, path: &str) -> Result<Item, String> {
    let n = fsx::norm(Path::new(path));
    list(game, docs, data).into_iter().find(|i| fsx::norm(Path::new(&i.path)) == n).ok_or_else(|| "Not in the installed list".to_string())
}

/// Move a file or folder; across drives (Documents elsewhere than the launcher data) copy, then delete.
fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("{} is already there", to.display()));
    }
    if let Some(d) = to.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_all(from, to).map_err(|e| {
        let _ = if to.is_dir() { std::fs::remove_dir_all(to) } else { std::fs::remove_file(to) };
        e
    })?;
    (if from.is_dir() { std::fs::remove_dir_all(from) } else { std::fs::remove_file(from) }).map_err(|e| e.to_string())
}

fn copy_all(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
            copy_all(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Switch an entry on (back into the game folder) or off (into the launcher's off folder).
pub fn set_enabled(game: &str, docs: &Path, data: &Path, path: &str, on: bool) -> Result<(), String> {
    let it = entry(game, docs, data, path)?;
    if it.enabled == on {
        return Ok(());
    }
    let now = PathBuf::from(&it.path);
    fsx::check(&now)?;
    if on {
        let back = PathBuf::from(&it.dir).join(&it.name);
        fsx::check(&back)?;
        move_path(&now, &back)?;
        let _g = lock();
        let mut off: Vec<OffEntry> = read_json(&off_file(data));
        off.retain(|o| fsx::norm(&off_dir(data).join(&o.id).join(file_name(&o.from))) != fsx::norm(&now));
        let _ = now.parent().map(std::fs::remove_dir);
        write_json(&off_file(data), &off)
    } else {
        let id = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        let to = off_dir(data).join(&id).join(&it.name);
        move_path(&now, &to)?;
        let _g = lock();
        let mut off: Vec<OffEntry> = read_json(&off_file(data));
        off.push(OffEntry { id, from: it.path.clone(), moved_at: fsx::iso(std::time::SystemTime::now()) });
        write_json(&off_file(data), &off)
    }
}

/// Recycle bin. The source note and an off record go too.
pub fn remove(game: &str, docs: &Path, data: &Path, path: &str, trash: impl Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    let it = entry(game, docs, data, path)?;
    let now = PathBuf::from(&it.path);
    fsx::check(&now)?;
    trash(&now)?;
    let _g = lock();
    let home = PathBuf::from(&it.dir).join(&it.name);
    let mut sources: BTreeMap<String, Source> = read_json(&sources_file(data));
    if sources.remove(&key(&home)).is_some() {
        let _ = write_json(&sources_file(data), &sources);
    }
    if !it.enabled {
        let mut off: Vec<OffEntry> = read_json(&off_file(data));
        off.retain(|o| fsx::norm(&off_dir(data).join(&o.id).join(file_name(&o.from))) != fsx::norm(&now));
        let _ = now.parent().map(std::fs::remove_dir);
        write_json(&off_file(data), &off)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ preview

const PICTURE: [&str; 7] = [".jpg", ".jpeg", ".png", ".webp", ".tga", ".bmp", ".gif"];
/// Pictures larger than this inside a zip are not decoded.
const MAX_PICTURE: u64 = 12 << 20;

/// Which picture to show: one called icon/preview/thumb/screen first, then the smallest other one.
fn rank(name: &str, size: u64) -> Option<(u8, u64)> {
    let l = name.to_ascii_lowercase();
    if !PICTURE.iter().any(|e| l.ends_with(e)) || size == 0 || size > MAX_PICTURE {
        return None;
    }
    let base = l.rsplit(['/', '\\']).next().unwrap_or(&l);
    let named = ["icon", "preview", "thumb", "screen", "shot"].iter().any(|k| base.contains(k));
    Some((if named { 0 } else { 1 }, size))
}

fn thumb_of(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    let img = image::load_from_memory(bytes).ok()?.thumbnail(256, 256).to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82).encode_image(&img).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out.into_inner())))
}

fn picture_in_zip(p: &Path) -> Option<Vec<u8>> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(p).ok()?).ok()?;
    let best = (0..z.len())
        .filter_map(|i| {
            let f = z.by_index(i).ok()?;
            rank(f.name(), f.size()).map(|r| (r, i))
        })
        .min()?;
    let mut f = z.by_index(best.1).ok()?;
    let mut buf = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn picture_in_dir(p: &Path) -> Option<Vec<u8>> {
    let mut found = vec![];
    for e in fsx::list(p) {
        if e.is_dir {
            for e2 in fsx::list(&e.path).into_iter().take(200) {
                if let Some(r) = rank(&e2.name, e2.len) {
                    found.push((r, e2.path));
                }
            }
        } else if let Some(r) = rank(&e.name, e.len) {
            found.push((r, e.path));
        }
    }
    found.into_iter().min().and_then(|(_, p)| std::fs::read(p).ok())
}

/// Preview of an entry as a data URL, cached by path, size and time.
pub fn preview(path: &Path) -> Option<String> {
    static C: OnceLock<Mutex<HashMap<(String, u64, u64), Option<String>>>> = OnceLock::new();
    let m = std::fs::metadata(path).ok()?;
    let t = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let k = (fsx::norm(path), m.len(), t);
    if let Some(v) = C.get_or_init(Default::default).lock().unwrap().get(&k) {
        return v.clone();
    }
    let bytes = if m.is_dir() { picture_in_dir(path) } else { picture_in_zip(path) };
    let v = bytes.and_then(|b| thumb_of(&b));
    let mut c = C.get_or_init(Default::default).lock().unwrap();
    if c.len() > 2000 {
        c.clear();
    }
    c.insert(k, v.clone());
    v
}

pub mod cmd {
    use super::*;
    use crate::state::AppState;
    use tauri::State;

    fn docs() -> Result<PathBuf, String> {
        crate::platform::documents_dir().ok_or_else(|| "No Documents folder".to_string())
    }

    #[tauri::command]
    pub async fn skins_installed(st: State<'_, AppState>, game: String) -> Result<Vec<Item>, String> {
        let (docs, data) = (docs()?, st.data_dir.clone());
        Ok(crate::bg::run(move || list(&game, &docs, &data)).await)
    }

    #[tauri::command]
    pub async fn skins_preview(st: State<'_, AppState>, game: String, path: String) -> Result<Option<String>, String> {
        let (docs, data) = (docs()?, st.data_dir.clone());
        crate::bg::run(move || entry(&game, &docs, &data, &path).map(|i| preview(Path::new(&i.path)))).await
    }

    #[tauri::command]
    pub async fn skins_set_enabled(st: State<'_, AppState>, game: String, path: String, enabled: bool) -> Result<(), String> {
        let (docs, data) = (docs()?, st.data_dir.clone());
        crate::bg::run(move || set_enabled(&game, &docs, &data, &path, enabled)).await
    }

    #[tauri::command]
    pub async fn skins_remove(st: State<'_, AppState>, game: String, path: String) -> Result<(), String> {
        let (docs, data) = (docs()?, st.data_dir.clone());
        crate::bg::run(move || remove(&game, &docs, &data, &path, crate::media::move_to_trash)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(p: &Path, files: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(p).unwrap());
        for (n, b) in files {
            z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap();
    }

    fn png() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(4, 4, image::Rgb([200, 30, 30]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn lists_switches_off_and_on_and_removes() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("Docs");
        let data = t.path().join("Data");
        let car = docs.join("TrackMania/Skins/Vehicles/CarCommon");
        let coast = docs.join("TrackMania/Skins/Coast/Mod");
        std::fs::create_dir_all(&car).unwrap();
        std::fs::create_dir_all(&coast).unwrap();
        zip_with(&car.join("Bath.zip"), &[("Icon.png", &png()), ("Diffuse.dds", b"x")]);
        zip_with(&coast.join("Summer.zip"), &[("a.dds", b"x")]);
        std::fs::write(car.join("notes.txt"), b"x").unwrap();
        std::fs::create_dir_all(car.join("Folder skin")).unwrap();
        std::fs::write(car.join("Folder skin/Diffuse.dds"), b"abc").unwrap();
        note_source(&data, &car.join("Bath.zip"), "https://maniapark.com/skin/31K6V4/download");
        note_source(&data, &car.join("Other.zip"), "https://evil.example/skin/1/download");

        let l = list("tmnf", &docs, &data);
        assert_eq!(l.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Summer.zip", "Bath.zip", "Folder skin"]);
        let bath = l.iter().find(|i| i.name == "Bath.zip").unwrap();
        assert_eq!(bath.source.as_ref().unwrap().park_id, "31K6V4");
        assert_eq!(bath.folder, "CarCommon");
        assert_eq!(l[0].folder, "Coast");
        assert_eq!(l.iter().find(|i| i.is_dir).unwrap().size, 3);
        // Same folders for TMUF (shared Documents); none for a game without skin folders.
        assert_eq!(list("tmuf", &docs, &data).len(), 3);
        assert!(list("tm-sunrise", &docs, &data).is_empty());

        assert!(preview(Path::new(&bath.path)).unwrap().starts_with("data:image/jpeg;base64,"));
        assert_eq!(preview(&coast.join("Summer.zip")), None);

        // Off: out of the game folder, into the launcher's; listed as off with its source.
        set_enabled("tmnf", &docs, &data, &bath.path, false).unwrap();
        assert!(!car.join("Bath.zip").exists());
        let l = list("tmnf", &docs, &data);
        let off = l.iter().find(|i| i.name == "Bath.zip").unwrap();
        assert!(!off.enabled);
        assert!(off.path.starts_with(&*data.to_string_lossy()));
        assert_eq!(off.source.as_ref().unwrap().park_type, "skin");
        // On again: back where it was.
        set_enabled("tmnf", &docs, &data, &off.path, true).unwrap();
        assert!(car.join("Bath.zip").exists());
        assert!(list("tmnf", &docs, &data).iter().all(|i| i.enabled));

        // Only listed paths: anything else is refused.
        assert!(set_enabled("tmnf", &docs, &data, &car.join("notes.txt").to_string_lossy(), false).is_err());
        assert!(remove("tmnf", &docs, &data, &docs.join("x.zip").to_string_lossy(), |_| Ok(())).is_err());

        // Remove: handed to the recycle bin (here: deleted by the test's trash), source note dropped.
        let trash = |p: &Path| std::fs::remove_file(p).map_err(|e| e.to_string());
        remove("tmnf", &docs, &data, &car.join("Bath.zip").to_string_lossy(), trash).unwrap();
        assert!(!car.join("Bath.zip").exists());
        let s: BTreeMap<String, Source> = read_json(&sources_file(&data));
        assert!(s.is_empty());

        // An off entry can be removed too.
        let summer = coast.join("Summer.zip").to_string_lossy().into_owned();
        set_enabled("tmnf", &docs, &data, &summer, false).unwrap();
        let off = list("tmnf", &docs, &data).into_iter().find(|i| !i.enabled).unwrap();
        remove("tmnf", &docs, &data, &off.path, trash).unwrap();
        assert!(list("tmnf", &docs, &data).iter().all(|i| i.name != "Summer.zip"));
        let o: Vec<OffEntry> = read_json(&off_file(&data));
        assert!(o.is_empty());
    }

    #[test]
    fn on_refuses_to_overwrite() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("Docs");
        let data = t.path().join("Data");
        let car = docs.join("TrackMania/Skins/Vehicles/CarCommon");
        std::fs::create_dir_all(&car).unwrap();
        zip_with(&car.join("A.zip"), &[("x", b"1")]);
        set_enabled("tmnf", &docs, &data, &car.join("A.zip").to_string_lossy(), false).unwrap();
        zip_with(&car.join("A.zip"), &[("x", b"2")]);
        let off = list("tmnf", &docs, &data).into_iter().find(|i| !i.enabled).unwrap();
        assert!(set_enabled("tmnf", &docs, &data, &off.path, true).is_err());
    }

    #[test]
    fn park_asset_ids() {
        assert_eq!(skins::park_asset("https://maniapark.com/mod/xyz/download"), Some(("mod".into(), "xyz".into())));
        assert_eq!(skins::park_asset("https://maniapark.com/gamemode/q/download"), None);
        assert_eq!(skins::park_asset("https://evil.example/skin/q/download"), None);
        let d = Path::new("D");
        assert_eq!(skins::all_dirs("tm2-canyon", d).len(), 2);
        assert_eq!(skins::all_dirs("tmnf", d).len(), 8);
        assert!(skins::all_dirs("tm-original", d).is_empty());
    }
}
