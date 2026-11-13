//! Players seen on a server: the dedicated server keeps no history (its logs do not name players),
//! so the launcher writes down every login it sees in the player list while the server runs
//! (`servers/<id>/players.json`, newest first, at most 500). The guest/ban/white lists offer these
//! logins with their last nickname.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Seen {
    pub login: String,
    /// Last nickname (format codes kept).
    pub nick: String,
    /// Unix seconds.
    pub first_seen: u64,
    pub last_seen: u64,
    /// Separate visits (a gap of more than 10 minutes starts a new one).
    pub visits: u32,
}

pub const MAX_SEEN: usize = 500;
const VISIT_GAP: u64 = 600;

fn file(dir: &Path) -> PathBuf {
    dir.join("players.json")
}

pub fn load(dir: &Path) -> Vec<Seen> {
    std::fs::read(file(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Merges the current player list (login, nick) into `list`; true when something changed.
pub fn merge(list: &mut Vec<Seen>, now: &[(String, String)], at: u64) -> bool {
    let mut changed = false;
    for (login, nick) in now {
        if !super::model::valid_login(login) {
            continue;
        }
        match list.iter_mut().find(|s| s.login.eq_ignore_ascii_case(login)) {
            Some(s) => {
                if at.saturating_sub(s.last_seen) > VISIT_GAP {
                    s.visits += 1;
                }
                if !nick.is_empty() && s.nick != *nick {
                    s.nick = nick.clone();
                }
                s.last_seen = at;
                changed = true;
            }
            None => {
                list.push(Seen { login: login.clone(), nick: nick.clone(), first_seen: at, last_seen: at, visits: 1 });
                changed = true;
            }
        }
    }
    if changed {
        list.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        list.truncate(MAX_SEEN);
    }
    changed
}

/// Records the players of a status poll (called by the watcher and the console).
pub fn record(dir: &Path, now: &[(String, String)]) {
    if now.is_empty() {
        return;
    }
    let mut list = load(dir);
    if merge(&mut list, now, super::now_secs()) {
        if let Ok(b) = serde_json::to_vec_pretty(&list) {
            let tmp = dir.join("players.json.tmp");
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(&tmp, file(dir));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_and_persist() {
        let mut l = vec![];
        assert!(merge(&mut l, &[("alice".into(), "$f00Alice".into()), ("bad login".into(), "x".into())], 1000));
        assert_eq!(l.len(), 1, "invalid logins are not kept");
        merge(&mut l, &[("bob".into(), "Bob".into())], 1100);
        merge(&mut l, &[("ALICE".into(), "$0f0Alice2".into())], 1200);
        assert_eq!(l[0].login, "alice", "newest first, login kept as first seen");
        assert_eq!((l[0].nick.as_str(), l[0].visits, l[0].first_seen), ("$0f0Alice2", 1, 1000));
        merge(&mut l, &[("alice".into(), "".into())], 1200 + VISIT_GAP + 1);
        assert_eq!((l[0].visits, l[0].nick.as_str()), (2, "$0f0Alice2"), "an empty nick keeps the old one");
        let many: Vec<(String, String)> = (0..MAX_SEEN + 20).map(|i| (format!("p{i}"), String::new())).collect();
        merge(&mut l, &many, 5000);
        assert_eq!(l.len(), MAX_SEEN);

        let t = tempfile::tempdir().unwrap();
        record(t.path(), &[("carol".into(), "Carol".into())]);
        record(t.path(), &[]);
        let back = load(t.path());
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].nick, "Carol");
    }
}
