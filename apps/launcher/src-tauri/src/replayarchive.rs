//! Replay archive. The game parses every replay under `Tracks\Replays` when its replay list is
//! refreshed, so a few thousand files freeze it for a minute. This moves old replays out of the user
//! folder to `<Documents>\TM Horizon\Replay-Archiv\<game id>\` (outside the game's user folder, because
//! the game scans recursively), keeping the sub-path below `Replays`.
//!
//! - Plan first (count, size, names), move only after a confirm; refused while the game runs.
//! - Every move is in `replay-archive-journal.json` (from, to, size, time); "Undo last archive" moves
//!   them back and never overwrites: files that are gone, changed in size or whose target exists are
//!   skipped and reported.
//! - Search over live and archived replays reads only the GBX header (`gbx::replay_head`, first 64 KB);
//!   the result is cached in `replay-index.json` keyed by path + size + mtime.
//! - File contents are never changed.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const DAY_MS: i64 = 86_400_000;
const HEAD_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayFile {
    /// Path below the Replays folder, with `/`.
    pub rel: String,
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
}

fn is_replay(name: &str) -> bool {
    name.to_lowercase().ends_with(".replay.gbx")
}

fn mtime_ms(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// All `*.Replay.Gbx` below `root`, recursive.
pub fn scan(root: &Path) -> Vec<ReplayFile> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            let p = e.path();
            if m.is_dir() {
                stack.push(p);
            } else if is_replay(&e.file_name().to_string_lossy()) {
                let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                out.push(ReplayFile { rel, path: p, size: m.len(), mtime_ms: mtime_ms(&m) });
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Rules {
    /// Older than this many days.
    pub days: Option<u32>,
    /// Everything beyond the newest N.
    pub keep: Option<u32>,
    pub autosaves: bool,
}

fn in_autosaves(rel: &str) -> bool {
    rel.split('/').next().map(|c| c.eq_ignore_ascii_case("autosaves")).unwrap_or(false) && rel.contains('/')
}

/// Indexes of the files to archive: older than `days` OR beyond the newest `keep`.
/// `Autosaves` only count (and only rank) with `autosaves`.
pub fn select(files: &[ReplayFile], r: &Rules, now_ms: i64) -> Vec<usize> {
    let mut eligible: Vec<usize> = (0..files.len()).filter(|i| r.autosaves || !in_autosaves(&files[*i].rel)).collect();
    eligible.sort_by(|a, b| files[*b].mtime_ms.cmp(&files[*a].mtime_ms).then(files[*a].rel.cmp(&files[*b].rel)));
    let mut out = vec![];
    for (rank, i) in eligible.into_iter().enumerate() {
        let old = r.days.is_some_and(|d| now_ms - files[i].mtime_ms > d as i64 * DAY_MS);
        let beyond = r.keep.is_some_and(|k| rank >= k as usize);
        if old || beyond {
            out.push(i);
        }
    }
    out.sort();
    out
}

// ------------------------------------------------------------------ journal

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Move {
    pub from: String,
    pub to: String,
    pub size: u64,
    pub time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Batch {
    pub id: String,
    pub time: String,
    pub game: String,
    pub moves: Vec<Move>,
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Journal {
    pub batches: Vec<Batch>,
}

fn journal_file(data: &Path) -> PathBuf {
    data.join("replay-archive-journal.json")
}

pub fn load_journal(data: &Path) -> Journal {
    std::fs::read_to_string(journal_file(data)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_journal(data: &Path, j: &Journal) -> Result<(), String> {
    crate::fsx::write(&journal_file(data), serde_json::to_string_pretty(j).map_err(|e| e.to_string())?.as_bytes())
}

// ------------------------------------------------------------------ moving

/// Rename, or copy + size check + delete when that is not possible (other volume).
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    if to.exists() {
        return Err("target exists".into());
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let size = std::fs::metadata(from).map_err(|e| e.to_string())?.len();
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    if std::fs::metadata(to).map(|m| m.len()).ok() != Some(size) {
        let _ = std::fs::remove_file(to);
        return Err("copy check failed".into());
    }
    std::fs::remove_file(from).map_err(|e| e.to_string())
}

/// `name.Replay.Gbx` -> `name (2).Replay.Gbx` until the name is free.
fn free_name(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let (stem, ext) = match name.to_lowercase().rfind(".replay.gbx") {
        Some(i) => (name[..i].to_string(), name[i..].to_string()),
        None => (name.clone(), String::new()),
    };
    (2..)
        .map(|n| p.with_file_name(format!("{stem} ({n}){ext}")))
        .find(|c| !c.exists())
        .unwrap()
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub moved: u32,
    pub bytes: u64,
    pub skipped: Vec<String>,
}

pub fn archive(files: &[ReplayFile], pick: &[usize], archive_root: &Path, data: &Path, game: &str) -> Result<Report, String> {
    let mut rep = Report::default();
    let mut moves = vec![];
    for &i in pick {
        let f = &files[i];
        let to = free_name(&archive_root.join(&f.rel));
        // The file may have changed since the plan was made.
        if std::fs::metadata(&f.path).map(|m| (m.len(), mtime_ms(&m))).ok() != Some((f.size, f.mtime_ms)) {
            rep.skipped.push(format!("{}: changed", f.rel));
            continue;
        }
        match move_file(&f.path, &to) {
            Ok(()) => {
                moves.push(Move { from: f.path.to_string_lossy().into(), to: to.to_string_lossy().into(), size: f.size, time: crate::fsx::now_iso() });
                rep.moved += 1;
                rep.bytes += f.size;
            }
            Err(e) => rep.skipped.push(format!("{}: {e}", f.rel)),
        }
    }
    if !moves.is_empty() {
        let mut j = load_journal(data);
        j.batches.push(Batch { id: crate::fsx::stamp(), time: crate::fsx::now_iso(), game: game.into(), moves, undone: false });
        save_journal(data, &j)?;
    }
    Ok(rep)
}

/// Moves the newest batch of this game back. Skips (and reports) files that are gone, changed in
/// size, or whose old place is taken; never overwrites.
pub fn undo_last(data: &Path, game: &str) -> Result<Report, String> {
    let mut j = load_journal(data);
    let Some(b) = j.batches.iter_mut().rev().find(|b| b.game == game && !b.undone) else { return Err("Nothing to undo".into()) };
    let mut rep = Report::default();
    for m in &b.moves {
        let (from, to) = (Path::new(&m.to), Path::new(&m.from));
        let name = to.file_name().unwrap_or_default().to_string_lossy().into_owned();
        match std::fs::metadata(from) {
            Err(_) => rep.skipped.push(format!("{name}: not in the archive any more")),
            Ok(meta) if meta.len() != m.size => rep.skipped.push(format!("{name}: changed")),
            Ok(_) if to.exists() => rep.skipped.push(format!("{name}: target exists")),
            Ok(_) => match move_file(from, to) {
                Ok(()) => {
                    rep.moved += 1;
                    rep.bytes += m.size;
                }
                Err(e) => rep.skipped.push(format!("{name}: {e}")),
            },
        }
    }
    b.undone = true;
    save_journal(data, &j)?;
    Ok(rep)
}

/// One archived file back to `Replays\<sub-path>`; never overwrites.
pub fn restore_one(archive_root: &Path, replays: &Path, file: &Path) -> Result<PathBuf, String> {
    let rel = file.strip_prefix(archive_root).map_err(|_| "Not in the archive".to_string())?;
    if rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) || !file.is_file() || !is_replay(&file.to_string_lossy()) {
        return Err("Not an archived replay".into());
    }
    let to = replays.join(rel);
    move_file(file, &to).map_err(|e| if e == "target exists" { "A replay with this name is already there".to_string() } else { e })?;
    Ok(to)
}

// ------------------------------------------------------------------ search index

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Head {
    pub size: u64,
    pub mtime_ms: i64,
    pub uid: Option<String>,
    pub env: Option<String>,
    pub time_ms: Option<u32>,
    pub nick: Option<String>,
    pub login: Option<String>,
}

fn index_file(data: &Path) -> PathBuf {
    data.join("replay-index.json")
}

pub fn load_index(data: &Path) -> HashMap<String, Head> {
    std::fs::read_to_string(index_file(data)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Header data for every file; unchanged files come from `cache`. Returns whether the cache changed.
pub fn refresh_index(files: &[ReplayFile], cache: &mut HashMap<String, Head>) -> bool {
    let mut changed = false;
    for f in files {
        let key = f.path.to_string_lossy().into_owned();
        if cache.get(&key).is_some_and(|h| h.size == f.size && h.mtime_ms == f.mtime_ms) {
            continue;
        }
        let mut h = Head { size: f.size, mtime_ms: f.mtime_ms, ..Default::default() };
        if let Some(r) = crate::fsx::read_bytes_prefix(&f.path, HEAD_BYTES).and_then(|b| crate::gbx::replay_head(&b)) {
            h.uid = r.uid;
            h.env = r.environment;
            h.time_ms = r.time_ms;
            h.nick = r.nickname;
            h.login = r.login;
        }
        cache.insert(key, h);
        changed = true;
    }
    let live: std::collections::HashSet<String> = files.iter().map(|f| f.path.to_string_lossy().into_owned()).collect();
    // Entries of files that are gone (or moved) are dropped, but only below the scanned roots.
    let before = cache.len();
    cache.retain(|k, _| live.contains(k));
    changed || cache.len() != before
}

/// 1:23.45 (TrackMania style, hundredths).
pub fn fmt_time(ms: u32) -> String {
    format!("{}:{:02}.{:02}", ms / 60000, ms / 1000 % 60, ms % 1000 / 10)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// "live" | "archive"
    pub place: String,
    pub path: String,
    pub rel: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub player: Option<String>,
    pub time: Option<String>,
    pub env: Option<String>,
}

/// Every word of `query` has to appear in the file name, driver, login, map uid, environment or
/// time (`1:23.45` or milliseconds). Newest first.
pub fn search(files: &[(ReplayFile, bool)], idx: &HashMap<String, Head>, query: &str, max: usize) -> Vec<Hit> {
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
    let mut out: Vec<Hit> = vec![];
    for (f, live) in files {
        let h = idx.get(&f.path.to_string_lossy().into_owned());
        let time = h.and_then(|h| h.time_ms).map(fmt_time);
        let hay = format!(
            "{} {} {} {} {} {} {}",
            f.rel,
            h.and_then(|h| h.nick.clone()).unwrap_or_default(),
            h.and_then(|h| h.login.clone()).unwrap_or_default(),
            h.and_then(|h| h.uid.clone()).unwrap_or_default(),
            h.and_then(|h| h.env.clone()).unwrap_or_default(),
            time.clone().unwrap_or_default(),
            h.and_then(|h| h.time_ms).map(|t| t.to_string()).unwrap_or_default(),
        )
        .to_lowercase();
        if words.iter().all(|w| hay.contains(w)) {
            out.push(Hit { place: if *live { "live" } else { "archive" }.into(), path: f.path.to_string_lossy().into(), rel: f.rel.clone(), size: f.size, mtime_ms: f.mtime_ms, player: h.and_then(|h| h.nick.clone()), time, env: h.and_then(|h| h.env.clone()) });
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then(a.rel.cmp(&b.rel)));
    out.truncate(max);
    out
}

// ------------------------------------------------------------------ commands

struct Dirs {
    replays: PathBuf,
    archive: PathBuf,
}

fn dirs(st: &AppState, game: &str) -> Result<Dirs, String> {
    use crate::horizonhost as hh;
    let docs = crate::platform::documents_dir().ok_or("Documents folder not found")?;
    let user = if hh::is_forever(game) {
        docs.join("TrackMania")
    } else if hh::is_legacy(game) {
        st.install_dir(game).ok_or("The game is not installed")?.join("GameData")
    } else {
        return Err("Not available for this game".into());
    };
    let replays = user.join("Tracks").join("Replays");
    if crate::fsx::blocked(&replays) {
        return Err("This folder is protected".into());
    }
    Ok(Dirs { replays, archive: docs.join("TM Horizon").join("Replay-Archiv").join(game) })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchState {
    pub replays_dir: String,
    pub archive_dir: String,
    pub count: u32,
    pub bytes: u64,
    pub archived_count: u32,
    pub archived_bytes: u64,
    pub days: u32,
    pub keep: u32,
    pub can_undo: bool,
}

#[tauri::command]
pub async fn replay_state(app: tauri::AppHandle, game_id: String) -> Result<ArchState, String> {
    crate::bg::run(move || -> Result<ArchState, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let d = dirs(&st, &game_id)?;
        let (live, arch) = (scan(&d.replays), scan(&d.archive));
        let prefs = crate::optimize::load_prefs(&st.data_dir);
        Ok(ArchState {
            replays_dir: d.replays.to_string_lossy().into(),
            archive_dir: d.archive.to_string_lossy().into(),
            count: live.len() as u32,
            bytes: live.iter().map(|f| f.size).sum(),
            archived_count: arch.len() as u32,
            archived_bytes: arch.iter().map(|f| f.size).sum(),
            days: prefs.archive_days,
            keep: prefs.archive_keep,
            can_undo: load_journal(&st.data_dir).batches.iter().any(|b| b.game == game_id && !b.undone),
        })
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchPlan {
    pub count: u32,
    pub bytes: u64,
    /// The first 40 relative paths.
    pub sample: Vec<String>,
}

#[tauri::command]
pub async fn replay_plan(app: tauri::AppHandle, game_id: String, rules: Rules) -> Result<ArchPlan, String> {
    crate::bg::run(move || -> Result<ArchPlan, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let d = dirs(&st, &game_id)?;
        let files = scan(&d.replays);
        let pick = select(&files, &rules, now_ms());
        Ok(ArchPlan { count: pick.len() as u32, bytes: pick.iter().map(|i| files[*i].size).sum(), sample: pick.iter().take(40).map(|i| files[*i].rel.clone()).collect() })
    })
    .await
}

#[tauri::command]
pub async fn replay_archive(app: tauri::AppHandle, game_id: String, rules: Rules) -> Result<Report, String> {
    crate::bg::run(move || -> Result<Report, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if crate::optimize::game_running(&st, &game_id) {
            return Err("Close the game first.".into());
        }
        let d = dirs(&st, &game_id)?;
        let files = scan(&d.replays);
        let pick = select(&files, &rules, now_ms());
        let mut prefs = crate::optimize::load_prefs(&st.data_dir);
        if let Some(x) = rules.days {
            prefs.archive_days = x;
        }
        if let Some(x) = rules.keep {
            prefs.archive_keep = x;
        }
        let _ = crate::optimize::save_prefs(&st.data_dir, &prefs);
        archive(&files, &pick, &d.archive, &st.data_dir, &game_id)
    })
    .await
}

#[tauri::command]
pub async fn replay_undo(app: tauri::AppHandle, game_id: String) -> Result<Report, String> {
    crate::bg::run(move || -> Result<Report, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if crate::optimize::game_running(&st, &game_id) {
            return Err("Close the game first.".into());
        }
        dirs(&st, &game_id)?;
        undo_last(&st.data_dir, &game_id)
    })
    .await
}

#[tauri::command]
pub async fn replay_search(app: tauri::AppHandle, game_id: String, query: String) -> Result<Vec<Hit>, String> {
    crate::bg::run(move || -> Result<Vec<Hit>, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let d = dirs(&st, &game_id)?;
        let mut all: Vec<(ReplayFile, bool)> = scan(&d.replays).into_iter().map(|f| (f, true)).collect();
        all.extend(scan(&d.archive).into_iter().map(|f| (f, false)));
        let mut idx = load_index(&st.data_dir);
        let flat: Vec<ReplayFile> = all.iter().map(|x| x.0.clone()).collect();
        if refresh_index(&flat, &mut idx) {
            let _ = crate::fsx::write(&index_file(&st.data_dir), serde_json::to_string(&idx).unwrap_or_default().as_bytes());
        }
        Ok(search(&all, &idx, &query, 200))
    })
    .await
}

#[tauri::command]
pub async fn replay_restore(app: tauri::AppHandle, game_id: String, path: String) -> Result<String, String> {
    crate::bg::run(move || -> Result<String, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        if crate::optimize::game_running(&st, &game_id) {
            return Err("Close the game first.".into());
        }
        let d = dirs(&st, &game_id)?;
        restore_one(&d.archive, &d.replays, Path::new(&path)).map(|p| p.to_string_lossy().into())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rf(rel: &str, age_days: i64, now: i64) -> ReplayFile {
        ReplayFile { rel: rel.into(), path: PathBuf::from(rel), size: 10, mtime_ms: now - age_days * DAY_MS }
    }

    #[test]
    fn selects_by_age_and_count() {
        let now = 1_000 * DAY_MS;
        let f = vec![rf("a.Replay.Gbx", 1, now), rf("b.Replay.Gbx", 10, now), rf("c.Replay.Gbx", 70, now), rf("Autosaves/x.Replay.Gbx", 200, now), rf("sub/d.Replay.Gbx", 90, now)];
        let by_age = select(&f, &Rules { days: Some(60), ..Default::default() }, now);
        assert_eq!(by_age, vec![2, 4], "autosaves stay");
        let by_count = select(&f, &Rules { keep: Some(2), ..Default::default() }, now);
        assert_eq!(by_count, vec![2, 4], "beyond the newest two (autosaves do not rank)");
        let both = select(&f, &Rules { days: Some(5), keep: Some(3), ..Default::default() }, now);
        assert_eq!(both, vec![1, 2, 4]);
        let with = select(&f, &Rules { days: Some(60), autosaves: true, ..Default::default() }, now);
        assert_eq!(with, vec![2, 3, 4]);
        assert!(select(&f, &Rules::default(), now).is_empty());
    }

    fn make(root: &Path, rel: &str, content: &[u8]) -> PathBuf {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn archive_and_undo_keep_sub_paths() {
        let t = tempfile::tempdir().unwrap();
        let (rep, arc, data) = (t.path().join("Replays"), t.path().join("arc"), t.path().join("data"));
        make(&rep, "a.Replay.Gbx", b"aaaa");
        make(&rep, "sub/b.Replay.Gbx", b"bb");
        make(&rep, "Autosaves/s.Replay.Gbx", b"s");
        make(&rep, "notes.txt", b"x");
        let files = scan(&rep);
        assert_eq!(files.len(), 3);
        let pick: Vec<usize> = (0..files.len()).filter(|i| !in_autosaves(&files[*i].rel)).collect();
        let r = archive(&files, &pick, &arc, &data, "tmnf").unwrap();
        assert_eq!((r.moved, r.bytes), (2, 6));
        assert!(arc.join("sub/b.Replay.Gbx").is_file() && !rep.join("sub/b.Replay.Gbx").exists());
        assert!(rep.join("Autosaves/s.Replay.Gbx").is_file() && rep.join("notes.txt").is_file());
        assert_eq!(load_journal(&data).batches[0].moves.len(), 2);
        let u = undo_last(&data, "tmnf").unwrap();
        assert_eq!((u.moved, u.skipped.len()), (2, 0));
        assert_eq!(std::fs::read(rep.join("sub/b.Replay.Gbx")).unwrap(), b"bb");
        assert!(undo_last(&data, "tmnf").is_err());
    }

    #[test]
    fn undo_skips_changed_missing_and_taken() {
        let t = tempfile::tempdir().unwrap();
        let (rep, arc, data) = (t.path().join("Replays"), t.path().join("arc"), t.path().join("data"));
        for n in ["a", "b", "c", "d"] {
            make(&rep, &format!("{n}.Replay.Gbx"), b"1234");
        }
        let files = scan(&rep);
        archive(&files, &[0, 1, 2, 3], &arc, &data, "tmnf").unwrap();
        std::fs::write(arc.join("a.Replay.Gbx"), b"changed!").unwrap(); // size differs
        std::fs::remove_file(arc.join("b.Replay.Gbx")).unwrap(); // gone
        make(&rep, "c.Replay.Gbx", b"new one"); // old place taken
        let u = undo_last(&data, "tmnf").unwrap();
        assert_eq!(u.moved, 1);
        assert_eq!(u.skipped.len(), 3);
        assert_eq!(std::fs::read(rep.join("c.Replay.Gbx")).unwrap(), b"new one", "never overwritten");
        assert!(arc.join("c.Replay.Gbx").is_file(), "stays in the archive");
        assert!(rep.join("d.Replay.Gbx").is_file());
    }

    #[test]
    fn name_collisions_in_the_archive_get_a_number() {
        let t = tempfile::tempdir().unwrap();
        let (rep, arc, data) = (t.path().join("Replays"), t.path().join("arc"), t.path().join("data"));
        make(&arc, "a.Replay.Gbx", b"old archive");
        make(&rep, "a.Replay.Gbx", b"new");
        let files = scan(&rep);
        let r = archive(&files, &[0], &arc, &data, "tmnf").unwrap();
        assert_eq!(r.moved, 1);
        assert_eq!(std::fs::read(arc.join("a.Replay.Gbx")).unwrap(), b"old archive");
        assert_eq!(std::fs::read(arc.join("a (2).Replay.Gbx")).unwrap(), b"new");
    }

    #[test]
    fn changed_since_plan_is_skipped() {
        let t = tempfile::tempdir().unwrap();
        let (rep, arc, data) = (t.path().join("Replays"), t.path().join("arc"), t.path().join("data"));
        make(&rep, "a.Replay.Gbx", b"1234");
        let files = scan(&rep);
        std::fs::write(rep.join("a.Replay.Gbx"), b"12345678").unwrap();
        let r = archive(&files, &[0], &arc, &data, "tmnf").unwrap();
        assert_eq!((r.moved, r.skipped.len()), (0, 1));
        assert!(rep.join("a.Replay.Gbx").is_file());
    }

    #[test]
    fn restore_one_never_overwrites() {
        let t = tempfile::tempdir().unwrap();
        let (rep, arc) = (t.path().join("Replays"), t.path().join("arc"));
        let f = make(&arc, "x/a.Replay.Gbx", b"1");
        let back = restore_one(&arc, &rep, &f).unwrap();
        assert_eq!(back, rep.join("x/a.Replay.Gbx"));
        let f2 = make(&arc, "x/a.Replay.Gbx", b"2");
        assert!(restore_one(&arc, &rep, &f2).unwrap_err().contains("already"));
        assert_eq!(std::fs::read(rep.join("x/a.Replay.Gbx")).unwrap(), b"1");
        assert!(restore_one(&arc, &rep, &rep.join("x/a.Replay.Gbx")).is_err(), "outside the archive");
    }

    #[test]
    fn index_is_cached_and_search_matches_header_fields() {
        let t = tempfile::tempdir().unwrap();
        let rep = t.path().join("Replays");
        let sample = crate::gbx::tests::replay_sample_run("oskar", "OskarNick", "Stadium", "UID123abc", 83450);
        make(&rep, "A01_Oskar.Replay.Gbx", &sample);
        make(&rep, "broken.Replay.Gbx", b"nope");
        let files = scan(&rep);
        let mut idx = HashMap::new();
        assert!(refresh_index(&files, &mut idx));
        assert!(!refresh_index(&files, &mut idx), "second run reads nothing new");
        let all: Vec<(ReplayFile, bool)> = files.iter().cloned().map(|f| (f, true)).collect();
        assert_eq!(search(&all, &idx, "oskarnick", 10).len(), 1);
        assert_eq!(search(&all, &idx, "1:23.45", 10).len(), 1);
        assert_eq!(search(&all, &idx, "uid123 stadium", 10).len(), 1);
        assert_eq!(search(&all, &idx, "a01", 10).len(), 1);
        assert_eq!(search(&all, &idx, "broken", 10)[0].player, None);
        assert_eq!(search(&all, &idx, "", 10).len(), 2);
        assert!(search(&all, &idx, "zzz", 10).is_empty());
        // A removed file leaves the cache.
        std::fs::remove_file(rep.join("broken.Replay.Gbx")).unwrap();
        assert!(refresh_index(&scan(&rep), &mut idx));
        assert_eq!(idx.len(), 1);
        assert_eq!(fmt_time(83450), "1:23.45");
    }
}
