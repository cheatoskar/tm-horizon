//! Horizon Host: the in-game mod host (docs/design/horizon-host.md).
//!
//! - ESWC, Sunrise, Original: the Legacy Loader (`dinput8.dll`) + `horizon\host.dll` next to the
//!   game exe. Installed only after the user confirmed the list of every file; any `dinput8.dll`
//!   already there (e.g. the ESWC Autosave loader) is backed up first and can be put back with one
//!   click. This module is the second (after eswcmods) and only other place that writes a
//!   `dinput8.dll`, and only into a scanned game folder or one of TM Horizon's own instances.
//! - Nations/United Forever: the TMLoader product "Horizon Host" (experimental), ticked in the
//!   TMLoader profiles the user picks.
//! - Plugins: `<host root>\plugins\<id>\`; which ones load is decided by TM Horizon, which writes
//!   `<host root>\profile.json` before each start (safe mode = no plugins).
//! - Source: tonight a local folder (the host repo's `dist`), every file checked against the
//!   SHA-256 in its manifest; later the GitHub releases of cheatoskar/horizon-host (TODO).
//!
//! Everything the host itself reads or writes (file names, profile.json, plugin.json, manifest)
//! is in [`format`], so aligning with the host's spec is a change in one place.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::fsx;

/// The host's file formats (proposal: docs/profile-json-proposal.md; the host's own spec wins).
pub mod format {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    /// Legacy games: the host root is `<game>\horizon`.
    pub const HOST_DIR: &str = "horizon";
    pub const LOADER: &str = "dinput8.dll";
    /// A dinput8.dll that was there before (ESWC Autosave's loader ...) is renamed to this; the
    /// Legacy Loader loads it and forwards DirectInput8Create through it (chaining).
    pub const CHAIN: &str = "dinput8.chain.dll";
    pub const HOST_DLL: &str = "host.dll";
    /// Next to host.dll.
    pub const PROFILE: &str = "profile.json";
    pub const PLUGINS: &str = "plugins";
    pub const LOGS: &str = "logs";
    pub const PLUGIN_JSON: &str = "plugin.json";
    pub const MANIFEST: &str = "manifest.json";
    /// TM Horizon's own install record in the host root (the host ignores it).
    pub const RECORD: &str = "tmhorizon-install.json";
    pub const PROFILE_SCHEMA: u32 = 1;
    /// TMLoader product id (Forever).
    pub const TML_PRODUCT: &str = "Horizon Host";
    /// Plugin that takes over ESWC Autosave (folder name in the host repo: plugins\eswc-autosave;
    /// "autosave" is accepted too).
    pub const AUTOSAVE_IDS: [&str; 2] = ["eswc-autosave", "autosave"];
    /// Dev source layout: `<dist>\legacy\manifest.json`, `<dist>\tmloader\Horizon Host\<v>\manifest.json`.
    pub const DEV_LEGACY: &str = "legacy";
    pub const DEV_TML: &str = "tmloader";
    /// Game ids in the order of the ABI bit mask (ESWC=1, SUNRISE=2, ORIGINAL=4, TMNF=8, TMUF=16).
    pub const MASK_GAMES: [&str; 5] = ["tmn-eswc", "tm-sunrise", "tm-original", "tmnf", "tmuf"];

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    pub struct ProfilePlugin {
        pub id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub version: Option<String>,
        #[serde(default = "yes")]
        pub enabled: bool,
    }

    fn yes() -> bool {
        true
    }

    /// `profile.json` as the host reads it (horizon-host src/common/profile.cpp, format 1). An
    /// override: without it the host loads every installed plugin (enabled_by_default).
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    pub struct Profile {
        pub format: u32,
        /// Host game key: eswc, sunrise, original, tmnf, tmuf.
        pub game: String,
        pub profile: String,
        pub safe_mode: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub menu_key: Option<String>,
        pub plugins: Vec<ProfilePlugin>,
        /// Where the host may append play events (finishes, starts, respawns) as JSON lines for the
        /// launcher's statistics (docs/design/host-stats-channel.md). Older hosts ignore it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub stats_dir: Option<String>,
        pub written_by: String,
        pub written_at: String,
    }

    /// Launcher game id -> the host's game key.
    pub fn host_game_key(game: &str) -> &'static str {
        match game {
            "tmn-eswc" => "eswc",
            "tm-sunrise" => "sunrise",
            "tm-original" => "original",
            "tmnf" => "tmnf",
            "tmuf" => "tmuf",
            _ => "",
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    pub struct ManifestFile {
        pub path: String,
        pub sha256: String,
    }

    #[derive(Debug, Clone, PartialEq)]
    pub struct Manifest {
        pub version: String,
        pub files: Vec<ManifestFile>,
    }

    /// `{version, files: [{path, sha256}]}` or `files: {path: sha256}`; `name`/`file` and `hash`
    /// are accepted for path/sha256.
    pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
        let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("manifest.json: {e}"))?;
        let version = v["version"].as_str().map(|s| s.trim().trim_start_matches(['v', 'V']).to_string()).filter(|s| !s.is_empty()).ok_or("manifest.json has no version")?;
        let mut files = Vec::new();
        match &v["files"] {
            Value::Array(a) => {
                for f in a {
                    let path = f["path"].as_str().or_else(|| f["name"].as_str()).or_else(|| f["file"].as_str()).ok_or("manifest.json: a file without path")?;
                    let sha = f["sha256"].as_str().or_else(|| f["hash"].as_str()).ok_or_else(|| format!("manifest.json: no sha256 for {path}"))?;
                    files.push(ManifestFile { path: path.replace('\\', "/"), sha256: sha.trim().to_lowercase() });
                }
            }
            Value::Object(m) => {
                for (path, sha) in m {
                    let sha = sha.as_str().ok_or_else(|| format!("manifest.json: no sha256 for {path}"))?;
                    files.push(ManifestFile { path: path.replace('\\', "/"), sha256: sha.trim().to_lowercase() });
                }
            }
            _ => return Err("manifest.json has no files".into()),
        }
        if files.is_empty() {
            return Err("manifest.json lists no files".into());
        }
        Ok(Manifest { version, files })
    }

    /// `plugin.json` of a plugin.
    #[derive(Debug, Clone, Serialize, PartialEq, Default)]
    #[serde(rename_all = "camelCase")]
    pub struct PluginMeta {
        pub id: String,
        pub name: String,
        pub version: Option<String>,
        pub description: Option<String>,
        /// Launcher game ids; empty = every game the host runs on.
        pub games: Vec<String>,
        /// "solo-only" | "online-ok"
        pub online: Option<String>,
        /// false = off until switched on (when there is no profile.json).
        pub enabled_by_default: bool,
        /// Loaded only when the game starts (plugin.json `startup_only`); clients from 0.3.0 on load
        /// every other module while the game runs.
        pub startup_only: bool,
    }

    fn game_id(s: &str) -> Option<&'static str> {
        Some(match s.to_lowercase().as_str() {
            "tmn-eswc" | "eswc" | "nations-eswc" => "tmn-eswc",
            "tm-sunrise" | "sunrise" => "tm-sunrise",
            "tm-original" | "original" => "tm-original",
            "tmnf" | "nations-forever" => "tmnf",
            "tmuf" | "united-forever" => "tmuf",
            _ => return None,
        })
    }

    pub fn parse_plugin(text: &str, folder_id: &str) -> Option<PluginMeta> {
        let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
        let id = v["id"].as_str().unwrap_or(folder_id).to_string();
        if !v.is_object() {
            return None;
        }
        let games = match &v["games"] {
            Value::Array(a) => a.iter().filter_map(|g| g.as_str().and_then(game_id)).map(String::from).collect(),
            Value::Number(n) => {
                let m = n.as_u64().unwrap_or(0);
                MASK_GAMES.iter().enumerate().filter(|(i, _)| m & (1 << i) != 0).map(|(_, g)| g.to_string()).collect()
            }
            _ => vec![],
        };
        Some(PluginMeta {
            name: v["name"].as_str().unwrap_or(&id).to_string(),
            version: v["version"].as_str().map(String::from),
            description: v["description"].as_str().map(String::from),
            online: v["online"].as_str().map(String::from),
            enabled_by_default: v["enabled_by_default"].as_bool().unwrap_or(true),
            startup_only: v["startup_only"].as_bool().unwrap_or(false),
            games,
            id,
        })
    }

    pub fn profile_json(p: &Profile) -> String {
        serde_json::to_string_pretty(p).unwrap_or_default()
    }
}

use format::*;

const MAX_FILE: u64 = 64 << 20;
const MAX_TOTAL: u64 = 256 << 20;
const LOG_TAIL: u64 = 96 * 1024;

/// Games the Legacy Loader is for.
pub fn is_legacy(game: &str) -> bool {
    matches!(game, "tmn-eswc" | "tm-sunrise" | "tm-original")
}

pub fn is_forever(game: &str) -> bool {
    matches!(game, "tmnf" | "tmuf")
}

/// Builds the host pins (design doc, "Exe pinning"); unknown exe = the host stays off.
/// Original: only the community Online Patch v2 exe (7,883,264 bytes, PE time 5d337477); the retail
/// exes are encrypted and stay play-only.
pub const KNOWN_EXES: [(&str, &str, &str); 3] = [
    ("tmn-eswc", "983bd12724739dcb0f876aeb3a4259154b068940f5167f57ede750ca452d8068", "Nations ESWC 1.80 (unofficial)"),
    ("tm-sunrise", "e59dfc7eaa5314e85b2b0df6f40ef7ba01a23bd5a9525f84407f5dff301df4fe", "Sunrise (Win10 repack)"),
    ("tm-original", "75e129d769f4595ddde54a8ef484162915bc2bf998c1a2139cc963294fe8175e", "Original (Online Patch v2)"),
];

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

// ------------------------------------------------------------------ paths and guarded writes

/// A relative path from a manifest: `/`-separated, no `..`, no drive, no stream, no empty parts.
pub fn safe_rel(rel: &str) -> Result<String, String> {
    let r = rel.replace('\\', "/");
    let r = r.trim_start_matches("./");
    if r.is_empty() || r.starts_with('/') || r.contains(':') {
        return Err(format!("bad path: {rel}"));
    }
    for part in r.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.trim_end_matches(['.', ' ']) != part {
            return Err(format!("bad path: {rel}"));
        }
    }
    Ok(r.to_string())
}

fn is_loader_rel(rel: &str) -> bool {
    rel.eq_ignore_ascii_case(LOADER)
}

fn rel_path(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

/// The game id of a legacy game folder (from its exe). The folder must not be blocked.
pub fn legacy_game_of(dir: &Path) -> Result<&'static str, String> {
    if fsx::blocked(dir) {
        return Err("This folder is protected (StarForce ESWC); nothing is written there.".into());
    }
    if !fsx::is_dir(dir) {
        return Err(format!("Folder not found: {}", dir.display()));
    }
    crate::scan::classify(dir).into_iter().map(|(g, _)| g).find(|g| is_legacy(g)).ok_or_else(|| "No ESWC, Sunrise or Original exe in this folder".to_string())
}

/// The one function that opens a path in a legacy game folder for writing or deleting. Only
/// `dinput8.dll` (top level) and files under `horizon\` are allowed.
fn legacy_target(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = safe_rel(rel)?;
    legacy_game_of(dir)?;
    let top = rel.split('/').next().unwrap_or("");
    if !(is_loader_rel(&rel) || rel.eq_ignore_ascii_case(CHAIN) || (top.eq_ignore_ascii_case(HOST_DIR) && rel.contains('/'))) {
        return Err(format!("not a Horizon Client file: {rel}"));
    }
    if !is_loader_rel(&rel) && rel.split('/').any(|p| p.eq_ignore_ascii_case(LOADER)) {
        return Err(format!("not a Horizon Client file: {rel}"));
    }
    let p = rel_path(dir, &rel);
    if let Ok(m) = std::fs::symlink_metadata(&p) {
        if m.file_type().is_symlink() {
            return Err(format!("refusing a link: {}", p.display()));
        }
    }
    if !is_loader_rel(&rel) {
        fsx::check(&p)?;
    }
    Ok(p)
}

/// Files under a base folder (TMLoader version folder or a legacy game folder's horizon root).
fn base_target(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = safe_rel(rel)?;
    if rel.split('/').any(|p| p.eq_ignore_ascii_case(LOADER)) {
        return Err(format!("refusing {rel}"));
    }
    let p = rel_path(base, &rel);
    fsx::check(&p)?;
    Ok(p)
}

/// Where a file of a target lives (legacy: game folder; TMLoader: version folder).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Legacy,
    Tml,
}

fn path_of(kind: Kind, base: &Path, rel: &str) -> Result<PathBuf, String> {
    match kind {
        Kind::Legacy => legacy_target(base, rel),
        Kind::Tml => base_target(base, rel),
    }
}

fn exists(kind: Kind, base: &Path, rel: &str) -> bool {
    path_of(kind, base, rel).map(|p| p.is_file()).unwrap_or(false)
}

fn put(kind: Kind, base: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let p = path_of(kind, base, rel)?;
    if is_loader_rel(rel) {
        // fsx::write refuses every dinput8.dll; this is the confirmed exception (temp + rename).
        let tmp = p.with_file_name(format!("{LOADER}.tmhorizon-new"));
        std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
        return std::fs::rename(&tmp, &p).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{}: {e}", p.display())
        });
    }
    fsx::write(&p, bytes)
}

fn del(kind: Kind, base: &Path, rel: &str) -> Result<(), String> {
    let p = path_of(kind, base, rel)?;
    if p.is_file() {
        std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(())
}

fn read_existing(kind: Kind, base: &Path, rel: &str) -> Option<Vec<u8>> {
    if is_loader_rel(rel) {
        return None; // never read or compared (house rule); always treated as "replace"
    }
    std::fs::read(path_of(kind, base, rel).ok()?).ok()
}

// ------------------------------------------------------------------ backups

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub created: String,
    pub reason: String,
    pub dir: String,
    pub files: Vec<String>,
}

pub fn backup_root(data: &Path) -> PathBuf {
    data.join("TM Horizon backups").join("horizon")
}

fn slug(s: &str) -> String {
    let s: String = s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    s.split('-').filter(|x| !x.is_empty()).collect::<Vec<_>>().join("-").chars().take(40).collect()
}

/// Copies the named files (those that exist) into a new backup folder. None = nothing to back up.
fn backup(kind: Kind, base: &Path, root: &Path, rels: &[String], reason: &str) -> Result<Option<String>, String> {
    let have: Vec<&String> = rels.iter().filter(|r| exists(kind, base, r)).collect();
    if have.is_empty() {
        return Ok(None);
    }
    let id = format!("{}-{}", fsx::stamp(), slug(reason));
    let bdir = root.join(&id);
    for r in &have {
        let src = path_of(kind, base, r)?;
        let dst = rel_path(&bdir.join("files"), r);
        std::fs::create_dir_all(dst.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
    }
    let m = serde_json::json!({ "created": fsx::now_iso(), "reason": reason, "dir": base.to_string_lossy(), "kind": if kind == Kind::Legacy { "legacy" } else { "tml" }, "files": have });
    std::fs::write(bdir.join("manifest.json"), m.to_string()).map_err(|e| e.to_string())?;
    Ok(Some(id))
}

/// Backups of one folder, newest first.
pub fn list_backups(root: &Path, base: &Path) -> Vec<Backup> {
    let want = fsx::norm(base);
    let mut out: Vec<Backup> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.path().join("manifest.json")).ok()?).ok()?;
            let dir = m["dir"].as_str().unwrap_or("").to_string();
            (fsx::norm(Path::new(&dir)) == want).then(|| Backup {
                id: e.file_name().to_string_lossy().into(),
                created: m["created"].as_str().unwrap_or("").into(),
                reason: m["reason"].as_str().unwrap_or("").into(),
                files: m["files"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                dir,
            })
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

fn backup_by_id(root: &Path, base: &Path, id: &str) -> Result<Backup, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err("bad backup id".into());
    }
    list_backups(root, base).into_iter().find(|b| b.id == id).ok_or_else(|| "Backup not found for this folder".into())
}

fn put_back(kind: Kind, base: &Path, root: &Path, b: &Backup) -> Result<(), String> {
    for r in &b.files {
        let bytes = std::fs::read(rel_path(&root.join(&b.id).join("files"), r)).map_err(|e| e.to_string())?;
        put(kind, base, r, &bytes)?;
    }
    Ok(())
}

/// Puts a backup's files back (the current ones are backed up first).
pub fn restore(dir: &Path, data: &Path, id: &str) -> Result<String, String> {
    let root = backup_root(data);
    let b = backup_by_id(&root, dir, id)?;
    backup(Kind::Legacy, dir, &root, &b.files, "before restore")?;
    put_back(Kind::Legacy, dir, &root, &b)?;
    // A restored foreign dinput8.dll is not the Legacy Loader any more (unless the backup also
    // brought back the install record that describes it).
    let rec_rel = format!("{HOST_DIR}/{RECORD}");
    if b.files.iter().any(|f| is_loader_rel(f)) && !b.files.iter().any(|f| f.eq_ignore_ascii_case(&rec_rel)) {
        if let Some(mut rec) = read_record(&dir.join(HOST_DIR)) {
            rec.files.retain(|f| !is_loader_rel(f));
            rec.loader_size = None;
            write_record(Kind::Legacy, dir, &rec)?;
        }
    }
    Ok(format!("Restored {}", b.files.join(", ")))
}

// ------------------------------------------------------------------ install record

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InstallRecord {
    pub version: String,
    pub source: String,
    /// Relative to the game folder (legacy) or the version folder (TMLoader).
    pub files: Vec<String>,
    pub sha256: BTreeMap<String, String>,
    /// Size of the Legacy Loader we wrote (dinput8.dll is never read; a size change = replaced).
    pub loader_size: Option<u64>,
    pub installed_at: String,
    pub backup_id: Option<String>,
    /// Backup holding the dinput8.dll that was there before the first install (ESWC Autosave ...).
    pub previous_backup: Option<String>,
    pub previous_owner: Option<String>,
    /// Owner of the dinput8.chain.dll the Legacy Loader loads (None = no chain).
    pub chained: Option<String>,
}

pub fn read_record(host_root: &Path) -> Option<InstallRecord> {
    serde_json::from_str(&fsx::read_string(&host_root.join(RECORD))?).ok()
}

fn write_record(kind: Kind, base: &Path, rec: &InstallRecord) -> Result<(), String> {
    let rel = if kind == Kind::Legacy { format!("{HOST_DIR}/{RECORD}") } else { RECORD.to_string() };
    put(kind, base, &rel, serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?.as_bytes())
}

// ------------------------------------------------------------------ source (dev folder / GitHub)

/// Verified files of one package (legacy or TMLoader), relative paths with `/`.
#[derive(Debug, Clone)]
pub struct Package {
    pub version: String,
    pub source: String,
    pub files: Vec<(String, Vec<u8>)>,
}

impl Package {
    /// Files of the host itself (no plugins).
    pub fn core(&self, plugin_prefix: &str) -> Vec<(String, Vec<u8>)> {
        self.files.iter().filter(|(r, _)| !r.to_lowercase().starts_with(plugin_prefix)).cloned().collect()
    }

    /// Plugin id -> (files relative to the package, plugin.json).
    pub fn plugins(&self, plugin_prefix: &str) -> BTreeMap<String, (Vec<(String, Vec<u8>)>, Option<PluginMeta>)> {
        let mut out: BTreeMap<String, (Vec<(String, Vec<u8>)>, Option<PluginMeta>)> = BTreeMap::new();
        for (r, b) in &self.files {
            let Some(rest) = r.get(plugin_prefix.len()..).filter(|_| r.to_lowercase().starts_with(plugin_prefix)) else { continue };
            let Some((id, file)) = rest.split_once('/') else { continue };
            let e = out.entry(id.to_string()).or_default();
            e.0.push((r.clone(), b.clone()));
            if file.eq_ignore_ascii_case(PLUGIN_JSON) {
                e.1 = parse_plugin(&String::from_utf8_lossy(b), id);
            }
        }
        out
    }
}

/// Reads and checks every file of a manifest folder. The source is TM Horizon's input (the host
/// repo's build output), so its dinput8.dll is read here; nothing of the user's is.
pub fn load_package(folder: &Path, source: &str) -> Result<Package, String> {
    if fsx::blocked(folder) {
        return Err("refusing this folder".into());
    }
    let text = std::fs::read_to_string(folder.join(MANIFEST)).map_err(|e| format!("{}: {e}", folder.join(MANIFEST).display()))?;
    let m = parse_manifest(&text)?;
    let mut total = 0u64;
    let mut files = Vec::new();
    for f in &m.files {
        let rel = safe_rel(&f.path)?;
        let p = rel_path(folder, &rel);
        let len = std::fs::metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?.len();
        total += len;
        if len > MAX_FILE || total > MAX_TOTAL {
            return Err("The package is bigger than TM Horizon allows".into());
        }
        let bytes = std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        if sha256_hex(&bytes) != f.sha256 {
            return Err(format!("Checksum of {rel} does not match the manifest; nothing was installed"));
        }
        files.push((rel, bytes));
    }
    Ok(Package { version: m.version, source: source.into(), files })
}

/// The host repo's `dist\manifest.json` (horizon-host tools/package.py): `{version, packages:
/// [{game, zip, sha256, files:[{path, sha256}]}], tmloader_product: {folder, files}}`.
fn host_manifest(dist: &Path) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(std::fs::read_to_string(dist.join(MANIFEST)).ok()?.trim_start_matches('\u{feff}')).ok()?;
    v.get("packages").is_some().then_some(v)
}

/// The host package's zip for a game: checked against the zip's and every file's SHA-256, then
/// mapped to the game-folder layout (`horizon\loader\dinput8.dll` -> `dinput8.dll`; the
/// package's install scripts and readme are left out, TM Horizon installs itself).
fn load_host_zip(dist: &Path, m: &serde_json::Value, game: &str) -> Result<Package, String> {
    let version = m["version"].as_str().ok_or("manifest.json has no version")?.to_string();
    let key = host_game_key(game);
    let pkg = m["packages"].as_array().into_iter().flatten().find(|p| p["game"].as_str() == Some(key)).ok_or_else(|| format!("Horizon Client {version} has no build for this game yet"))?;
    let zip_rel = safe_rel(pkg["zip"].as_str().ok_or("manifest.json: package without zip")?)?;
    let zip_path = rel_path(dist, &zip_rel);
    let meta = std::fs::metadata(&zip_path).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    if meta.len() > MAX_TOTAL {
        return Err("The package is bigger than TM Horizon allows".into());
    }
    let bytes = std::fs::read(&zip_path).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    host_zip_from_bytes(m, game, bytes, &format!("dev:{}", dist.display()))
}

/// The checks and the mapping of a host package zip, whether it came from a folder or from GitHub.
fn host_zip_from_bytes(m: &serde_json::Value, game: &str, bytes: Vec<u8>, source: &str) -> Result<Package, String> {
    use std::io::Read;
    let version = m["version"].as_str().ok_or("manifest.json has no version")?.to_string();
    let key = host_game_key(game);
    let pkg = m["packages"].as_array().into_iter().flatten().find(|p| p["game"].as_str() == Some(key)).ok_or_else(|| format!("Horizon Client {version} has no build for this game yet"))?;
    let zip_rel = safe_rel(pkg["zip"].as_str().ok_or("manifest.json: package without zip")?)?;
    if Some(sha256_hex(&bytes).as_str()) != pkg["sha256"].as_str().map(|x| x.to_lowercase()).as_deref() {
        return Err(format!("Checksum of {zip_rel} does not match the manifest; nothing was installed"));
    }
    let want: HashMap<String, String> = pkg["files"].as_array().into_iter().flatten().filter_map(|f| Some((f["path"].as_str()?.replace('\\', "/").to_lowercase(), f["sha256"].as_str()?.to_lowercase()))).collect();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("{zip_rel}: {e}"))?;
    let mut files = Vec::new();
    let mut total = 0u64;
    for i in 0..z.len() {
        let f = z.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let rel = safe_rel(&f.name().replace('\\', "/"))?;
        let mut buf = Vec::new();
        f.take(MAX_FILE + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        total += buf.len() as u64;
        if buf.len() as u64 > MAX_FILE || total > MAX_TOTAL {
            return Err("The package is bigger than TM Horizon allows".into());
        }
        if want.get(&rel.to_lowercase()) != Some(&sha256_hex(&buf)) {
            return Err(format!("{rel} in {zip_rel} is not in the manifest or its checksum differs; nothing was installed"));
        }
        let l = rel.to_lowercase();
        let mapped = if l == "horizon/loader/dinput8.dll" {
            LOADER.to_string()
        } else if l.starts_with("horizon/loader/") || !l.starts_with("horizon/") {
            continue; // Horizon-Install.cmd, install.ps1, README: the package's own installer
        } else {
            rel
        };
        files.push((mapped, buf));
    }
    Ok(Package { version, source: source.into(), files })
}

/// Version of a dev folder's build (the host repo's `manifest.json`, or TM Horizon's own layout).
pub fn dev_version(dist: &Path) -> Option<String> {
    let read = |p: PathBuf| fsx::read_string(&p).and_then(|t| parse_manifest(&t).ok()).map(|m| m.version);
    host_manifest(dist).and_then(|m| m["version"].as_str().map(|v| v.trim().trim_start_matches(['v', 'V']).to_string())).or_else(|| read(dist.join(DEV_LEGACY).join(MANIFEST))).or_else(|| read(dist.join(MANIFEST)))
}

/// The legacy package for a game from a dev folder: the host repo's `dist\manifest.json` (per-game
/// zip), else TM Horizon's own layout `<dist>\legacy\manifest.json` (tests, hand-made builds).
pub fn dev_legacy_for(dist: &Path, game: &str) -> Result<Package, String> {
    if let Some(m) = host_manifest(dist) {
        return load_host_zip(dist, &m, game);
    }
    dev_legacy(dist)
}

/// TM Horizon's own layout: `<dist>\legacy\manifest.json` (or the folder itself).
pub fn dev_legacy(dist: &Path) -> Result<Package, String> {
    let f = if dist.join(DEV_LEGACY).join(MANIFEST).is_file() { dist.join(DEV_LEGACY) } else { dist.to_path_buf() };
    if !f.join(MANIFEST).is_file() {
        return Err(format!("No manifest.json in {} (run the host's build.cmd package)", dist.display()));
    }
    load_package(&f, &format!("dev:{}", dist.display()))
}

/// The TMLoader product of the host repo's `dist\manifest.json` (`tmloader_product.files`, paths
/// `<version>/...` and the product's `description.yaml`), every file checked.
fn host_tml(dist: &Path, m: &serde_json::Value) -> Result<(PathBuf, Package), String> {
    let version = m["version"].as_str().ok_or("manifest.json has no version")?.to_string();
    let tp = &m["tmloader_product"];
    let folder = rel_path(dist, &safe_rel(tp["folder"].as_str().ok_or("manifest.json has no TMLoader product")?)?);
    let mut files = Vec::new();
    let prefix = format!("{}/", version.to_lowercase());
    for f in tp["files"].as_array().into_iter().flatten() {
        let rel = safe_rel(f["path"].as_str().ok_or("manifest.json: file without path")?)?;
        let Some(inner) = rel.get(prefix.len()..).filter(|_| rel.to_lowercase().starts_with(&prefix)) else { continue };
        let bytes = std::fs::read(rel_path(&folder, &rel)).map_err(|e| format!("{rel}: {e}"))?;
        if Some(sha256_hex(&bytes).as_str()) != f["sha256"].as_str().map(|x| x.to_lowercase()).as_deref() {
            return Err(format!("Checksum of {rel} does not match the manifest; nothing was installed"));
        }
        files.push((inner.to_string(), bytes));
    }
    if files.is_empty() {
        return Err(format!("No TMLoader files for {version} in the manifest"));
    }
    Ok((folder.join(&version), Package { version, source: format!("dev:{}", dist.display()), files }))
}

/// The newest TMLoader version folder of a dev folder: `<dist>\tmloader\Horizon Host\<v>\`.
pub fn dev_tml(dist: &Path) -> Result<(PathBuf, Package), String> {
    if let Some(m) = host_manifest(dist) {
        return host_tml(dist, &m);
    }
    let pdir = dist.join(DEV_TML).join(TML_PRODUCT);
    let mut versions: Vec<(String, PathBuf)> = std::fs::read_dir(&pdir)
        .map_err(|_| format!("No TMLoader build in {}", pdir.display()))?
        .flatten()
        .filter(|e| e.path().join(MANIFEST).is_file())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    versions.sort_by(|a, b| crate::modindex::cmp_version(&a.0, &b.0));
    let (_, vdir) = versions.pop().ok_or_else(|| format!("No TMLoader build in {}", pdir.display()))?;
    let p = load_package(&vdir, &format!("dev:{}", dist.display()))?;
    Ok((vdir, p))
}

/// Names, sizes and times of every file in a build folder (at most 4000 entries; None = too big
/// to stamp, then nothing is cached).
type Stamp = Vec<(PathBuf, u64, Option<std::time::SystemTime>)>;

fn folder_stamp(dir: &Path) -> Option<Stamp> {
    let mut out = Vec::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in fsx::list(&d) {
            if out.len() >= 4000 {
                return None;
            }
            if e.is_dir {
                todo.push(e.path.clone());
            }
            out.push((e.path, e.len, e.modified));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Some(out)
}

/// A package read from a local build folder, kept while the folder's files stay the same.
/// Reading it checks the SHA-256 of the zip and of every file, which made each refresh of the
/// Horizon Client card (and so every module switch) slow; a changed build is read again.
fn dev_cached<T: Clone>(cache: &Mutex<BTreeMap<String, (Stamp, Result<T, String>)>>, dist: &Path, key: &str, load: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let stamp = folder_stamp(dist);
    let k = format!("{}|{key}", fsx::norm(dist));
    if let Some(s) = &stamp {
        if let Some((old, r)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&k) {
            if old == s {
                return r.clone();
            }
        }
    }
    let r = load();
    if let Some(s) = stamp {
        cache.lock().unwrap_or_else(|e| e.into_inner()).insert(k, (s, r.clone()));
    }
    r
}

/// [`dev_legacy_for`], read again only when the build folder changed.
pub fn dev_legacy_cached(dist: &Path, game: &str) -> Result<Package, String> {
    static CACHE: Mutex<BTreeMap<String, (Stamp, Result<Package, String>)>> = Mutex::new(BTreeMap::new());
    // One host zip per game; TM Horizon's own layout has one package for all games.
    let key = if host_manifest(dist).is_some() { host_game_key(game) } else { "legacy" };
    dev_cached(&CACHE, dist, key, || dev_legacy_for(dist, game))
}

/// [`dev_tml`], read again only when the build folder changed.
pub fn dev_tml_cached(dist: &Path) -> Result<(PathBuf, Package), String> {
    static CACHE: Mutex<BTreeMap<String, (Stamp, Result<(PathBuf, Package), String>)>> = Mutex::new(BTreeMap::new());
    dev_cached(&CACHE, dist, "tml", || dev_tml(dist))
}

/// GitHub releases of the host (not published yet).
/// The client's public repository (the repository was created as horizon-client; horizon-host never existed on GitHub).
pub const GITHUB_REPO: &str = "cheatoskar/horizon-client";

/// One release asset: name and download URL.
#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    pub name: String,
    pub url: String,
}

/// What a GitHub release of the host offers: `manifest.json` and `Horizon-Host-<version>-<Game>.zip`
/// per game (Game: ESWC, Sunrise, Original, TMNF, TMUF; any case).
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub tag: String,
    pub version: String,
    pub manifest: Asset,
    pub zips: Vec<(String, Asset)>,
    /// `SHA256SUMS.txt` of the release (checked against each downloaded zip when present).
    pub sums: Option<Asset>,
}

pub fn parse_release(rel: &serde_json::Value) -> Result<Release, String> {
    let tag = rel["tag_name"].as_str().ok_or("no release")?.to_string();
    let version = tag.trim().trim_start_matches(['v', 'V']).to_string();
    let assets: Vec<Asset> = rel["assets"].as_array().into_iter().flatten().filter_map(|a| Some(Asset { name: a["name"].as_str()?.to_string(), url: a["browser_download_url"].as_str()?.to_string() })).collect();
    let manifest = assets.iter().find(|a| a.name.eq_ignore_ascii_case(MANIFEST)).cloned().ok_or_else(|| format!("Release {tag} has no manifest.json"))?;
    // Zips are named Horizon-Host-<version>-<Game>.zip (older builds) or Horizon-Client-<version>-<Game>.zip.
    let prefixes = [format!("horizon-host-{}-", version.to_lowercase()), format!("horizon-client-{}-", version.to_lowercase())];
    let zips = assets
        .iter()
        .filter_map(|a| {
            let l = a.name.to_lowercase();
            let game = prefixes.iter().find_map(|p| l.strip_prefix(p.as_str()))?.strip_suffix(".zip")?;
            (!game.is_empty()).then(|| (game.to_string(), a.clone()))
        })
        .collect();
    let sums = assets.iter().find(|a| a.name.eq_ignore_ascii_case("SHA256SUMS.txt") || a.name.eq_ignore_ascii_case("SHA256SUMS")).cloned();
    Ok(Release { tag, version, manifest, zips, sums })
}

/// The release's manifest.json: from a GitHub host, listing packages, and of this very release.
fn release_manifest(r: &Release, fetch: &dyn Fn(&str, u64) -> Result<Vec<u8>, String>) -> Result<serde_json::Value, String> {
    if !crate::linuxsetup::github_download_host(&r.manifest.url) {
        return Err(format!("{}: not a GitHub download address", r.manifest.name));
    }
    let m: serde_json::Value = serde_json::from_slice(&fetch(&r.manifest.url, 1 << 20)?).map_err(|e| format!("manifest.json: {e}"))?;
    if m.get("packages").is_none() {
        return Err("manifest.json of the release lists no packages".into());
    }
    if m["version"].as_str().map(|v| v.trim_start_matches(['v', 'V'])) != Some(r.version.as_str()) {
        return Err("manifest.json does not belong to this release".into());
    }
    Ok(m)
}

/// A downloaded zip against the release's SHA256SUMS.txt (when the release has one; the manifest
/// check follows in any case).
fn check_release_sums(r: &Release, zip: &Asset, bytes: &[u8], fetch: &dyn Fn(&str, u64) -> Result<Vec<u8>, String>) -> Result<(), String> {
    let Some(s) = &r.sums else { return Ok(()) };
    if !crate::linuxsetup::github_download_host(&s.url) {
        return Err(format!("{}: not a GitHub download address", s.name));
    }
    let text = String::from_utf8_lossy(&fetch(&s.url, 1 << 20)?).into_owned();
    match crate::addons::sum_for(&text, &zip.name) {
        Some(h) if h == sha256_hex(bytes) => Ok(()),
        Some(_) => Err(format!("Checksum of {} does not match SHA256SUMS.txt; nothing was installed", zip.name)),
        None => Err(format!("SHA256SUMS.txt does not list {}; nothing was installed", zip.name)),
    }
}

/// Downloads and checks the host package of a game from the latest GitHub release. `fetch(url,
/// max)` is the download (https, GitHub hosts only); tests pass a fake.
pub fn github_package(game: &str, release: &serde_json::Value, fetch: &dyn Fn(&str, u64) -> Result<Vec<u8>, String>) -> Result<Package, String> {
    let r = parse_release(release)?;
    let key = host_game_key(game);
    let zip = r.zips.iter().find(|(g, _)| g == key).map(|(_, a)| a).ok_or_else(|| format!("Horizon Client {} has no build for this game yet", r.version))?;
    if !crate::linuxsetup::github_download_host(&zip.url) {
        return Err(format!("{}: not a GitHub download address", zip.name));
    }
    let m = release_manifest(&r, fetch)?;
    let bytes = fetch(&zip.url, MAX_TOTAL)?;
    check_release_sums(&r, zip, &bytes, fetch)?;
    host_zip_from_bytes(&m, game, bytes, &format!("github:{GITHUB_REPO}"))
}

/// What goes into TMLoader's products folder: the version folder's files plus the version's and
/// the product's description.yaml.
#[derive(Debug, Clone)]
pub struct TmlSource {
    pub pkg: Package,
    /// Files for the version folder outside the package's list (a dev build's description.yaml).
    pub extra: Vec<(String, Vec<u8>)>,
    /// `Horizon Host\description.yaml` (name, changelog and CoreMod dependency TMLoader shows).
    pub product_desc: Option<Vec<u8>>,
}

/// The TMLoader product from a local build folder.
pub fn dev_tml_source(dist: &Path) -> Result<TmlSource, String> {
    let (vsrc, pkg) = dev_tml_cached(dist)?;
    Ok(TmlSource { pkg, extra: tml_extra(&vsrc), product_desc: tml_product_desc(&vsrc) })
}

/// The TMLoader product of a GitHub release: `Horizon-Client-<v>-TMLoader.zip` holds
/// `Horizon Host\description.yaml` and `Horizon Host\<v>\...`. The zip is checked against the
/// manifest and SHA256SUMS.txt, every file against the manifest, and every listed file must be in it.
pub fn github_tml(release: &serde_json::Value, fetch: &dyn Fn(&str, u64) -> Result<Vec<u8>, String>) -> Result<TmlSource, String> {
    use std::io::Read;
    let r = parse_release(release)?;
    let zip = r.zips.iter().find(|(g, _)| g == "tmloader").map(|(_, a)| a).ok_or_else(|| format!("Horizon Client {} has no TMLoader build", r.version))?;
    if !crate::linuxsetup::github_download_host(&zip.url) {
        return Err(format!("{}: not a GitHub download address", zip.name));
    }
    let m = release_manifest(&r, fetch)?;
    let pkg = m["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["kind"].as_str() == Some("tmloader") || p["game"].as_str() == Some("forever"))
        .ok_or_else(|| format!("manifest.json of {} lists no TMLoader package", r.version))?;
    let folder = m["folder_name"].as_str().unwrap_or(TML_PRODUCT);
    if folder != TML_PRODUCT {
        return Err(format!("The TMLoader product is called \"{folder}\", TM Horizon expects \"{TML_PRODUCT}\""));
    }
    let bytes = fetch(&zip.url, MAX_TOTAL)?;
    check_release_sums(&r, zip, &bytes, fetch)?;
    if Some(sha256_hex(&bytes).as_str()) != pkg["sha256"].as_str().map(|x| x.to_lowercase()).as_deref() {
        return Err(format!("Checksum of {} does not match the manifest; nothing was installed", zip.name));
    }
    let want: HashMap<String, String> = pkg["files"].as_array().into_iter().flatten().filter_map(|f| Some((f["path"].as_str()?.replace('\\', "/").to_lowercase(), f["sha256"].as_str()?.to_lowercase()))).collect();
    let vprefix = format!("{}/{}/", TML_PRODUCT.to_lowercase(), r.version.to_lowercase());
    let pdesc = format!("{}/description.yaml", TML_PRODUCT.to_lowercase());
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("{}: {e}", zip.name))?;
    let (mut files, mut product_desc, mut seen, mut total) = (Vec::new(), None, 0usize, 0u64);
    for i in 0..z.len() {
        let f = z.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let rel = safe_rel(&f.name().replace('\\', "/"))?;
        let mut buf = Vec::new();
        f.take(MAX_FILE + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        total += buf.len() as u64;
        if buf.len() as u64 > MAX_FILE || total > MAX_TOTAL {
            return Err("The package is bigger than TM Horizon allows".into());
        }
        let l = rel.to_lowercase();
        if want.get(&l) != Some(&sha256_hex(&buf)) {
            return Err(format!("{rel} in {} is not in the manifest or its checksum differs; nothing was installed", zip.name));
        }
        seen += 1;
        if l == pdesc {
            product_desc = Some(buf);
        } else if l.starts_with(&vprefix) {
            files.push((rel[vprefix.len()..].to_string(), buf));
        } else {
            return Err(format!("{rel} in {} is outside the product's version folder; nothing was installed", zip.name));
        }
    }
    if seen != want.len() {
        return Err(format!("{} misses files the manifest lists; nothing was installed", zip.name));
    }
    if !files.iter().any(|(r, _)| r.eq_ignore_ascii_case("description.yaml")) {
        return Err(format!("{} has no description.yaml for {}", zip.name, r.version));
    }
    Ok(TmlSource { pkg: Package { version: r.version.clone(), source: format!("github:{GITHUB_REPO}"), files }, extra: vec![], product_desc })
}

/// Version and file list of the release's TMLoader product from release.json and manifest.json
/// alone (a few KB), for the card's status and update check. The files have no content: only
/// [`github_tml`] downloads the zip, when the user installs or updates.
pub fn github_tml_listing(release: &serde_json::Value, fetch: &dyn Fn(&str, u64) -> Result<Vec<u8>, String>) -> Result<Package, String> {
    let r = parse_release(release)?;
    let zip = r.zips.iter().find(|(g, _)| g == "tmloader").map(|(_, a)| a).ok_or_else(|| format!("Horizon Client {} has no TMLoader build", r.version))?;
    if !crate::linuxsetup::github_download_host(&zip.url) {
        return Err(format!("{}: not a GitHub download address", zip.name));
    }
    let m = release_manifest(&r, fetch)?;
    let pkg = m["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["kind"].as_str() == Some("tmloader") || p["game"].as_str() == Some("forever"))
        .ok_or_else(|| format!("manifest.json of {} lists no TMLoader package", r.version))?;
    let vprefix = format!("{}/{}/", TML_PRODUCT.to_lowercase(), r.version.to_lowercase());
    let files: Vec<(String, Vec<u8>)> = pkg["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["path"].as_str().map(|p| p.replace('\\', "/")))
        .filter(|p| p.to_lowercase().starts_with(&vprefix))
        .map(|p| (p[vprefix.len()..].to_string(), Vec::new()))
        .collect();
    if files.is_empty() {
        return Err(format!("manifest.json of {} lists no TMLoader files", r.version));
    }
    Ok(Package { version: r.version.clone(), source: format!("github:{GITHUB_REPO}"), files })
}

/// [`github_tml_listing`] for the latest release, kept for 10 minutes.
pub fn github_tml_listing_cached() -> Result<Package, String> {
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Instant, Result<Package, String>)>> = Mutex::new(None);
    if let Some((at, r)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < Duration::from_secs(600) {
            return r.clone();
        }
    }
    let r = github_latest_release()
        .map_err(|e| format!("Horizon Client release on github.com/{GITHUB_REPO}: {e}"))
        .and_then(|rel| github_tml_listing(&rel, &|u, max| crate::net::get_bytes(u, max)));
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), r.clone()));
    r
}

/// [`github_tml`] for the latest release (install and update only), kept for 10 minutes so the
/// file list and the install that follows use one download.
pub fn github_tml_cached() -> Result<TmlSource, String> {
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Instant, Result<TmlSource, String>)>> = Mutex::new(None);
    if let Some((at, r)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < Duration::from_secs(600) {
            return r.clone();
        }
    }
    let r = github_latest_release()
        .map_err(|e| format!("Horizon Client release on github.com/{GITHUB_REPO}: {e}"))
        .and_then(|rel| github_tml(&rel, &|u, max| crate::net::get_bytes(u, max)));
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), r.clone()));
    r
}

/// The latest release of the host (GitHub API).
pub fn github_latest_release() -> Result<serde_json::Value, String> {
    crate::net::get_json(&format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest"))
}

/// The package from GitHub, kept for 10 minutes per game (the card asks often; the download is big).
pub fn github_legacy(game: &str) -> Result<Package, String> {
    use std::time::{Duration, Instant};
    static CACHE: Mutex<BTreeMap<String, (Instant, Result<Package, String>)>> = Mutex::new(BTreeMap::new());
    if let Some((at, r)) = CACHE.lock().unwrap().get(game) {
        if at.elapsed() < Duration::from_secs(600) {
            return r.clone();
        }
    }
    let r = github_latest_release()
        .map_err(|e| format!("Horizon Client release on github.com/{GITHUB_REPO}: {e}"))
        .and_then(|rel| github_package(game, &rel, &|u, max| crate::net::get_bytes(u, max)));
    CACHE.lock().unwrap().insert(game.to_string(), (Instant::now(), r.clone()));
    r
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// "dev" | "github"
    pub kind: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub tml_version: Option<String>,
    pub error: Option<String>,
}

// ------------------------------------------------------------------ launcher store

/// TM Horizon's own Horizon settings (`<data>\horizon-host.json`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    /// Local build folder of the host (the repo's `dist`); None = GitHub releases.
    pub dev_dir: Option<String>,
    /// Enabled plugin ids per scope: `dir:<normalised folder>` or `tml:<TMLoader profile>`.
    pub enabled: BTreeMap<String, Vec<String>>,
    pub hotkey: Option<String>,
}

fn store_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: Mutex<()> = Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn load_store(data: &Path) -> Store {
    fsx::read_string(&data.join("horizon-host.json")).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn update_store(data: &Path, f: impl FnOnce(&mut Store)) -> Result<Store, String> {
    let _g = store_lock();
    let mut s = load_store(data);
    f(&mut s);
    fsx::write(&data.join("horizon-host.json"), serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?.as_bytes())?;
    Ok(s)
}

pub fn dir_scope(dir: &Path) -> String {
    format!("dir:{}", fsx::norm(dir))
}

pub fn tml_scope(profile: &str) -> String {
    format!("tml:{profile}")
}

/// Switches a plugin for a scope. The first switch starts from `defaults` (what the host loads
/// without a profile.json: every installed plugin).
pub fn set_enabled(data: &Path, scope: &str, id: &str, on: bool, defaults: &[String]) -> Result<Vec<String>, String> {
    let s = update_store(data, |s| {
        let l = s.enabled.entry(scope.to_string()).or_insert_with(|| defaults.to_vec());
        l.retain(|x| x != id);
        if on {
            l.push(id.to_string());
        }
    })?;
    Ok(s.enabled.get(scope).cloned().unwrap_or_default())
}

/// The host's own settings file (`<host root>\settings\host.json`): a flat JSON object the in-game
/// menu writes, key `plugin.<id>.enabled` = 1 / 0 (docs/profile-json.md of horizon-host).
pub fn host_settings_path(host_root: &Path) -> PathBuf {
    state_dir(host_root, "settings").join("host.json")
}

/// Where the host keeps `settings` and `logs`: inside the host root (legacy games), but for the TMLoader
/// product the client writes them one level up, next to the version folders (`products\Horizon Host\settings`,
/// `...\logs`, seen with 0.3.0), so they survive version updates. Falls back to the version folder when
/// only that one has the folder (older builds).
fn state_dir(host_root: &Path, sub: &str) -> PathBuf {
    let own = host_root.join(sub);
    if let Some(product) = host_root.parent().filter(|p| p.file_name().is_some_and(|n| n == TML_PRODUCT)) {
        let up = product.join(sub);
        if fsx::is_dir(&up) || !fsx::is_dir(&own) {
            return up;
        }
    }
    own
}

/// Clients from 0.3.0 on load modules while the game runs; older ones only at the start. An unknown
/// version (hand-copied test builds without an install record) counts as current.
pub fn loads_at_runtime(version: Option<&str>) -> bool {
    version.is_none_or(|v| crate::modindex::cmp_version(v, "0.3.0") != std::cmp::Ordering::Less)
}

/// The in-game menu's switch for a plugin: Some(false) = switched off there, None = never switched.
pub fn menu_switch(host_root: &Path, id: &str) -> Option<bool> {
    let text = fsx::read_string(&host_settings_path(host_root))?;
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let x = v.get(format!("plugin.{id}.enabled"))?;
    x.as_f64().map(|n| n != 0.0).or_else(|| x.as_bool()).or_else(|| x.as_str().map(|s| s != "0" && !s.eq_ignore_ascii_case("false")))
}

/// Writes the same switch the in-game menu writes, so the launcher and the menu never disagree
/// (a plugin switched off in the menu stays off even when profile.json lists it). Other keys
/// (hotkeys, bar, OnlineFix, panels) are kept. A file that is not a JSON object is left alone.
pub fn set_menu_switch(host_root: &Path, id: &str, on: bool) -> Result<(), String> {
    // Read, change, write: two quick switches (the card no longer waits between them) must not
    // lose one of the keys.
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = host_settings_path(host_root);
    let mut obj = match fsx::read_string(&path) {
        None => serde_json::Map::new(),
        Some(text) => match serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => return Err(format!("{} is not a JSON object; switch the module in the in-game menu", path.display())),
        },
    };
    obj.insert(format!("plugin.{id}.enabled"), serde_json::Value::from(if on { 1 } else { 0 }));
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fsx::write(&path, text.as_bytes())
}

/// The user's own plugin choice for a scope; None = never switched (host defaults).
pub fn enabled(data: &Path, scope: &str) -> Option<Vec<String>> {
    load_store(data).enabled.get(scope).cloned()
}

/// What the host loads without a profile.json: installed plugins that are on by default.
pub fn installed_ids(host_root: &Path) -> Vec<String> {
    installed_plugins(host_root).into_iter().filter(|m| m.enabled_by_default).map(|m| m.id).collect()
}

/// Removes a profile.json that TM Horizon wrote earlier (the host then uses its defaults).
fn drop_profile(host_root: &Path) -> Result<(), String> {
    let p = host_root.join(PROFILE);
    let ours = fsx::read_string(&p).and_then(|t| serde_json::from_str::<Profile>(&t).ok()).is_some_and(|x| x.written_by.starts_with("TM Horizon"));
    if ours {
        std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(())
}

// ------------------------------------------------------------------ plugins, profile.json, logs

pub fn installed_plugins(host_root: &Path) -> Vec<PluginMeta> {
    let mut out: Vec<PluginMeta> = fsx::list(&host_root.join(PLUGINS))
        .into_iter()
        .filter(|e| e.is_dir)
        .filter_map(|e| parse_plugin(&fsx::read_string(&e.path.join(PLUGIN_JSON))?, &e.name).map(|mut m| {
            m.id = e.name.clone(); // the folder name is what the host loads
            m
        }))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Writes `<host root>\profile.json`: the enabled plugins that are installed (in enabled order).
static STATS_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// `<app data>\host-stats`: profile.json tells the host to write its events there (set once at start).
pub fn set_stats_dir(dir: PathBuf) {
    let _ = STATS_DIR.set(dir);
}

pub fn write_profile(host_root: &Path, game: &str, profile: &str, enabled: &[String], safe: bool, hotkey: Option<&str>) -> Result<Profile, String> {
    let inst = installed_plugins(host_root);
    let plugins = enabled
        .iter()
        .filter_map(|id| inst.iter().find(|m| &m.id == id))
        .filter(|m| m.games.is_empty() || m.games.iter().any(|g| g == game || (is_forever(game) && is_forever(g))))
        .map(|m| ProfilePlugin { id: m.id.clone(), version: m.version.clone(), enabled: true })
        .collect();
    let p = Profile {
        format: PROFILE_SCHEMA,
        game: host_game_key(game).into(),
        profile: profile.into(),
        safe_mode: safe,
        menu_key: hotkey.map(String::from),
        plugins,
        stats_dir: STATS_DIR.get().map(|d| d.join(game).to_string_lossy().into_owned()),
        written_by: format!("TM Horizon {}", env!("CARGO_PKG_VERSION")),
        written_at: fsx::now_iso(),
    };
    fsx::write(&host_root.join(PROFILE), profile_json(&p).as_bytes())?;
    Ok(p)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub path: String,
    pub modified: Option<String>,
    pub size: u64,
    /// The end of the log (big logs are cut at the front).
    pub text: String,
    pub cut: bool,
}

/// Logs of a host root, newest first.
pub fn log_files(host_root: &Path, max: usize) -> Vec<PathBuf> {
    let mut v: Vec<_> = fsx::list(&state_dir(host_root, LOGS)).into_iter().filter(|e| e.is_file && e.name.to_lowercase().ends_with(".log")).map(|e| (e.modified, e.path)).collect();
    v.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    v.into_iter().take(max).map(|(_, p)| p).collect()
}

pub fn latest_log(host_root: &Path) -> Option<LogFile> {
    use std::io::{Read, Seek, SeekFrom};
    let p = log_files(host_root, 1).pop()?;
    fsx::check(&p).ok()?;
    let mut f = std::fs::File::open(&p).ok()?;
    let size = f.metadata().ok()?.len();
    let cut = size > LOG_TAIL;
    if cut {
        f.seek(SeekFrom::Start(size - LOG_TAIL)).ok()?;
    }
    let mut buf = Vec::new();
    f.take(LOG_TAIL).read_to_end(&mut buf).ok()?;
    Some(LogFile { name: p.file_name()?.to_string_lossy().into(), path: p.to_string_lossy().into(), modified: fsx::mtime_iso(&p), size, text: String::from_utf8_lossy(&buf).into_owned(), cut })
}

// ------------------------------------------------------------------ legacy install

const PLUGIN_PREFIX_LEGACY: &str = "horizon/plugins/";
const PLUGIN_PREFIX_TML: &str = "plugins/";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub path: String,
    /// "new" | "replace" | "same" | "keep"
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub game: String,
    pub dir: String,
    pub version: String,
    pub installed: Option<String>,
    pub files: Vec<PlanFile>,
    /// Owner of the dinput8.dll that gets chained: renamed to dinput8.chain.dll (backup copy too)
    /// and loaded by the Legacy Loader ("ESWC Autosave", "unknown").
    pub chains: Option<String>,
    pub autosave_present: bool,
    pub exe_known: Option<String>,
    pub warnings: Vec<String>,
    pub backup_root: String,
}

/// User settings files that an update leaves alone.
fn keep_on_update(rel: &str) -> bool {
    let l = rel.to_lowercase();
    !l.ends_with(PLUGIN_JSON) && !l.ends_with(MANIFEST) && (l.ends_with(".ini") || l.ends_with(".cfg") || l.ends_with(".json"))
}

fn plan_files(kind: Kind, base: &Path, files: &[(String, Vec<u8>)]) -> Vec<PlanFile> {
    files
        .iter()
        .map(|(rel, bytes)| {
            let action = if !exists(kind, base, rel) {
                "new"
            } else if keep_on_update(rel) {
                "keep"
            } else if read_existing(kind, base, rel).as_deref() == Some(bytes.as_slice()) {
                "same"
            } else {
                "replace"
            };
            PlanFile { path: rel.clone(), action: action.into() }
        })
        .collect()
}

/// "horizon" | "missing" | "other" | "none"
pub fn loader_state(dir: &Path) -> &'static str {
    let have = dir.join(LOADER).is_file();
    let rec = read_record(&dir.join(HOST_DIR));
    match rec.filter(|r| r.files.iter().any(|f| is_loader_rel(f))) {
        Some(r) if have => {
            let size = std::fs::metadata(dir.join(LOADER)).map(|m| m.len()).ok();
            if r.loader_size.is_some() && size == r.loader_size { "horizon" } else { "other" }
        }
        Some(_) => "missing",
        None if have => "other",
        None => "none",
    }
}

pub fn autosave_present(dir: &Path) -> bool {
    fsx::is_file(&dir.join("eswc_autosave.dll")) || fsx::is_file(&dir.join("eswc_autosave.ini"))
}

fn other_owner(dir: &Path) -> String {
    if autosave_present(dir) { "ESWC Autosave".into() } else { "unknown".into() }
}

/// The dinput8.dll is the Legacy Loader put there by the host's own package (Horizon-Install.cmd),
/// not by TM Horizon. dinput8.dll is never read (house rule), so: no install record of ours, a
/// horizon\host.dll next to it, and either a dinput8.chain.dll (the script chained something) or
/// the same size as the loader being installed. Such a loader is replaced, never chained (two
/// loaders would load the host twice).
pub fn package_loader(dir: &Path, loader_len: Option<u64>) -> bool {
    let have = dir.join(LOADER).is_file();
    if !have || read_record(&dir.join(HOST_DIR)).is_some() || !fsx::is_file(&dir.join(HOST_DIR).join(HOST_DLL)) {
        return false;
    }
    let size = std::fs::metadata(dir.join(LOADER)).map(|m| m.len()).ok();
    dir.join(CHAIN).is_file() || (loader_len.is_some() && size == loader_len)
}

fn chain_owner(dir: &Path) -> String {
    other_owner(dir)
}

/// Downloaded/loaded files waiting for the user's OK, per folder.
fn staged() -> &'static Mutex<HashMap<String, Package>> {
    static S: OnceLock<Mutex<HashMap<String, Package>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn stage(dir: &Path, p: Package) {
    staged().lock().unwrap().insert(fsx::norm(dir), p);
}

/// What installing/updating would do. Nothing is written.
pub fn prepare(dir: &Path, data: &Path, pkg: Package) -> Result<Plan, String> {
    let game = legacy_game_of(dir)?;
    let core = pkg.core(PLUGIN_PREFIX_LEGACY);
    if !core.iter().any(|(r, _)| is_loader_rel(r)) || !core.iter().any(|(r, _)| r.eq_ignore_ascii_case(&format!("{HOST_DIR}/{HOST_DLL}"))) {
        return Err("The package has no dinput8.dll or horizon/host.dll".into());
    }
    for (r, _) in &core {
        legacy_target(dir, r)?;
    }
    let mut files = plan_files(Kind::Legacy, dir, &core);
    let state = loader_state(dir);
    let loader_len = core.iter().find(|(r, _)| is_loader_rel(r)).map(|(_, b)| b.len() as u64);
    let chains = (state == "other" && !package_loader(dir, loader_len)).then(|| other_owner(dir));
    if chains.is_some() {
        files.insert(0, PlanFile { path: CHAIN.into(), action: if exists(Kind::Legacy, dir, CHAIN) { "chain-replace" } else { "chain" }.into() });
    }
    let exe = exe_info(dir, game);
    // The card shows the exe check and the chain in the user's language; only extra notes here.
    let mut warnings = Vec::new();
    if package_loader(dir, loader_len) {
        warnings.push("Horizon Client was put here by its own package (Horizon-Install.cmd); TM Horizon takes it over.".into());
    }
    let plan = Plan {
        game: game.into(),
        dir: dir.to_string_lossy().into(),
        version: pkg.version.clone(),
        installed: read_record(&dir.join(HOST_DIR)).map(|r| r.version),
        files,
        chains,
        autosave_present: autosave_present(dir),
        exe_known: exe.and_then(|e| e.known),
        warnings,
        backup_root: backup_root(data).to_string_lossy().into(),
    };
    stage(dir, pkg);
    Ok(plan)
}

/// Writes the staged host files after the user's OK. Backup first.
pub fn apply(dir: &Path, data: &Path) -> Result<String, String> {
    let pkg = staged().lock().unwrap().remove(&fsx::norm(dir)).ok_or("Nothing prepared; open the dialog again")?;
    legacy_game_of(dir)?;
    let core = pkg.core(PLUGIN_PREFIX_LEGACY);
    let plan = plan_files(Kind::Legacy, dir, &core);
    let state = loader_state(dir);
    let loader_len = core.iter().find(|(r, _)| is_loader_rel(r)).map(|(_, b)| b.len() as u64);
    let owner = (state == "other" && !package_loader(dir, loader_len)).then(|| other_owner(dir));
    let mut replaced: Vec<String> = plan.iter().filter(|p| p.action == "replace").map(|p| p.path.clone()).collect();
    if owner.is_some() {
        replaced.push(CHAIN.into()); // an older chain file is overwritten below
    }
    let root = backup_root(data);
    let b = backup(Kind::Legacy, dir, &root, &replaced, &format!("before Horizon Client {}", pkg.version))?;
    if owner.is_some() {
        // Chain the foreign loader: dinput8.dll -> dinput8.chain.dll (the backup holds a copy).
        let from = legacy_target(dir, LOADER)?;
        let to = legacy_target(dir, CHAIN)?;
        if to.is_file() {
            std::fs::remove_file(&to).map_err(|e| format!("{}: {e}", to.display()))?;
        }
        std::fs::rename(&from, &to).map_err(|e| format!("{} -> {}: {e}", from.display(), to.display()))?;
    }
    for (rel, bytes) in &core {
        let action = plan.iter().find(|p| &p.path == rel).map(|p| p.action.as_str()).unwrap_or("new");
        if action == "new" || action == "replace" {
            put(Kind::Legacy, dir, rel, bytes)?;
        }
    }
    let old = read_record(&dir.join(HOST_DIR)).unwrap_or_default();
    let (previous_backup, previous_owner) = if owner.is_some() && b.is_some() { (b.clone(), owner.clone()) } else { (old.previous_backup.clone(), old.previous_owner.clone()) };
    let chained = if owner.is_some() { owner.clone() } else { old.chained.clone().or_else(|| Some(chain_owner(dir))).filter(|_| exists(Kind::Legacy, dir, CHAIN)) };
    let rec = InstallRecord {
        version: pkg.version.clone(),
        source: pkg.source.clone(),
        files: core.iter().map(|(r, _)| r.clone()).collect(),
        sha256: core.iter().map(|(r, b)| (r.clone(), sha256_hex(b))).collect(),
        loader_size: core.iter().find(|(r, _)| is_loader_rel(r)).map(|(_, b)| b.len() as u64),
        installed_at: fsx::now_iso(),
        backup_id: b.clone(),
        previous_backup,
        previous_owner,
        chained,
    };
    write_record(Kind::Legacy, dir, &rec)?;
    Ok(match b {
        Some(id) => format!("Horizon Client {} installed. Backup: {id}", pkg.version),
        None => format!("Horizon Client {} installed.", pkg.version),
    })
}

/// Removes the loader and host.dll (backup first). Plugins, settings and logs stay. With
/// `restore_previous` the dinput8.dll that was there before (ESWC Autosave ...) is put back.
pub fn remove(dir: &Path, data: &Path, restore_previous: bool) -> Result<String, String> {
    legacy_game_of(dir)?;
    let rec = read_record(&dir.join(HOST_DIR)).ok_or("Horizon Client is not installed here (no install record)")?;
    let root = backup_root(data);
    // dinput8.dll only when it is still ours; the user's settings files stay.
    let mine = loader_state(dir) == "horizon";
    let ours: Vec<String> = rec.files.iter().filter(|f| if is_loader_rel(f) { mine } else { !keep_on_update(f) }).cloned().collect();
    let mut with_record = ours.clone();
    with_record.push(format!("{HOST_DIR}/{RECORD}"));
    let b = backup(Kind::Legacy, dir, &root, &with_record, "before removing Horizon Client")?;
    for f in &ours {
        del(Kind::Legacy, dir, f)?;
    }
    del(Kind::Legacy, dir, &format!("{HOST_DIR}/{RECORD}"))?;
    let mut msg = match &b {
        Some(id) => format!("Horizon Client removed. Backup: {id}"),
        None => "Horizon Client removed.".to_string(),
    };
    // The chained original goes back to its name (always: uninstall restores the original).
    if exists(Kind::Legacy, dir, CHAIN) && !dir.join(LOADER).is_file() {
        let from = legacy_target(dir, CHAIN)?;
        let to = legacy_target(dir, LOADER)?;
        std::fs::rename(&from, &to).map_err(|e| format!("{} -> {}: {e}", from.display(), to.display()))?;
        msg.push_str(&format!(" {CHAIN} is dinput8.dll again."));
    } else if restore_previous {
        if let Some(prev) = rec.previous_backup.as_deref() {
            let pb = backup_by_id(&root, dir, prev)?;
            if !dir.join(LOADER).is_file() || !pb.files.iter().any(|f| is_loader_rel(f)) {
                put_back(Kind::Legacy, dir, &root, &pb)?;
                msg.push_str(&format!(" Put back: {}", pb.files.join(", ")));
            }
        }
    }
    Ok(msg)
}

// ------------------------------------------------------------------ plugins (legacy and TMLoader)

/// Installs one plugin from the package into `<base>\<prefix><id>\` (backup of replaced files).
pub fn install_plugin(kind: Kind, base: &Path, data: &Path, pkg: &Package, id: &str) -> Result<String, String> {
    let prefix = if kind == Kind::Legacy { PLUGIN_PREFIX_LEGACY } else { PLUGIN_PREFIX_TML };
    let plugins = pkg.plugins(prefix);
    let (files, meta) = plugins.get(id).ok_or_else(|| format!("No plugin {id} in Horizon Client {}", pkg.version))?;
    if meta.is_none() {
        return Err(format!("Plugin {id} has no plugin.json"));
    }
    let plan = plan_files(kind, base, files);
    let replaced: Vec<String> = plan.iter().filter(|p| p.action == "replace").map(|p| p.path.clone()).collect();
    let b = backup(kind, base, &backup_root(data), &replaced, &format!("before plugin {id}"))?;
    for (rel, bytes) in files {
        let a = plan.iter().find(|p| &p.path == rel).map(|p| p.action.as_str()).unwrap_or("new");
        if a == "new" || a == "replace" {
            put(kind, base, rel, bytes)?;
        }
    }
    let v = meta.as_ref().and_then(|m| m.version.clone()).unwrap_or_default();
    Ok(match b {
        Some(bid) => format!("Plugin {id} {v} installed. Backup: {bid}"),
        None => format!("Plugin {id} {v} installed."),
    })
}

/// Removes a plugin folder (all its files backed up first).
pub fn remove_plugin(kind: Kind, base: &Path, data: &Path, id: &str) -> Result<String, String> {
    safe_rel(id)?;
    if id.contains('/') {
        return Err("bad plugin id".into());
    }
    let prefix = if kind == Kind::Legacy { PLUGIN_PREFIX_LEGACY } else { PLUGIN_PREFIX_TML };
    let pdir = rel_path(base, &format!("{prefix}{id}"));
    fsx::check(&pdir)?;
    let mut rels = Vec::new();
    fn walk(d: &Path, rel: &str, out: &mut Vec<String>) {
        for e in fsx::list(d) {
            let r = format!("{rel}/{}", e.name);
            if e.is_dir {
                walk(&e.path, &r, out);
            } else if e.is_file {
                out.push(r);
            }
        }
    }
    walk(&pdir, &format!("{prefix}{id}"), &mut rels);
    if rels.is_empty() {
        return Err(format!("Plugin {id} is not installed"));
    }
    let b = backup(kind, base, &backup_root(data), &rels, &format!("before removing plugin {id}"))?;
    std::fs::remove_dir_all(&pdir).map_err(|e| format!("{}: {e}", pdir.display()))?;
    Ok(format!("Plugin {id} removed.{}", b.map(|b| format!(" Backup: {b}")).unwrap_or_default()))
}

/// ESWC Autosave -> the host's Autosave plugin (optional; Autosave keeps running chained until
/// then): installs the plugin, hands over the old ini (the plugin imports it), enables it for
/// this folder and removes the chained loader (backup first). eswc_autosave.dll/.ini stay.
pub fn migrate_autosave(dir: &Path, data: &Path, pkg: &Package) -> Result<String, String> {
    legacy_game_of(dir)?;
    let plugins = pkg.plugins(PLUGIN_PREFIX_LEGACY);
    let id = AUTOSAVE_IDS.iter().find(|i| plugins.contains_key(**i)).ok_or_else(|| format!("Horizon Client {} has no Autosave plugin", pkg.version))?;
    let mut msg = install_plugin(Kind::Legacy, dir, data, pkg, id)?;
    if let Some(ini) = fsx::read_string(&dir.join("eswc_autosave.ini")) {
        put(Kind::Legacy, dir, &format!("{PLUGIN_PREFIX_LEGACY}{id}/eswc_autosave.ini"), ini.as_bytes())?;
        msg.push_str(" Settings taken over from eswc_autosave.ini.");
    }
    set_enabled(data, &dir_scope(dir), id, true, &installed_ids(&dir.join(HOST_DIR)))?;
    if exists(Kind::Legacy, dir, CHAIN) {
        backup(Kind::Legacy, dir, &backup_root(data), &[CHAIN.to_string()], "before switching to the Autosave plugin")?;
        del(Kind::Legacy, dir, CHAIN)?;
        if let Some(mut rec) = read_record(&dir.join(HOST_DIR)) {
            rec.chained = None;
            write_record(Kind::Legacy, dir, &rec)?;
        }
        msg.push_str(" The chained ESWC Autosave loader is off now.");
    }
    Ok(msg)
}

// ------------------------------------------------------------------ status

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExeInfo {
    pub name: String,
    pub sha256: String,
    pub known: Option<String>,
}

/// The game exe's SHA-256 (cached per path, size and time) and whether the host knows it.
pub fn exe_info(dir: &Path, game: &str) -> Option<ExeInfo> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, Option<std::time::SystemTime>, String)>>> = OnceLock::new();
    let (_, exe) = crate::scan::classify(dir).into_iter().find(|(g, _)| *g == game)?;
    fsx::check(&exe).ok()?;
    let meta = std::fs::metadata(&exe).ok()?;
    let key = fsx::norm(&exe);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let hit = cache.lock().unwrap().get(&key).filter(|c| c.0 == meta.len() && c.1 == meta.modified().ok()).map(|c| c.2.clone());
    let sha = match hit {
        Some(s) => s,
        None => {
            let s = sha256_hex(&std::fs::read(&exe).ok()?);
            cache.lock().unwrap().insert(key, (meta.len(), meta.modified().ok(), s.clone()));
            s
        }
    };
    let known = KNOWN_EXES.iter().find(|(g, h, _)| *g == game && *h == sha).map(|(_, _, l)| l.to_string());
    Some(ExeInfo { name: exe.file_name()?.to_string_lossy().into(), sha256: sha, known })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub games: Vec<String>,
    pub online: Option<String>,
    pub installed: Option<String>,
    pub available: Option<String>,
    pub enabled: bool,
    pub compatible: bool,
    /// Switching it applies at the next game start (plugin.json `startup_only`).
    pub startup_only: bool,
    /// The plugin's icon.png (installed copy, else the package's) as a data URL; None without one.
    pub icon: Option<String>,
}

/// A plugin's icon.png as a data URL (PNG only, at most 256 KB).
fn icon_data_url(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    (bytes.starts_with(b"\x89PNG") && bytes.len() <= 256 * 1024).then(|| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Installed plugins of a host root + those in the package, with the enabled flag of a scope.
pub fn plugin_states(host_root: &Path, pkg: Option<&Package>, prefix: &str, game: &str, enabled: Option<&[String]>) -> Vec<PluginState> {
    let inst = installed_plugins(host_root);
    let avail = pkg.map(|p| p.plugins(prefix)).unwrap_or_default();
    let mut ids: Vec<String> = inst.iter().map(|m| m.id.clone()).chain(avail.keys().cloned()).collect();
    ids.sort();
    ids.dedup();
    ids.into_iter()
        .map(|id| {
            let i = inst.iter().find(|m| m.id == id);
            let a = avail.get(&id).and_then(|x| x.1.clone());
            let icon = std::fs::read(host_root.join(PLUGINS).join(&id).join("icon.png")).ok().and_then(|b| icon_data_url(&b)).or_else(|| {
                avail.get(&id).and_then(|x| x.0.iter().find(|(r, _)| r.to_lowercase().ends_with("/icon.png")).and_then(|(_, b)| icon_data_url(b)))
            });
            let meta = i.cloned().or_else(|| a.clone()).unwrap_or_else(|| PluginMeta { id: id.clone(), name: id.clone(), ..Default::default() });
            PluginState {
                compatible: meta.games.is_empty() || meta.games.iter().any(|g| g == game),
                // Off when either TM Horizon's choice or the in-game menu (settings\host.json) says off.
                // Without a choice in TM Horizon the in-game menu's switch decides, else plugin.json's default.
                enabled: i.is_some_and(|m| match (enabled, menu_switch(host_root, &id)) {
                    (Some(l), menu) => l.contains(&id) && menu != Some(false),
                    (None, Some(menu)) => menu,
                    (None, None) => m.enabled_by_default,
                }),
                installed: i.map(|m| m.version.clone().unwrap_or_else(|| "?".into())),
                available: a.and_then(|m| m.version),
                name: meta.name,
                description: meta.description,
                games: meta.games,
                online: meta.online,
                startup_only: meta.startup_only,
                icon,
                id,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub game: String,
    pub dir: String,
    pub host_root: String,
    pub installed: Option<String>,
    /// "horizon" | "missing" | "other" | "none"
    pub loader: String,
    pub loader_owner: Option<String>,
    pub exe: Option<ExeInfo>,
    pub source: SourceInfo,
    pub update: bool,
    /// Backup with the dinput8.dll from before the first install.
    pub previous: Option<Backup>,
    pub previous_owner: Option<String>,
    /// Owner of dinput8.chain.dll (loaded through the Legacy Loader).
    pub chained: Option<String>,
    /// Plugins follow the user's choice (false = host defaults, every installed plugin).
    pub custom_plugins: bool,
    /// The installed client switches modules while the game runs (0.3.0 and later).
    pub runtime_modules: bool,
    pub autosave_present: bool,
    pub autosave_migrated: bool,
    pub plugins: Vec<PluginState>,
    pub backups: Vec<Backup>,
    pub has_log: bool,
}

pub fn status(dir: &Path, data: &Path, pkg: Result<Package, String>, src: SourceInfo) -> Result<Status, String> {
    let game = legacy_game_of(dir)?;
    let host_root = dir.join(HOST_DIR);
    let rec = read_record(&host_root);
    let loader = loader_state(dir);
    let mut source = src;
    let pkg = match pkg {
        Ok(p) => {
            source.version = Some(p.version.clone());
            Some(p)
        }
        Err(e) => {
            source.error = Some(e);
            None
        }
    };
    let installed = rec.as_ref().map(|r| r.version.clone());
    let update = match (&installed, &source.version) {
        (Some(i), Some(a)) => crate::updates::is_newer(a, i),
        _ => false,
    };
    let en = enabled(data, &dir_scope(dir));
    let runtime_modules = loads_at_runtime(installed.as_deref());
    let plugins = plugin_states(&host_root, pkg.as_ref(), PLUGIN_PREFIX_LEGACY, game, en.as_deref());
    let root = backup_root(data);
    let previous = rec.as_ref().and_then(|r| r.previous_backup.as_deref()).and_then(|id| backup_by_id(&root, dir, id).ok());
    Ok(Status {
        game: game.into(),
        dir: dir.to_string_lossy().into(),
        host_root: host_root.to_string_lossy().into(),
        installed,
        loader_owner: (loader == "other").then(|| if package_loader(dir, None) { "Horizon (package)".to_string() } else { other_owner(dir) }),
        loader: loader.into(),
        exe: exe_info(dir, game),
        update,
        previous_owner: rec.as_ref().and_then(|r| r.previous_owner.clone()),
        chained: exists(Kind::Legacy, dir, CHAIN).then(|| rec.as_ref().and_then(|r| r.chained.clone()).unwrap_or_else(|| other_owner(dir))),
        custom_plugins: en.is_some(),
        runtime_modules,
        previous,
        autosave_present: autosave_present(dir),
        autosave_migrated: plugins.iter().any(|p| AUTOSAVE_IDS.contains(&p.id.as_str()) && p.installed.is_some() && p.enabled),
        plugins,
        backups: list_backups(&root, dir),
        has_log: !log_files(&host_root, 1).is_empty(),
        source,
    })
}

// ------------------------------------------------------------------ TMLoader (Forever)

pub fn tml_product_dir(tml_root: &Path) -> PathBuf {
    crate::tmloader::products_dir(tml_root).join(TML_PRODUCT)
}

/// Installed versions of the product, newest last.
pub fn tml_versions(tml_root: &Path) -> Vec<(String, PathBuf)> {
    let mut v: Vec<(String, PathBuf)> = fsx::list(&tml_product_dir(tml_root))
        .into_iter()
        // A version folder has its description.yaml (like TMLoader reads it). The client's own `settings`,
        // `logs` and `data` folders sit next to the versions since 0.3.0 and are not versions.
        .filter(|e| e.is_dir && !e.name.starts_with('.') && fsx::is_file(&e.path.join("description.yaml")) && crate::tmloader::version_installed(&e.path))
        .map(|e| (e.name, e.path))
        .collect();
    v.sort_by(|a, b| crate::modindex::cmp_version(&a.0, &b.0));
    v
}

/// The version folder a TMLoader profile runs (its pinned version, else the newest).
pub fn tml_host_root(tml_root: &Path, pinned: Option<&str>) -> Option<PathBuf> {
    let v = tml_versions(tml_root);
    pinned.and_then(|p| v.iter().find(|(x, _)| x == p).map(|(_, d)| d.clone())).or_else(|| v.last().map(|(_, d)| d.clone()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmlPlan {
    pub version: String,
    pub folder: String,
    pub files: Vec<PlanFile>,
    pub installed: Vec<String>,
}

pub fn tml_plan(tml_root: &Path, pkg: &Package) -> Result<TmlPlan, String> {
    if !fsx::is_file(&tml_root.join("config.yaml")) {
        return Err("TMLoader not found".into());
    }
    let vdir = tml_product_dir(tml_root).join(&pkg.version);
    safe_rel(&pkg.version)?;
    for (r, _) in &pkg.files {
        base_target(&vdir, r)?;
    }
    Ok(TmlPlan {
        version: pkg.version.clone(),
        folder: vdir.to_string_lossy().into(),
        files: plan_files(Kind::Tml, &vdir, &pkg.files),
        installed: tml_versions(tml_root).into_iter().map(|(v, _)| v).collect(),
    })
}

/// Copies the package into `products\Horizon Host\<version>\` (built next to it, then swapped
/// in) and ticks it in the given profiles. TMLoader and the game must not run (caller checks).
pub fn tml_apply(tml_root: &Path, pkg: &Package, extra: &[(String, Vec<u8>)], product_desc: Option<&[u8]>, profiles: &[String], backup_dir: &Path) -> Result<String, String> {
    tml_plan(tml_root, pkg)?;
    let _g = crate::tmloader::write_lock();
    let pdir = tml_product_dir(tml_root);
    let vdir = pdir.join(&pkg.version);
    let next = pdir.join(format!(".{}.tmhub-installing", pkg.version));
    let old = pdir.join(format!(".{}.tmhub-old", pkg.version));
    let _ = std::fs::remove_dir_all(&next);
    let _ = std::fs::remove_dir_all(&old);
    // Files of the old version folder (logs, plugin settings, profile.json) carry over.
    if fsx::is_dir(&vdir) {
        for (rel, _) in &pkg.files {
            crate::tmloader::backup(tml_root, &base_target(&vdir, rel)?, backup_dir)?;
        }
        copy_tree(&vdir, &next)?;
    } else if let Some((_, prev)) = tml_versions(tml_root).into_iter().filter(|(v, _)| v != &pkg.version).last() {
        carry_over(&prev, &next, pkg)?;
    }
    for (rel, bytes) in pkg.files.iter().chain(extra.iter()) {
        let keep = keep_on_update(rel) && fsx::is_file(&rel_path(&next, rel)) && !rel.eq_ignore_ascii_case("description.yaml");
        if !keep {
            fsx::write(&base_target(&next, rel)?, bytes)?;
        }
    }
    let rec = InstallRecord {
        version: pkg.version.clone(),
        source: pkg.source.clone(),
        files: pkg.files.iter().map(|(r, _)| r.clone()).collect(),
        sha256: pkg.files.iter().map(|(r, b)| (r.clone(), sha256_hex(b))).collect(),
        installed_at: fsx::now_iso(),
        ..Default::default()
    };
    write_record(Kind::Tml, &next, &rec)?;
    if !fsx::is_file(&next.join("description.yaml")) {
        let exe = pkg.files.iter().map(|(r, _)| r.as_str()).find(|r| !r.contains('/') && r.to_lowercase().ends_with(".dll")).unwrap_or(HOST_DLL);
        fsx::write(&next.join("description.yaml"), format!("executable: {exe}\ndependencies:\n  - id: CoreMod\n").as_bytes())?;
    }
    if fsx::is_dir(&vdir) {
        std::fs::rename(&vdir, &old).map_err(|e| format!("{}: {e}", vdir.display()))?;
    }
    if let Err(e) = std::fs::rename(&next, &vdir) {
        let _ = std::fs::rename(&old, &vdir);
        return Err(format!("{}: {e}", vdir.display()));
    }
    let _ = std::fs::remove_dir_all(&old);
    let pdesc = pdir.join("description.yaml");
    if let (false, Some(d)) = (fsx::is_file(&pdesc), product_desc) {
        fsx::write(&pdesc, d)?;
    }
    if !fsx::is_file(&pdesc) {
        fsx::write(&pdesc, b"name: Horizon Client\nauthor: TM Horizon\ntype: modification\ndescription: In-game menu and modules of TM Horizon (experimental).\n")?;
    }
    drop(_g);
    let mut ticked = Vec::new();
    for p in profiles {
        crate::tmloader::set_profile_mod(tml_root, p, TML_PRODUCT, true, backup_dir)?;
        ticked.push(p.clone());
    }
    Ok(if ticked.is_empty() {
        format!("Horizon Client {} installed in TMLoader.", pkg.version)
    } else {
        format!("Horizon Client {} installed in TMLoader and switched on in {}.", pkg.version, ticked.join(", "))
    })
}

/// Unticks the product in every profile and moves its folder into the backup folder.
pub fn tml_remove(tml_root: &Path, backup_dir: &Path) -> Result<String, String> {
    let pdir = tml_product_dir(tml_root);
    if !fsx::is_dir(&pdir) {
        return Err("Horizon Client is not installed in TMLoader".into());
    }
    for p in crate::tmloader::read_info(tml_root).profiles {
        if p.mods.iter().any(|m| m.id == TML_PRODUCT) {
            crate::tmloader::set_profile_mod(tml_root, &p.name, TML_PRODUCT, false, backup_dir)?;
        }
    }
    let _g = crate::tmloader::write_lock();
    copy_tree(&pdir, &backup_dir.join(TML_PRODUCT))?;
    if !fsx::is_inside(&pdir, &crate::tmloader::products_dir(tml_root)) {
        return Err("refusing".into());
    }
    std::fs::remove_dir_all(&pdir).map_err(|e| format!("{}: {e}", pdir.display()))?;
    Ok(format!("Horizon Client removed from TMLoader. Backup: {}", backup_dir.display()))
}

/// A new version folder takes over from the last installed one what is the user's: modules the
/// client package does not ship (TMVS Horizon modules and others installed later) and settings
/// files (.ini/.cfg/.json) the new package does not bring. The product's own `settings`, `logs` and
/// `data` folders sit beside the versions and are never touched.
fn carry_over(prev: &Path, next: &Path, pkg: &Package) -> Result<(), String> {
    let new_ids: Vec<String> = pkg.plugins(PLUGIN_PREFIX_TML).into_keys().map(|k| k.to_lowercase()).collect();
    let id_of = |rel: &str| rel.strip_prefix(PLUGIN_PREFIX_TML).and_then(|r| r.split_once('/')).map(|(id, _)| id.to_lowercase());
    let old_ids: Vec<String> = read_record(prev).map(|r| r.files.iter().filter_map(|f| id_of(&f.to_lowercase())).collect()).unwrap_or_default();
    let pdir = prev.join(PLUGIN_PREFIX_TML.trim_end_matches('/'));
    for e in fsx::list(&pdir) {
        let id = e.name.to_lowercase();
        if e.is_dir && !new_ids.contains(&id) && !old_ids.contains(&id) {
            copy_tree(&e.path, &next.join(PLUGIN_PREFIX_TML.trim_end_matches('/')).join(&e.name))?;
        }
    }
    let ours: Vec<String> = pkg.files.iter().map(|(r, _)| r.to_lowercase()).collect();
    fn walk(d: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
        for e in fsx::list(d) {
            let r = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
            if e.is_dir {
                walk(&e.path, &r, out);
            } else if e.is_file {
                out.push((r, e.path));
            }
        }
    }
    let mut all = Vec::new();
    walk(prev, "", &mut all);
    for (rel, p) in all {
        let l = rel.to_lowercase();
        let plugin_ok = id_of(&l).map(|id| new_ids.contains(&id)).unwrap_or(true);
        if keep_on_update(&rel) && !l.eq_ignore_ascii_case(RECORD) && !ours.contains(&l) && plugin_ok {
            fsx::copy(&p, &base_target(next, &rel)?)?;
        }
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    for e in fsx::list(from) {
        let dest = to.join(&e.name);
        if e.is_dir {
            copy_tree(&e.path, &dest)?;
        } else if e.is_file {
            fsx::copy(&e.path, &dest)?;
        }
    }
    std::fs::create_dir_all(to).map_err(|e| e.to_string())
}

/// The version's description.yaml next to a TM Horizon-layout manifest (the host's own manifest
/// lists it as a file already).
pub fn tml_extra(vdir_src: &Path) -> Vec<(String, Vec<u8>)> {
    ["description.yaml"].iter().filter_map(|n| std::fs::read(vdir_src.join(n)).ok().map(|b| (n.to_string(), b))).collect()
}

/// The product's own description.yaml (one folder above the version).
pub fn tml_product_desc(vdir_src: &Path) -> Option<Vec<u8>> {
    std::fs::read(vdir_src.parent()?.join("description.yaml")).ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmlStatus {
    pub tmloader: bool,
    pub installed: Vec<String>,
    pub source: SourceInfo,
    pub update: bool,
    /// TMLoader profiles with the product switched on.
    pub profiles_on: Vec<String>,
    pub profiles: Vec<String>,
    pub plugins: Vec<PluginState>,
    pub host_root: Option<String>,
    pub has_log: bool,
    /// The client version this profile runs switches modules while the game runs (0.3.0 and later).
    pub runtime_modules: bool,
}

pub fn tml_status(tml_root: Option<&Path>, data: &Path, profile: Option<&str>, game: &str, pkg: Result<Package, String>, src: SourceInfo) -> TmlStatus {
    let mut source = src;
    let pkg = match pkg {
        Ok(p) => {
            source.tml_version = Some(p.version.clone());
            Some(p)
        }
        Err(e) => {
            source.error = Some(e);
            None
        }
    };
    let info = tml_root.filter(|r| fsx::is_file(&r.join("config.yaml"))).map(crate::tmloader::read_info);
    let installed: Vec<String> = tml_root.map(tml_versions).unwrap_or_default().into_iter().map(|(v, _)| v).collect();
    let update = match (installed.last(), &source.tml_version) {
        (Some(i), Some(a)) => crate::updates::is_newer(a, i),
        _ => false,
    };
    let pinned = info.as_ref().and_then(|i| i.profiles.iter().find(|p| Some(p.name.as_str()) == profile)).and_then(|p| p.mods.iter().find(|m| m.id == TML_PRODUCT)).and_then(|m| m.version.clone());
    let host_root = tml_root.and_then(|r| tml_host_root(r, pinned.as_deref()));
    let en = profile.and_then(|p| enabled(data, &tml_scope(p)));
    TmlStatus {
        tmloader: info.is_some(),
        update,
        profiles_on: info.as_ref().map(|i| i.profiles.iter().filter(|p| p.mods.iter().any(|m| m.id == TML_PRODUCT)).map(|p| p.name.clone()).collect()).unwrap_or_default(),
        profiles: info.as_ref().map(|i| i.profiles.iter().map(|p| p.name.clone()).collect()).unwrap_or_default(),
        plugins: host_root.as_deref().map(|h| plugin_states(h, pkg.as_ref(), PLUGIN_PREFIX_TML, game, en.as_deref())).unwrap_or_default(),
        has_log: host_root.as_deref().map(|h| !log_files(h, 1).is_empty()).unwrap_or(false),
        runtime_modules: loads_at_runtime(host_root.as_deref().and_then(|h| h.file_name()).map(|n| n.to_string_lossy()).as_deref()),
        host_root: host_root.map(|h| h.to_string_lossy().into()),
        installed,
        source,
    }
}

/// Before a start: profile.json for the host that will load. It is an override: written only for
/// safe mode or when the user switched plugins in TM Horizon; otherwise an earlier one of ours is
/// removed and the host uses its defaults (every installed plugin). Legacy: the started folder;
/// Forever: the TMLoader profile's product folder.
pub fn before_start(data: &Path, game: &str, dir: &Path, tml_root: Option<&Path>, tml_profile: Option<&str>, safe: bool) -> Result<Option<Profile>, String> {
    let hotkey = load_store(data).hotkey;
    if is_legacy(game) {
        let host_root = dir.join(HOST_DIR);
        if read_record(&host_root).is_none() && !fsx::is_file(&host_root.join(HOST_DLL)) {
            return Ok(None);
        }
        return profile_for_start(&host_root, game, "Default", enabled(data, &dir_scope(dir)), safe, hotkey.as_deref());
    }
    if is_forever(game) {
        let (Some(root), Some(profile)) = (tml_root, tml_profile) else { return Ok(None) };
        let info = crate::tmloader::read_info(root);
        let Some(p) = info.profiles.iter().find(|p| p.name == profile) else { return Ok(None) };
        let Some(m) = p.mods.iter().find(|m| m.id == TML_PRODUCT) else { return Ok(None) };
        let Some(host_root) = tml_host_root(root, m.version.as_deref()) else { return Ok(None) };
        return profile_for_start(&host_root, game, profile, enabled(data, &tml_scope(profile)), safe, hotkey.as_deref());
    }
    Ok(None)
}

fn profile_for_start(host_root: &Path, game: &str, profile: &str, en: Option<Vec<String>>, safe: bool, hotkey: Option<&str>) -> Result<Option<Profile>, String> {
    match en {
        _ if safe => write_profile(host_root, game, profile, &[], true, hotkey).map(Some),
        Some(list) => write_profile(host_root, game, profile, &list, false, hotkey).map(Some),
        None => drop_profile(host_root).map(|_| None),
    }
}

/// Host logs for the problem report: (file, zip folder, label).
pub fn report_logs(install: Option<&Path>, tml_root: Option<&Path>) -> Vec<(PathBuf, String, String)> {
    let mut out = Vec::new();
    let mut roots = Vec::new();
    if let Some(d) = install {
        roots.push(d.join(HOST_DIR));
    }
    if let Some(r) = tml_root {
        roots.extend(tml_versions(r).into_iter().map(|(_, d)| d));
    }
    for h in roots {
        for p in log_files(&h, 3) {
            out.push((p, "logs/Horizon".into(), "Horizon Client log".into()));
        }
        let prof = h.join(PROFILE);
        if fsx::is_file(&prof) {
            out.push((prof, "logs/Horizon".into(), "Horizon Client profile".into()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tml_settings_and_logs_folders_are_not_versions() {
        // Layout of Horizon Client 0.3.0 next to 0.2.0: settings, logs and data sit beside the version folders.
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        std::fs::write(root.join("config.yaml"), "version: 1.0.1
").unwrap();
        let pdir = tml_product_dir(root);
        for v in ["0.2.0", "0.3.0"] {
            let d = pdir.join(v);
            std::fs::create_dir_all(d.join("plugins").join("input-display")).unwrap();
            std::fs::write(d.join("description.yaml"), "executable: HorizonHost.dll
").unwrap();
            std::fs::write(d.join(HOST_DLL), b"x").unwrap();
            std::fs::write(d.join("plugins").join("input-display").join("plugin.json"), r#"{"id":"input-display","name":"Input Display","version":"0.1.0","icon":"icon.png","enabled_by_default":false}"#).unwrap();
        }
        std::fs::create_dir_all(pdir.join("settings")).unwrap();
        std::fs::write(pdir.join("settings").join("host.json"), r#"{"plugin.input-display.enabled":1}"#).unwrap();
        std::fs::create_dir_all(pdir.join("logs")).unwrap();
        std::fs::write(pdir.join("logs").join("host.log"), "x").unwrap();
        std::fs::create_dir_all(pdir.join("data").join("input-display")).unwrap();
        let names: Vec<String> = tml_versions(root).into_iter().map(|(v, _)| v).collect();
        assert_eq!(names, ["0.2.0", "0.3.0"]);
        let host = tml_host_root(root, None).unwrap();
        assert!(host.ends_with("0.3.0"));
        // Settings and logs of the product level are the ones the client uses.
        assert_eq!(host_settings_path(&host), pdir.join("settings").join("host.json"));
        assert_eq!(log_files(&host, 1).len(), 1);
        let st = tml_status(Some(root), t.path(), None, "tmnf", Err("offline".into()), SourceInfo::default());
        assert_eq!(st.installed, ["0.2.0", "0.3.0"]);
        assert!(st.runtime_modules);
        let p = st.plugins.iter().find(|p| p.id == "input-display").expect("module listed");
        assert!(p.enabled, "on in the in-game menu (product-level host.json)");
        assert!(!p.startup_only);
        assert!(!loads_at_runtime(Some("0.2.0")) && loads_at_runtime(Some("0.3.0")) && loads_at_runtime(None));
    }

    #[test]
    fn menu_switch_shares_host_json_with_the_in_game_menu() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("horizon");
        assert_eq!(menu_switch(&root, "capture"), None, "no file: never switched");
        // Keys the host wrote stay; the switch is a number like the host writes it.
        std::fs::create_dir_all(root.join("settings")).unwrap();
        std::fs::write(host_settings_path(&root), "\u{feff}{\"hotkey.host.menu\":\"F2\",\"plugin.capture.enabled\":1,\"bar\":0}").unwrap();
        assert_eq!(menu_switch(&root, "capture"), Some(true));
        set_menu_switch(&root, "capture", false).unwrap();
        set_menu_switch(&root, "wr-hunter", true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(host_settings_path(&root)).unwrap()).unwrap();
        assert_eq!(v["plugin.capture.enabled"], 0);
        assert_eq!(v["plugin.wr-hunter.enabled"], 1);
        assert_eq!(v["hotkey.host.menu"], "F2");
        assert_eq!(v["bar"], 0);
        assert_eq!(menu_switch(&root, "capture"), Some(false));
        // A broken file is not overwritten.
        std::fs::write(host_settings_path(&root), "[1,2]").unwrap();
        assert!(set_menu_switch(&root, "capture", true).is_err());
        assert_eq!(std::fs::read_to_string(host_settings_path(&root)).unwrap(), "[1,2]");
    }

    fn sandbox(tag: &str, exe: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let game = t.path().join("Game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join(exe), b"MZ dummy").unwrap();
        let data = t.path().join(format!("data-{tag}"));
        (t, game, data)
    }

    /// A dev dist folder like the host repo builds it.
    fn dist(root: &Path, version: &str, loader: &[u8]) -> PathBuf {
        let d = root.join(format!("dist-{version}"));
        let files: Vec<(&str, Vec<u8>)> = vec![
            ("dinput8.dll", loader.to_vec()),
            ("horizon/host.dll", format!("host {version}").into_bytes()),
            ("horizon/host.ini", b"[host]".to_vec()),
            ("horizon/plugins/eswc-autosave/plugin.json", br#"{"id":"eswc-autosave","name":"Autosave","version":"0.1.0","description":"Saves every finished run as a replay.","games":["eswc","sunrise"],"online":"solo-only"}"#.to_vec()),
            ("horizon/plugins/eswc-autosave/eswc-autosave.dll", b"MZ autosave".to_vec()),
            ("horizon/plugins/sample/plugin.json", br#"{"id":"sample","name":"Sample","version":"1.0.0","description":"Shows a tile in the menu and an overlay text.","games":31}"#.to_vec()),
            ("horizon/plugins/sample/sample.dll", b"MZ sample".to_vec()),
        ];
        let mut man = Vec::new();
        for (r, b) in &files {
            let p = rel_path(&d.join("legacy"), r);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b).unwrap();
            man.push(serde_json::json!({ "path": r, "sha256": sha256_hex(b) }));
        }
        std::fs::write(d.join("legacy").join(MANIFEST), serde_json::json!({ "version": version, "files": man }).to_string()).unwrap();
        // TMLoader build: host.dll + description.yaml + one plugin.
        let v = d.join("tmloader").join(TML_PRODUCT).join(version);
        std::fs::create_dir_all(v.join("plugins/sample")).unwrap();
        let tfiles: Vec<(&str, Vec<u8>)> = vec![("host.dll", b"MZ host tml".to_vec()), ("plugins/sample/plugin.json", br#"{"id":"sample","version":"1.0.0"}"#.to_vec())];
        let mut tman = Vec::new();
        for (r, b) in &tfiles {
            std::fs::write(rel_path(&v, r), b).unwrap();
            tman.push(serde_json::json!({ "path": r, "sha256": sha256_hex(b) }));
        }
        std::fs::write(v.join(MANIFEST), serde_json::json!({ "version": version, "files": tman }).to_string()).unwrap();
        std::fs::write(v.join("description.yaml"), "executable: host.dll\ndependencies:\n  - id: CoreMod\n").unwrap();
        d
    }

    #[test]
    fn manifest_and_plugin_formats() {
        let m = parse_manifest(r#"{"version":"v0.2.0","files":{"dinput8.dll":"AB","horizon\\host.dll":"cd"}}"#).unwrap();
        assert_eq!(m.version, "0.2.0");
        assert!(m.files.iter().any(|f| f.path == "horizon/host.dll" && f.sha256 == "cd"));
        assert!(parse_manifest(r#"{"files":[]}"#).is_err());
        let p = parse_plugin(r#"{"name":"X","games":5}"#, "x").unwrap();
        assert_eq!(p.id, "x");
        assert_eq!(p.games, ["tmn-eswc", "tm-original"]);
        assert_eq!(parse_plugin(r#"{"games":["sunrise","TMUF","nope"]}"#, "y").unwrap().games, ["tm-sunrise", "tmuf"]);
        for bad in ["../x", "a/../b", "C:/x", "/x", "a//b", "x.dll.", "a:b"] {
            assert!(safe_rel(bad).is_err(), "{bad}");
        }
        assert_eq!(safe_rel("horizon\\host.dll").unwrap(), "horizon/host.dll");
    }

    /// The host repo's own packaging (tools/package.py): dist\manifest.json + per-game zips.
    fn host_dist(root: &Path, version: &str) -> PathBuf {
        let d = root.join("host-dist");
        let rel = std::fs::create_dir_all(d.join("release"));
        rel.unwrap();
        let files: Vec<(&str, &[u8])> = vec![
            ("horizon/loader/dinput8.dll", b"MZ loader"),
            ("horizon/loader/install.ps1", b"ps"),
            ("horizon/host.dll", b"MZ host"),
            ("horizon/plugins/eswc-autosave/plugin.json", br#"{"id":"eswc-autosave","name":"ESWC Autosave","version":"2.0.0","games":["eswc","sunrise"],"enabled_by_default":false}"#),
            ("horizon/plugins/eswc-autosave/eswc-autosave.dll", b"MZ as"),
            ("Horizon-Install.cmd", b"@echo off"),
            ("README-Horizon.txt", b"readme"),
        ];
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            for (n, b) in &files {
                z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
                std::io::Write::write_all(&mut z, b).unwrap();
            }
            z.finish().unwrap();
        }
        let zip = buf.into_inner();
        std::fs::write(d.join("release/Horizon-Host-x-ESWC.zip"), &zip).unwrap();
        let tv = d.join("tmloader/Horizon Host").join(version);
        std::fs::create_dir_all(tv.join("plugins/sample")).unwrap();
        std::fs::write(d.join("tmloader/Horizon Host/description.yaml"), "name: Horizon Host\ntype: modification\n").unwrap();
        std::fs::write(tv.join("description.yaml"), "executable: HorizonHost.dll\n").unwrap();
        std::fs::write(tv.join("HorizonHost.dll"), "MZ").unwrap();
        std::fs::write(tv.join("plugins/sample/plugin.json"), r#"{"id":"sample"}"#).unwrap();
        let tfiles: Vec<serde_json::Value> = ["description.yaml", &format!("{version}/description.yaml"), &format!("{version}/HorizonHost.dll"), &format!("{version}/plugins/sample/plugin.json")]
            .iter()
            .map(|r| serde_json::json!({ "path": r, "sha256": sha256_hex(&std::fs::read(rel_path(&d.join("tmloader/Horizon Host"), r)).unwrap()) }))
            .collect();
        let m = serde_json::json!({
            "name": "Horizon Host", "version": version, "plugin_abi": 1,
            "packages": [{ "game": "eswc", "zip": "release/Horizon-Host-x-ESWC.zip", "sha256": sha256_hex(&zip),
                "files": files.iter().map(|(n, b)| serde_json::json!({ "path": n, "sha256": sha256_hex(b) })).collect::<Vec<_>>() }],
            "tmloader_product": { "folder": "tmloader/Horizon Host", "files": tfiles }
        });
        std::fs::write(d.join(MANIFEST), m.to_string()).unwrap();
        d
    }

    #[test]
    fn reads_the_host_repos_dist_layout() {
        let t = tempfile::tempdir().unwrap();
        let d = host_dist(t.path(), "0.1.0");
        let p = dev_legacy_for(&d, "tmn-eswc").unwrap();
        let names: Vec<&str> = p.files.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(names, ["dinput8.dll", "horizon/host.dll", "horizon/plugins/eswc-autosave/plugin.json", "horizon/plugins/eswc-autosave/eswc-autosave.dll"]);
        assert!(dev_legacy_for(&d, "tm-original").unwrap_err().contains("no build"));
        let (vsrc, tp) = dev_tml(&d).unwrap();
        assert_eq!(tp.version, "0.1.0");
        assert!(tp.files.iter().any(|(r, _)| r == "HorizonHost.dll"));
        assert!(tml_product_desc(&vsrc).is_some());
        // enabled_by_default: false -> off without a choice; profile.json keys as the host reads them.
        let (_t2, game, data) = sandbox("hostdist", "TmNationsESWC.exe");
        prepare(&game, &data, p.clone()).unwrap();
        apply(&game, &data).unwrap();
        install_plugin(Kind::Legacy, &game, &data, &p, "eswc-autosave").unwrap();
        assert!(installed_ids(&game.join(HOST_DIR)).is_empty());
        let st = status(&game, &data, Ok(p), SourceInfo::default()).unwrap();
        assert!(!st.plugins[0].enabled);
        let prof = before_start(&data, "tmn-eswc", &game, None, None, true).unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(game.join("horizon/profile.json")).unwrap()).unwrap();
        assert_eq!(v["format"], 1);
        assert_eq!(v["game"], "eswc");
        assert_eq!(v["safe_mode"], true);
        assert!(v.get("written_by").is_some() && prof.safe_mode);
        // A tampered zip is refused.
        let z = d.join("release/Horizon-Host-x-ESWC.zip");
        let mut b = std::fs::read(&z).unwrap();
        let n = b.len();
        b[n - 30] ^= 1;
        std::fs::write(&z, b).unwrap();
        assert!(dev_legacy_for(&d, "tmn-eswc").unwrap_err().contains("Checksum"));
    }

    fn release_json(version: &str, base: &str) -> serde_json::Value {
        serde_json::json!({ "tag_name": format!("v{version}"), "assets": [
            { "name": "manifest.json", "browser_download_url": format!("{base}/manifest.json") },
            { "name": format!("Horizon-Host-{version}-ESWC.zip"), "browser_download_url": format!("{base}/Horizon-Host-{version}-ESWC.zip") },
            { "name": "notes.txt", "browser_download_url": format!("{base}/notes.txt") } ] })
    }

    #[test]
    fn github_release_source_is_checked_like_the_dev_folder() {
        let t = tempfile::tempdir().unwrap();
        let d = host_dist(t.path(), "0.1.0");
        assert_eq!(dev_version(&d).as_deref(), Some("0.1.0"));
        let base = "https://github.com/cheatoskar/horizon-host/releases/download/v0.1.0";
        let zip = std::fs::read(d.join("release/Horizon-Host-x-ESWC.zip")).unwrap();
        let man = std::fs::read(d.join(MANIFEST)).unwrap();
        let fetch = |u: &str, _max: u64| -> Result<Vec<u8>, String> {
            if u.ends_with("manifest.json") { Ok(man.clone()) } else if u.ends_with("-ESWC.zip") { Ok(zip.clone()) } else { Err("404".into()) }
        };
        let rel = release_json("0.1.0", base);
        let r = parse_release(&rel).unwrap();
        assert_eq!((r.version.as_str(), r.zips.len(), r.zips[0].0.as_str()), ("0.1.0", 1, "eswc"));
        let p = github_package("tmn-eswc", &rel, &fetch).unwrap();
        assert_eq!(p.version, "0.1.0");
        assert_eq!(p.source, format!("github:{GITHUB_REPO}"));
        assert!(p.files.iter().any(|(r, _)| r == "dinput8.dll"));
        // No build for that game, a foreign download host, a tampered zip, a manifest of another release.
        assert!(github_package("tm-original", &rel, &fetch).unwrap_err().contains("no build"));
        assert!(github_package("tmn-eswc", &release_json("0.1.0", "https://evil.example/x"), &fetch).unwrap_err().contains("not a GitHub"));
        let mut bad = zip.clone();
        let n = bad.len();
        bad[n - 30] ^= 1;
        assert!(github_package("tmn-eswc", &rel, &|u: &str, m: u64| if u.ends_with(".zip") { Ok(bad.clone()) } else { fetch(u, m) }).unwrap_err().contains("Checksum"));
        assert!(github_package("tmn-eswc", &release_json("0.2.0", base), &fetch).unwrap_err().contains("does not belong"));
        assert!(parse_release(&serde_json::json!({ "tag_name": "v1", "assets": [] })).unwrap_err().contains("no manifest"));
    }

    #[test]
    fn rejects_bad_checksums() {
        let t = tempfile::tempdir().unwrap();
        let d = dist(t.path(), "0.1.0", b"loader");
        std::fs::write(d.join("legacy/horizon/host.dll"), b"tampered").unwrap();
        let e = dev_legacy(&d).unwrap_err();
        assert!(e.contains("Checksum"), "{e}");
    }

    #[test]
    fn a_build_folder_is_read_again_only_when_it_changed() {
        let t = tempfile::tempdir().unwrap();
        let d = dist(t.path(), "0.1.0", b"loader");
        let a = dev_legacy_cached(&d, "tmn-eswc").unwrap();
        assert_eq!(a.version, "0.1.0");
        assert_eq!(dev_legacy_cached(&d, "tm-sunrise").unwrap().files, a.files, "same build, same files");
        assert_eq!(dev_tml_cached(&d).unwrap().1.version, "0.1.0");
        // A tampered file changes size and time: read again, the checksum check catches it.
        std::fs::write(d.join("legacy/horizon/host.dll"), b"tampered, and longer").unwrap();
        assert!(dev_legacy_cached(&d, "tmn-eswc").unwrap_err().contains("Checksum"));
        // A new build in the same folder is picked up.
        let d2 = dist(t.path(), "0.2.10", b"loader");
        std::fs::remove_dir_all(&d).unwrap();
        std::fs::rename(&d2, &d).unwrap();
        assert_eq!(dev_legacy_cached(&d, "tmn-eswc").unwrap().version, "0.2.10");
    }

    #[test]
    fn install_backup_update_remove_restore_with_a_foreign_dinput8() {
        let (t, game, data) = sandbox("flow", "TmNationsESWC.exe");
        // The owner's ESWC Autosave loader.
        std::fs::write(game.join("dinput8.dll"), b"autosave loader").unwrap();
        std::fs::write(game.join("eswc_autosave.dll"), b"MZ old autosave").unwrap();
        std::fs::write(game.join("eswc_autosave.ini"), b"[autosave]\nkey=F9\n").unwrap();
        assert_eq!(loader_state(&game), "other");

        let d1 = dist(t.path(), "0.1.0", b"horizon loader v1");
        let plan = prepare(&game, &data, dev_legacy(&d1).unwrap()).unwrap();
        assert_eq!(plan.game, "tmn-eswc");
        assert_eq!(plan.chains.as_deref(), Some("ESWC Autosave"));
        assert!(plan.autosave_present);
        let paths: Vec<&str> = plan.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["dinput8.chain.dll", "dinput8.dll", "horizon/host.dll", "horizon/host.ini"], "core only, plugins separately");
        assert_eq!(plan.files[0].action, "chain");
        apply(&game, &data).unwrap();
        assert_eq!(std::fs::read(game.join("dinput8.dll")).unwrap(), b"horizon loader v1");
        assert_eq!(std::fs::read(game.join(CHAIN)).unwrap(), b"autosave loader", "the old loader keeps running chained");
        assert_eq!(loader_state(&game), "horizon");
        // Without a choice in TM Horizon no profile.json is written (host defaults).
        assert!(before_start(&data, "tmn-eswc", &game, None, None, false).unwrap().is_none());
        assert!(!game.join("horizon/profile.json").exists());
        let st = status(&game, &data, Err("x".into()), SourceInfo::default()).unwrap();
        assert_eq!(st.chained.as_deref(), Some("ESWC Autosave"));
        assert!(!st.custom_plugins);
        let rec = read_record(&game.join(HOST_DIR)).unwrap();
        assert_eq!(rec.version, "0.1.0");
        assert_eq!(rec.previous_owner.as_deref(), Some("ESWC Autosave"));
        let prev = rec.previous_backup.clone().unwrap();
        let root = backup_root(&data);
        assert_eq!(std::fs::read(root.join(&prev).join("files").join("dinput8.dll")).unwrap(), b"autosave loader");

        // Plugins + migration of ESWC Autosave + profile.json.
        let pkg = dev_legacy(&d1).unwrap();
        migrate_autosave(&game, &data, &pkg).unwrap();
        assert!(game.join("horizon/plugins/eswc-autosave/eswc-autosave.dll").is_file());
        assert!(!game.join(CHAIN).exists(), "migration ends the chain");
        assert_eq!(std::fs::read_to_string(game.join("horizon/plugins/eswc-autosave/eswc_autosave.ini")).unwrap(), "[autosave]\nkey=F9\n");
        install_plugin(Kind::Legacy, &game, &data, &pkg, "sample").unwrap();
        set_enabled(&data, &dir_scope(&game), "sample", true, &[]).unwrap();
        set_enabled(&data, &dir_scope(&game), "missing-one", true, &[]).unwrap();
        let p = before_start(&data, "tmn-eswc", &game, None, None, false).unwrap().unwrap();
        let ids: Vec<&str> = p.plugins.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["eswc-autosave", "sample"], "only installed ones, in enabled order");
        let written: Profile = serde_json::from_str(&std::fs::read_to_string(game.join("horizon/profile.json")).unwrap()).unwrap();
        assert_eq!(written, p);
        let safe = before_start(&data, "tmn-eswc", &game, None, None, true).unwrap().unwrap();
        assert!(safe.safe_mode && safe.plugins.is_empty());
        let st = status(&game, &data, Ok(pkg.clone()), SourceInfo::default()).unwrap();
        assert!(st.autosave_migrated && !st.update);
        assert_eq!(st.installed.as_deref(), Some("0.1.0"));
        assert!(st.previous.is_some());

        // Update: host.dll replaced with a backup, the user's host.ini kept.
        std::fs::write(game.join("horizon/host.ini"), b"[mine]").unwrap();
        let d2 = dist(t.path(), "0.2.0", b"horizon loader v2");
        let st = status(&game, &data, dev_legacy(&d2), SourceInfo::default()).unwrap();
        assert!(st.update);
        let plan = prepare(&game, &data, dev_legacy(&d2).unwrap()).unwrap();
        assert!(plan.chains.is_none(), "dinput8.dll is ours now");
        assert_eq!(plan.files.iter().find(|f| f.path == "horizon/host.ini").unwrap().action, "keep");
        apply(&game, &data).unwrap();
        assert_eq!(std::fs::read(game.join("horizon/host.dll")).unwrap(), b"host 0.2.0");
        assert_eq!(std::fs::read(game.join("horizon/host.ini")).unwrap(), b"[mine]");
        assert_eq!(read_record(&game.join(HOST_DIR)).unwrap().previous_backup.as_deref(), Some(prev.as_str()), "the first foreign loader stays restorable");

        // Remove with one-click restore of the old loader; plugins and logs stay.
        std::fs::create_dir_all(game.join("horizon/logs")).unwrap();
        std::fs::write(game.join("horizon/logs/2026-11-11_20-00-00.log"), "host started\nplugin autosave loaded\n").unwrap();
        remove(&game, &data, true).unwrap();
        assert_eq!(std::fs::read(game.join("dinput8.dll")).unwrap(), b"autosave loader");
        assert!(!game.join("horizon/host.dll").exists());
        assert!(game.join("horizon/plugins/eswc-autosave/plugin.json").is_file());
        assert_eq!(loader_state(&game), "other");
        assert!(latest_log(&game.join(HOST_DIR)).unwrap().text.contains("autosave loaded"));
        assert_eq!(report_logs(Some(&game), None).len(), 2, "log + profile.json");

        // Restore the backup made before the removal: Horizon is back.
        let b = list_backups(&root, &game).into_iter().find(|b| b.reason == "before removing Horizon Client").unwrap();
        restore(&game, &data, &b.id).unwrap();
        assert_eq!(std::fs::read(game.join("dinput8.dll")).unwrap(), b"horizon loader v2");
        // Plugin removal is backed up too.
        remove_plugin(Kind::Legacy, &game, &data, "sample").unwrap();
        assert!(!game.join("horizon/plugins/sample").exists());
        assert!(list_backups(&root, &game).iter().any(|b| b.reason.contains("removing plugin sample")));
    }

    #[test]
    fn chain_install_and_uninstall_restore_the_original() {
        let (t, game, data) = sandbox("chain", "TmNationsESWC.exe");
        std::fs::write(game.join("dinput8.dll"), b"someone's proxy").unwrap();
        let d = dist(t.path(), "0.1.0", b"horizon loader");
        prepare(&game, &data, dev_legacy(&d).unwrap()).unwrap();
        apply(&game, &data).unwrap();
        assert_eq!(std::fs::read(game.join(CHAIN)).unwrap(), b"someone's proxy");
        assert_eq!(status(&game, &data, Err("x".into()), SourceInfo::default()).unwrap().chained.as_deref(), Some("unknown"));
        // Safe mode, then a normal start without a choice: our profile.json goes away again.
        assert!(before_start(&data, "tmn-eswc", &game, None, None, true).unwrap().unwrap().safe_mode);
        assert!(game.join("horizon/profile.json").is_file());
        assert!(before_start(&data, "tmn-eswc", &game, None, None, false).unwrap().is_none());
        assert!(!game.join("horizon/profile.json").exists());
        // A profile.json the user wrote by hand is left alone.
        std::fs::write(game.join("horizon/profile.json"), "{\"schema\":1}").unwrap();
        before_start(&data, "tmn-eswc", &game, None, None, false).unwrap();
        assert!(game.join("horizon/profile.json").exists());
        remove(&game, &data, false).unwrap();
        assert_eq!(std::fs::read(game.join("dinput8.dll")).unwrap(), b"someone's proxy");
        assert!(!game.join(CHAIN).exists());
    }

    #[test]
    fn takes_over_a_package_install_without_chaining_it() {
        let (t, game, data) = sandbox("pkg", "TmSunrise.exe");
        // Horizon-Install.cmd: the old proxy became the chain, the loader sits in dinput8.dll.
        std::fs::write(game.join("dinput8.dll"), b"horizon loader from the zip").unwrap();
        std::fs::write(game.join(CHAIN), b"someone's proxy").unwrap();
        std::fs::create_dir_all(game.join("horizon")).unwrap();
        std::fs::write(game.join("horizon/host.dll"), b"host from the zip").unwrap();
        assert!(package_loader(&game, None));
        let d = dist(t.path(), "0.1.0", b"horizon loader");
        let plan = prepare(&game, &data, dev_legacy(&d).unwrap()).unwrap();
        assert!(plan.chains.is_none(), "never chain a Horizon loader");
        apply(&game, &data).unwrap();
        assert_eq!(std::fs::read(game.join("dinput8.dll")).unwrap(), b"horizon loader");
        assert_eq!(std::fs::read(game.join(CHAIN)).unwrap(), b"someone's proxy", "the chain stays");
        assert_eq!(read_record(&game.join(HOST_DIR)).unwrap().chained.as_deref(), Some("unknown"));
        remove(&game, &data, false).unwrap();
        assert_eq!(std::fs::read(game.join("dinput8.dll")).unwrap(), b"someone's proxy");
    }

    #[test]
    fn restore_of_a_foreign_loader_marks_the_host_loader_gone() {
        let (t, game, data) = sandbox("restore", "TmSunrise.exe");
        std::fs::write(game.join("dinput8.dll"), b"someone else").unwrap();
        let d = dist(t.path(), "0.1.0", b"horizon loader");
        prepare(&game, &data, dev_legacy(&d).unwrap()).unwrap();
        apply(&game, &data).unwrap();
        let prev = read_record(&game.join(HOST_DIR)).unwrap().previous_backup.unwrap();
        restore(&game, &data, &prev).unwrap();
        assert_eq!(std::fs::read(game.join("dinput8.dll")).unwrap(), b"someone else");
        assert_eq!(loader_state(&game), "other");
        assert_eq!(status(&game, &data, Err("x".into()), SourceInfo::default()).unwrap().loader_owner.as_deref(), Some("unknown"));
    }

    #[test]
    fn refuses_other_folders_and_paths() {
        let (_t, game, _) = sandbox("refuse", "TmNationsESWC.exe");
        assert!(legacy_target(&game, "TmNationsESWC.exe").is_err(), "only loader + horizon\\");
        assert!(legacy_target(&game, "horizon/../x.dll").is_err());
        assert!(legacy_target(&game, "horizon/dinput8.dll").is_err());
        assert!(legacy_target(&game, "d3d9.dll").is_err());
        assert!(legacy_target(&game, "dinput8.dll").is_ok());
        let not_game = game.parent().unwrap().join("other");
        std::fs::create_dir_all(&not_game).unwrap();
        assert!(legacy_game_of(&not_game).is_err());
        assert!(legacy_game_of(&fsx::eswc_protected_dir()).is_err(), "never the StarForce folder");
        assert!(legacy_target(&fsx::eswc_protected_dir(), "dinput8.dll").is_err());
        // A Forever folder is not a legacy target.
        let tmnf = game.parent().unwrap().join("tmnf");
        std::fs::create_dir_all(&tmnf).unwrap();
        std::fs::write(tmnf.join("TmForever.exe"), b"MZ").unwrap();
        assert!(legacy_game_of(&tmnf).is_err());
    }

    #[test]
    fn no_profile_without_a_host() {
        let (_t, game, data) = sandbox("nohost", "TmNationsESWC.exe");
        assert!(before_start(&data, "tmn-eswc", &game, None, None, false).unwrap().is_none());
        assert!(!game.join("horizon").exists());
    }

    /// A TMLoader release zip like Horizon Client 0.3.1's (`Horizon Host\description.yaml`,
    /// `Horizon Host\<v>\...`) with its manifest and SHA256SUMS.txt.
    fn tml_release(version: &str, extra_zip_file: Option<(&str, &[u8])>, unlisted: Option<&str>) -> (serde_json::Value, Vec<u8>, Vec<u8>, Vec<u8>) {
        let v = |r: &str| format!("Horizon Host/{version}/{r}");
        let files: Vec<(String, Vec<u8>)> = vec![
            ("Horizon Host/description.yaml".into(), b"name: Horizon Client\nexecutable: HorizonHost.dll\n".to_vec()),
            (v("HorizonHost.dll"), b"MZ host".to_vec()),
            (v("description.yaml"), b"executable: HorizonHost.dll\ndependencies:\n  - id: CoreMod\n".to_vec()),
            (v("modules.json"), b"{}".to_vec()),
            (v("plugins/input-display/plugin.json"), br#"{"id":"input-display","name":"Input Display","version":"1.0.0"}"#.to_vec()),
            (v("plugins/input-display/input-display.dll"), b"MZ id".to_vec()),
        ];
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            for (n, b) in files.iter().map(|(n, b)| (n.as_str(), b.as_slice())).chain(extra_zip_file) {
                z.start_file(n, zip::write::SimpleFileOptions::default()).unwrap();
                std::io::Write::write_all(&mut z, b).unwrap();
            }
            z.finish().unwrap();
        }
        let zip = buf.into_inner();
        let mut listed: Vec<serde_json::Value> = files.iter().chain(extra_zip_file.map(|(n, b)| (n.to_string(), b.to_vec())).iter()).map(|(n, b)| serde_json::json!({ "path": n, "sha256": sha256_hex(b) })).collect();
        if let Some(u) = unlisted {
            listed.push(serde_json::json!({ "path": u, "sha256": sha256_hex(b"missing") }));
        }
        let name = format!("Horizon-Client-{version}-TMLoader.zip");
        let man = serde_json::json!({ "name": "Horizon Client", "folder_name": "Horizon Host", "version": version,
            "packages": [{ "game": "forever", "kind": "tmloader", "zip": format!("release/{name}"), "sha256": sha256_hex(&zip), "files": listed }] });
        let sums = format!("{}  *Horizon-Client-{version}-ESWC.zip\n{} *{name}\n", "0".repeat(64), sha256_hex(&zip));
        let base = format!("https://github.com/cheatoskar/horizon-client/releases/download/v{version}");
        let rel = serde_json::json!({ "tag_name": format!("v{version}"), "assets": [
            { "name": "manifest.json", "browser_download_url": format!("{base}/manifest.json") },
            { "name": "SHA256SUMS.txt", "browser_download_url": format!("{base}/SHA256SUMS.txt") },
            { "name": name, "browser_download_url": format!("{base}/{name}") } ] });
        (rel, man.to_string().into_bytes(), zip, sums.into_bytes())
    }

    fn fetcher(man: Vec<u8>, zip: Vec<u8>, sums: Vec<u8>) -> impl Fn(&str, u64) -> Result<Vec<u8>, String> {
        move |u: &str, _| {
            if u.ends_with("manifest.json") { Ok(man.clone()) } else if u.ends_with("SHA256SUMS.txt") { Ok(sums.clone()) } else if u.ends_with(".zip") { Ok(zip.clone()) } else { Err("404".into()) }
        }
    }

    #[test]
    fn github_tmloader_product_is_checked_by_manifest_and_sums() {
        let (rel, man, zip, sums) = tml_release("0.3.1", None, None);
        let s = github_tml(&rel, &fetcher(man.clone(), zip.clone(), sums.clone())).unwrap();
        assert_eq!(s.pkg.version, "0.3.1");
        assert_eq!(s.pkg.source, format!("github:{GITHUB_REPO}"));
        let names: Vec<&str> = s.pkg.files.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(names, ["HorizonHost.dll", "description.yaml", "modules.json", "plugins/input-display/plugin.json", "plugins/input-display/input-display.dll"]);
        assert!(s.product_desc.unwrap().starts_with(b"name: Horizon Client"));
        // Status and update check: manifest only, the zip is never fetched.
        let no_zip = |u: &str, m: u64| if u.ends_with(".zip") { panic!("zip fetched for the status") } else { fetcher(man.clone(), vec![], sums.clone())(u, m) };
        let l = github_tml_listing(&rel, &no_zip).unwrap();
        assert_eq!(l.version, "0.3.1");
        assert_eq!(l.files.iter().map(|(r, _)| r.as_str()).collect::<Vec<_>>(), names);
        assert_eq!(l.plugins(PLUGIN_PREFIX_TML).keys().map(String::as_str).collect::<Vec<_>>(), ["input-display"]);
        // Tampered zip, SHA256SUMS of another zip, a file outside the version folder, a listed file missing.
        let mut bad = zip.clone();
        let n = bad.len();
        bad[n - 30] ^= 1;
        assert!(github_tml(&rel, &fetcher(man.clone(), bad, sums.clone())).unwrap_err().contains("SHA256SUMS"));
        let other = format!("{} *Horizon-Client-0.3.1-TMLoader.zip\n", "1".repeat(64)).into_bytes();
        assert!(github_tml(&rel, &fetcher(man.clone(), zip.clone(), other)).unwrap_err().contains("does not match SHA256SUMS"));
        let (rel2, man2, zip2, sums2) = tml_release("0.3.1", Some(("Horizon Host/0.3.0/x.dll", b"MZ")), None);
        assert!(github_tml(&rel2, &fetcher(man2, zip2, sums2)).unwrap_err().contains("outside"));
        let (rel3, man3, zip3, sums3) = tml_release("0.3.1", None, Some("Horizon Host/0.3.1/plugins/x/x.dll"));
        assert!(github_tml(&rel3, &fetcher(man3, zip3, sums3)).unwrap_err().contains("misses"));
        // A manifest of another release, a release without a TMLoader zip.
        let (_, man4, _, _) = tml_release("0.3.2", None, None);
        assert!(github_tml(&rel, &fetcher(man4, zip.clone(), sums.clone())).unwrap_err().contains("does not belong"));
        assert!(github_tml(&release_json("0.1.0", "https://github.com/x/y"), &fetcher(man, zip, sums)).unwrap_err().contains("no TMLoader build"));
    }

    #[test]
    fn github_tmloader_update_keeps_user_modules_and_settings() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("TMLoader");
        crate::tmloader::tests::fake_root(&root);
        let pdir = tml_product_dir(&root);
        // 0.3.0 as the launcher installed it, plus what the user added afterwards.
        let (rel, man, zip, sums) = tml_release("0.3.0", Some(("Horizon Host/0.3.0/plugins/dropped/plugin.json", br#"{"id":"dropped"}"#)), None);
        let old = github_tml(&rel, &fetcher(man, zip, sums)).unwrap();
        tml_apply(&root, &old.pkg, &old.extra, old.product_desc.as_deref(), &[], &t.path().join("b0")).unwrap();
        let v0 = pdir.join("0.3.0");
        std::fs::create_dir_all(v0.join("plugins/tmvs-capture")).unwrap();
        std::fs::write(v0.join("plugins/tmvs-capture/plugin.json"), br#"{"id":"tmvs-capture"}"#).unwrap();
        std::fs::write(v0.join("plugins/tmvs-capture/tmvs-capture.dll"), b"MZ tmvs").unwrap();
        std::fs::write(v0.join("plugins/input-display/settings.json"), b"{\"x\":1}").unwrap();
        for (d, f) in [("settings", "host.json"), ("data", "wr.json"), ("logs", "host.log")] {
            std::fs::create_dir_all(pdir.join(d)).unwrap();
            std::fs::write(pdir.join(d).join(f), b"mine").unwrap();
        }
        // 0.3.1 from GitHub, switched on in the profile.
        let (rel, man, zip, sums) = tml_release("0.3.1", None, None);
        let new = github_tml(&rel, &fetcher(man, zip, sums)).unwrap();
        let msg = tml_apply(&root, &new.pkg, &new.extra, new.product_desc.as_deref(), &["default".to_string()], &t.path().join("b1")).unwrap();
        assert!(msg.contains("0.3.1") && msg.contains("default"));
        let v1 = pdir.join("0.3.1");
        assert!(v1.join("HorizonHost.dll").is_file() && v1.join("description.yaml").is_file() && v1.join(RECORD).is_file());
        assert_eq!(std::fs::read(v1.join("plugins/tmvs-capture/tmvs-capture.dll")).unwrap(), b"MZ tmvs");
        assert_eq!(std::fs::read(v1.join("plugins/input-display/settings.json")).unwrap(), b"{\"x\":1}");
        assert_eq!(std::fs::read(v1.join("modules.json")).unwrap(), b"{}");
        assert!(!v1.join("plugins/dropped").exists(), "a module the old package shipped is not carried over");
        assert_eq!(read_record(&v1).unwrap().version, "0.3.1");
        for (d, f) in [("settings", "host.json"), ("data", "wr.json"), ("logs", "host.log")] {
            assert_eq!(std::fs::read(pdir.join(d).join(f)).unwrap(), b"mine");
        }
        assert_eq!(tml_versions(&root).last().map(|(v, _)| v.as_str()), Some("0.3.1"));
        assert!(crate::tmloader::read_info(&root).profiles[0].mods.iter().any(|m| m.id == TML_PRODUCT));
        let st = tml_status(Some(&root), &t.path().join("data"), Some("default"), "tmnf", Ok(new.pkg.clone()), SourceInfo::default());
        assert!(!st.update && st.plugins.iter().any(|p| p.id == "tmvs-capture"));
    }

    /// The real release folder (read only): `HORIZON_CLIENT_RELEASE=<release-client-x folder> cargo test real_tml_release`.
    #[test]
    fn real_tml_release_folder() {
        let Ok(dir) = std::env::var("HORIZON_CLIENT_RELEASE") else { return };
        let dir = PathBuf::from(dir);
        let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(MANIFEST)).unwrap()).unwrap();
        let v = m["version"].as_str().unwrap().to_string();
        let name = format!("Horizon-Client-{v}-TMLoader.zip");
        let base = format!("https://github.com/cheatoskar/horizon-client/releases/download/v{v}");
        let rel = serde_json::json!({ "tag_name": format!("v{v}"), "assets": [
            { "name": "manifest.json", "browser_download_url": format!("{base}/manifest.json") },
            { "name": "SHA256SUMS.txt", "browser_download_url": format!("{base}/SHA256SUMS.txt") },
            { "name": name, "browser_download_url": format!("{base}/{name}") } ] });
        let s = github_tml(&rel, &fetcher(std::fs::read(dir.join(MANIFEST)).unwrap(), std::fs::read(dir.join("release").join(&name)).unwrap(), std::fs::read(dir.join("release/SHA256SUMS.txt")).unwrap())).unwrap();
        assert!(s.pkg.files.iter().any(|(r, _)| r == "HorizonHost.dll"));
        assert!(s.product_desc.is_some());
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("TMLoader");
        crate::tmloader::tests::fake_root(&root);
        tml_apply(&root, &s.pkg, &s.extra, s.product_desc.as_deref(), &["default".to_string()], &t.path().join("b")).unwrap();
        assert!(tml_product_dir(&root).join(&v).join("HorizonHost.dll").is_file());
        eprintln!("real release {v}: {} files", s.pkg.files.len());
    }

    #[test]
    fn tmloader_product_install_profiles_and_remove() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("TMLoader");
        crate::tmloader::tests::fake_root(&root);
        let data = t.path().join("data");
        let d = dist(t.path(), "0.1.0", b"x");
        let (vsrc, pkg) = dev_tml(&d).unwrap();
        let plan = tml_plan(&root, &pkg).unwrap();
        assert!(plan.files.iter().all(|f| f.action == "new"));
        tml_apply(&root, &pkg, &tml_extra(&vsrc), tml_product_desc(&vsrc).as_deref(), &["default".to_string()], &t.path().join("b1")).unwrap();
        let vdir = tml_product_dir(&root).join("0.1.0");
        assert!(vdir.join("host.dll").is_file() && vdir.join("description.yaml").is_file());
        assert!(tml_product_dir(&root).join("description.yaml").is_file());
        let info = crate::tmloader::read_info(&root);
        assert!(info.profiles[0].mods.iter().any(|m| m.id == TML_PRODUCT));
        let st = tml_status(Some(&root), &data, Some("default"), "tmuf", Ok(pkg.clone()), SourceInfo::default());
        assert_eq!(st.profiles_on, ["default"]);
        assert_eq!(st.installed, ["0.1.0"]);
        assert_eq!(st.plugins.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["sample"]);
        // Plugin toggle -> profile.json in the version folder.
        set_enabled(&data, &tml_scope("default"), "sample", true, &[]).unwrap();
        let p = before_start(&data, "tmuf", Path::new("unused"), Some(&root), Some("default"), false).unwrap().unwrap();
        assert_eq!(p.plugins[0].id, "sample");
        assert!(vdir.join(PROFILE).is_file());
        // Update keeps the old folder's profile.json and logs.
        std::fs::create_dir_all(vdir.join("logs")).unwrap();
        std::fs::write(vdir.join("logs/a.log"), "x").unwrap();
        tml_apply(&root, &pkg, &[], None, &[], &t.path().join("b2")).unwrap();
        assert!(vdir.join("logs/a.log").is_file());
        tml_remove(&root, &t.path().join("b3")).unwrap();
        assert!(!tml_product_dir(&root).exists());
        assert!(t.path().join("b3").join(TML_PRODUCT).join("0.1.0").join("host.dll").is_file());
        assert!(!crate::tmloader::read_info(&root).profiles[0].mods.iter().any(|m| m.id == TML_PRODUCT));
    }

    /// Demo sandbox for screenshots: `HORIZON_DEMO_DIR=<scratch> HORIZON_DEMO_DATA=<app.tmhub.shots
    /// data folder> cargo test demo_sandbox -- --ignored`. Writes only into those two folders.
    #[test]
    #[ignore]
    fn demo_sandbox() {
        let (Ok(root), Ok(data)) = (std::env::var("HORIZON_DEMO_DIR"), std::env::var("HORIZON_DEMO_DATA")) else { return };
        let (root, data) = (PathBuf::from(root), PathBuf::from(data));
        assert!(data.to_string_lossy().contains("app.tmhub.shots"), "only the screenshot app's data folder");
        assert!(!fsx::is_inside(&root, &dirs::home_dir().unwrap().join("Games")), "never a real game folder");
        let game = root.join("TMN-ESWC-demo");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("TmNationsESWC.exe"), b"MZ demo exe").unwrap();
        std::fs::write(game.join("dinput8.dll"), b"MZ eswc autosave loader").unwrap();
        std::fs::write(game.join("eswc_autosave.dll"), b"MZ eswc autosave").unwrap();
        std::fs::write(game.join("eswc_autosave.ini"), "[autosave]\nkey=F9\n").unwrap();
        let d = dist(&root, "0.1.0", b"MZ horizon legacy loader");
        update_store(&data, |s| s.dev_dir = Some(d.to_string_lossy().into())).unwrap();
        let pkg = dev_legacy(&d).unwrap();
        prepare(&game, &data, pkg.clone()).unwrap();
        apply(&game, &data).unwrap();
        install_plugin(Kind::Legacy, &game, &data, &pkg, "sample").unwrap();
        set_enabled(&data, &dir_scope(&game), "sample", true, &installed_ids(&game.join(HOST_DIR))).unwrap();
        std::fs::create_dir_all(game.join("horizon/logs")).unwrap();
        std::fs::write(
            game.join("horizon/logs/2026-11-11_21-04-12.log"),
            "21:04:12 [host] Horizon Host 0.1.0, ABI 1, game ESWC\n21:04:12 [host] exe sha256 not on the tested list: plugins stay off\n21:04:12 [host] profile.json: 1 plugin (sample 1.0.0), safe mode off\n",
        )
        .unwrap();
        crate::tmloader::tests::fake_root(&root.join("TMLoader"));
        // A second copy without the host (install dialog).
        let fresh = root.join("TMN-ESWC-demo-fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::write(fresh.join("TmNationsESWC.exe"), b"MZ demo exe").unwrap();
        std::fs::write(fresh.join("dinput8.dll"), b"MZ eswc autosave loader").unwrap();
        std::fs::write(fresh.join("eswc_autosave.dll"), b"MZ eswc autosave").unwrap();
        println!("game {}\nfresh {}\ndist {}", game.display(), fresh.display(), d.display());
    }

    /// `cargo test real_dev_dist -- --ignored --nocapture`: checks the host repo's build (read-only).
    #[test]
    #[ignore]
    fn real_dev_dist() {
        let d = std::env::var("HORIZON_DIST").map(PathBuf::from).unwrap_or_else(|_| dirs::home_dir().unwrap().join("Downloads/horizon-host/dist"));
        match dev_legacy_for(&d, "tmn-eswc") {
            Ok(p) => println!("legacy {} files {:?}", p.version, p.files.iter().map(|(r, b)| (r.clone(), b.len())).collect::<Vec<_>>()),
            Err(e) => println!("legacy: {e}"),
        }
        match dev_tml(&d) {
            Ok((v, p)) => println!("tmloader {} at {}", p.version, v.display()),
            Err(e) => println!("tmloader: {e}"),
        }
    }
}
