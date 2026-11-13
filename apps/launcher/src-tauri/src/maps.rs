//! Where a .Gbx downloaded from TMX goes, per game, and which exchange belongs to a game.
//!
//! | Game | Maps | Replays |
//! |---|---|---|
//! | Nations / United Forever | Documents\TrackMania\Tracks\Challenges\Downloaded | ...\Tracks\Replays\Downloaded |
//! | Nations ESWC 1.80 | <game folder>\GameData\Tracks\Challenges\Downloaded (its own data folder, profiles live there too) | ...\GameData\Tracks\Replays\Downloaded |
//! | ManiaPlanet titles | Documents\ManiaPlanet\Maps\Downloaded | Documents\ManiaPlanet\Replays\Downloaded |
//! | Trackmania (2020) | Documents\Trackmania2020\Maps\Downloaded when that folder exists (the game picks it when Forever already owns Documents\TrackMania), else Documents\Trackmania\Maps\Downloaded | ...\Replays\Downloaded |
//! | Sunrise (community repack, installed on my PC) | <game folder>\GameData\Tracks\Challenges\Downloaded | |
//! | Original (not installed on my PC, not checked) | <game folder>\GameData\Tracks\Challenges\Downloaded | |
//!
//! Opening a map: ESWC, Sunrise and Original open it directly with `/file="<map>"` only when their exe
//! has a real `/file` switch (launch.rs `exe_switches`, checked once per exe at runtime). The ESWC 1.80
//! and Sunrise repack exes on my PC have none ("/file" there is only `</file>` in XML), so the map is
//! saved under Downloaded and the game is started.

use std::path::{Path, PathBuf};

pub fn tmx_site(game: &str) -> Option<&'static str> {
    Some(match game {
        "tmnf" => "tmnf.exchange",
        "tmuf" => "tmuf.exchange",
        "tmn-eswc" => "nations.tm-exchange.com",
        "tm-original" => "original.tm-exchange.com",
        "tm-sunrise" => "sunrise.tm-exchange.com",
        "tm2-stadium" | "tm2-canyon" | "tm2-valley" | "tm2-lagoon" => "tm.mania.exchange",
        "sm-storm" => "sm.mania.exchange",
        "tm2020" => "trackmania.exchange",
        _ => return None,
    })
}

/// Hosts that stay inside the embedded TMX view (everything else opens in the browser).
pub fn exchange_host(host: &str) -> bool {
    let h = host.to_lowercase();
    ["tm-exchange.com", "mania.exchange", "mania-exchange.com", "tmnf.exchange", "tmuf.exchange", "trackmania.exchange"]
        .iter()
        .any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

/// Trackmania (2020)'s user folder. On a PC that already has Forever's Documents\TrackMania
/// (Windows names are case-insensitive) the game uses Documents\Trackmania2020.
pub fn tm2020_user_dir(docs: &Path) -> PathBuf {
    let t20 = docs.join("Trackmania2020");
    if t20.is_dir() {
        return t20;
    }
    let tm = docs.join("Trackmania");
    // fsx: case-insensitive on Linux, where Wine sees TrackMania and Trackmania as one folder.
    if crate::fsx::is_dir(&tm.join("Tracks").join("Challenges")) {
        // That is Forever's folder; the game will create Trackmania2020.
        return t20;
    }
    tm
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GbxKind {
    Map,
    Replay,
    Other,
}

pub fn gbx_kind(name: &str) -> Option<GbxKind> {
    let l = name.to_lowercase();
    if !l.ends_with(".gbx") {
        return None;
    }
    Some(if l.ends_with(".challenge.gbx") || l.ends_with(".map.gbx") {
        GbxKind::Map
    } else if l.ends_with(".replay.gbx") {
        GbxKind::Replay
    } else {
        GbxKind::Other
    })
}

/// Target folder for a downloaded .Gbx. `install_dir` is the game's folder (ESWC, legacy).
pub fn download_dir(game: &str, kind: GbxKind, docs: &Path, install_dir: Option<&Path>) -> Option<PathBuf> {
    let replays = kind == GbxKind::Replay;
    Some(match game {
        "tmnf" | "tmuf" => {
            let t = docs.join("TrackMania").join("Tracks");
            if replays {
                t.join("Replays").join("Downloaded")
            } else {
                t.join("Challenges").join("Downloaded")
            }
        }
        "tmn-eswc" | "tm-original" | "tm-sunrise" => {
            let t = install_dir?.join("GameData").join("Tracks");
            if replays {
                t.join("Replays").join("Downloaded")
            } else {
                t.join("Challenges").join("Downloaded")
            }
        }
        "tm2-stadium" | "tm2-canyon" | "tm2-valley" | "tm2-lagoon" | "sm-storm" => {
            let m = docs.join("ManiaPlanet");
            if replays {
                m.join("Replays").join("Downloaded")
            } else {
                m.join("Maps").join("Downloaded")
            }
        }
        "tm2020" => {
            let u = tm2020_user_dir(docs);
            if replays {
                u.join("Replays").join("Downloaded")
            } else {
                u.join("Maps").join("Downloaded")
            }
        }
        _ => return None,
    })
}

/// File name safe for Windows; keeps TrackMania's "$" codes, drops path and reserved chars.
pub fn sanitize(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut s: String = base.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() {
        s = "map.Gbx".into();
    }
    let stem = s.split('.').next().unwrap_or("").to_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
        "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        s = format!("_{s}");
    }
    s
}

/// `dir\name`, or `dir\Name (2).Challenge.Gbx` when the name is taken.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let lower = name.to_lowercase();
    let ext_len = [".challenge.gbx", ".map.gbx", ".replay.gbx", ".gbx"].iter().find(|e| lower.ends_with(*e)).map(|e| e.len()).unwrap_or(0);
    let (stem, ext) = name.split_at(name.len() - ext_len);
    for n in 2..1000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(name)
}

/// Decides where a download from the TMX view is saved. None = not a .Gbx (left to the browser
/// default: the user's Downloads folder).
pub fn route(game: &str, suggested: &Path, docs: &Path, install_dir: Option<&Path>) -> Option<PathBuf> {
    let name = sanitize(&suggested.file_name()?.to_string_lossy());
    let kind = gbx_kind(&name)?;
    let dir = download_dir(game, kind, docs, install_dir)?;
    if crate::fsx::blocked(&dir) {
        return None;
    }
    let _ = std::fs::create_dir_all(&dir);
    Some(unique_path(&dir, &name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_per_game() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("Documents");
        let eswc = t.path().join("Games/TMN-ESWC-inoffiziell");
        let s = Path::new(r"C:\Users\me\Downloads\A07-Race.Challenge.Gbx");
        let r = route("tmnf", s, &docs, None).unwrap();
        assert_eq!(r, docs.join("TrackMania/Tracks/Challenges/Downloaded/A07-Race.Challenge.Gbx"));
        assert!(docs.join("TrackMania/Tracks/Challenges/Downloaded").is_dir());
        assert_eq!(route("tmuf", Path::new("x.Replay.Gbx"), &docs, None).unwrap(), docs.join("TrackMania/Tracks/Replays/Downloaded/x.Replay.Gbx"));
        assert_eq!(route("tmn-eswc", s, &docs, Some(&eswc)).unwrap(), eswc.join("GameData/Tracks/Challenges/Downloaded/A07-Race.Challenge.Gbx"));
        assert_eq!(route("tmn-eswc", s, &docs, None), None);
        assert_eq!(route("tm2-canyon", Path::new("Canyon.Map.Gbx"), &docs, None).unwrap(), docs.join("ManiaPlanet/Maps/Downloaded/Canyon.Map.Gbx"));
        assert_eq!(route("sm-storm", Path::new("Arena.Map.Gbx"), &docs, None).unwrap(), docs.join("ManiaPlanet/Maps/Downloaded/Arena.Map.Gbx"));
        assert_eq!(route("tmnf", Path::new("setup.exe"), &docs, None), None);
    }

    #[test]
    fn tm2020_folder() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path();
        // Fresh PC: Documents\Trackmania.
        assert_eq!(tm2020_user_dir(docs), docs.join("Trackmania"));
        // Forever's folder present: Trackmania2020.
        std::fs::create_dir_all(docs.join("TrackMania/Tracks/Challenges")).unwrap();
        assert_eq!(tm2020_user_dir(docs), docs.join("Trackmania2020"));
        assert_eq!(route("tm2020", Path::new("a.Map.Gbx"), docs, None).unwrap(), docs.join("Trackmania2020/Maps/Downloaded/a.Map.Gbx"));
    }

    #[test]
    fn names_are_safe_and_unique() {
        assert_eq!(sanitize(r"..\..\evil.Challenge.Gbx"), "evil.Challenge.Gbx");
        assert_eq!(sanitize("a:b?.Map.Gbx"), "a_b_.Map.Gbx");
        assert_eq!(sanitize("CON.Map.Gbx"), "_CON.Map.Gbx");
        assert_eq!(sanitize("$f00Red$z Map.Challenge.Gbx"), "$f00Red$z Map.Challenge.Gbx");
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("A.Challenge.Gbx"), b"x").unwrap();
        assert_eq!(unique_path(t.path(), "A.Challenge.Gbx"), t.path().join("A (2).Challenge.Gbx"));
    }

    #[test]
    fn exchange_hosts() {
        assert!(exchange_host("tmnf.exchange") && exchange_host("tm.mania.exchange") && exchange_host("nations.tm-exchange.com"));
        assert!(!exchange_host("github.com") && !exchange_host("evil-exchange.com.attacker.net"));
        assert_eq!(tmx_site("tm2-lagoon"), Some("tm.mania.exchange"));
    }
}
