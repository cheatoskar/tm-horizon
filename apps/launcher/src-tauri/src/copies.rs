//! Game copies: every place a game keeps its own replays and maps, for statistics and play time.
//!
//! - Forever (TMNF/TMUF): one copy per user folder. An install's Nadeo.ini picks it
//!   (`UserSubDir=TrackMania` = Documents\TrackMania, the default); TM Horizon's instances use
//!   `TrackMania_<id>`. Installs that share a user folder are one copy.
//! - ManiaPlanet: Documents\ManiaPlanet, instances `ManiaPlanet_<id>`.
//! - Trackmania (2020): its Documents folder.
//! - ESWC, Sunrise, Original: every install folder and every instance is a copy (they keep their
//!   data in `GameData` next to the exe).
//!
//! A copy's id is its normalised data folder, so it stays the same between runs.

use crate::fsx;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameCopy {
    pub id: String,
    /// stats::FAMILIES
    pub family: &'static str,
    pub label: String,
    /// Folder with the copy's Tracks (Forever, legacy) or Replays/Maps (ManiaPlanet, Trackmania).
    pub data: String,
    /// Game folders that write into this copy, with their game id.
    pub dirs: Vec<(String, String)>,
    pub instance: Option<String>,
    /// The copy older play time without a copy belongs to (Documents folder, or the install Play starts).
    pub main: bool,
}

/// One game folder known to the launcher.
#[derive(Debug, Clone)]
pub struct Install {
    pub game: String,
    pub dir: PathBuf,
    pub label: String,
    /// TM Horizon instance id.
    pub instance: Option<String>,
    /// Instance user folder (Nadeo.ini value the instance was built with).
    pub user_dir: Option<String>,
    /// The install Play starts for this game.
    pub selected: bool,
}

/// `UserSubDir` of a Forever install's Nadeo.ini (None = not set, the game uses "TrackMania").
pub fn forever_user_sub(dir: &Path) -> Option<String> {
    let text = fsx::read_string(&dir.join("Nadeo.ini"))?;
    let mut in_section = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_section = l.eq_ignore_ascii_case("[TmForever]");
            continue;
        }
        if in_section {
            if let Some((k, v)) = l.split_once('=') {
                if k.trim().eq_ignore_ascii_case("UserSubDir") {
                    let v = v.trim();
                    // A plain folder name under Documents only.
                    return (!v.is_empty() && !v.contains(['\\', '/', ':', '{', '.'])).then(|| v.to_string());
                }
            }
        }
    }
    None
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

/// All copies. `user_sub` reads a Forever install's user folder name (Nadeo.ini; a fake in tests).
pub fn build(docs: Option<&Path>, installs: &[Install], user_sub: &dyn Fn(&Path) -> Option<String>) -> Vec<GameCopy> {
    let mut out: Vec<GameCopy> = vec![];
    let mut add = |family: &'static str, data: PathBuf, label: String, dir: Option<(&Path, &str)>, instance: Option<String>, main: bool| {
        let id = fsx::norm(&data);
        let d = dir.map(|(p, g)| (fsx::norm(p), g.to_string()));
        if let Some(c) = out.iter_mut().find(|c| c.id == id) {
            if let Some(d) = d {
                if !c.dirs.contains(&d) {
                    c.dirs.push(d);
                }
            }
            c.main |= main;
            return;
        }
        out.push(GameCopy { id, family, label, data: data.to_string_lossy().into_owned(), dirs: d.into_iter().collect(), instance, main });
    };
    if let Some(d) = docs {
        add("forever", d.join("TrackMania"), "Documents\\TrackMania".into(), None, None, true);
        add("maniaplanet", d.join("ManiaPlanet"), "Documents\\ManiaPlanet".into(), None, None, true);
        // Forever and Trackmania (2020) can share Documents\TrackMania; then only Forever reads it.
        let t20 = crate::maps::tm2020_user_dir(d);
        if fsx::norm(&t20) != fsx::norm(&d.join("TrackMania")) {
            add("tm2020", t20, "Trackmania".into(), None, None, true);
        }
    }
    for i in installs {
        let Some(fam) = crate::stats::family_of(&i.game) else { continue };
        match fam {
            "forever" => {
                let Some(d) = docs else { continue };
                let sub = match (&i.instance, &i.user_dir) {
                    (Some(_), Some(u)) if !u.contains(['\\', '/', ':', '{']) => Some(u.clone()),
                    _ => user_sub(&i.dir),
                }
                .unwrap_or_else(|| "TrackMania".into());
                let main = sub.eq_ignore_ascii_case("TrackMania");
                let label = if main { "Documents\\TrackMania".to_string() } else { i.label.clone() };
                add("forever", d.join(&sub), label, Some((&i.dir, &i.game)), i.instance.clone(), main);
            }
            "maniaplanet" => {
                let Some(d) = docs else { continue };
                // Instances: UserDir={userdocs}\ManiaPlanet_<id>.
                let sub = i.user_dir.as_deref().and_then(|u| u.rsplit('\\').next()).filter(|s| !s.is_empty() && !s.contains(['{', ':', '/'])).unwrap_or("ManiaPlanet").to_string();
                let main = sub.eq_ignore_ascii_case("ManiaPlanet");
                let label = if main { "Documents\\ManiaPlanet".to_string() } else { i.label.clone() };
                add("maniaplanet", d.join(&sub), label, Some((&i.dir, "maniaplanet")), i.instance.clone(), main);
            }
            "tm2020" => {
                let Some(d) = docs else { continue };
                let t20 = crate::maps::tm2020_user_dir(d);
                if fsx::norm(&t20) != fsx::norm(&d.join("TrackMania")) {
                    add("tm2020", t20, "Trackmania".into(), Some((&i.dir, "tm2020")), None, true);
                }
            }
            f => {
                if fsx::blocked(&i.dir) {
                    continue;
                }
                let label = if i.instance.is_some() { i.label.clone() } else { name_of(&i.dir) };
                add(f, i.dir.join("GameData"), label, Some((&i.dir, &i.game)), i.instance.clone(), i.selected && i.instance.is_none());
            }
        }
    }
    // Legacy games without a selected install: their first install counts as the main copy.
    for f in ["tmn-eswc", "tm-sunrise", "tm-original"] {
        if !out.iter().any(|c| c.family == f && c.main) {
            if let Some(c) = out.iter_mut().find(|c| c.family == f && c.instance.is_none()) {
                c.main = true;
            }
        }
    }
    out
}

/// The copy a running exe belongs to: the one whose game folders hold it. (copy id, game id)
pub fn of_exe(copies: &[GameCopy], exe: &Path) -> Option<(String, String)> {
    let dir = fsx::norm(exe.parent()?);
    copies.iter().find_map(|c| c.dirs.iter().find(|(d, _)| *d == dir).map(|(_, g)| (c.id.clone(), g.clone())))
}

/// The copy that play time of `key` (game id or `game@instance`) without a recorded copy belongs to.
pub fn of_key<'a>(copies: &'a [GameCopy], key: &str) -> Option<&'a GameCopy> {
    let (game, inst) = match key.split_once('@') {
        Some((g, i)) => (g, Some(i)),
        None => (key, None),
    };
    let fam = crate::stats::family_of(game)?;
    match inst {
        Some(i) => copies.iter().find(|c| c.instance.as_deref() == Some(i)),
        None => copies.iter().find(|c| c.family == fam && c.main),
    }
}

/// Every install and instance the launcher knows (last scan + instances).
pub fn installs(st: &crate::state::AppState) -> Vec<Install> {
    let mut out = vec![];
    let selected = st.settings().selected_install;
    if let Some(s) = st.snapshot.lock().unwrap().as_ref() {
        let g = &s.games;
        let lists: [(&str, &Vec<crate::scan::InstallInfo>); 7] = [
            ("tmnf", &g.tmnf.installs),
            ("tmuf", &g.tmuf.installs),
            ("tmn-eswc", &g.eswc.installs),
            ("tm-sunrise", &g.sunrise.installs),
            ("tm-original", &g.original.installs),
            ("maniaplanet", &g.maniaplanet.installs),
            ("tm2020", &g.tm2020.installs),
        ];
        for (game, list) in lists {
            let picked = crate::state::pick_install(list, selected.get(game).map(String::as_str)).map(|i| i.path.clone());
            for i in list.iter().filter(|i| !i.path.is_empty()) {
                out.push(Install { game: game.into(), dir: PathBuf::from(&i.path), label: name_of(Path::new(&i.path)), instance: None, user_dir: None, selected: picked.as_deref() == Some(i.path.as_str()) });
            }
        }
    }
    for i in crate::instances::list(&st.data_dir) {
        let game = if crate::launch::title_id(&i.game).is_some() { "maniaplanet".to_string() } else { i.game.clone() };
        out.push(Install { game, dir: PathBuf::from(&i.path), label: i.name.clone(), instance: Some(i.id.clone()), user_dir: i.user_dir.clone(), selected: false });
    }
    out
}

/// The copies of this PC.
pub fn all(st: &crate::state::AppState) -> Vec<GameCopy> {
    let docs = crate::platform::documents_dir();
    build(docs.as_deref(), &installs(st), &forever_user_sub)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst(game: &str, dir: &str, instance: Option<&str>, user_dir: Option<&str>, selected: bool) -> Install {
        Install { game: game.into(), dir: PathBuf::from(dir), label: instance.map(|i| format!("Inst {i}")).unwrap_or_else(|| name_of(Path::new(dir))), instance: instance.map(String::from), user_dir: user_dir.map(String::from), selected }
    }

    #[test]
    fn copies_per_user_folder_and_install() {
        let docs = Path::new("C:/Users/me/Documents");
        let list = vec![
            inst("tmnf", "C:/Games/TMNF", None, None, true),
            inst("tmuf", "C:/Games/TMUF", None, None, true),
            inst("tmuf", "C:/Games/TMUF-test", None, None, false),
            inst("tmnf", "C:/inst/a", Some("a"), Some("TrackMania_a"), false),
            inst("tmn-eswc", "C:/Games/ESWC", None, None, false),
            inst("tmn-eswc", "C:/Games/ESWC-next", None, None, true),
            inst("tm-sunrise", "C:/Games/TMS", None, None, false),
            inst("tm-sunrise", "C:/inst/s", Some("s"), None, false),
            inst("maniaplanet", "C:/MP", None, None, false),
        ];
        // TMUF-test has its own user folder in Nadeo.ini.
        let sub = |d: &Path| (d.ends_with("TMUF-test")).then(|| "TrackMania_test".to_string());
        let c = build(Some(docs), &list, &sub);
        let fam = |f: &str| c.iter().filter(|x| x.family == f).count();
        assert_eq!(fam("forever"), 3, "{c:#?}");
        assert_eq!(fam("tmn-eswc"), 2);
        assert_eq!(fam("tm-sunrise"), 2);
        let main = c.iter().find(|x| x.family == "forever" && x.main).unwrap();
        assert_eq!(main.dirs.len(), 2, "TMNF and TMUF share Documents\\TrackMania");
        assert!(c.iter().any(|x| x.instance.as_deref() == Some("a") && x.data.ends_with("TrackMania_a")));
        // The selected ESWC install is the main copy; Sunrise without a selection: its first install.
        assert!(c.iter().find(|x| x.label == "ESWC-next").unwrap().main);
        assert!(!c.iter().find(|x| x.label == "ESWC").unwrap().main);
        assert!(c.iter().find(|x| x.label == "TMS").unwrap().main);
        // Exes map to their copy and game.
        let (id, g) = of_exe(&c, Path::new("C:/Games/TMUF-test/TmForever.exe")).unwrap();
        assert_eq!(g, "tmuf");
        assert!(id.ends_with("trackmania_test"), "{id}");
        assert_eq!(of_exe(&c, Path::new("C:/inst/s/TmSunrise.exe")).unwrap().1, "tm-sunrise");
        assert!(of_exe(&c, Path::new("D:/other/TmForever.exe")).is_none());
        // Keys without a copy.
        assert_eq!(of_key(&c, "tmnf").unwrap().id, main.id);
        assert_eq!(of_key(&c, "tmnf@a").unwrap().instance.as_deref(), Some("a"));
        assert_eq!(of_key(&c, "tmn-eswc").unwrap().label, "ESWC-next");
    }

    #[test]
    fn nadeo_ini_user_folder() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(forever_user_sub(t.path()), None);
        std::fs::write(t.path().join("Nadeo.ini"), "[TmForever]\r\nVersion=2.11.26\r\nUserSubDir=TrackMania_x\r\n").unwrap();
        assert_eq!(forever_user_sub(t.path()).as_deref(), Some("TrackMania_x"));
        std::fs::write(t.path().join("Nadeo.ini"), "[Other]\nUserSubDir=Nope\n[TmForever]\nUserSubDir=..\\evil\n").unwrap();
        assert_eq!(forever_user_sub(t.path()), None);
    }
}
