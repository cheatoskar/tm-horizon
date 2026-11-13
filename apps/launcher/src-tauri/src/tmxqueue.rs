//! The auto-upload queue survives a restart of the launcher.
//!
//! `queue.json` (metadata) and `cache\<sha256>.Replay.Gbx` (the replay bytes) live in
//! `<app data>\tmx-upload\`. Replays that only exist in memory (the 100% TMX mod hands them over
//! through its bridge, the file is not on disk) are kept in the cache folder, so a job can be
//! resumed without the mod. Limits: at most `MAX_JOBS` jobs, `MAX_CACHE` bytes of replays and
//! `MAX_AGE_MS` of age; what falls out of the limits is dropped with a note in the history.

use crate::tmxupload::{Job, ModRef, Queue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

pub const MAX_JOBS: usize = 100;
pub const MAX_CACHE: usize = 256 << 20;
pub const MAX_AGE_MS: u64 = 7 * 24 * 3600 * 1000;
const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedJob {
    pub id: u64,
    pub game: String,
    pub site: String,
    pub map: String,
    pub time_ms: Option<i64>,
    pub source: String,
    pub file_name: String,
    pub sha: String,
    pub state: String,
    pub attempts: u32,
    pub due_ms: u64,
    pub detail: Option<String>,
    pub created_ms: u64,
    /// The mod's job (port, id, result already sent).
    pub mod_port: Option<u16>,
    pub mod_id: Option<String>,
    pub mod_told: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct File {
    version: u32,
    next_id: u64,
    jobs: Vec<SavedJob>,
}

fn saved(j: &Job) -> SavedJob {
    let (mod_port, mod_id, mod_told) = match &j.mod_ref {
        ModRef::None => (None, None, false),
        ModRef::Bridge { port, id, told } => (Some(*port), Some(id.clone()), *told),
    };
    SavedJob {
        id: j.id,
        game: j.game.clone(),
        site: j.site.clone(),
        map: j.map.clone(),
        time_ms: j.time_ms,
        source: j.source.clone(),
        file_name: j.file_name.clone(),
        sha: j.sha.clone(),
        state: j.state.clone(),
        attempts: j.attempts,
        due_ms: j.due_ms,
        detail: j.detail.clone(),
        created_ms: j.created_ms,
        mod_port,
        mod_id,
        mod_told,
    }
}

fn cache_name(sha: &str) -> String {
    format!("{sha}.Replay.Gbx")
}

fn sha_ok(sha: &str) -> bool {
    sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Writes the queue: the metadata file, the replay copies that are not cached yet, and removes
/// cached replays no job needs any more. Jobs beyond the limits are not written.
pub fn save(file: &Path, cache: &Path, q: &Queue) -> Result<(), String> {
    let mut keep: Vec<&Job> = vec![];
    let mut bytes = 0usize;
    // Oldest first: they have waited longest.
    let mut jobs: Vec<&Job> = q.jobs.iter().filter(|j| sha_ok(&j.sha)).collect();
    jobs.sort_by_key(|j| (j.created_ms, j.id));
    for j in jobs {
        if keep.len() >= MAX_JOBS || bytes + j.bytes.len() > MAX_CACHE {
            continue;
        }
        bytes += j.bytes.len();
        keep.push(j);
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    for j in &keep {
        let p = cache.join(cache_name(&j.sha));
        if !p.is_file() {
            let tmp = p.with_extension("part");
            std::fs::write(&tmp, &*j.bytes).and_then(|_| std::fs::rename(&tmp, &p)).map_err(|e| e.to_string())?;
        }
    }
    let f = File { version: VERSION, next_id: q.next_id(), jobs: keep.iter().map(|j| saved(j)).collect() };
    crate::fsx::write(file, &serde_json::to_vec_pretty(&f).map_err(|e| e.to_string())?)?;
    let wanted: HashSet<String> = keep.iter().map(|j| cache_name(&j.sha)).collect();
    if let Ok(rd) = std::fs::read_dir(cache) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if (n.ends_with(".Replay.Gbx") || n.ends_with(".part")) && !wanted.contains(&n) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

/// A job that could not be resumed.
#[derive(Debug, Clone, PartialEq)]
pub struct Dropped {
    pub game: String,
    pub site: String,
    pub map: String,
    pub time_ms: Option<i64>,
    pub source: String,
    pub why: String,
}

#[derive(Debug, Default)]
pub struct Restored {
    pub jobs: Vec<Job>,
    pub next_id: u64,
    pub dropped: Vec<Dropped>,
}

/// Reads the queue back. A job that was `uploading` when the launcher closed waits again; its
/// replay is checked against the stored SHA-256. Too old, too many or damaged: dropped.
pub fn load(file: &Path, cache: &Path, now: u64) -> Restored {
    let f: File = std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut out = Restored { next_id: f.next_id, ..Default::default() };
    for s in f.jobs {
        let drop = |out: &mut Restored, why: &str| {
            out.dropped.push(Dropped { game: s.game.clone(), site: s.site.clone(), map: s.map.clone(), time_ms: s.time_ms, source: s.source.clone(), why: why.into() })
        };
        if now.saturating_sub(s.created_ms) > MAX_AGE_MS {
            drop(&mut out, "Waited longer than 7 days; dropped");
            continue;
        }
        if out.jobs.len() >= MAX_JOBS {
            drop(&mut out, "Too many waiting replays; dropped");
            continue;
        }
        if !sha_ok(&s.sha) {
            drop(&mut out, "Damaged queue entry; dropped");
            continue;
        }
        let Some(bytes) = std::fs::read(cache.join(cache_name(&s.sha))).ok().filter(|b| hex::encode(Sha256::digest(b)) == s.sha) else {
            drop(&mut out, "The saved replay is missing or changed; dropped");
            continue;
        };
        let mod_ref = match (s.mod_port, s.mod_id.clone()) {
            (Some(port), Some(id)) => ModRef::Bridge { port, id, told: s.mod_told },
            _ => ModRef::None,
        };
        out.next_id = out.next_id.max(s.id);
        out.jobs.push(Job {
            id: s.id,
            game: s.game,
            site: s.site,
            map: s.map,
            time_ms: s.time_ms,
            source: s.source,
            file_name: s.file_name,
            bytes: Arc::new(bytes),
            sha: s.sha,
            state: if s.state == "uploading" { "waiting".into() } else { s.state },
            attempts: s.attempts,
            due_ms: s.due_ms,
            detail: s.detail,
            created_ms: s.created_ms,
            mod_ref,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmxupload::{make_job, sha256};

    fn job(q: &mut Queue, tag: &str, now: u64, mod_ref: ModRef) -> u64 {
        let mut b = b"GBX\x06\x00BUCR".to_vec();
        b.extend_from_slice(tag.as_bytes());
        q.push(make_job("tmnf", "tmnf.exchange", &format!("{tag}.Replay.Gbx"), tag.into(), Some(25120), "mod", b, mod_ref), now).unwrap()
    }

    #[test]
    fn queue_survives_a_restart_with_the_replay_bytes() {
        let t = tempfile::tempdir().unwrap();
        let (file, cache) = (t.path().join("queue.json"), t.path().join("cache"));
        let mut q = Queue::default();
        let a = job(&mut q, "A01", 1_000, ModRef::Bridge { port: 27311, id: "m1".into(), told: false });
        let b = job(&mut q, "B02", 1_000, ModRef::None);
        q.jobs[0].state = "uploading".into();
        q.jobs[1].state = "retry".into();
        q.jobs[1].attempts = 2;
        q.jobs[1].due_ms = 99_000;
        q.jobs[1].detail = Some("TMX busy (503)".into());
        save(&file, &cache, &q).unwrap();
        assert!(cache.join(cache_name(&q.jobs[0].sha)).is_file());

        let r = load(&file, &cache, 5_000);
        assert!(r.dropped.is_empty());
        assert_eq!(r.jobs.len(), 2);
        assert_eq!(r.next_id, b);
        let (ra, rb) = (&r.jobs[0], &r.jobs[1]);
        assert_eq!((ra.id, rb.id), (a, b));
        assert_eq!(ra.state, "waiting", "an interrupted upload starts again");
        assert_eq!(ra.mod_ref, ModRef::Bridge { port: 27311, id: "m1".into(), told: false });
        assert_eq!((rb.state.as_str(), rb.attempts, rb.due_ms), ("retry", 2, 99_000));
        assert_eq!(rb.detail.as_deref(), Some("TMX busy (503)"));
        assert_eq!(sha256(&rb.bytes), rb.sha);
        assert_eq!(&**ra.bytes, &**q.jobs[0].bytes);
    }

    #[test]
    fn limits_age_missing_and_changed_files() {
        let t = tempfile::tempdir().unwrap();
        let (file, cache) = (t.path().join("queue.json"), t.path().join("cache"));
        let mut q = Queue::default();
        job(&mut q, "old", 1_000, ModRef::None);
        job(&mut q, "gone", 10 * MAX_AGE_MS, ModRef::None);
        job(&mut q, "changed", 10 * MAX_AGE_MS, ModRef::None);
        job(&mut q, "fine", 10 * MAX_AGE_MS, ModRef::None);
        save(&file, &cache, &q).unwrap();
        std::fs::remove_file(cache.join(cache_name(&q.jobs[1].sha))).unwrap();
        std::fs::write(cache.join(cache_name(&q.jobs[2].sha)), b"tampered").unwrap();
        let r = load(&file, &cache, 10 * MAX_AGE_MS + 5);
        assert_eq!(r.jobs.iter().map(|j| j.map.as_str()).collect::<Vec<_>>(), ["fine"]);
        let why: Vec<_> = r.dropped.iter().map(|d| (d.map.as_str(), d.why.as_str())).collect();
        assert!(why.contains(&("old", "Waited longer than 7 days; dropped")));
        assert!(why.iter().any(|(m, w)| *m == "gone" && w.contains("missing")));
        assert!(why.iter().any(|(m, w)| *m == "changed" && w.contains("changed")));
    }

    #[test]
    fn caps_and_cleanup() {
        let t = tempfile::tempdir().unwrap();
        let (file, cache) = (t.path().join("queue.json"), t.path().join("cache"));
        let mut q = Queue::default();
        for i in 0..MAX_JOBS + 5 {
            job(&mut q, &format!("m{i:03}"), 1_000 + i as u64, ModRef::None);
        }
        save(&file, &cache, &q).unwrap();
        assert_eq!(load(&file, &cache, 2_000).jobs.len(), MAX_JOBS);
        assert_eq!(std::fs::read_dir(&cache).unwrap().count(), MAX_JOBS);
        // A finished job leaves the queue: its copy goes, the others stay.
        let gone = q.jobs.remove(0);
        save(&file, &cache, &q).unwrap();
        assert!(!cache.join(cache_name(&gone.sha)).exists());
        // Unreadable file: empty queue, no panic.
        std::fs::write(&file, b"{ not json").unwrap();
        assert!(load(&file, &cache, 2_000).jobs.is_empty());
    }
}
