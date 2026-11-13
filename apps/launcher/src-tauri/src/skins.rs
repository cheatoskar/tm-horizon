//! ManiaPark (maniapark.com, by the Mania Exchange team) inside the launcher: car skins, car
//! models and texture mods, saved into the selected game's skin folders.
//!
//! ManiaPark downloads are `https://maniapark.com/{skin|model|mod|...}/{AssetId}/download`,
//! always a .zip (Content-Disposition gives the name). The Mania Exchange API does not cover
//! ManiaPark (it has only the site's own /api/search), so the embedded page is the store.
//!
//! | Game | Skins and models | Texture mods |
//! |---|---|---|
//! | Nations / United Forever | Documents\TrackMania\Skins\Vehicles\CarCommon | Documents\TrackMania\Skins\<Env>\Mod (Stadium, or the environment named in the file) |
//! | ManiaPlanet titles | Documents\ManiaPlanet\Skins\Models\<StadiumCar/CanyonCar/ValleyCar/LagoonCar/ArenaPlayer> | Documents\ManiaPlanet\Skins\<Stadium/Canyon/Valley/Lagoon/Storm>\Mod |
//! | Trackmania (2020) | <Trackmania user folder>\Skins\Models\CarSport | <Trackmania user folder>\Skins\Stadium\Mod (not confirmed) |
//! Car folder for Forever: CarCommon (confirmed on this PC, works for every car); ManiaPark has
//! no car field for skins. Game modes, map types and objects are left to the Downloads folder.

use crate::maps;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SkinKind {
    Skin,
    Mod,
}

impl SkinKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkinKind::Skin => "skin",
            SkinKind::Mod => "mod",
        }
    }
}

/// ManiaPark's game filter for a launcher game.
pub fn park_game(game: &str) -> &'static str {
    match game {
        "tm2020" => "trackmania2020",
        g if crate::launch::title_id(g).is_some() => "maniaplanet",
        _ => "trackmania1",
    }
}

pub fn home_url(game: &str) -> String {
    format!("https://maniapark.com/search?view=tiles&asset=2&q=game%3a{}", park_game(game))
}

pub fn park_host(host: &str) -> bool {
    let h = host.to_lowercase();
    h == "maniapark.com" || h.ends_with(".maniapark.com")
}

/// Asset type from a ManiaPark URL path: /skin/<id>/download -> "skin".
pub fn asset_type(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    if !park_host(u.host_str()?) {
        return None;
    }
    u.path_segments()?.next().map(|s| s.to_lowercase())
}

const FOREVER_ENVS: [(&str, &[&str]); 7] = [
    ("Stadium", &["stadium"]),
    ("Coast", &["coast"]),
    ("Bay", &["bay"]),
    ("Island", &["island"]),
    ("Rally", &["rally"]),
    ("Alpine", &["alpine", "snow"]),
    ("Speed", &["speed", "desert"]),
];

/// Environment named in a file name, Stadium otherwise.
pub fn forever_env(name: &str) -> &'static str {
    let l = name.to_lowercase();
    FOREVER_ENVS.iter().find(|(_, keys)| keys.iter().any(|k| l.contains(k))).map(|(e, _)| *e).unwrap_or("Stadium")
}

pub fn mp_env_car(game: &str) -> (&'static str, &'static str) {
    match game {
        "tm2-canyon" => ("Canyon", "CanyonCar"),
        "tm2-valley" => ("Valley", "ValleyCar"),
        "tm2-lagoon" => ("Lagoon", "LagoonCar"),
        "sm-storm" => ("Storm", "ArenaPlayer"),
        _ => ("Stadium", "StadiumCar"),
    }
}

pub fn target_dir(game: &str, kind: SkinKind, name: &str, docs: &Path) -> Option<PathBuf> {
    Some(match (crate::launch::family(game)?, kind) {
        (crate::launch::Family::Forever, SkinKind::Skin) => docs.join("TrackMania").join("Skins").join("Vehicles").join("CarCommon"),
        (crate::launch::Family::Forever, SkinKind::Mod) => docs.join("TrackMania").join("Skins").join(forever_env(name)).join("Mod"),
        (crate::launch::Family::ManiaPlanet, SkinKind::Skin) => docs.join("ManiaPlanet").join("Skins").join("Models").join(mp_env_car(game).1),
        (crate::launch::Family::ManiaPlanet, SkinKind::Mod) => docs.join("ManiaPlanet").join("Skins").join(mp_env_car(game).0).join("Mod"),
        (crate::launch::Family::Tm2020, SkinKind::Skin) => maps::tm2020_user_dir(docs).join("Skins").join("Models").join("CarSport"),
        (crate::launch::Family::Tm2020, SkinKind::Mod) => maps::tm2020_user_dir(docs).join("Skins").join("Stadium").join("Mod"),
        _ => return None,
    })
}

/// Every folder `target_dir` can write to for `game` (Forever: CarCommon and each environment's Mod
/// folder), with the kind and a short label (car or environment). The installed list (skinlib.rs) reads these.
pub fn all_dirs(game: &str, docs: &Path) -> Vec<(SkinKind, &'static str, PathBuf)> {
    let Some(fam) = crate::launch::family(game) else { return vec![] };
    let mut out = vec![];
    match fam {
        crate::launch::Family::Forever => {
            out.push((SkinKind::Skin, "CarCommon", docs.join("TrackMania").join("Skins").join("Vehicles").join("CarCommon")));
            for (env, _) in FOREVER_ENVS {
                out.push((SkinKind::Mod, env, docs.join("TrackMania").join("Skins").join(env).join("Mod")));
            }
        }
        crate::launch::Family::ManiaPlanet | crate::launch::Family::Tm2020 => {
            let (env, car) = if fam == crate::launch::Family::Tm2020 { ("Stadium", "CarSport") } else { mp_env_car(game) };
            for (kind, label) in [(SkinKind::Skin, car), (SkinKind::Mod, env)] {
                if let Some(d) = target_dir(game, kind, "", docs) {
                    out.push((kind, label, d));
                }
            }
        }
        _ => {}
    }
    out
}

/// ManiaPark asset type and id from a download link: `https://maniapark.com/skin/<id>/download`.
pub fn park_asset(url: &str) -> Option<(String, String)> {
    let u = url::Url::parse(url).ok()?;
    if !park_host(u.host_str()?) {
        return None;
    }
    let mut seg = u.path_segments()?;
    let kind = seg.next()?.to_lowercase();
    let id = seg.next()?.to_string();
    (!id.is_empty() && matches!(kind.as_str(), "skin" | "model" | "mod")).then_some((kind, id))
}

pub fn kind_of_path(p: &Path) -> Option<&'static str> {
    let s = crate::fsx::norm(p);
    if s.contains("\\mod\\") {
        Some("mod")
    } else if s.contains("\\skins\\") {
        Some("skin")
    } else {
        None
    }
}

/// Where a ManiaPark download goes. None = not a skin/model/mod zip.
pub fn route(game: &str, url: &str, _page: &str, name: &str, docs: &Path, _install: Option<&Path>) -> Option<(SkinKind, PathBuf)> {
    let kind = match asset_type(url)?.as_str() {
        "skin" | "model" => SkinKind::Skin,
        "mod" => SkinKind::Mod,
        _ => return None,
    };
    let name = maps::sanitize(name);
    if !name.to_lowercase().ends_with(".zip") {
        return None;
    }
    let dir = target_dir(game, kind, &name, docs)?;
    if crate::fsx::blocked(&dir) {
        return None;
    }
    let _ = std::fs::create_dir_all(&dir);
    Some((kind, maps::unique_path(&dir, &name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_maniapark_downloads() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        let skin = "https://maniapark.com/skin/31K6V4niZ0O34kPSZXQOyQ/download";
        let model = "https://maniapark.com/model/abc/download";
        let m = "https://maniapark.com/mod/xyz/download";
        assert_eq!(route("tmuf", skin, "", "BathRacer.zip", d, None).unwrap(), (SkinKind::Skin, d.join("TrackMania/Skins/Vehicles/CarCommon/BathRacer.zip")));
        assert_eq!(route("tmnf", model, "", "Car.zip", d, None).unwrap().1, d.join("TrackMania/Skins/Vehicles/CarCommon/Car.zip"));
        assert_eq!(route("tmuf", m, "", "Coast Summer.zip", d, None).unwrap().1, d.join("TrackMania/Skins/Coast/Mod/Coast Summer.zip"));
        assert_eq!(route("tmnf", m, "", "Clean.zip", d, None).unwrap().1, d.join("TrackMania/Skins/Stadium/Mod/Clean.zip"));
        assert_eq!(route("tm2-canyon", skin, "", "X.zip", d, None).unwrap().1, d.join("ManiaPlanet/Skins/Models/CanyonCar/X.zip"));
        assert_eq!(route("tm2-valley", m, "", "V.zip", d, None).unwrap().1, d.join("ManiaPlanet/Skins/Valley/Mod/V.zip"));
        assert_eq!(route("tm2020", skin, "", "S.zip", d, None).unwrap().1, d.join("Trackmania/Skins/Models/CarSport/S.zip"));
        assert_eq!(route("tmuf", "https://maniapark.com/gamemode/q/download", "", "G.zip", d, None), None);
        assert_eq!(route("tmuf", "https://evil.example/skin/q/download", "", "G.zip", d, None), None);
    }

    #[test]
    fn park_urls() {
        assert_eq!(home_url("tmnf"), "https://maniapark.com/search?view=tiles&asset=2&q=game%3atrackmania1");
        assert_eq!(park_game("tm2-stadium"), "maniaplanet");
        assert_eq!(forever_env("Snow pack"), "Alpine");
    }
}
