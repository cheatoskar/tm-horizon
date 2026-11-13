//! Installs catalog mods that are not on a TMLoader server (GitHub releases, direct zips, public
//! Google Drive / Yandex Disk files) by an `installSpec` from the catalog:
//! - "files": the zip's files go next to the game exe, into its GameData folder or into
//!   Documents\TrackMania; every replaced file is backed up first, new files are recorded so a
//!   restore removes them again.
//! - "tmloader-product": the zip holds a TMLoader product folder (<Product>/<version>/...); it is
//!   copied into TMLoader's products folder (TMLoader must not be running).
//! The spec comes from the bundled catalog through the UI, so everything in it is checked here:
//! https only, relative paths only, every target inside its root and never a protected path
//! (StarForce folder, any dinput8.dll — see fsx).
//!
//! One exception for dinput8.dll: the hub allows it only for the author's own loaders (Legacy
//! Essentials, Legacy Randomizer) and then names the file in the signed index's `starForceBlocked`
//! (docs/hub/dinput8-exception.md on the hub). Only a file named there is installed, never into a
//! StarForce game (`starforce_game`), never over Horizon Client's loader, and never updated without a
//! click. A spec without the field keeps every dinput8.dll out.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::{fsx, net};

const MAX_DOWNLOAD: u64 = 400 << 20;
const MAX_FILES: usize = 5000;

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub github: Option<String>,
    pub asset: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSpec {
    pub kind: String,
    pub download: Download,
    pub base: Option<String>,
    #[serde(default)]
    pub strip: usize,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub games: Vec<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    pub note: Option<String>,
    /// Known SHA-256 of the download (checked when set).
    #[serde(default)]
    pub sha256: Option<String>,
    /// Version of the download when the source knows it (TM Horizon Hub copies).
    #[serde(default)]
    pub version: Option<String>,
    /// Files of the download that must never go into a StarForce game (signed hub index; only
    /// versions with the hub-allowed dinput8.dll carry it).
    #[serde(default)]
    pub star_force_blocked: Option<Vec<String>>,
}

/// StarForce-protected game folder: the protected ESWC folder (fsx), or a folder with StarForce's
/// own files next to the exe (protect.dll / protect.exe of StarForce 3).
pub fn starforce_game(dir: &Path) -> bool {
    fsx::blocked(dir) || ["protect.dll", "protect.exe"].iter().any(|f| dir.join(f).is_file())
}

/// Is `rel` (a path inside the download, after strip) named in the spec's `starForceBlocked`?
fn listed(spec: &InstallSpec, rel: &str) -> bool {
    let r = rel.replace('\\', "/").to_lowercase();
    spec.star_force_blocked.iter().flatten().any(|x| {
        let x = x.replace('\\', "/").to_lowercase();
        x == r || x.rsplit('/').next() == Some(r.as_str()) || r.rsplit('/').next() == Some(x.as_str())
    })
}

/// The files of a spec that may be a dinput8.dll: only those the hub named (see the module notes).
/// `game_dir` is the game's own folder (StarForce check, Horizon Client's loader).
pub fn dinput8_rules(spec: &InstallSpec, files: &[String], game_dir: &Path) -> Result<bool, String> {
    let blocked: Vec<&String> = files.iter().filter(|f| listed(spec, f)).collect();
    let d8: Vec<&String> = files.iter().filter(|f| fsx::is_dinput8(Path::new(f.as_str()))).collect();
    if let Some(f) = d8.iter().find(|f| !listed(spec, f)) {
        return Err(format!("{f}: this download has a dinput8.dll the hub did not allow; nothing was installed"));
    }
    if !blocked.is_empty() && starforce_game(game_dir) {
        return Err(format!("{} can't go into a game with StarForce copy protection; nothing was installed", blocked[0]));
    }
    if !d8.is_empty() && crate::horizonhost::read_record(&game_dir.join(crate::horizonhost::format::HOST_DIR)).is_some() {
        return Err("Horizon Client is in this game folder and already includes this. Nothing was installed.".into());
    }
    Ok(!d8.is_empty())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub path: String,
    /// "new" | "replace" | "same"
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub entry_id: String,
    pub version: String,
    pub game: String,
    pub root: String,
    pub files: Vec<PlanFile>,
    pub requires: Vec<String>,
    pub warnings: Vec<String>,
    pub backup_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub created: String,
    pub reason: String,
    pub files: Vec<String>,
}

struct Staged {
    /// The hub-allowed dinput8.dll is part of it (dinput8_rules).
    dinput8: bool,
    version: String,
    root: PathBuf,
    kind: String,
    files: Vec<(String, Vec<u8>)>,
    spec: Option<InstallSpec>,
    source: String,
    asset: String,
    sha256: String,
}

fn staged() -> &'static Mutex<HashMap<String, Staged>> {
    static S: OnceLock<Mutex<HashMap<String, Staged>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Case-insensitive glob with `*` only.
pub fn glob(pat: &str, name: &str) -> bool {
    let (p, n) = (pat.to_lowercase(), name.to_lowercase());
    let parts: Vec<&str> = p.split('*').collect();
    if parts.len() == 1 {
        return p == n;
    }
    let mut pos = 0;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !n.starts_with(part) {
                return false;
            }
            pos = part.len();
        } else if i == parts.len() - 1 {
            return n.len() >= pos + part.len() && n.ends_with(part);
        } else {
            match n[pos..].find(part) {
                Some(f) => pos += f + part.len(),
                None => return false,
            }
        }
    }
    true
}

/// A relative path inside a zip or spec, cleaned: forward slashes, no `..`, no absolute parts,
/// no drive or stream colons. None when it is not safe.
pub fn safe_rel(p: &str) -> Option<String> {
    let p = p.replace('\\', "/");
    if p.contains(':') || p.starts_with('/') {
        return None;
    }
    let mut out = Vec::new();
    for c in Path::new(&p).components() {
        match c {
            Component::Normal(s) => {
                let s = s.to_string_lossy();
                if s.trim_end_matches(['.', ' ']).is_empty() {
                    return None;
                }
                out.push(s.to_string());
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.is_empty()).then(|| out.join("/"))
}

/// Files of the download after `strip` and `include`.
pub fn select_files(entries: Vec<(String, Vec<u8>)>, strip: usize, include: &[String]) -> Vec<(String, Vec<u8>)> {
    entries
        .into_iter()
        .filter_map(|(name, b)| {
            let rel = safe_rel(&name)?;
            let parts: Vec<&str> = rel.split('/').collect();
            if parts.len() <= strip {
                return None;
            }
            let rel = parts[strip..].join("/");
            let lower = rel.to_lowercase();
            if !include.is_empty() && !include.iter().any(|i| lower.starts_with(&i.replace('\\', "/").to_lowercase())) {
                return None;
            }
            Some((rel, b))
        })
        .collect()
}

fn unzip_all(zip: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| format!("not a zip: {e}"))?;
    if z.len() > MAX_FILES {
        return Err("The zip has too many files".into());
    }
    let mut out = Vec::new();
    let mut total = 0u64;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        total += f.size();
        if total > 2 * MAX_DOWNLOAD {
            return Err("The zip unpacks to too much".into());
        }
        let mut b = Vec::new();
        f.read_to_end(&mut b).map_err(|e| e.to_string())?;
        out.push((f.name().to_string(), b));
    }
    Ok(out)
}

/// Resolves the spec's download to (version, file name, url).
fn resolve(d: &Download) -> Result<(String, String, String), String> {
    if let Some(repo) = &d.github {
        if !repo.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c)) || repo.matches('/').count() != 1 {
            return Err("bad GitHub repo".into());
        }
        let rel = net::get_json(&format!("https://api.github.com/repos/{repo}/releases/latest"))?;
        let tag = rel["tag_name"].as_str().unwrap_or("latest").trim_start_matches('v').to_string();
        let assets = rel["assets"].as_array().cloned().unwrap_or_default();
        let name_of = |a: &serde_json::Value| a["name"].as_str().unwrap_or("").to_string();
        let pick = match &d.asset {
            Some(p) => assets.iter().find(|a| glob(p, &name_of(a))),
            None => assets.iter().find(|a| name_of(a).to_lowercase().ends_with(".zip")).or_else(|| assets.iter().find(|a| name_of(a).to_lowercase().ends_with(".dll"))),
        }
        .ok_or("The latest release has no matching file")?;
        let url = pick["browser_download_url"].as_str().ok_or("no download link")?.to_string();
        return Ok((tag, name_of(pick), url));
    }
    let url = d.url.clone().ok_or("No download in the spec")?;
    // Debug builds also take a local dev hub (http://localhost, http://127.0.0.1).
    let dev_local = cfg!(debug_assertions) && url::Url::parse(&url).map(|u| u.scheme() == "http" && matches!(u.host_str(), Some("localhost") | Some("127.0.0.1"))).unwrap_or(false);
    if !url.starts_with("https://") && !dev_local {
        return Err("Only https downloads are installed".into());
    }
    // Launcher Preview: only files from GitHub (the author's release); everything else is link-only there.
    if crate::RELEASE_PREVIEW && !url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).is_some_and(|h| h == "github.com") {
        return Err("This version installs catalog mods only from GitHub releases".into());
    }
    if url.starts_with("https://disk.yandex.") || url.starts_with("https://yadi.sk/") {
        let api = format!("https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key={}", url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>());
        let j = net::get_json(&api)?;
        let href = j["href"].as_str().ok_or("Yandex gave no download link")?.to_string();
        let name = url::Url::parse(&href).ok().and_then(|u| u.query_pairs().find(|(k, _)| k == "filename").map(|(_, v)| v.to_string())).unwrap_or_else(|| "download.zip".into());
        return Ok(("latest".into(), name, href));
    }
    let name = url.split(['?', '#']).next().unwrap_or("").rsplit('/').next().unwrap_or("download").to_string();
    Ok(("latest".into(), if name.contains('.') { name } else { "download.zip".into() }, url))
}

fn backup_root(data: &Path) -> PathBuf {
    data.join("TM Horizon backups").join("mods")
}

fn stamp() -> String {
    fsx::now_iso().replace([':', '-'], "").chars().take(15).collect()
}

/// Target path for a relative file under a root, after every safety check.
#[cfg(test)]
fn target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    target_with(root, rel, false)
}

/// `target`, where `dinput8` lets a top-level dinput8.dll through (the hub-allowed loader, checked by
/// `dinput8_rules` before): the folder itself must still pass every check, and the file must not be a link.
fn target_with(root: &Path, rel: &str, dinput8: bool) -> Result<PathBuf, String> {
    let rel = safe_rel(rel).ok_or_else(|| format!("unsafe path: {rel}"))?;
    let p = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !fsx::norm(&p).starts_with(&fsx::norm(root)) {
        return Err(format!("outside the folder: {rel}"));
    }
    if dinput8 && !rel.contains('/') && fsx::is_dinput8(&p) {
        fsx::check(root)?;
        if starforce_game(root) {
            return Err("refusing a StarForce game folder".into());
        }
        if std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("refusing a link: {}", p.display()));
        }
        return Ok(p);
    }
    fsx::check(&p)?;
    Ok(p)
}

/// Writes one target file. The hub-allowed dinput8.dll (already checked by `target_with`) is written as a
/// new file and renamed over the old name, which also never writes through a hard link of an instance;
/// everything else goes through `fsx::write` after `break_link`.
fn put_file(p: &Path, b: &[u8], dinput8: bool) -> Result<(), String> {
    if dinput8 && fsx::is_dinput8(p) {
        let tmp = p.with_file_name("dinput8.dll.tmhorizon-new");
        std::fs::write(&tmp, b).map_err(|e| format!("{}: {e}", tmp.display()))?;
        return std::fs::rename(&tmp, p).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{}: {e}", p.display())
        });
    }
    crate::instances::break_link(p)?;
    fsx::write(p, b)
}

/// Download, unpack and plan. Nothing is written into the game or TMLoader.
pub fn prepare(spec: &InstallSpec, entry_id: &str, game: &str, root: &Path, data: &Path) -> Result<Plan, String> {
    prepare_in(spec, entry_id, game, root, root, data)
}

/// `prepare` with the game's own folder (`game_dir`) when the files go somewhere below it (GameData).
pub fn prepare_in(spec: &InstallSpec, entry_id: &str, game: &str, root: &Path, game_dir: &Path, data: &Path) -> Result<Plan, String> {
    // Before any download: a spec that names files for no StarForce game is refused there right away.
    if spec.star_force_blocked.as_ref().is_some_and(|l| !l.is_empty()) && starforce_game(game_dir) {
        return Err("This mod can't go into a game with StarForce copy protection.".into());
    }
    if !["files", "tmloader-product"].contains(&spec.kind.as_str()) {
        return Err("unknown install kind".into());
    }
    fsx::check(root)?;
    if !root.is_dir() {
        return Err(format!("Folder not found: {}", root.display()));
    }
    let (version, name, url) = resolve(&spec.download)?;
    let version = spec.version.clone().filter(|v| !v.is_empty()).unwrap_or(version);
    let bytes = net::get_bytes(&url, MAX_DOWNLOAD)?;
    let sha256: String = sha2::Digest::finalize(<sha2::Sha256 as sha2::Digest>::new_with_prefix(&bytes)).iter().map(|b| format!("{b:02x}")).collect();
    if let Some(want) = &spec.sha256 {
        if !want.eq_ignore_ascii_case(&sha256) {
            return Err("Checksum does not match; nothing was installed".into());
        }
    }
    let source = spec.download.github.as_ref().map(|g| format!("github:{g}")).unwrap_or_else(|| spec.download.url.clone().unwrap_or_default());
    let entries = if name.to_lowercase().ends_with(".zip") || bytes.starts_with(b"PK\x03\x04") { unzip_all(&bytes)? } else { vec![(name.clone(), bytes)] };
    let files = select_files(entries, spec.strip, &spec.include);
    if files.is_empty() {
        return Err("Nothing to install in the download".into());
    }
    let names: Vec<String> = files.iter().map(|(p, _)| p.clone()).collect();
    let dinput8 = spec.kind == "files" && dinput8_rules(spec, &names, game_dir)?;
    let mut warnings = Vec::new();
    if spec.kind == "tmloader-product" {
        let has_desc = files.iter().any(|(p, _)| p.to_lowercase().ends_with("description.yaml"));
        if !has_desc {
            return Err("The download is not a TMLoader product (no description.yaml)".into());
        }
    }
    let mut plan = Vec::new();
    for (rel, b) in &files {
        let p = target_with(root, rel, dinput8)?;
        let action = if !p.exists() {
            "new"
        } else if std::fs::metadata(&p).map(|m| m.len() == b.len() as u64).unwrap_or(false) && std::fs::read(&p).map(|x| x == *b).unwrap_or(false) {
            "same"
        } else {
            "replace"
        };
        plan.push(PlanFile { path: rel.clone(), action: action.into() });
    }
    if plan.iter().filter(|f| f.action == "replace").count() > 0 {
        warnings.push("Some game files will be replaced; they are backed up first.".into());
    }
    if let Some(n) = &spec.note {
        warnings.push(n.clone());
    }
    warnings.extend(foreign_proxy_warnings(root, &plan));
    // File conflicts: another mod installed here already wrote some of these files.
    let mine: std::collections::HashSet<String> = plan.iter().map(|f| f.path.to_lowercase()).collect();
    for r in crate::updates::list(data) {
        if r.entry_id == entry_id || fsx::norm(Path::new(&r.root)) != fsx::norm(root) {
            continue;
        }
        let clash: Vec<&String> = r.files.iter().filter(|f| mine.contains(&f.to_lowercase())).collect();
        if !clash.is_empty() {
            warnings.push(format!("{} also wrote {} of these files ({}…); installing replaces its version (backup first).", r.entry_id, clash.len(), clash[0]));
        }
    }
    if dinput8 {
        warnings.push("Installs a dinput8.dll loader next to the game (a backup of any old one is kept).".into());
    }
    staged().lock().unwrap().insert(format!("{entry_id}|{game}"), Staged { dinput8, version: version.clone(), root: root.to_path_buf(), kind: spec.kind.clone(), files, spec: Some(spec.clone()), source, asset: name, sha256 });
    Ok(Plan {
        entry_id: entry_id.into(),
        version,
        game: game.into(),
        root: root.to_string_lossy().into(),
        files: plan,
        requires: spec.requires.clone(),
        warnings,
        backup_root: backup_root(data).to_string_lossy().into(),
    })
}

/// Writes the prepared files: replaced ones are backed up, new ones recorded for restore.
pub fn apply(entry_id: &str, game: &str, data: &Path) -> Result<String, String> {
    let s = staged().lock().unwrap().remove(&format!("{entry_id}|{game}")).ok_or("Nothing prepared; open the dialog again")?;
    if s.kind == "tmloader-product" {
        crate::tmloader::ensure_idle()?;
    }
    let mut replaced = Vec::new();
    let mut added = Vec::new();
    for (rel, b) in &s.files {
        let p = target_with(&s.root, rel, s.dinput8)?;
        if p.exists() {
            if std::fs::read(&p).map(|x| x != *b).unwrap_or(true) {
                replaced.push(rel.clone());
            }
        } else {
            added.push(rel.clone());
        }
    }
    let id = format!("{}-{}", stamp(), entry_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>());
    let bdir = backup_root(data).join(&id);
    std::fs::create_dir_all(bdir.join("files")).map_err(|e| e.to_string())?;
    for rel in &replaced {
        let src = target_with(&s.root, rel, s.dinput8)?;
        let dst = bdir.join("files").join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(d) = dst.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
    }
    let manifest = serde_json::json!({ "created": fsx::now_iso(), "reason": format!("{entry_id} {}", s.version), "root": s.root.to_string_lossy(), "replaced": replaced, "added": added, "dinput8": s.dinput8 });
    std::fs::write(bdir.join("manifest.json"), manifest.to_string()).map_err(|e| e.to_string())?;
    let mut written = 0;
    for (rel, b) in &s.files {
        let p = target_with(&s.root, rel, s.dinput8)?;
        if p.exists() && std::fs::read(&p).map(|x| x == *b).unwrap_or(false) {
            continue;
        }
        // Separate installations: a hard link to the original game becomes a real copy first.
        put_file(&p, b, s.dinput8)?;
        written += 1;
    }
    let rec = crate::updates::InstallRecord {
        entry_id: entry_id.into(),
        game: game.into(),
        kind: "catalog".into(),
        spec: s.spec.as_ref().and_then(|x| serde_json::to_value(x).ok()),
        // A loader (dinput8.dll) is never updated without a click.
        auto_update: !s.dinput8 && crate::updates::default_auto(&s.source) && s.spec.as_ref().is_some_and(|x| x.download.asset.is_some()),
        source: s.source.clone(),
        version: s.version.clone(),
        asset: s.asset.clone(),
        sha256: s.sha256.clone(),
        files: s.files.iter().map(|(p, _)| p.clone()).collect(),
        root: s.root.to_string_lossy().into(),
        installed_at: fsx::now_iso(),
        backup_id: Some(id.clone()),
    };
    crate::updates::record(data, rec)?;
    Ok(format!("Installed {entry_id} ({written} files). Backup: {id}"))
}

/// Version and target files of a prepared install (for the change history); nothing prepared = empty.
pub fn staged_targets(entry_id: &str, game: &str) -> (String, Vec<crate::history::Watch>) {
    let st = staged().lock().unwrap();
    match st.get(&format!("{entry_id}|{game}")) {
        Some(s) => (s.version.clone(), s.files.iter().filter_map(|(rel, _)| target_with(&s.root, rel, s.dinput8).ok()).map(crate::history::Watch::File).collect()),
        None => (String::new(), vec![]),
    }
}

/// Game and files a backup would put back or remove (for the change history).
pub fn backup_targets(id: &str, data: &Path) -> (String, Vec<crate::history::Watch>) {
    if id.contains(['/', '\\']) || id.contains("..") {
        return (String::new(), vec![]);
    }
    let Some(m) = std::fs::read_to_string(backup_root(data).join(id).join("manifest.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { return (String::new(), vec![]) };
    let Some(root) = m["root"].as_str().map(PathBuf::from) else { return (String::new(), vec![]) };
    let game = crate::updates::list(data).into_iter().find(|r| r.backup_id.as_deref() == Some(id)).map(|r| r.game).unwrap_or_default();
    let files = ["replaced", "added"]
        .iter()
        .flat_map(|k| m[*k].as_array().cloned().unwrap_or_default())
        .filter_map(|x| x.as_str().and_then(|r| target_with(&root, r, m["dinput8"] == true).ok()))
        .map(crate::history::Watch::File)
        .collect();
    (game, files)
}

pub fn list_backups(data: &Path) -> Vec<Backup> {
    let mut out: Vec<Backup> = std::fs::read_dir(backup_root(data))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.path().join("manifest.json")).ok()?).ok()?;
            let files = ["replaced", "added"].iter().flat_map(|k| m[*k].as_array().cloned().unwrap_or_default()).filter_map(|x| x.as_str().map(String::from)).collect();
            Some(Backup { id: e.file_name().to_string_lossy().into(), created: m["created"].as_str().unwrap_or("").into(), reason: m["reason"].as_str().unwrap_or("").into(), files })
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

/// Undoes an install: replaced files come back, files it added are removed.
pub fn restore(id: &str, data: &Path) -> Result<String, String> {
    if id.contains(['/', '\\']) || id.contains("..") {
        return Err("bad backup id".into());
    }
    let bdir = backup_root(data).join(id);
    let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(bdir.join("manifest.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let root = PathBuf::from(m["root"].as_str().ok_or("manifest without folder")?);
    fsx::check(&root)?;
    let list = |k: &str| m[k].as_array().cloned().unwrap_or_default().into_iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>();
    let d8 = m["dinput8"] == true;
    for rel in list("replaced") {
        let b = std::fs::read(bdir.join("files").join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))).map_err(|e| e.to_string())?;
        let p = target_with(&root, &rel, d8)?;
        put_file(&p, &b, d8)?;
    }
    let mut removed = 0;
    for rel in list("added") {
        let p = target_with(&root, &rel, d8)?;
        if p.is_file() {
            std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            removed += 1;
        }
    }
    Ok(format!("Restored ({} files back, {removed} removed)", list("replaced").len()))
}

/// Proxy DLLs (d3d9.dll, ...) that the install would replace and that are not ours (e.g. the graphics
/// wrapper a Sunrise repack ships as d3d9.dll): named in the confirmation, which offers Install
/// (backup first) or Cancel (keeps it). Read only.
pub fn foreign_proxy_warnings(root: &Path, plan: &[PlanFile]) -> Vec<String> {
    plan.iter()
        .filter(|f| f.action == "replace" && !f.path.contains(['/', '\\']) && crate::proxymods::PROXY_DLLS.iter().any(|d| d.eq_ignore_ascii_case(&f.path)))
        .filter(|f| {
            let p = root.join(&f.path);
            !fsx::blocked(&p) && std::fs::read(&p).map(|b| crate::proxymods::identify(&b).is_none()).unwrap_or(false)
        })
        .map(|f| format!("{} in this game folder belongs to another program (for example a graphics wrapper of a repack). Install replaces it (backup first); Cancel keeps it.", f.path))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreign_proxy_dll_is_named() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("d3d9.dll"), b"MZ some repack wrapper").unwrap();
        std::fs::write(t.path().join("dxgi.dll"), b"MZ TM Vibrant Shaders tmvs.ini").unwrap();
        let plan = vec![
            PlanFile { path: "d3d9.dll".into(), action: "replace".into() },
            PlanFile { path: "dxgi.dll".into(), action: "replace".into() },
            PlanFile { path: "tmvs.ini".into(), action: "new".into() },
        ];
        let w = foreign_proxy_warnings(t.path(), &plan);
        assert_eq!(w.len(), 1);
        assert!(w[0].starts_with("d3d9.dll in this game folder belongs to another program"));
    }

    #[test]
    fn globs_and_paths() {
        assert!(glob("TwinkieForever*.zip", "twinkieforever-2.0.zip"));
        assert!(glob("*.dll", "a.dll") && !glob("*.dll", "a.zip"));
        assert!(glob("a*b*c", "axxbyyc") && !glob("a*b*c", "axxc"));
        assert_eq!(safe_rel("GameData\\Skins\\a.zip").as_deref(), Some("GameData/Skins/a.zip"));
        assert_eq!(safe_rel("../evil.dll"), None);
        assert_eq!(safe_rel("C:/x.dll"), None);
        assert_eq!(safe_rel("a/b.txt:stream"), None);
        let sel = select_files(vec![("Pack/GameData/x.txt".into(), vec![1]), ("Pack/readme.md".into(), vec![2]), ("../bad".into(), vec![3])], 1, &["GameData".into()]);
        assert_eq!(sel.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["GameData/x.txt"]);
    }

    #[test]
    fn install_and_restore_in_a_sandbox() {
        let base = std::env::temp_dir().join(format!("tmh-cat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("game");
        let data = base.join("data");
        std::fs::create_dir_all(root.join("GameData")).unwrap();
        std::fs::write(root.join("GameData").join("a.txt"), b"old").unwrap();
        staged().lock().unwrap().insert(
            "x|tmnf".into(),
            Staged {
                dinput8: false,
                version: "1".into(), root: root.clone(), kind: "files".into(), files: vec![("GameData/a.txt".into(), b"new".to_vec()), ("GameData/b.txt".into(), b"added".to_vec())],
                spec: None, source: "https://example.org/x.zip".into(), asset: "x.zip".into(), sha256: String::new(),
            },
        );
        apply("x", "tmnf", &data).unwrap();
        assert_eq!(std::fs::read(root.join("GameData/a.txt")).unwrap(), b"new");
        let recs = crate::updates::list(&data);
        assert_eq!(recs.len(), 1, "the install is recorded");
        assert_eq!(recs[0].files.len(), 2);
        assert!(!recs[0].auto_update, "plain links are not auto-updated");
        let b = list_backups(&data);
        assert_eq!(b.len(), 1);
        restore(&b[0].id, &data).unwrap();
        assert_eq!(std::fs::read(root.join("GameData/a.txt")).unwrap(), b"old");
        assert!(!root.join("GameData/b.txt").exists());
        assert!(target(&root, "dinput8.dll").is_err(), "never a dinput8.dll");
        assert!(target(&fsx::eswc_protected_dir(), "x.txt").is_err(), "never the StarForce folder");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A file mod installed into a separate installation replaces the hard link there; the
    /// original game's file keeps its bytes, also after a restore.
    #[test]
    fn install_into_an_instance_leaves_the_original_alone() {
        let t = tempfile::tempdir().unwrap();
        let game = t.path().join("TmNationsForever");
        std::fs::create_dir_all(game.join("GameData").join("Menu")).unwrap();
        std::fs::write(game.join("GameData").join("Menu").join("big.pak"), vec![5u8; 128 * 1024]).unwrap();
        std::fs::write(game.join("TmForever.exe"), vec![1u8; 128 * 1024]).unwrap();
        std::fs::write(game.join("Nadeo.ini"), "[TmForever]\r\nVersion=2.11.26\r\n").unwrap();
        let data = t.path().join("data");
        let exe = game.join("TmForever.exe").to_string_lossy().into_owned();
        let n = crate::instances::NewInstance { name: "Mods", game: "tmnf", source: &game, exe: Some(&exe), launcher: None, allow_copy: false, force_copy: false };
        let inst = crate::instances::create(&data, &n).unwrap().instance;
        let root = PathBuf::from(&inst.path);
        let linked = root.join("GameData").join("Menu").join("big.pak");
        assert_eq!(crate::instances::link_count(&linked), 2);
        staged().lock().unwrap().insert(
            "skinpack|tmnf@mods".into(),
            Staged { dinput8: false, version: "1".into(), root: root.clone(), kind: "files".into(), files: vec![("GameData/Menu/big.pak".into(), b"modded".to_vec())], spec: None, source: "https://example.org/x.zip".into(), asset: "x.zip".into(), sha256: String::new() },
        );
        apply("skinpack", "tmnf@mods", &data).unwrap();
        assert_eq!(std::fs::read(&linked).unwrap(), b"modded");
        assert_eq!(std::fs::read(game.join("GameData").join("Menu").join("big.pak")).unwrap(), vec![5u8; 128 * 1024]);
        assert_eq!(crate::updates::list(&data)[0].game, "tmnf@mods");
        let b = list_backups(&data);
        restore(&b[0].id, &data).unwrap();
        assert_eq!(std::fs::read(&linked).unwrap(), vec![5u8; 128 * 1024]);
        assert_eq!(std::fs::read(game.join("GameData").join("Menu").join("big.pak")).unwrap(), vec![5u8; 128 * 1024]);
    }

    /// Self-test per install kind: a TMLoader product goes into a (sandbox) products folder.
    #[test]
    fn tmloader_product_into_a_sandbox_products_folder() {
        let base = std::env::temp_dir().join(format!("tmh-prod-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let products = base.join("database").join("TmForever").join("products");
        std::fs::create_dir_all(&products).unwrap();
        let data = base.join("data");
        staged().lock().unwrap().insert(
            "p|tmuf".into(),
            Staged {
                dinput8: false,
                version: "1.0".into(), root: products.clone(), kind: "tmloader-product".into(),
                files: vec![("ChampionMod/description.yaml".into(), b"name: ChampionMod".to_vec()), ("ChampionMod/1.0/description.yaml".into(), b"version: 1.0".to_vec()), ("ChampionMod/1.0/mod.dll".into(), b"MZ".to_vec())],
                spec: None, source: "github:o/r".into(), asset: "ChampionMod.zip".into(), sha256: String::new(),
            },
        );
        match apply("p", "tmuf", &data) {
            Ok(_) => {
                assert!(products.join("ChampionMod/1.0/mod.dll").is_file());
                let b = list_backups(&data);
                restore(&b[0].id, &data).unwrap();
                assert!(!products.join("ChampionMod/1.0/mod.dll").exists(), "restore removes what the install added");
            }
            // TMLoader or a game is running on this PC: the installer must refuse, which is also correct.
            Err(e) => assert!(e.contains("running"), "{e}"),
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    fn loader_spec(blocked: Option<Vec<&str>>) -> InstallSpec {
        InstallSpec {
            kind: "files".into(),
            download: Download::default(),
            base: Some("game".into()),
            strip: 0,
            include: vec![],
            games: vec!["tm-sunrise".into()],
            requires: vec![],
            note: None,
            sha256: None,
            version: Some("1.3.0".into()),
            star_force_blocked: blocked.map(|v| v.into_iter().map(String::from).collect()),
        }
    }

    #[test]
    fn dinput8_only_when_the_hub_named_it_and_never_for_starforce() {
        let t = tempfile::tempdir().unwrap();
        let game = t.path().join("TMS");
        std::fs::create_dir_all(&game).unwrap();
        let files = vec!["dinput8.dll".to_string(), "horizon-essentials.dll".to_string()];
        // No starForceBlocked: the dinput8.dll is refused (an index without the field, or another project).
        assert!(dinput8_rules(&loader_spec(None), &files, &game).is_err());
        assert!(dinput8_rules(&loader_spec(Some(vec!["other.dll"])), &files, &game).is_err());
        // Named: allowed into a game without StarForce.
        assert_eq!(dinput8_rules(&loader_spec(Some(vec!["dinput8.dll"])), &files, &game), Ok(true));
        // A download without a dinput8.dll is untouched by the rule.
        assert_eq!(dinput8_rules(&loader_spec(None), &["readme.txt".to_string()], &game), Ok(false));
        // StarForce files next to the exe: refused.
        let sf = t.path().join("Retail");
        std::fs::create_dir_all(&sf).unwrap();
        std::fs::write(sf.join("protect.dll"), b"x").unwrap();
        assert!(starforce_game(&sf) && !starforce_game(&game));
        let e = dinput8_rules(&loader_spec(Some(vec!["dinput8.dll"])), &files, &sf).unwrap_err();
        assert!(e.contains("StarForce"), "{e}");
        // The protected ESWC folder is a StarForce game too, and is refused before any download.
        assert!(starforce_game(&fsx::eswc_protected_dir()));
        let e = prepare_in(&loader_spec(Some(vec!["dinput8.dll"])), "x", "tmn-eswc", &fsx::eswc_protected_dir(), &fsx::eswc_protected_dir(), t.path()).unwrap_err();
        assert!(e.contains("StarForce"), "{e}");
        // Horizon Client's loader is never replaced.
        std::fs::create_dir_all(game.join(crate::horizonhost::format::HOST_DIR)).unwrap();
        std::fs::write(game.join(crate::horizonhost::format::HOST_DIR).join(crate::horizonhost::format::RECORD), br#"{"version":"0.3.1","files":[]}"#).unwrap();
        assert!(dinput8_rules(&loader_spec(Some(vec!["dinput8.dll"])), &files, &game).unwrap_err().contains("Horizon Client"));
    }

    #[test]
    fn allowed_loader_installs_backs_up_and_restores() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("game");
        let data = t.path().join("data");
        std::fs::create_dir_all(&root).unwrap();
        // Somebody else's loader is there: it is backed up and comes back on restore.
        std::fs::write(root.join("dinput8.dll"), b"MZ other loader").unwrap();
        staged().lock().unwrap().insert(
            "ess|tm-sunrise".into(),
            Staged {
                dinput8: true,
                version: "1.3.0".into(),
                root: root.clone(),
                kind: "files".into(),
                files: vec![("dinput8.dll".into(), b"MZ essentials".to_vec()), ("essentials.ini".into(), b"[x]".to_vec())],
                spec: Some(loader_spec(Some(vec!["dinput8.dll"]))),
                source: "https://github.com/cheatoskar/eswc-autosave/releases/download/v1.3.0/x.zip".into(),
                asset: "x.zip".into(),
                sha256: String::new(),
            },
        );
        apply("ess", "tm-sunrise", &data).unwrap();
        assert_eq!(std::fs::read(root.join("dinput8.dll")).unwrap(), b"MZ essentials");
        let rec = crate::updates::list(&data).into_iter().find(|r| r.entry_id == "ess").unwrap();
        assert!(!rec.auto_update, "a loader is never updated by itself");
        let id = list_backups(&data)[0].id.clone();
        restore(&id, &data).unwrap();
        assert_eq!(std::fs::read(root.join("dinput8.dll")).unwrap(), b"MZ other loader");
        assert!(!root.join("essentials.ini").exists());
        // Without the flag the same path stays refused.
        assert!(target(&root, "dinput8.dll").is_err());
        assert!(target_with(&root, "sub/dinput8.dll", true).is_err(), "only next to the exe");
    }
}
