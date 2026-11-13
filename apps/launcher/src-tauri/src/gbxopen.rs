//! The ".Gbx open with" dialog: a map or replay double-clicked in Explorer (fileassoc.rs) or handed
//! to TM Horizon otherwise. The file's header tells which game it is for (gbx.rs), the dialog lists
//! the installed copies of those games, and "Open in <copy>" copies the file into that copy's
//! `Downloaded` folder and starts it the way TMX "Play" does (commands::open_map_in).
//!
//! Which game: the header XML's `exever` (3.x = ManiaPlanet / Trackmania, `exebld` from 2020-07 on =
//! Trackmania 2020; 2.11 = Forever) and the environment (Stadium = Nations ESWC or Forever; Island,
//! Coast, Bay = Sunrise or United; Desert/Speed, Snow/Alpine, Rally = Original or United). The first
//! game is the best guess; Forever opens the older maps too.

use crate::{fsx, gbx, maps};
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 64 << 20;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    /// "map" | "replay"
    pub kind: String,
    pub uid: Option<String>,
    pub name: Option<String>,
    pub author: Option<String>,
    pub env: Option<String>,
    pub time_ms: Option<u32>,
    pub exever: Option<String>,
    /// Launcher game ids, best guess first.
    pub games: Vec<String>,
    /// data: URL (maps; upside down as TrackMania stores it).
    pub thumbnail: Option<String>,
}

/// The header XML of a map (chunk 0x...005), None when there is none.
pub fn map_xml(data: &[u8]) -> Option<String> {
    let mut p = 3usize;
    let u16_at = |p: usize| data.get(p..p + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |p: usize| data.get(p..p + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if data.get(..3)? != b"GBX" {
        return None;
    }
    let version = u16_at(p)?;
    p += 2;
    if !(3..=6).contains(&version) || *data.get(p)? != b'B' {
        return None;
    }
    p += if version >= 4 { 4 } else { 3 };
    p += 4; // class id
    let user = u32_at(p)? as usize;
    p += 4;
    if user == 0 {
        return None;
    }
    let count = u32_at(p)?;
    p += 4;
    if count > 64 {
        return None;
    }
    let mut table = vec![];
    for _ in 0..count {
        table.push((u32_at(p)?, (u32_at(p + 4)? & 0x7FFF_FFFF) as usize));
        p += 8;
    }
    for (id, size) in table {
        let raw = data.get(p..p.checked_add(size)?)?;
        p += size;
        if id & 0x00FF_FFFF == 0x043005 || id & 0x00FF_FFFF == 0x003005 {
            let len = u32::from_le_bytes(raw.get(..4)?.try_into().ok()?) as usize;
            return raw.get(4..4usize.checked_add(len)?).map(|b| String::from_utf8_lossy(b).into_owned());
        }
    }
    None
}

fn attr(xml: &str, tag: &str, key: &str) -> Option<String> {
    gbx::xml_attr(xml, tag, key).filter(|v| !v.is_empty())
}

/// Games a file is for, best first (see the module notes).
pub fn games_for(env: Option<&str>, exever: Option<&str>, exebld: Option<&str>, title: Option<&str>) -> Vec<&'static str> {
    let env = env.unwrap_or("").to_lowercase();
    let v = exever.unwrap_or("");
    if v.starts_with('3') {
        let t = title.unwrap_or("").to_lowercase();
        if exebld.is_some_and(|b| b >= "2020-07") {
            return vec!["tm2020"];
        }
        let title_env = if t.contains("canyon") { "canyon" } else if t.contains("valley") { "valley" } else if t.contains("lagoon") { "lagoon" } else if t.contains("storm") { "storm" } else { env.as_str() };
        return match title_env {
            "canyon" => vec!["tm2-canyon"],
            "valley" => vec!["tm2-valley"],
            "lagoon" => vec!["tm2-lagoon"],
            "storm" => vec!["sm-storm"],
            _ => vec!["tm2-stadium"],
        };
    }
    let forever = v.starts_with("2.11");
    match env.as_str() {
        "stadium" if forever => vec!["tmnf", "tmuf"],
        "stadium" => vec!["tmn-eswc", "tmnf", "tmuf"],
        "island" | "coast" | "bay" if forever => vec!["tmuf"],
        "island" | "coast" | "bay" => vec!["tm-sunrise", "tmuf"],
        "desert" | "speed" | "snow" | "alpine" | "rally" if forever => vec!["tmuf"],
        "desert" | "speed" | "snow" | "alpine" | "rally" => vec!["tm-original", "tmuf"],
        _ => vec![],
    }
}

/// Reads the header of a map or replay.
pub fn detect(bytes: &[u8]) -> Result<Detected, String> {
    if let Some(h) = gbx::replay_head(bytes) {
        let xml = gbx::replay_xml(bytes).unwrap_or_default();
        let exever = attr(&xml, "header", "exever");
        let games = games_for(h.environment.as_deref(), exever.as_deref(), attr(&xml, "header", "exebld").as_deref(), attr(&xml, "header", "title").as_deref());
        return Ok(Detected {
            kind: "replay".into(),
            uid: h.uid,
            name: attr(&xml, "map", "name").or_else(|| attr(&xml, "challenge", "name")),
            author: h.nickname.or(h.login),
            env: h.environment,
            time_ms: h.time_ms.or_else(|| attr(&xml, "times", "best").and_then(|t| t.parse().ok())).filter(|t| *t > 0 && *t != u32::MAX),
            exever,
            games: games.into_iter().map(String::from).collect(),
            thumbnail: None,
        });
    }
    let i = gbx::parse(bytes)?;
    let xml = map_xml(bytes).unwrap_or_default();
    let exever = attr(&xml, "header", "exever");
    let games = games_for(i.environment.as_deref(), exever.as_deref(), attr(&xml, "header", "exebld").as_deref(), attr(&xml, "header", "title").as_deref());
    if i.uid.is_none() && i.environment.is_none() {
        return Err("Not a map or replay".into());
    }
    Ok(Detected { kind: "map".into(), uid: i.uid, name: i.name, author: i.author, env: i.environment, time_ms: i.author_time, exever, games: games.into_iter().map(String::from).collect(), thumbnail: i.thumbnail })
}

/// One place the file can be opened.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub game: String,
    pub label: String,
    pub dir: String,
    pub instance: Option<String>,
    /// The install Play starts for this game.
    pub main: bool,
}

/// The copies of `games` on this PC (installs and instances; StarForce ESWC never).
pub fn choices(st: &crate::state::AppState, games: &[String]) -> Vec<Choice> {
    let mut out = vec![];
    let insts = crate::instances::list(&st.data_dir);
    for g in games {
        let main = st.install(g).map(|i| fsx::norm(Path::new(&i.path)));
        let mut list = crate::horizoncmds::installs_of(st, g);
        if list.is_empty() {
            list.extend(st.install(g));
        }
        for i in list {
            if i.path.is_empty() || fsx::blocked(Path::new(&i.path)) || i.exe.is_none() {
                continue;
            }
            let n = fsx::norm(Path::new(&i.path));
            out.push(Choice { game: g.clone(), label: Path::new(&i.path).file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(), main: main.as_deref() == Some(n.as_str()), dir: i.path, instance: None });
        }
        for i in insts.iter().filter(|i| i.game == *g || (crate::launch::title_id(g).is_some() && crate::launch::title_id(&i.game).is_some() && g == &i.game)) {
            out.push(Choice { game: g.clone(), label: i.name.clone(), dir: i.path.clone(), instance: Some(i.id.clone()), main: false });
        }
    }
    out
}

/// The copy's `Downloaded` folder for maps or replays, and its user folder (allowed for open_map).
pub fn target_dir(game: &str, replay: bool, docs: &Path, dir: &Path, user_dir: Option<&str>) -> Option<(PathBuf, Option<PathBuf>)> {
    let (maps_name, reps) = ("Maps", "Replays");
    match game {
        "tmnf" | "tmuf" => {
            let sub = user_dir.filter(|u| !u.contains(['\\', '/', ':', '{'])).map(String::from).or_else(|| crate::copies::forever_user_sub(dir)).unwrap_or_else(|| "TrackMania".into());
            let user = docs.join(&sub);
            Some((user.join("Tracks").join(if replay { reps } else { "Challenges" }).join("Downloaded"), Some(user)))
        }
        "tmn-eswc" | "tm-sunrise" | "tm-original" => Some((dir.join("GameData").join("Tracks").join(if replay { reps } else { "Challenges" }).join("Downloaded"), None)),
        "tm2020" => {
            let u = maps::tm2020_user_dir(docs);
            Some((u.join(if replay { reps } else { maps_name }).join("Downloaded"), None))
        }
        g if crate::launch::title_id(g).is_some() => {
            let sub = user_dir.and_then(|u| u.rsplit('\\').next()).filter(|s| !s.is_empty() && !s.contains(['{', ':', '/'])).unwrap_or("ManiaPlanet").to_string();
            let user = docs.join(&sub);
            Some((user.join(if replay { reps } else { maps_name }).join("Downloaded"), Some(user)))
        }
        _ => None,
    }
}

/// Copies `src` into `dir` (kept as it is when it already lies there). Returns the file to open.
pub fn place(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    if fsx::resolve(src).zip(fsx::resolve(dir)).is_some_and(|(s, d)| fsx::is_inside(&s, &d)) {
        return Ok(src.to_path_buf());
    }
    if fsx::blocked(dir) {
        return Err("Refusing to write there".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let name = maps::sanitize(&src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    // The same file there already: no second copy.
    let same = dir.join(&name);
    let bytes = std::fs::read(src).map_err(|e| e.to_string())?;
    if std::fs::read(&same).is_ok_and(|b| b == bytes) {
        return Ok(same);
    }
    let dest = maps::unique_path(dir, &name);
    fsx::write(&dest, &bytes)?;
    Ok(dest)
}

fn check_src(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let kind = maps::gbx_kind(&p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    if !matches!(kind, Some(maps::GbxKind::Map | maps::GbxKind::Replay | maps::GbxKind::Other)) || fsx::blocked(&p) || !p.is_file() {
        return Err("Not a .Gbx file".into());
    }
    if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_FILE {
        return Err("The file is too big".into());
    }
    Ok(p)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInfo {
    pub path: String,
    pub file: String,
    pub detected: Detected,
    pub choices: Vec<Choice>,
}

#[tauri::command]
pub async fn gbx_open_info(app: tauri::AppHandle, path: String) -> Result<OpenInfo, String> {
    crate::bg::run(move || -> Result<OpenInfo, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let p = check_src(&path)?;
        let bytes = fsx::read_bytes_prefix(&p, 8 << 20).ok_or("Cannot read the file")?;
        let d = detect(&bytes)?;
        let choices = choices(&st, &d.games);
        Ok(OpenInfo { file: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path, detected: d, choices })
    })
    .await
}

/// Files a second start handed over (Explorer double-click while TM Horizon runs), for the dialog.
#[tauri::command(async)]
pub fn take_pending_files(st: tauri::State<crate::state::AppState>) -> Vec<String> {
    std::mem::take(&mut *st.pending_files.lock().unwrap())
}

/// "Open in <copy>": the file goes into that copy's Downloaded folder, then the game opens it.
#[tauri::command]
pub async fn gbx_open_in(app: tauri::AppHandle, path: String, game: String, dir: String, instance: Option<String>) -> crate::commands::ActionResult {
    crate::bg::run(move || -> crate::commands::ActionResult {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let r = (|| -> Result<(String, crate::scan::InstallInfo, PathBuf, Option<PathBuf>), String> {
            let src = check_src(&path)?;
            let bytes = fsx::read_bytes_prefix(&src, 8 << 20).ok_or("Cannot read the file")?;
            let d = detect(&bytes)?;
            if !d.games.contains(&game) {
                return Err("This file is not for that game".into());
            }
            let c = choices(&st, std::slice::from_ref(&game)).into_iter().find(|c| c.instance == instance && fsx::norm(Path::new(&c.dir)) == fsx::norm(Path::new(&dir))).ok_or("This copy is not known")?;
            let (install, user_dir) = match &c.instance {
                Some(id) => {
                    let i = crate::instances::get(&st.data_dir, id)?;
                    (crate::instances::install_info(&i), i.user_dir.clone())
                }
                None => (crate::horizoncmds::installs_of(&st, &game).into_iter().chain(st.install(&game)).find(|i| fsx::norm(Path::new(&i.path)) == fsx::norm(Path::new(&c.dir))).ok_or("Not installed")?, None),
            };
            let docs = crate::platform::documents_dir().ok_or("Documents folder not found")?;
            let (target, user) = target_dir(&game, d.kind == "replay", &docs, Path::new(&install.path), user_dir.as_deref()).ok_or("No folder for this game")?;
            let dest = place(&src, &target)?;
            Ok((game.clone(), install, dest, user))
        })();
        match r {
            Ok((game, install, dest, user)) => crate::commands::open_map_in(&app, &st, game, None, dest.to_string_lossy().into_owned(), install, &user.into_iter().collect::<Vec<_>>()),
            Err(e) => crate::commands::fail(e),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gbx::tests::replay_sample_run;

    #[test]
    fn which_game() {
        assert_eq!(games_for(Some("Stadium"), Some("2.11.26"), None, None), vec!["tmnf", "tmuf"]);
        assert_eq!(games_for(Some("Stadium"), None, None, None), vec!["tmn-eswc", "tmnf", "tmuf"]);
        assert_eq!(games_for(Some("Bay"), Some("2.0.1"), None, None), vec!["tm-sunrise", "tmuf"]);
        assert_eq!(games_for(Some("Bay"), Some("2.11.26"), None, None), vec!["tmuf"]);
        assert_eq!(games_for(Some("Speed"), None, None, None), vec!["tm-original", "tmuf"]);
        assert_eq!(games_for(Some("Canyon"), Some("3.3.0"), Some("2017-05-31_23_00"), Some("TMCanyon")), vec!["tm2-canyon"]);
        assert_eq!(games_for(Some("Stadium"), Some("3.3.0"), Some("2024-03-19_14_47"), Some("TMStadium")), vec!["tm2020"]);
        assert_eq!(games_for(Some("Stadium"), Some("3.3.0"), Some("2019-11-19_18_50"), Some("TMStadium")), vec!["tm2-stadium"]);
        assert!(games_for(Some("Mars"), None, None, None).is_empty());
    }

    #[test]
    fn replay_and_map_headers() {
        let r = detect(&replay_sample_run("me", "Me", "Stadium", "uidA", 45230)).unwrap();
        assert_eq!((r.kind.as_str(), r.uid.as_deref(), r.time_ms), ("replay", Some("uidA"), Some(45230)));
        assert_eq!(r.games, vec!["tmnf", "tmuf"], "exever 2.11.26 in the sample");
        let bytes = crate::gbx::tests::sample();
        assert!(map_xml(&bytes).unwrap().contains("authortime=\"468200\""));
        let m = detect(&bytes).unwrap();
        assert_eq!((m.kind.as_str(), m.uid.as_deref(), m.env.as_deref()), ("map", Some("U1"), Some("Stadium")));
        assert_eq!(m.games, vec!["tmn-eswc", "tmnf", "tmuf"], "a Stadium map without exever: ESWC first, Forever too");
        assert!(m.thumbnail.is_some());
        assert!(detect(b"GBX nonsense").is_err());
    }

    #[test]
    fn target_folders_and_placing() {
        let docs = Path::new("C:/Users/me/Documents");
        let (d, u) = target_dir("tmuf", false, docs, Path::new("C:/inst/x"), Some("TrackMania_x")).unwrap();
        assert!(d.ends_with("TrackMania_x/Tracks/Challenges/Downloaded"), "{d:?}");
        assert!(u.unwrap().ends_with("TrackMania_x"));
        let (d, _) = target_dir("tm-sunrise", true, docs, Path::new("C:/Games/TMS"), None).unwrap();
        assert!(d.ends_with("TMS/GameData/Tracks/Replays/Downloaded"));
        let (d, _) = target_dir("tm2-canyon", false, docs, Path::new("C:/MP"), Some("{userdocs}\\ManiaPlanet_c")).unwrap();
        assert!(d.ends_with("ManiaPlanet_c/Maps/Downloaded"));
        assert!(target_dir("tm-ds", false, docs, Path::new("C:/x"), None).is_none());

        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("Downloads").join("A01.Challenge.Gbx");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"GBX map").unwrap();
        let dir = t.path().join("Game").join("Downloaded");
        let a = place(&src, &dir).unwrap();
        assert_eq!(a, dir.join("A01.Challenge.Gbx"));
        assert_eq!(place(&src, &dir).unwrap(), a, "the same file is not copied twice");
        std::fs::write(&src, b"GBX map v2").unwrap();
        assert_eq!(place(&src, &dir).unwrap(), dir.join("A01 (2).Challenge.Gbx"));
        assert_eq!(place(&a, &dir).unwrap(), a, "already there: opened where it is");
    }
}
