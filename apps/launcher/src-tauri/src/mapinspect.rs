//! Map details (src/pages/MapDetails.tsx): the map inspector of 100tmx.com, natively in the launcher
//! (packages/map-inspector). The page parses the .Gbx itself (gbx.js in a worker); this side only hands
//! it the bytes of a local map file and finds map files: in the player's map folders by UID (map rows
//! in Statistics carry no path) and as a list for the "Local maps" picker. Read only, never the body
//! of anything but a map the player chose.

use crate::hosting::mapfiles::{self, MapMeta};
use std::path::{Path, PathBuf};

/// A big TMF map is a couple of megabytes; anything past this is not a map.
pub const MAX_MAP_BYTES: u64 = 32 << 20;
/// Files looked at per folder tree when listing or searching.
const MAX_LIST: usize = 5000;

/// Stats families and game ids to a family key.
pub fn family_of(id: &str) -> Option<&'static str> {
    Some(match id {
        "forever" | "tmnf" | "tmuf" => "forever",
        "maniaplanet" => "maniaplanet",
        "tm2020" => "tm2020",
        "tmn-eswc" => "tmn-eswc",
        "tm-sunrise" => "tm-sunrise",
        "tm-original" => "tm-original",
        g if crate::launch::title_id(g).is_some() => "maniaplanet",
        _ => return None,
    })
}

/// The folders a family keeps its maps in (the same places Statistics and the map downloads use).
/// Legacy games keep them in the install folder: `install(game id)` gives it.
pub fn map_roots(family: &str, docs: Option<&Path>, install: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    match family {
        "forever" => docs.map(|d| vec![d.join("TrackMania").join("Tracks").join("Challenges")]).unwrap_or_default(),
        "maniaplanet" => docs.map(|d| vec![d.join("ManiaPlanet").join("Maps")]).unwrap_or_default(),
        "tm2020" => docs.map(|d| vec![crate::maps::tm2020_user_dir(d).join("Maps")]).unwrap_or_default(),
        "tmn-eswc" | "tm-sunrise" | "tm-original" => install(family).map(|i| vec![i.join("GameData").join("Tracks").join("Challenges")]).unwrap_or_default(),
        _ => vec![],
    }
}

/// Every map under the roots (header facts, cached by mapfiles), roots that are blocked or missing skipped.
pub fn list(roots: &[PathBuf]) -> Vec<MapMeta> {
    let mut out = vec![];
    for r in roots {
        if !r.is_dir() || crate::fsx::blocked(r) {
            continue;
        }
        out.extend(mapfiles::list_maps(r, MAX_LIST));
    }
    out
}

/// The newest file with this UID (a map saved twice: the one last written).
pub fn find(roots: &[PathBuf], uid: &str) -> Option<String> {
    let uid = uid.trim();
    if uid.is_empty() {
        return None;
    }
    let mut hits: Vec<(Option<std::time::SystemTime>, String)> = list(roots)
        .into_iter()
        .filter(|m| m.uid == uid)
        .map(|m| (std::fs::metadata(&m.path).and_then(|x| x.modified()).ok(), m.path))
        .collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.into_iter().next().map(|(_, p)| p)
}

/// The whole file of a map: refused unless the name and the header class say map, and it is not too big.
pub fn read_map(path: &Path) -> Result<Vec<u8>, String> {
    crate::fsx::check(path)?;
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_MAP_BYTES {
        return Err("too big for a map".into());
    }
    let name = path.to_string_lossy();
    if !name.to_ascii_lowercase().ends_with(".gbx") {
        return Err("not a .Gbx file".into());
    }
    let head = mapfiles::read_head(path)?;
    let info = crate::gbx::parse(&head)?;
    if !mapfiles::is_map_class(info.class_id) {
        return Err("not a map".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

pub mod cmd {
    use super::*;
    use crate::state::AppState;
    use tauri::State;

    fn roots_for(st: &AppState, family: &str) -> Vec<PathBuf> {
        let docs = crate::platform::documents_dir();
        map_roots(family, docs.as_deref(), &|g| st.install_dir(g))
    }

    /// Bytes of a local map, as an ArrayBuffer on the JS side.
    #[tauri::command]
    pub async fn map_inspect_bytes(path: String) -> Result<tauri::ipc::Response, String> {
        let bytes = tauri::async_runtime::spawn_blocking(move || read_map(Path::new(&path))).await.map_err(|e| e.to_string())??;
        Ok(tauri::ipc::Response::new(bytes))
    }

    /// Path of the local file of a map by UID (Statistics rows), None = not in the map folders.
    #[tauri::command]
    pub async fn map_inspect_find(st: State<'_, AppState>, family: String, uid: String) -> Result<Option<String>, String> {
        let Some(f) = family_of(&family) else { return Ok(None) };
        let roots = roots_for(&st, f);
        Ok(crate::bg::run(move || find(&roots, &uid)).await)
    }

    /// The player's maps of a game (or family), header facts only.
    #[tauri::command]
    pub async fn map_inspect_list(st: State<'_, AppState>, game: String) -> Result<Vec<MapMeta>, String> {
        let Some(f) = family_of(&game) else { return Ok(vec![]) };
        let roots = roots_for(&st, f);
        Ok(crate::bg::run(move || list(&roots)).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_and_roots() {
        assert_eq!(family_of("tmnf"), Some("forever"));
        assert_eq!(family_of("tm2-canyon"), Some("maniaplanet"));
        assert_eq!(family_of("tm-sunrise"), Some("tm-sunrise"));
        assert_eq!(family_of("nope"), None);
        let d = Path::new("D");
        assert_eq!(map_roots("forever", Some(d), &|_| None), vec![d.join("TrackMania").join("Tracks").join("Challenges")]);
        assert_eq!(map_roots("tm-sunrise", Some(d), &|g| (g == "tm-sunrise").then(|| PathBuf::from("G"))), vec![PathBuf::from("G").join("GameData").join("Tracks").join("Challenges")]);
        assert!(map_roots("tm-original", Some(d), &|_| None).is_empty());
    }

    #[test]
    fn finds_by_uid_and_reads_only_maps() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("Challenges");
        std::fs::create_dir_all(root.join("My Challenges")).unwrap();
        let a = root.join("My Challenges").join("A.Challenge.Gbx");
        std::fs::write(&a, mapfiles::tests::map_bytes("A", "me", 30000)).unwrap();
        let rep = root.join("R.Replay.Gbx");
        std::fs::write(&rep, mapfiles::tests::replay_bytes()).unwrap();
        let listed = list(&[root.clone(), t.path().join("missing")]);
        assert_eq!(listed.len(), 1);
        let uid = listed[0].uid.clone();
        assert!(!uid.is_empty());
        assert_eq!(find(&[root.clone()], &uid).as_deref(), Some(a.to_string_lossy().as_ref()));
        assert_eq!(find(&[root.clone()], "other"), None);
        assert_eq!(find(&[root.clone()], ""), None);
        assert!(read_map(&a).unwrap().starts_with(b"GBX"));
        assert!(read_map(&rep).is_err());
        let txt = root.join("x.txt");
        std::fs::write(&txt, b"GBX").unwrap();
        assert!(read_map(&txt).is_err());
    }
}
