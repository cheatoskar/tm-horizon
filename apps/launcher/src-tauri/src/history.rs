//! Change history ("Verlauf") with undo for everything TM Horizon writes into game folders and user
//! folders: mod installs, updates and removals, Horizon Host, TMVS presets/looks/packs, profile
//! switches, restores.
//!
//! How it works: before an operation, every watched file (a single file, the top level of a folder,
//! or a whole folder tree) is hashed (SHA-256) and copied into a content-addressed store
//! `<app data>\history\blobs\<sha256>` (the same content is kept once). After the operation the same
//! places are hashed again. Files whose state differs (new, changed, deleted) become one entry in
//! `<app data>\history\index.json`; copies nobody needs are removed right away.
//!
//! Undo puts every file back exactly (or deletes what the operation added) and removes the folders it
//! created when they are empty. It refuses, with the list of files, when any of them changed since
//! (by the game, by hand or by a later change) and while the game runs. All restored files are staged
//! next to their target first, so a failing write leaves nothing half done.
//!
//! The store is size-capped: the oldest entries lose their copies first (they stay in the list, marked
//! "expired", without undo). Nothing here follows symbolic links or junctions, and the protected
//! StarForce ESWC folder is never read (fsx guard). dinput8.dll is read only when an operation names
//! it explicitly (Horizon Host and ESWC loader installs write it).

use crate::fsx;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Copies kept at most (oldest entries expire first).
pub const MAX_STORE_BYTES: u64 = 2 << 30;
/// Entries kept in the list at most.
pub const MAX_ENTRIES: usize = 400;
/// One operation's watched places: more than this and the entry is recorded without undo.
pub const MAX_SCAN_FILES: usize = 20_000;
pub const MAX_SCAN_BYTES: u64 = 1 << 30;

/// What to snapshot before an operation.
#[derive(Debug, Clone)]
pub enum Watch {
    /// One file (may not exist yet).
    File(PathBuf),
    /// The files directly in a folder (not its subfolders).
    Shallow(PathBuf),
    /// A folder with everything below it (may not exist yet).
    Tree(PathBuf),
}

/// What the entry is about, for the list.
#[derive(Debug, Clone)]
pub struct Op {
    /// Game ids the change belongs to (Forever changes: "tmnf" and "tmuf").
    pub games: Vec<String>,
    /// "mod-install", "mod-profile", "mod-update", "mod-rollback", "mod-remove", "host-install",
    /// "host-remove", "host-restore", "host-plugin", "tmvs-install", "tmvs-remove", "openplanet",
    /// "restore", "profile", "pack".
    pub kind: String,
    /// What it is about: a mod id, an item or profile name ("TM Vibrant Shaders", "Horizon Host").
    pub title: String,
    /// Extra: version, profile, "on"/"off" (the UI builds the sentence from kind + title + detail).
    pub detail: String,
}

impl Op {
    pub fn new(games: &[&str], kind: &str, title: impl Into<String>) -> Op {
        Op { games: games.iter().map(|g| g.to_string()).collect(), kind: kind.into(), title: title.into(), detail: String::new() }
    }
    pub fn detail(mut self, d: impl Into<String>) -> Op {
        self.detail = d.into();
        self
    }
    /// A game id or `<game>@<instance>`; Forever ids count for both Forever games.
    pub fn for_game(game: &str, kind: &str, title: impl Into<String>) -> Op {
        let g = game.split('@').next().unwrap_or(game);
        let games: Vec<&str> = if g == "tmnf" || g == "tmuf" || g == "forever" { vec!["tmnf", "tmuf"] } else { vec![g] };
        Op::new(&games, kind, title)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// SHA-256 before the operation; None = the file did not exist.
    pub before: Option<String>,
    /// SHA-256 after the operation; None = the operation deleted it.
    pub after: Option<String>,
    /// Size before (0 when new).
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    /// ISO time of the operation.
    pub at: String,
    pub games: Vec<String>,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    pub files: Vec<FileChange>,
    /// Folders the operation created (removed again by undo when empty).
    #[serde(default)]
    pub dirs_created: Vec<String>,
    /// When it was undone.
    #[serde(default)]
    pub undone: Option<String>,
    /// The copies were removed to keep the store small: no undo.
    #[serde(default)]
    pub expired: bool,
    /// Too much to copy before the operation: listed, no undo.
    #[serde(default)]
    pub incomplete: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Index {
    changes: Vec<Change>,
}

/// The entry as the UI gets it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeView {
    #[serde(flatten)]
    pub change: Change,
    /// None = undo possible now (files unchanged); else a code: "undone", "expired", "incomplete",
    /// "changed" (see `changed`).
    pub blocked: Option<String>,
    /// Files that differ from what the operation left.
    pub changed: Vec<String>,
}

/// Result of an undo.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub ok: bool,
    /// "done", "changed", "running", "undone", "expired", "incomplete", "missing", "error".
    pub code: String,
    /// Restored or deleted files (done), or the files that block it (changed).
    pub files: Vec<String>,
    /// Titles of later changes that touched the same files (changed).
    pub later: Vec<String>,
    /// Process name (running) or error text (error).
    pub detail: Option<String>,
}

impl UndoResult {
    fn no(code: &str) -> Self {
        UndoResult { ok: false, code: code.into(), files: vec![], later: vec![], detail: None }
    }
}

// ------------------------------------------------------------------ store

pub fn root(data: &Path) -> PathBuf {
    data.join("history")
}
fn blobs(data: &Path) -> PathBuf {
    root(data).join("blobs")
}
fn index_file(data: &Path) -> PathBuf {
    root(data).join("index.json")
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static L: Mutex<()> = Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

/// Hashes an in-flight recorder copied but has not referenced yet (never collected meanwhile).
fn pinned() -> &'static Mutex<HashMap<String, u32>> {
    static P: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load(data: &Path) -> Index {
    std::fs::read(index_file(data)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(data: &Path, ix: &Index) -> Result<(), String> {
    fsx::write(&index_file(data), &serde_json::to_vec_pretty(ix).map_err(|e| e.to_string())?)
}

fn norm(p: &Path) -> String {
    fsx::norm(p)
}

/// Guard: the protected ESWC folder is never touched; dinput8.dll only when named on purpose.
fn allowed(p: &Path, explicit: bool) -> bool {
    if fsx::is_dinput8(p) {
        return explicit && p.parent().is_some_and(|d| !fsx::blocked(d));
    }
    !fsx::blocked(p)
}

/// SHA-256 of a file, streamed; with `store` the bytes are also copied into the blob store.
fn hash_file(p: &Path, store: Option<&Path>) -> std::io::Result<(String, u64)> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut size = 0u64;
    let mut buf = vec![0u8; 256 * 1024];
    let mut tmp = match store {
        Some(dir) => {
            std::fs::create_dir_all(dir)?;
            let t = dir.join(format!(".in-{}-{}", std::process::id(), fsx::stamp()));
            Some((std::fs::File::create(&t)?, t))
        }
        None => None,
    };
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        size += n as u64;
        if let Some((t, _)) = tmp.as_mut() {
            t.write_all(&buf[..n])?;
        }
    }
    let hex = hex::encode(h.finalize());
    if let (Some((t, tp)), Some(dir)) = (tmp, store) {
        drop(t);
        let dst = dir.join(&hex);
        if dst.is_file() {
            let _ = std::fs::remove_file(&tp);
        } else if let Err(e) = std::fs::rename(&tp, &dst) {
            let _ = std::fs::remove_file(&tp);
            return Err(e);
        }
    }
    Ok((hex, size))
}

#[derive(Debug, Default)]
struct Scan {
    /// norm path -> (path, sha, size)
    files: BTreeMap<String, (PathBuf, String, u64)>,
    dirs: BTreeMap<String, PathBuf>,
    /// Parent folders of watched files (and watched folders) that did not exist.
    missing_dirs: Vec<PathBuf>,
    /// Hashes this scan pinned in the store (released when the recording is finished).
    pinned: Vec<String>,
    too_big: bool,
    bytes: u64,
}

fn is_temp(name: &str) -> bool {
    name.ends_with(".tmhub-tmp") || name.ends_with(".tmhub-undo")
}

fn scan_one(p: &Path, explicit: bool, store: Option<&Path>, out: &mut Scan) {
    if !allowed(p, explicit) {
        return;
    }
    let Ok(m) = std::fs::symlink_metadata(p) else { return };
    if !m.is_file() {
        return;
    }
    if out.files.len() >= MAX_SCAN_FILES || out.bytes + m.len() > MAX_SCAN_BYTES {
        out.too_big = true;
        // Still hash it (for the list), but keep no copy.
        if let Ok((h, s)) = hash_file(p, None) {
            out.files.insert(norm(p), (p.to_path_buf(), h, s));
        }
        return;
    }
    let st = if out.too_big { None } else { store };
    if let Ok((h, s)) = hash_file(p, st) {
        if st.is_some() {
            *pinned().lock().unwrap().entry(h.clone()).or_default() += 1;
            out.pinned.push(h.clone());
        }
        out.bytes += s;
        out.files.insert(norm(p), (p.to_path_buf(), h, s));
    }
}

fn walk(dir: &Path, depth: u32, recursive: bool, store: Option<&Path>, out: &mut Scan) {
    if depth > 24 || !allowed(dir, false) {
        return;
    }
    let Ok(m) = std::fs::symlink_metadata(dir) else { return };
    // Junctions and symbolic links are not followed (on Windows a junction is not is_dir here).
    if !m.is_dir() || m.file_type().is_symlink() {
        return;
    }
    out.dirs.insert(norm(dir), dir.to_path_buf());
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if is_temp(&name) || fsx::is_dinput8(&p) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if recursive {
                walk(&p, depth + 1, true, store, out);
            }
        } else if ft.is_file() {
            scan_one(&p, false, store, out);
        }
    }
}

/// Remembers the folders from `dir` upwards that do not exist (stops at the first that does).
fn note_missing(dir: Option<&Path>, out: &mut Scan) {
    let mut d = dir;
    while let Some(x) = d {
        if x.as_os_str().is_empty() || x.exists() {
            break;
        }
        if !out.missing_dirs.iter().any(|m| m == x) {
            out.missing_dirs.push(x.to_path_buf());
        }
        d = x.parent();
    }
}

fn scan(watches: &[Watch], store: Option<&Path>) -> Scan {
    let mut out = Scan::default();
    for w in watches {
        match w {
            Watch::File(p) => {
                note_missing(p.parent(), &mut out);
                scan_one(p, true, store, &mut out);
            }
            Watch::Shallow(d) => {
                note_missing(Some(d), &mut out);
                walk(d, 0, false, store, &mut out)
            }
            Watch::Tree(d) => {
                note_missing(d.parent(), &mut out);
                walk(d, 0, true, store, &mut out)
            }
        }
    }
    out
}

fn unpin(hashes: impl Iterator<Item = String>) {
    let mut p = pinned().lock().unwrap();
    for h in hashes {
        if let Some(n) = p.get_mut(&h) {
            *n -= 1;
            if *n == 0 {
                p.remove(&h);
            }
        }
    }
}

/// Removes copies no entry needs any more, then expires the oldest entries until the store fits.
fn collect(data: &Path, ix: &mut Index, max_bytes: u64) {
    let dir = blobs(data);
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let mut sizes: BTreeMap<String, u64> = BTreeMap::new();
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with(".in-") {
            // A crashed copy (older than a day) goes; a running one stays.
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_secs() > 86_400);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
            continue;
        }
        sizes.insert(n, e.metadata().map(|m| m.len()).unwrap_or(0));
    }
    let needed = |ix: &Index| -> BTreeSet<String> {
        ix.changes.iter().filter(|c| c.undone.is_none() && !c.expired && !c.incomplete).flat_map(|c| c.files.iter().filter_map(|f| f.before.clone())).collect()
    };
    loop {
        let keep = needed(ix);
        let pins = pinned().lock().unwrap().clone();
        let total: u64 = sizes.iter().filter(|(h, _)| keep.contains(*h) || pins.contains_key(*h)).map(|(_, s)| s).sum();
        let drop: Vec<String> = sizes.keys().filter(|h| !keep.contains(*h) && !pins.contains_key(*h)).cloned().collect();
        for h in drop {
            let _ = std::fs::remove_file(dir.join(&h));
            sizes.remove(&h);
        }
        if total <= max_bytes {
            break;
        }
        // Oldest entry that still holds copies expires.
        let Some(c) = ix.changes.iter_mut().find(|c| c.undone.is_none() && !c.expired && !c.incomplete && c.files.iter().any(|f| f.before.is_some())) else { break };
        c.expired = true;
    }
}

// ------------------------------------------------------------------ recording

/// A running recording: created before the operation, finished after it.
pub struct Recorder {
    data: PathBuf,
    op: Op,
    watches: Vec<Watch>,
    pre: Scan,
    max_bytes: u64,
    done: bool,
}

impl Recorder {
    pub fn start(data: &Path, op: Op, watches: Vec<Watch>) -> Recorder {
        Self::start_capped(data, op, watches, MAX_STORE_BYTES)
    }

    pub fn start_capped(data: &Path, op: Op, watches: Vec<Watch>, max_bytes: u64) -> Recorder {
        let pre = scan(&watches, Some(&blobs(data)));
        Recorder { data: data.to_path_buf(), op, watches, pre, max_bytes, done: false }
    }

    /// Records what changed (nothing changed = no entry). Returns the entry id. Dropping a recorder
    /// without calling this finishes it too (so `let _rec = Recorder::start(..)` covers early returns).
    pub fn finish(mut self) -> Option<String> {
        self.finalize()
    }

    fn finalize(&mut self) -> Option<String> {
        if self.done {
            return None;
        }
        self.done = true;
        let post = scan(&self.watches, None);
        let mut files = Vec::new();
        let keys: BTreeSet<&String> = self.pre.files.keys().chain(post.files.keys()).collect();
        for k in keys {
            let a = self.pre.files.get(k);
            let b = post.files.get(k);
            if a.map(|x| &x.1) == b.map(|x| &x.1) {
                continue;
            }
            let path = b.or(a).map(|x| x.0.to_string_lossy().into_owned()).unwrap_or_default();
            files.push(FileChange { path, before: a.map(|x| x.1.clone()), after: b.map(|x| x.1.clone()), size: a.map(|x| x.2).unwrap_or(0) });
        }
        let mut dirs_created: Vec<String> = post.dirs.iter().filter(|(k, _)| !self.pre.dirs.contains_key(*k)).map(|(_, p)| p.to_string_lossy().into_owned()).collect();
        // Parent folders of watched files that were missing before and exist now.
        for d in &self.pre.missing_dirs {
            let s = d.to_string_lossy().into_owned();
            if d.is_dir() && !dirs_created.contains(&s) {
                dirs_created.push(s);
            }
        }
        let pinned_hashes: Vec<String> = self.pre.pinned.clone();
        let id = if files.is_empty() {
            None
        } else {
            let _g = lock();
            let mut ix = load(&self.data);
            let id = fsx::stamp();
            ix.changes.push(Change {
                id: id.clone(),
                at: fsx::now_iso(),
                games: self.op.games.clone(),
                kind: self.op.kind.clone(),
                title: self.op.title.clone(),
                detail: self.op.detail.clone(),
                files,
                dirs_created,
                undone: None,
                expired: false,
                incomplete: self.pre.too_big,
            });
            if ix.changes.len() > MAX_ENTRIES {
                let n = ix.changes.len() - MAX_ENTRIES;
                ix.changes.drain(..n);
            }
            unpin(pinned_hashes.iter().cloned());
            collect(&self.data, &mut ix, self.max_bytes);
            let _ = save(&self.data, &ix);
            Some(id)
        };
        if id.is_none() {
            let _g = lock();
            unpin(pinned_hashes.into_iter());
            let mut ix = load(&self.data);
            collect(&self.data, &mut ix, self.max_bytes);
        }
        id
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.finalize();
    }
}

// ------------------------------------------------------------------ what each operation touches

/// TMLoader: the product version folders of an install plan, plus the profiles.
pub fn tml_watches(root: &Path, plan: &[(String, String)]) -> Vec<Watch> {
    let mut v: Vec<Watch> = plan.iter().map(|(p, ver)| Watch::Tree(crate::tmloader::products_dir(root).join(p).join(ver))).collect();
    v.push(Watch::Tree(crate::tmloader::profiles_dir(root)));
    v
}

/// TMLoader profiles only (switches, versions, new profiles).
pub fn tml_profiles(root: &Path) -> Vec<Watch> {
    vec![Watch::Tree(crate::tmloader::profiles_dir(root))]
}

/// A legacy game folder with Horizon Host or a loader mod: its top level (dinput8.dll named on
/// purpose) and the `horizon` folder.
pub fn game_dir_watches(dir: &Path, with_host: bool) -> Vec<Watch> {
    let mut v = vec![Watch::Shallow(dir.to_path_buf()), Watch::File(dir.join("dinput8.dll"))];
    if with_host {
        v.push(Watch::Tree(dir.join("horizon")));
    }
    v
}

/// Single files under a folder.
pub fn files_in(root: &Path, rels: &[String]) -> Vec<Watch> {
    rels.iter().map(|r| Watch::File(root.join(r.replace('/', std::path::MAIN_SEPARATOR_STR)))).collect()
}

/// Runs `f` with a recording around it (whatever `f` returns, changes it made are recorded).
pub fn record<R>(data: &Path, op: Op, watches: Vec<Watch>, f: impl FnOnce() -> R) -> R {
    let rec = Recorder::start(data, op, watches);
    let r = f();
    rec.finish();
    r
}

// ------------------------------------------------------------------ list and undo

fn current_hash(p: &Path, explicit: bool) -> Option<String> {
    if !allowed(p, explicit) {
        return None;
    }
    let m = std::fs::symlink_metadata(p).ok()?;
    if !m.is_file() {
        return None;
    }
    hash_file(p, None).ok().map(|x| x.0)
}

/// Files of `c` that are no longer what the operation left.
fn changed_files(c: &Change) -> Vec<String> {
    c.files
        .iter()
        .filter(|f| {
            let p = Path::new(&f.path);
            current_hash(p, fsx::is_dinput8(p)) != f.after
        })
        .map(|f| f.path.clone())
        .collect()
}

fn blocked_code(c: &Change) -> Option<&'static str> {
    if c.undone.is_some() {
        Some("undone")
    } else if c.incomplete {
        Some("incomplete")
    } else if c.expired {
        Some("expired")
    } else {
        None
    }
}

/// Entries, newest first; `game` filters (None = all). With `check` each entry's files are hashed
/// to tell whether undo is possible now.
pub fn list(data: &Path, game: Option<&str>, check: bool) -> Vec<ChangeView> {
    let ix = {
        let _g = lock();
        load(data)
    };
    ix.changes
        .into_iter()
        .rev()
        .filter(|c| game.is_none_or(|g| c.games.iter().any(|x| x == g)))
        .map(|c| {
            let mut blocked = blocked_code(&c).map(String::from);
            let changed = if blocked.is_none() && check { changed_files(&c) } else { vec![] };
            if blocked.is_none() && !changed.is_empty() {
                blocked = Some("changed".into());
            }
            ChangeView { change: c, blocked, changed }
        })
        .collect()
}

/// Process names that must not run while a change of these games is undone.
pub fn processes_for(games: &[String]) -> Vec<String> {
    let mut v: Vec<String> = games.iter().flat_map(|g| crate::discord::process_names(g, None)).collect();
    if games.iter().any(|g| g == "tmnf" || g == "tmuf") {
        v.push("tmloader.exe".into());
        v.push("shimrun.exe".into());
    }
    v.sort();
    v.dedup();
    v
}

/// Undoes one entry. `running` = names of running processes (lower case is fine).
pub fn undo(data: &Path, id: &str, running: &[String]) -> UndoResult {
    let _g = lock();
    let mut ix = load(data);
    let Some(pos) = ix.changes.iter().position(|c| c.id == id) else { return UndoResult::no("missing") };
    let c = ix.changes[pos].clone();
    if let Some(code) = blocked_code(&c) {
        return UndoResult::no(code);
    }
    let procs = processes_for(&c.games);
    if let Some(p) = running.iter().find(|r| procs.iter().any(|x| x.eq_ignore_ascii_case(r))) {
        return UndoResult { detail: Some(p.clone()), ..UndoResult::no("running") };
    }
    let changed = changed_files(&c);
    if !changed.is_empty() {
        let set: BTreeSet<String> = changed.iter().map(|p| norm(Path::new(p))).collect();
        let later: Vec<String> = ix.changes[pos + 1..]
            .iter()
            .filter(|l| l.undone.is_none() && l.files.iter().any(|f| set.contains(&norm(Path::new(&f.path)))))
            .map(|l| l.title.clone())
            .collect();
        return UndoResult { files: changed, later, ..UndoResult::no("changed") };
    }
    // Every copy must be there before anything is touched.
    let store = blobs(data);
    for f in &c.files {
        if let Some(h) = &f.before {
            if !store.join(h).is_file() {
                ix.changes[pos].expired = true;
                let _ = save(data, &ix);
                return UndoResult::no("expired");
            }
        }
    }
    // 1. Stage every file to restore next to its target.
    let mut staged: Vec<(PathBuf, PathBuf)> = vec![];
    let cleanup = |staged: &[(PathBuf, PathBuf)]| {
        for (t, _) in staged {
            let _ = std::fs::remove_file(t);
        }
    };
    for f in &c.files {
        let Some(h) = &f.before else { continue };
        let target = PathBuf::from(&f.path);
        if !allowed(&target, fsx::is_dinput8(&target)) {
            cleanup(&staged);
            return UndoResult { detail: Some(format!("refusing to touch {}", target.display())), ..UndoResult::no("error") };
        }
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = target.with_file_name(format!(".{name}.{}.tmhub-undo", std::process::id()));
        let r = (|| -> std::io::Result<()> {
            if let Some(d) = target.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::copy(store.join(h), &tmp)?;
            // The copy must still be the recorded content.
            if hash_file(&tmp, None)?.0 != *h {
                return Err(std::io::Error::other("stored copy is damaged"));
            }
            Ok(())
        })();
        if let Err(e) = r {
            let _ = std::fs::remove_file(&tmp);
            cleanup(&staged);
            return UndoResult { detail: Some(format!("{}: {e}", target.display())), ..UndoResult::no("error") };
        }
        staged.push((tmp, target));
    }
    // 2. Swap in, delete what the operation added.
    let mut done = vec![];
    let mut errors = vec![];
    for (tmp, target) in &staged {
        match std::fs::rename(tmp, target) {
            Ok(()) => done.push(target.to_string_lossy().into_owned()),
            Err(e) => {
                let _ = std::fs::remove_file(tmp);
                errors.push(format!("{}: {e}", target.display()));
            }
        }
    }
    for f in c.files.iter().filter(|f| f.before.is_none()) {
        let p = Path::new(&f.path);
        if !allowed(p, fsx::is_dinput8(p)) {
            continue;
        }
        match std::fs::remove_file(p) {
            Ok(()) => done.push(f.path.clone()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => errors.push(format!("{}: {e}", p.display())),
        }
    }
    // 3. Folders it created, deepest first, only when empty.
    let mut dirs: Vec<&String> = c.dirs_created.iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));
    for d in dirs {
        let _ = std::fs::remove_dir(d);
    }
    ix.changes[pos].undone = Some(fsx::now_iso());
    collect(data, &mut ix, MAX_STORE_BYTES);
    let _ = save(data, &ix);
    if errors.is_empty() {
        UndoResult { ok: true, code: "done".into(), files: done, later: vec![], detail: None }
    } else {
        UndoResult { ok: false, code: "error".into(), files: done, later: vec![], detail: Some(errors.join("\n")) }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    pub entries: usize,
    pub bytes: u64,
    pub max_bytes: u64,
    pub dir: String,
}

pub fn info(data: &Path) -> StoreInfo {
    let bytes = std::fs::read_dir(blobs(data)).into_iter().flatten().flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum();
    StoreInfo { entries: load(data).changes.len(), bytes, max_bytes: MAX_STORE_BYTES, dir: root(data).to_string_lossy().into_owned() }
}

// ------------------------------------------------------------------ commands

pub mod cmd {
    use super::*;
    use crate::state::AppState;

    #[tauri::command]
    pub async fn history_list(app: tauri::AppHandle, game: Option<String>) -> Vec<ChangeView> {
        crate::bg::run(move || -> Vec<ChangeView> {
            let st = tauri::Manager::state::<AppState>(&app);
            list(&st.data_dir, game.as_deref(), true)
        })
        .await
    }

    #[tauri::command]
    pub async fn history_undo(app: tauri::AppHandle, id: String) -> UndoResult {
        crate::bg::run(move || -> UndoResult {
            let st = tauri::Manager::state::<AppState>(&app);
            let r = undo(&st.data_dir, &id, &crate::platform::running_process_names());
            if r.ok {
                crate::commands::refresh_tmloader(&st);
            }
            r
        })
        .await
    }

    #[tauri::command]
    pub async fn history_info(app: tauri::AppHandle) -> StoreInfo {
        crate::bg::run(move || -> StoreInfo {
            let st = tauri::Manager::state::<AppState>(&app);
            info(&st.data_dir)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(t: &str) -> Op {
        Op::new(&["tmnf", "tmuf"], "mod-install", t)
    }
    fn w(p: &Path, b: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b).unwrap();
    }

    #[test]
    fn install_into_new_folder_is_undone_completely() {
        let data = tempfile::tempdir().unwrap();
        let game = tempfile::tempdir().unwrap();
        let mod_dir = game.path().join("products").join("TMVS").join("1.4.2");
        let rec = Recorder::start(data.path(), op("TMVS 1.4.2"), vec![Watch::Tree(mod_dir.clone())]);
        w(&mod_dir.join("TMVS.dll"), b"dll");
        w(&mod_dir.join("shaders").join("a.fx"), b"fx");
        let id = rec.finish().expect("an entry");
        let l = list(data.path(), Some("tmuf"), true);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].change.files.len(), 2);
        assert!(l[0].change.files.iter().all(|f| f.before.is_none()));
        assert!(l[0].blocked.is_none());
        assert!(list(data.path(), Some("tm2020"), true).is_empty());
        let r = undo(data.path(), &id, &[]);
        assert!(r.ok, "{r:?}");
        assert_eq!(r.files.len(), 2);
        assert!(!mod_dir.exists(), "created folders are gone");
        assert!(!game.path().join("products").exists(), "parents created by the install too");
        // Twice: refused.
        assert_eq!(undo(data.path(), &id, &[]).code, "undone");
        assert_eq!(list(data.path(), None, true)[0].blocked.as_deref(), Some("undone"));
    }

    #[test]
    fn overwritten_and_deleted_files_come_back_exactly() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let prof = dir.path().join("profiles");
        w(&prof.join("Default.yaml"), b"mods: []\r\n");
        w(&prof.join("Old.yaml"), b"old profile");
        record(data.path(), op("Profile"), vec![Watch::Tree(prof.clone())], || {
            std::fs::write(prof.join("Default.yaml"), b"mods:\n- TMVS\n").unwrap();
            std::fs::remove_file(prof.join("Old.yaml")).unwrap();
        });
        let l = list(data.path(), None, true);
        assert_eq!(l.len(), 1);
        let c = &l[0].change;
        assert!(c.files.iter().any(|f| f.path.ends_with("Old.yaml") && f.after.is_none() && f.before.is_some()));
        let r = undo(data.path(), &c.id, &[]);
        assert!(r.ok, "{r:?}");
        assert_eq!(std::fs::read(prof.join("Default.yaml")).unwrap(), b"mods: []\r\n");
        assert_eq!(std::fs::read(prof.join("Old.yaml")).unwrap(), b"old profile");
        assert!(prof.exists(), "a folder that existed before stays");
        // No leftovers of staging.
        assert!(std::fs::read_dir(&prof).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("tmhub")));
        // The copies are no longer needed.
        assert_eq!(info(data.path()).bytes, 0);
    }

    #[test]
    fn nothing_changed_records_nothing_and_keeps_no_copies() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        w(&dir.path().join("a.txt"), b"same");
        let id = Recorder::start(data.path(), op("x"), vec![Watch::Shallow(dir.path().to_path_buf())]).finish();
        assert!(id.is_none());
        assert!(list(data.path(), None, false).is_empty());
        assert_eq!(info(data.path()).bytes, 0);
    }

    #[test]
    fn refuses_when_a_file_changed_since_and_names_the_later_change() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("d3d9.dll");
        w(&f, b"v1");
        record(data.path(), op("Mod A"), vec![Watch::File(f.clone())], || std::fs::write(&f, b"v2").unwrap());
        record(data.path(), op("Mod B"), vec![Watch::File(f.clone())], || std::fs::write(&f, b"v3").unwrap());
        let l = list(data.path(), None, true);
        assert_eq!(l.len(), 2);
        let older = &l[1];
        assert_eq!(older.blocked.as_deref(), Some("changed"));
        let r = undo(data.path(), &older.change.id, &[]);
        assert_eq!(r.code, "changed");
        assert_eq!(r.later, vec!["Mod B".to_string()]);
        assert_eq!(std::fs::read(&f).unwrap(), b"v3", "nothing touched");
        // Newest first, then the older one works.
        assert!(undo(data.path(), &l[0].change.id, &[]).ok);
        assert_eq!(std::fs::read(&f).unwrap(), b"v2");
        assert!(undo(data.path(), &older.change.id, &[]).ok);
        assert_eq!(std::fs::read(&f).unwrap(), b"v1");
        // Changed by hand after the install: refused too.
        record(data.path(), op("Mod C"), vec![Watch::File(f.clone())], || std::fs::write(&f, b"c").unwrap());
        std::fs::write(&f, b"edited by hand").unwrap();
        let c = list(data.path(), None, true).remove(0);
        assert_eq!(c.changed.len(), 1);
        assert_eq!(undo(data.path(), &c.change.id, &[]).code, "changed");
    }

    #[test]
    fn refuses_while_the_game_runs() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.ini");
        record(data.path(), op("x"), vec![Watch::File(f.clone())], || w(&f, b"1"));
        let id = list(data.path(), None, false)[0].change.id.clone();
        let r = undo(data.path(), &id, &["TmForever.exe".into()]);
        assert_eq!(r.code, "running");
        assert_eq!(r.detail.as_deref(), Some("TmForever.exe"));
        assert!(f.exists());
        assert!(undo(data.path(), &id, &["explorer.exe".into()]).ok);
        assert!(!f.exists());
    }

    #[test]
    fn store_cap_expires_the_oldest_first() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut ids = vec![];
        for i in 0..3u8 {
            let f = dir.path().join(format!("f{i}.bin"));
            w(&f, &vec![i; 1000]);
            let rec = Recorder::start_capped(data.path(), op(&format!("op{i}")), vec![Watch::File(f.clone())], 2500);
            std::fs::write(&f, b"new").unwrap();
            ids.push(rec.finish().unwrap());
        }
        let l = list(data.path(), None, false);
        let expired: Vec<_> = l.iter().filter(|c| c.blocked.as_deref() == Some("expired")).map(|c| c.change.title.clone()).collect();
        assert_eq!(expired, vec!["op0".to_string()]);
        assert!(info(data.path()).bytes <= 2500);
        assert_eq!(undo(data.path(), &ids[0], &[]).code, "expired");
        assert!(undo(data.path(), &ids[2], &[]).ok);
        assert_eq!(std::fs::read(dir.path().join("f2.bin")).unwrap(), vec![2u8; 1000]);
    }

    #[test]
    fn dinput8_only_when_named() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let d8 = dir.path().join("dinput8.dll");
        // A folder watch never reads it.
        let rec = Recorder::start(data.path(), op("tree"), vec![Watch::Shallow(dir.path().to_path_buf())]);
        w(&d8, b"loader");
        assert!(rec.finish().is_none());
        // Named on purpose (Horizon Host install): recorded and undone.
        let rec = Recorder::start(data.path(), Op::for_game("tm-sunrise", "host-install", "Horizon Host"), vec![Watch::File(d8.clone()), Watch::Tree(dir.path().join("horizon"))]);
        std::fs::write(&d8, b"host").unwrap();
        w(&dir.path().join("horizon").join("host.dll"), b"h");
        let id = rec.finish().unwrap();
        let c = &list(data.path(), Some("tm-sunrise"), true)[0];
        assert_eq!(c.change.files.len(), 2);
        assert!(undo(data.path(), &id, &[]).ok);
        assert_eq!(std::fs::read(&d8).unwrap(), b"loader");
        assert!(!dir.path().join("horizon").exists());
    }

    #[test]
    fn damaged_or_missing_copy_is_reported_not_half_applied() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        w(&a, b"a1");
        w(&b, b"b1");
        record(data.path(), op("two"), vec![Watch::Shallow(dir.path().to_path_buf())], || {
            std::fs::write(&a, b"a2").unwrap();
            std::fs::write(&b, b"b2").unwrap();
        });
        let c = list(data.path(), None, false).remove(0);
        // Damage one stored copy: the undo stops before touching anything.
        let h = c.change.files.iter().find(|f| f.path.ends_with("b.txt")).unwrap().before.clone().unwrap();
        std::fs::write(blobs(data.path()).join(&h), b"rot").unwrap();
        let r = undo(data.path(), &c.change.id, &[]);
        assert_eq!(r.code, "error");
        assert_eq!(std::fs::read(&a).unwrap(), b"a2", "nothing swapped in");
        assert_eq!(std::fs::read(&b).unwrap(), b"b2");
        // Missing copy: expired.
        std::fs::remove_file(blobs(data.path()).join(&h)).unwrap();
        assert_eq!(undo(data.path(), &c.change.id, &[]).code, "expired");
    }

    #[test]
    fn for_game_maps_forever_and_instances() {
        assert_eq!(Op::for_game("tmuf@abc", "x", "t").games, vec!["tmnf", "tmuf"]);
        assert_eq!(Op::for_game("tm-sunrise", "x", "t").games, vec!["tm-sunrise"]);
        assert!(processes_for(&["tmnf".into()]).contains(&"tmloader.exe".to_string()));
    }
}
