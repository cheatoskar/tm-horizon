//! TMNF / TMUF auto-upload without the 100% TMX mod: the game's own replay folder.
//!
//! Where Forever writes replays (`Documents\TrackMania\Tracks\Replays`):
//! - `Autosaves\` : the game saves a personal best here by itself, named `<profile>_<map>.Replay.gbx`
//!   (one file per profile and map, overwritten by the next best).
//! - the folder itself: replays the player saved by hand, ghosts saved from a leaderboard, files
//!   copied in from other players.
//! - `Downloaded\` (replays fetched from TMX or servers) is never looked at.
//!
//! Which files count as the player's own (the rule, also in docs/design/tmx-autoupload.md):
//! 1. Only `Autosaves\` and the top level of `Replays\`. Only files written after the switch was
//!    turned on, at least 2 s old.
//! 2. The replay header has to be readable (driver login via `gbx::replay_head`).
//! 3. A file in `Autosaves\` is the player's own: the game writes it for the active profile. Its
//!    driver login is remembered as one of "my logins".
//! 4. A file in the top level of `Replays\` counts only when its driver login is one of "my
//!    logins" (learned from the autosaves, stored in the config). Anything else is skipped with a
//!    note in the history ("not your replay").
//! 5. The same replay is never uploaded twice: by SHA-256 and by map + time, which also catches
//!    the copy the 100% TMX mod offers for the same run.
//!
//! TMNF and TMUF share the folder. A replay goes to tmnf.exchange or tmuf.exchange by its map's
//! environment: not Stadium means TMUF; Stadium goes to TMNF when that switch is on, else TMUF.
//! A Stadium map that exists only on tmuf.exchange is refused there with TMX's normal answer.

use crate::gbx::replay_head;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// How many of the newest autosaves are read to learn the player's logins.
const LEARN_FILES: usize = 100;
/// At most this many logins are kept.
pub const MAX_LOGINS: usize = 8;

/// `<documents>\TrackMania\Tracks\Replays\Autosaves` and `...\Replays` (top level only).
pub fn forever_dirs(docs: &Path) -> Vec<PathBuf> {
    let r = docs.join("TrackMania").join("Tracks").join("Replays");
    vec![r.join("Autosaves"), r]
}

/// Whether `path` lies directly in an `Autosaves` folder.
pub fn is_autosave(path: &Path) -> bool {
    path.parent().and_then(|p| p.file_name()).is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("autosaves"))
}

/// Exchange game for a replay: see the module notes.
pub fn pick_game(env: Option<&str>, tmnf_on: bool, tmuf_on: bool) -> Option<&'static str> {
    let stadium = env.is_none_or(|e| e.eq_ignore_ascii_case("stadium"));
    match (tmnf_on, tmuf_on) {
        (true, true) => Some(if stadium { "tmnf" } else { "tmuf" }),
        (true, false) => stadium.then_some("tmnf"),
        (false, true) => Some("tmuf"),
        (false, false) => None,
    }
}

/// Logins of the player's own autosaves: the newest `LEARN_FILES` files of the Autosaves folder.
pub fn learn_logins(autosaves: &Path) -> BTreeSet<String> {
    let mut files: Vec<_> = crate::fsx::list(autosaves).into_iter().filter(|e| e.is_file && crate::maps::gbx_kind(&e.name) == Some(crate::maps::GbxKind::Replay)).collect();
    files.sort_by_key(|e| std::cmp::Reverse(e.modified));
    files
        .into_iter()
        .take(LEARN_FILES)
        .filter_map(|e| crate::fsx::read_bytes_prefix(&e.path, 64 * 1024))
        .filter_map(|b| replay_head(&b))
        .filter_map(|h| h.login)
        .filter(|l| !l.is_empty())
        .take(MAX_LOGINS)
        .collect()
}

/// What to do with one replay file of the Forever folder.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Upload it as `game`; `login` is remembered when it came from an autosave.
    Take { game: &'static str, login: Option<String> },
    /// Not uploaded, with the reason for the history.
    Skip(String),
}

/// Applies the rule to the first bytes of a replay. `mine` = logins known so far.
pub fn decide(autosave: bool, bytes: &[u8], mine: &BTreeSet<String>, tmnf_on: bool, tmuf_on: bool) -> Decision {
    let Some(head) = replay_head(bytes) else { return Decision::Skip("The replay header could not be read".into()) };
    let login = head.login.clone().filter(|l| !l.is_empty());
    if !autosave {
        match &login {
            Some(l) if mine.contains(l) => {}
            Some(l) => return Decision::Skip(format!("Not your replay (driver {l})")),
            None => return Decision::Skip("Not uploaded: the replay has no driver login, so it can't be told to be yours".into()),
        }
    }
    match pick_game(head.environment.as_deref(), tmnf_on, tmuf_on) {
        Some(game) => Decision::Take { game, login: if autosave { login } else { None } },
        None => Decision::Skip("This map's environment has no exchange with the switches that are on".into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::gbx::tests::replay_sample;

    fn set(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn folders_and_autosave_detection() {
        let d = forever_dirs(Path::new("/docs"));
        assert!(d[0].ends_with("Replays/Autosaves") && d[1].ends_with("Tracks/Replays"));
        assert!(is_autosave(&d[0].join("Kunde_3aM.Replay.gbx")));
        assert!(is_autosave(Path::new("x/autosaves/a.Replay.gbx")));
        assert!(!is_autosave(&d[1].join("a.Replay.gbx")));
        assert!(!is_autosave(&d[1].join("Downloaded").join("a.Replay.gbx")));
    }

    #[test]
    fn game_by_environment() {
        assert_eq!(pick_game(Some("Stadium"), true, true), Some("tmnf"));
        assert_eq!(pick_game(Some("Snow"), true, true), Some("tmuf"));
        assert_eq!(pick_game(Some("Snow"), true, false), None, "TMNF has no Snow");
        assert_eq!(pick_game(Some("Stadium"), false, true), Some("tmuf"));
        assert_eq!(pick_game(Some("Stadium"), false, false), None);
    }

    #[test]
    fn own_replays_only() {
        let mine = set(&["cheatoskar"]);
        let mine_file = replay_sample("cheatoskar", "[TAS]cheatoskar");
        let other = replay_sample("someoneelse", "Someone");
        let guest = replay_sample("", "Guest");
        // Autosaves: always taken, the login is remembered.
        assert_eq!(decide(true, &other, &BTreeSet::new(), true, false), Decision::Take { game: "tmnf", login: Some("someoneelse".into()) });
        assert_eq!(decide(true, &guest, &BTreeSet::new(), true, false), Decision::Take { game: "tmnf", login: None });
        // Replays folder: only known logins.
        assert_eq!(decide(false, &mine_file, &mine, true, false), Decision::Take { game: "tmnf", login: None });
        assert!(matches!(decide(false, &other, &mine, true, false), Decision::Skip(m) if m.contains("someoneelse")));
        assert!(matches!(decide(false, &guest, &mine, true, false), Decision::Skip(_)));
        assert!(matches!(decide(false, &mine_file, &BTreeSet::new(), true, false), Decision::Skip(_)));
        // No header, no upload.
        assert!(matches!(decide(true, b"garbage", &mine, true, false), Decision::Skip(m) if m.contains("header")));
    }

    #[test]
    fn learns_logins_from_the_autosaves_folder() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path();
        let dirs = forever_dirs(docs);
        std::fs::create_dir_all(&dirs[0]).unwrap();
        std::fs::write(dirs[0].join("Kunde_3aM.Replay.gbx"), replay_sample("cheatoskar", "x")).unwrap();
        std::fs::write(dirs[0].join("Speem_A01.Replay.gbx"), replay_sample("speem", "y")).unwrap();
        std::fs::write(dirs[0].join("broken.Replay.gbx"), b"nope").unwrap();
        std::fs::write(dirs[0].join("notes.txt"), b"x").unwrap();
        assert_eq!(learn_logins(&dirs[0]), set(&["cheatoskar", "speem"]));
        assert!(learn_logins(&docs.join("nothing")).is_empty());
    }
}
