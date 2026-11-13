//! TMLoader (Tomashu's mod loader for TrackMania Forever, closed source).
//!
//! Layout, from %LOCALAPPDATA%\TMLoader on this PC, TMLoader's own ui/layouts/loader.d.ts and
//! the Lutris TMUF installer (which writes the same files):
//!   config.yaml                                  servers, default_profiles, database path
//!   database/TmForever/products/<Product>/description.yaml           name, author, type, ...
//!   database/TmForever/products/<Product>/<version>/description.yaml executable, priority,
//!       dependencies, changelog (the index entry without download_link / hash_sha256)
//!   database/TmForever/products/<Product>/<version>/<files>          the extracted zip
//!   database/TmForever/profiles/<name>.yaml      program: {id, version?}, args?, mods: [{id, version?}]
//! A version counts as installed when its folder holds more than description.yaml.
//!
//! Writes (mod install, profile switches) happen only while neither TMLoader nor the game runs,
//! and every file that gets replaced is first copied to TM Horizon's own backup folder (never next
//! to TMLoader's files, where TMLoader might read it as a profile or version).

use crate::fsx;
use serde::Serialize;
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const GAME: &str = "TmForever";

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub id: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmlVersion {
    pub version: String,
    pub installed: bool,
    pub executable: Option<String>,
    pub dependencies: Vec<Dependency>,
    pub changelog: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmlProduct {
    pub id: String,
    pub name: String,
    pub author: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub homepage: Option<String>,
    pub description: Option<String>,
    pub icon_link: Option<String>,
    pub external: bool,
    pub install: Option<String>,
    pub versions: Vec<TmlVersion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMod {
    pub id: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmlProfile {
    pub name: String,
    pub program: Option<ProfileMod>,
    pub args: Option<String>,
    pub mods: Vec<ProfileMod>,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TmLoaderInfo {
    pub installed: bool,
    /// TMLoader.exe is there but it never ran: config.yaml and the database appear at its first
    /// start (guided setup in a Wine prefix). Mods can be installed once it has started.
    pub first_run: bool,
    pub root: Option<String>,
    /// The folder is not %LOCALAPPDATA%\TMLoader (dev sandbox).
    pub sandbox: bool,
    pub exe: Option<String>,
    pub version: Option<String>,
    pub servers: Vec<String>,
    pub masterserver: Option<String>,
    pub default_profiles: BTreeMap<String, String>,
    pub products: BTreeMap<String, TmlProduct>,
    pub profiles: Vec<TmlProfile>,
}

/// TMLoader folder: setting > TMHUB_TMLOADER_DIR > %LOCALAPPDATA%\TMLoader.
pub fn default_root() -> Option<PathBuf> {
    crate::platform::local_app_data().map(|p| p.join("TMLoader"))
}

/// A TMLoader folder that has been started (config.yaml) or at least installed (TMLoader.exe).
pub fn has_exe(root: &Path) -> bool {
    fsx::is_file(&root.join("TMLoader.exe"))
}

/// Of several candidate folders: one with config.yaml, else one with TMLoader.exe, else the first.
pub fn pick_root(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|c| fsx::is_file(&c.join("config.yaml")))
        .or_else(|| candidates.iter().find(|c| has_exe(c)))
        .or_else(|| candidates.first())
        .cloned()
}

/// `%LOCALAPPDATA%\TMLoader` of every Wine prefix the player set up or picked (Linux).
pub fn prefix_roots(l: &crate::platform::wine::LinuxSettings, user: Option<&str>) -> Vec<PathBuf> {
    let mut prefixes: Vec<&str> = vec![];
    prefixes.extend(l.prefix.as_deref());
    prefixes.extend(l.games.values().filter_map(|g| g.prefix.as_deref()));
    prefixes.extend(l.prefixes.iter().map(String::as_str));
    let mut out: Vec<PathBuf> = vec![];
    for p in prefixes.into_iter().filter(|p| !p.trim().is_empty()) {
        if let Some(a) = crate::platform::wine::local_app_data(Path::new(p), user) {
            let r = crate::platform::wine::resolve_ci(&a.join("TMLoader")).into_owned();
            if !out.contains(&r) {
                out.push(r);
            }
        }
    }
    out
}

/// The TMLoader folder: an explicit setting or TMHUB_TMLOADER_DIR, else the default folder of the
/// main prefix/Windows user; on Linux a game's own prefix (guided setup) counts when the main one
/// has no TMLoader.
pub fn resolve_root_in(setting: Option<&str>, extra: &[PathBuf]) -> Option<PathBuf> {
    let r = resolve_root(setting)?;
    let explicit = setting.is_some_and(|s| !s.trim().is_empty()) || std::env::var("TMHUB_TMLOADER_DIR").is_ok_and(|s| !s.trim().is_empty());
    if explicit || extra.is_empty() {
        return Some(r);
    }
    let mut all = vec![r];
    all.extend(extra.iter().cloned());
    pick_root(&all)
}

pub fn resolve_root(setting: Option<&str>) -> Option<PathBuf> {
    if let Some(s) = setting.filter(|s| !s.trim().is_empty()) {
        return Some(PathBuf::from(s));
    }
    if let Ok(s) = std::env::var("TMHUB_TMLOADER_DIR") {
        if !s.trim().is_empty() {
            return Some(PathBuf::from(s));
        }
    }
    default_root()
}

pub fn read_yaml(p: &Path) -> Option<Value> {
    serde_yaml::from_str(&fsx::read_string(p)?).ok()
}

fn s(v: &Value, k: &str) -> Option<String> {
    match v.get(k)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn deps(v: &Value) -> Vec<Dependency> {
    v.get("dependencies")
        .and_then(Value::as_sequence)
        .map(|seq| seq.iter().filter_map(|d| Some(Dependency { id: s(d, "id")?, version: s(d, "version") })).collect())
        .unwrap_or_default()
}

/// Not the default folder and not in a Wine prefix: a dev sandbox.
fn is_sandbox(root: &Path) -> bool {
    let in_prefix = root.components().any(|c| c.as_os_str().eq_ignore_ascii_case("drive_c"));
    !in_prefix && default_root().map(|d| fsx::norm(&d) != fsx::norm(root)).unwrap_or(true)
}

pub fn database_dir(root: &Path) -> PathBuf {
    let cfg = read_yaml(&root.join("config.yaml"));
    let db = cfg.as_ref().and_then(|c| s(c, "database")).unwrap_or_else(|| "./database".into());
    let db = db.trim_start_matches("./").trim_start_matches(".\\");
    let p = Path::new(db);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}

pub fn game_dir(root: &Path) -> PathBuf {
    database_dir(root).join(GAME)
}

pub fn products_dir(root: &Path) -> PathBuf {
    game_dir(root).join("products")
}

pub fn profiles_dir(root: &Path) -> PathBuf {
    game_dir(root).join("profiles")
}

pub fn version_installed(vdir: &Path) -> bool {
    fsx::list(vdir).iter().any(|f| f.is_file && !f.name.eq_ignore_ascii_case("description.yaml"))
}

pub fn read_info(root: &Path) -> TmLoaderInfo {
    let Some(cfg) = read_yaml(&root.join("config.yaml")) else {
        let exe = has_exe(root);
        return TmLoaderInfo {
            installed: exe,
            first_run: exe,
            exe: exe.then(|| root.join("TMLoader.exe").to_string_lossy().into_owned()),
            root: Some(root.to_string_lossy().into()),
            sandbox: exe && is_sandbox(root),
            ..Default::default()
        };
    };
    let mut products = BTreeMap::new();
    for e in fsx::list(&products_dir(root)) {
        if !e.is_dir {
            continue;
        }
        let desc = read_yaml(&e.path.join("description.yaml")).unwrap_or(Value::Null);
        let settings = read_yaml(&e.path.join("settings.yaml"));
        let mut versions = Vec::new();
        for v in fsx::list(&e.path) {
            if !v.is_dir {
                continue;
            }
            let Some(vdesc) = read_yaml(&v.path.join("description.yaml")) else { continue };
            versions.push(TmlVersion {
                version: v.name.clone(),
                installed: version_installed(&v.path),
                executable: s(&vdesc, "executable"),
                dependencies: deps(&vdesc),
                changelog: s(&vdesc, "changelog"),
            });
        }
        products.insert(
            e.name.clone(),
            TmlProduct {
                id: e.name.clone(),
                name: s(&desc, "name").unwrap_or_else(|| e.name.clone()),
                author: s(&desc, "author"),
                kind: s(&desc, "type"),
                homepage: s(&desc, "homepage"),
                description: s(&desc, "description"),
                icon_link: s(&desc, "icon_link"),
                external: desc.get("external").and_then(Value::as_bool).unwrap_or(false),
                install: settings.as_ref().and_then(|x| s(x, "install")),
                versions,
            },
        );
    }
    let mut profiles = Vec::new();
    for e in fsx::list(&profiles_dir(root)) {
        if !e.is_file || !e.name.to_lowercase().ends_with(".yaml") {
            continue;
        }
        let p = read_yaml(&e.path).unwrap_or(Value::Null);
        let sel = |v: &Value| Some(ProfileMod { id: s(v, "id")?, version: s(v, "version") });
        profiles.push(TmlProfile {
            name: e.name[..e.name.len() - 5].to_string(),
            program: p.get("program").and_then(sel),
            args: s(&p, "args"),
            mods: p.get("mods").and_then(Value::as_sequence).map(|q| q.iter().filter_map(sel).collect()).unwrap_or_default(),
            modified: fsx::mtime_iso(&e.path),
        });
    }
    let default_profiles = cfg
        .get("default_profiles")
        .and_then(Value::as_mapping)
        .map(|m| m.iter().filter_map(|(k, v)| Some((k.as_str()?.to_string(), v.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    let servers = cfg
        .get("servers")
        .and_then(Value::as_sequence)
        .map(|q| q.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let sandbox = is_sandbox(root);
    TmLoaderInfo {
        installed: true,
        first_run: false,
        root: Some(root.to_string_lossy().into()),
        sandbox,
        exe: Some(root.join("TMLoader.exe").to_string_lossy().into()),
        version: s(&cfg, "version"),
        servers,
        masterserver: s(&cfg, "masterserver"),
        default_profiles,
        products,
        profiles,
    }
}

// ------------------------------------------------------------------ writes

/// Processes that hold TMLoader's files or the game.
pub const BUSY_PROCESSES: [&str; 3] = ["tmloader.exe", "tmforever.exe", "shimrun.exe"];

pub fn busy(running: &[String]) -> Option<String> {
    BUSY_PROCESSES.iter().find(|p| running.iter().any(|r| r == *p)).map(|p| p.to_string())
}

pub fn ensure_idle() -> Result<(), String> {
    match busy(&crate::platform::running_process_names()) {
        Some(p) => Err(format!("{p} is running. Close TMLoader and the game first.")),
        None => Ok(()),
    }
}

/// Copies `file` (if it exists) to `<backup_root>/<stamp>/<path relative to root>`.
pub fn backup(root: &Path, file: &Path, backup_dir: &Path) -> Result<Option<PathBuf>, String> {
    if !fsx::is_file(file) {
        return Ok(None);
    }
    let rel = file.strip_prefix(root).map(Path::to_path_buf).unwrap_or_else(|_| PathBuf::from(file.file_name().unwrap()));
    let to = backup_dir.join(rel);
    fsx::copy(file, &to)?;
    Ok(Some(to))
}

fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." || name.contains("..") {
        Err(format!("Invalid name: {name}"))
    } else {
        Ok(())
    }
}

/// Switches a mod on or off in a profile. Keeps every other key and entry as it is.
pub fn set_profile_mod(root: &Path, profile: &str, mod_id: &str, on: bool, backup_dir: &Path) -> Result<bool, String> {
    valid_name(profile)?;
    let file = profiles_dir(root).join(format!("{profile}.yaml"));
    let _guard = write_lock();
    let text = fsx::read_string(&file).ok_or_else(|| format!("Profile not found: {profile}"))?;
    if has_yaml_comment(&text) {
        return Err(format!("\"{profile}\" has comments that a rewrite would lose; change it in TMLoader."));
    }
    let mut doc: Value = serde_yaml::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    let map = doc.as_mapping_mut().ok_or("Profile is not a mapping")?;
    let key = Value::String("mods".into());
    if !map.contains_key(&key) {
        map.insert(key.clone(), Value::Sequence(vec![]));
    }
    let seq = map.get_mut(&key).and_then(Value::as_sequence_mut).ok_or("mods is not a list")?;
    let has = seq.iter().any(|m| m.get("id").and_then(Value::as_str) == Some(mod_id));
    if has == on {
        return Ok(false);
    }
    if on {
        let mut m = Mapping::new();
        m.insert("id".into(), Value::String(mod_id.into()));
        seq.push(Value::Mapping(m));
    } else {
        seq.retain(|m| m.get("id").and_then(Value::as_str) != Some(mod_id));
    }
    let crlf = text.contains("\r\n");
    let out = match emit_like_tmloader(&doc) {
        Some(s) if crlf => s.replace('\n', "\r\n"),
        Some(s) => s,
        None => serde_yaml::to_string(&doc).map_err(|e| e.to_string())?,
    };
    backup(root, &file, backup_dir)?;
    fsx::write(&file, out.as_bytes())?;
    Ok(true)
}

/// Pins a mod in a profile to `version` (None = use the newest installed). Turns the mod on.
pub fn set_profile_mod_version(root: &Path, profile: &str, mod_id: &str, version: Option<&str>, backup_dir: &Path) -> Result<bool, String> {
    valid_name(profile)?;
    if let Some(v) = version {
        valid_name(v)?;
    }
    let file = profiles_dir(root).join(format!("{profile}.yaml"));
    let _guard = write_lock();
    let text = fsx::read_string(&file).ok_or_else(|| format!("Profile not found: {profile}"))?;
    if has_yaml_comment(&text) {
        return Err(format!("\"{profile}\" has comments that a rewrite would lose; change it in TMLoader."));
    }
    let mut doc: Value = serde_yaml::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    let map = doc.as_mapping_mut().ok_or("Profile is not a mapping")?;
    let key = Value::String("mods".into());
    if !map.contains_key(&key) {
        map.insert(key.clone(), Value::Sequence(vec![]));
    }
    let seq = map.get_mut(&key).and_then(Value::as_sequence_mut).ok_or("mods is not a list")?;
    let mut entry = Mapping::new();
    entry.insert("id".into(), Value::String(mod_id.into()));
    if let Some(v) = version {
        entry.insert("version".into(), Value::String(v.into()));
    }
    let new = Value::Mapping(entry);
    match seq.iter_mut().find(|m| m.get("id").and_then(Value::as_str) == Some(mod_id)) {
        Some(m) if *m == new => return Ok(false),
        Some(m) => *m = new,
        None => seq.push(new),
    }
    let crlf = text.contains("\r\n");
    let out = match emit_like_tmloader(&doc) {
        Some(s) if crlf => s.replace('\n', "\r\n"),
        Some(s) => s,
        None => serde_yaml::to_string(&doc).map_err(|e| e.to_string())?,
    };
    backup(root, &file, backup_dir)?;
    fsx::write(&file, out.as_bytes())?;
    Ok(true)
}

/// Writes a new TMLoader profile (same layout TMLoader writes). A taken name gets " (2)", " (3)"...
/// Returns the name used.
pub fn create_profile(root: &Path, name: &str, program_version: Option<&str>, args: Option<&str>, mods: &[(String, Option<String>)]) -> Result<String, String> {
    valid_name(name)?;
    let _guard = write_lock();
    let dir = profiles_dir(root);
    if !fsx::is_dir(&dir) && !fsx::is_file(&root.join("config.yaml")) {
        return Err("TMLoader not found".into());
    }
    let mut used = name.to_string();
    let mut n = 2;
    while fsx::exists(&dir.join(format!("{used}.yaml"))) {
        used = format!("{name} ({n})");
        n += 1;
    }
    let mut program = Mapping::new();
    program.insert("id".into(), Value::String(GAME.into()));
    if let Some(v) = program_version {
        valid_name(v)?;
        program.insert("version".into(), Value::String(v.into()));
    }
    let mut doc = Mapping::new();
    doc.insert("program".into(), Value::Mapping(program));
    if let Some(a) = args.filter(|a| !a.trim().is_empty()) {
        doc.insert("args".into(), Value::String(a.into()));
    }
    let mut seq = Vec::new();
    for (id, v) in mods {
        valid_name(id)?;
        let mut m = Mapping::new();
        m.insert("id".into(), Value::String(id.clone()));
        if let Some(v) = v {
            valid_name(v)?;
            m.insert("version".into(), Value::String(v.clone()));
        }
        seq.push(Value::Mapping(m));
    }
    doc.insert("mods".into(), Value::Sequence(seq));
    let doc = Value::Mapping(doc);
    let out = emit_like_tmloader(&doc).map(Ok).unwrap_or_else(|| serde_yaml::to_string(&doc).map_err(|e| e.to_string()))?;
    fsx::write(&dir.join(format!("{used}.yaml")), out.as_bytes())?;
    Ok(used)
}

/// Deletes a TMLoader profile file (a backup goes to `backup_dir` first). TMLoader's default profile
/// is refused: TMLoader and its desktop shortcuts start it.
pub fn delete_profile(root: &Path, name: &str, backup_dir: &Path) -> Result<(), String> {
    valid_name(name)?;
    let _guard = write_lock();
    let file = profiles_dir(root).join(format!("{name}.yaml"));
    if !fsx::is_file(&file) {
        return Err(format!("Profile not found: {name}"));
    }
    if read_info(root).default_profiles.get(GAME).is_some_and(|d| d == name) {
        return Err(format!("\"{name}\" is TMLoader's default profile. Pick another default in TMLoader first."));
    }
    backup(root, &file, backup_dir)?;
    std::fs::remove_file(&file).map_err(|e| format!("{}: {e}", file.display()))
}

/// A YAML comment line or trailing comment (serde_yaml drops comments on a rewrite).
pub fn has_yaml_comment(text: &str) -> bool {
    text.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with('#') || (l.contains(" #") && !l.contains('\'') && !l.contains('"'))
    })
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if s.contains('\n') => None,
        Value::String(_) | Value::Number(_) | Value::Bool(_) => Some(serde_yaml::to_string(v).ok()?.trim_end().to_string()),
        Value::Null => Some("~".into()),
        _ => None,
    }
}

/// Writes a profile the way TMLoader does (block style, list items indented under their key,
/// as in its own profiles/*.yaml). None when the document is more complex than that.
pub fn emit_like_tmloader(doc: &Value) -> Option<String> {
    fn map(m: &Mapping, ind: usize, out: &mut String) -> Option<()> {
        let pad = " ".repeat(ind);
        for (k, v) in m {
            let k = k.as_str()?;
            match v {
                Value::Mapping(inner) if !inner.is_empty() => {
                    out.push_str(&format!("{pad}{k}:\n"));
                    map(inner, ind + 2, out)?;
                }
                Value::Sequence(items) if !items.is_empty() => {
                    out.push_str(&format!("{pad}{k}:\n"));
                    for it in items {
                        match it {
                            Value::Mapping(im) if !im.is_empty() => {
                                for (i, (ik, iv)) in im.iter().enumerate() {
                                    let lead = if i == 0 { format!("{pad}  - ") } else { format!("{pad}    ") };
                                    out.push_str(&format!("{lead}{}: {}\n", ik.as_str()?, scalar(iv)?));
                                }
                            }
                            other => out.push_str(&format!("{pad}  - {}\n", scalar(other)?)),
                        }
                    }
                }
                Value::Sequence(_) => out.push_str(&format!("{pad}{k}: []\n")),
                Value::Mapping(_) => out.push_str(&format!("{pad}{k}: {{}}\n")),
                other => out.push_str(&format!("{pad}{k}: {}\n", scalar(other)?)),
            }
        }
        Some(())
    }
    let mut out = String::new();
    map(doc.as_mapping()?, 0, &mut out)?;
    // Must read back to the same document.
    (serde_yaml::from_str::<Value>(&out).ok()? == *doc).then_some(out)
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn verify_sha256(data: &[u8], expected: &str) -> Result<(), String> {
    let got = sha256_hex(data);
    if got.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(format!("SHA-256 mismatch: index says {expected}, download is {got}"))
    }
}

/// One version entry of a TMLoader repository index (`products.<id>.versions.<ver>`).
pub struct IndexVersion<'a> {
    pub product_id: &'a str,
    /// Product fields of the index (name, author, type, ...; versions are ignored).
    pub product: &'a Value,
    pub version: &'a str,
    /// The version entry itself (executable, dependencies, download_link, hash_sha256, ...).
    pub entry: &'a Value,
}

/// Fields TMLoader keeps in a version's description.yaml (everything but the download data).
pub fn version_description(entry: &Value) -> Value {
    let mut m = entry.as_mapping().cloned().unwrap_or_default();
    for k in ["download_link", "hash_sha256", "password"] {
        m.remove(k);
    }
    Value::Mapping(m)
}

pub fn product_description(product: &Value) -> Value {
    let mut m = product.as_mapping().cloned().unwrap_or_default();
    m.remove("versions");
    Value::Mapping(m)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub product: String,
    pub version: String,
    pub folder: String,
    pub files: Vec<String>,
    pub backups: Vec<String>,
}

pub const ZIP_MAX_ENTRIES: usize = 20_000;
pub const ZIP_MAX_FILE: u64 = 512 << 20;
pub const ZIP_MAX_TOTAL: u64 = 1 << 30;

/// One install or profile write at a time (shared staging folders, read-modify-write of YAML).
pub static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
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

/// Verifies the zip against the index's SHA-256 and extracts it into
/// products/<Product>/<version>/ the way TMLoader lays it out.
pub fn install_from_zip(root: &Path, iv: &IndexVersion, zip: &[u8], staging: &Path, backup_dir: &Path) -> Result<InstallReport, String> {
    install_from_zip_limited(root, iv, zip, staging, backup_dir, ZIP_MAX_FILE, ZIP_MAX_TOTAL)
}

fn install_from_zip_limited(root: &Path, iv: &IndexVersion, zip: &[u8], staging: &Path, backup_dir: &Path, max_file: u64, max_total: u64) -> Result<InstallReport, String> {
    valid_name(iv.product_id)?;
    valid_name(iv.version)?;
    let expected = iv.entry.get("hash_sha256").and_then(Value::as_str).ok_or("The index has no SHA-256 for this version; install it with TMLoader.")?;
    if iv.entry.get("password").is_some() {
        return Err("This download is password protected; install it with TMLoader.".into());
    }
    verify_sha256(zip, expected)?;

    // Extract into a staging folder outside TMLoader's database first.
    let _ = std::fs::remove_dir_all(staging);
    std::fs::create_dir_all(staging).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| format!("Not a zip: {e}"))?;
    if archive.len() > ZIP_MAX_ENTRIES {
        return Err(format!("The zip has more than {ZIP_MAX_ENTRIES} entries"));
    }
    let mut files = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let f = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { return Err(format!("Unsafe path in zip: {}", f.name())) };
        if f.is_dir() {
            continue;
        }
        let rel = fsx::clean(&rel);
        if fsx::has_ads(&rel) || rel.is_absolute() {
            return Err(format!("Unsafe path in zip: {}", f.name()));
        }
        if fsx::is_dinput8(&rel) || rel.file_name().map(|n| n.eq_ignore_ascii_case("description.yaml")).unwrap_or(false) {
            continue;
        }
        // Never trust the sizes in the zip header: read at most the limit (zip bombs).
        let left = max_total.saturating_sub(total).min(max_file);
        let mut buf = Vec::with_capacity((f.size().min(1 << 20)) as usize);
        f.take(left + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if buf.len() as u64 > left {
            return Err("The zip unpacks to more than TM Horizon allows for a mod".into());
        }
        total += buf.len() as u64;
        fsx::write(&staging.join(&rel), &buf)?;
        files.push(rel);
    }
    if files.is_empty() {
        return Err("The zip is empty".into());
    }
    if let Some(exe) = iv.entry.get("executable").and_then(Value::as_str) {
        if !files.iter().any(|f| f.to_string_lossy().replace('\\', "/").eq_ignore_ascii_case(exe)) {
            return Err(format!("The zip has no {exe}"));
        }
    }

    let pdir = products_dir(root).join(iv.product_id);
    let vdir = pdir.join(iv.version);
    let mut backups = Vec::new();
    for rel in &files {
        if let Some(b) = backup(root, &vdir.join(rel), backup_dir)? {
            backups.push(b.to_string_lossy().into_owned());
        }
    }
    // Build the complete new version folder next to the live one (existing files such as a
    // mod's own settings are carried over), then swap it in with two renames, so TMLoader never
    // sees a half-copied version.
    let next = pdir.join(format!(".{}.tmhub-installing", iv.version));
    let old = pdir.join(format!(".{}.tmhub-old", iv.version));
    let _ = std::fs::remove_dir_all(&next);
    let _ = std::fs::remove_dir_all(&old);
    if fsx::is_dir(&vdir) {
        copy_tree(&vdir, &next)?;
    }
    for rel in &files {
        fsx::copy(&staging.join(rel), &next.join(rel))?;
    }
    // Descriptions only where TMLoader has none yet (its next fetch rewrites them anyway).
    let vdesc = next.join("description.yaml");
    if !fsx::is_file(&vdesc) {
        fsx::write(&vdesc, serde_yaml::to_string(&version_description(iv.entry)).map_err(|e| e.to_string())?.as_bytes())?;
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
    if !fsx::is_file(&pdesc) {
        fsx::write(&pdesc, serde_yaml::to_string(&product_description(iv.product)).map_err(|e| e.to_string())?.as_bytes())?;
    }
    let _ = std::fs::remove_dir_all(staging);
    Ok(InstallReport {
        product: iv.product_id.into(),
        version: iv.version.into(),
        folder: vdir.to_string_lossy().into(),
        files: files.iter().map(|f| f.to_string_lossy().into_owned()).collect(),
        backups,
    })
}

/// Picks the version a dependency needs: an installed one that matches, else the newest
/// index version that matches. `^1.0.7` style ranges as in the indexes.
pub fn pick_version<'a>(range: Option<&str>, candidates: impl Iterator<Item = &'a str>) -> Option<String> {
    let req = range.and_then(|r| semver::VersionReq::parse(r).ok());
    let mut best: Option<(semver::Version, String)> = None;
    for c in candidates {
        let Ok(v) = semver::Version::parse(c) else { continue };
        let ok = match &req {
            Some(r) => r.matches(&v) || (!v.pre.is_empty() && r.matches(&semver::Version::new(v.major, v.minor, v.patch))),
            None => true,
        };
        if ok && best.as_ref().map(|(b, _)| v > *b).unwrap_or(true) {
            best = Some((v, c.to_string()));
        }
    }
    best.map(|(_, s)| s)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            for (name, data) in files {
                z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn creates_profiles_and_pins_versions() {
        let t = tempfile::tempdir().unwrap();
        fake_root(t.path());
        let mods = vec![("TMInterface".to_string(), None), ("CoreMod".to_string(), None)];
        let name = create_profile(t.path(), "TAS", None, None, &mods).unwrap();
        assert_eq!(name, "TAS");
        let text = std::fs::read_to_string(profiles_dir(t.path()).join("TAS.yaml")).unwrap();
        assert_eq!(text, "program:\n  id: TmForever\nmods:\n  - id: TMInterface\n  - id: CoreMod\n");
        assert_eq!(create_profile(t.path(), "TAS", Some("2.12.0-compat"), None, &[]).unwrap(), "TAS (2)");
        let t2 = std::fs::read_to_string(profiles_dir(t.path()).join("TAS (2).yaml")).unwrap();
        assert!(t2.contains("version: 2.12.0-compat") && t2.contains("mods: []"));
        assert!(create_profile(t.path(), "../x", None, None, &[]).is_err());
        let info = read_info(t.path());
        assert!(info.profiles.iter().any(|p| p.name == "TAS" && p.mods.len() == 2));

        let b = t.path().join("bak");
        assert!(set_profile_mod_version(t.path(), "default", "Competition Patch", Some("2.0.1"), &b).unwrap());
        let d = std::fs::read_to_string(profiles_dir(t.path()).join("default.yaml")).unwrap();
        assert!(d.contains("  - id: Competition Patch\n    version: 2.0.1\n"), "{d}");
        assert!(!set_profile_mod_version(t.path(), "default", "Competition Patch", Some("2.0.1"), &b).unwrap());
        assert!(set_profile_mod_version(t.path(), "default", "Competition Patch", None, &b).unwrap());
        let d = std::fs::read_to_string(profiles_dir(t.path()).join("default.yaml")).unwrap();
        assert!(d.contains("  - id: Competition Patch\n") && !d.contains("1.5.3") && !d.contains("2.0.1"));
    }

    #[test]
    fn deletes_profiles_but_not_the_default() {
        let t = tempfile::tempdir().unwrap();
        fake_root(t.path());
        let b = t.path().join("bak");
        create_profile(t.path(), "Race", None, None, &[("CoreMod".to_string(), None)]).unwrap();
        delete_profile(t.path(), "Race", &b).unwrap();
        assert!(!profiles_dir(t.path()).join("Race.yaml").exists());
        assert!(b.join("database/TmForever/profiles/Race.yaml").is_file(), "backup kept");
        assert!(read_info(t.path()).profiles.iter().all(|p| p.name != "Race"));
        assert!(delete_profile(t.path(), "Race", &b).is_err(), "already gone");
        assert!(delete_profile(t.path(), "default", &b).is_err(), "TMLoader's default stays");
        assert!(profiles_dir(t.path()).join("default.yaml").is_file());
        assert!(delete_profile(t.path(), "../config", &b).is_err());
    }

    /// A tiny TMLoader folder like the real one (config, one profile, one product).
    pub fn fake_root(dir: &Path) {
        fsx::write(&dir.join("config.yaml"), b"version: 1.0.1\ndatabase: ./database\ndefault_profiles:\n  TmForever: default\nservers:\n  - 'https://example.invalid/modloader/'\n").unwrap();
        fsx::write(
            &dir.join("database/TmForever/profiles/default.yaml"),
            b"program:\n  id: TmForever\nmods:\n  - id: TMUnlimiter\n  - id: Competition Patch\n    version: 1.5.3\n",
        )
        .unwrap();
        fsx::write(&dir.join("database/TmForever/products/CoreMod/description.yaml"), b"name: CoreMod\ntype: modification\n").unwrap();
        fsx::write(&dir.join("database/TmForever/products/CoreMod/1.0.12/description.yaml"), b"executable: CoreMod.dll\n").unwrap();
        fsx::write(&dir.join("database/TmForever/products/CoreMod/1.0.12/CoreMod.dll"), b"MZ").unwrap();
    }

    fn index_entry(zip: &[u8]) -> (Value, Value) {
        let product: Value = serde_yaml::from_str("name: CenterSpeed\nauthor: OneCredit\ntype: modification\nversions: {}\n").unwrap();
        let entry: Value = serde_yaml::from_str(&format!(
            "executable: CenterSpeed.dll\ndependencies:\n  - id: CoreMod\n    version: ^1.0.7\ndownload_link: https://example.invalid/x.zip\nhash_sha256: {}\nchangelog: |-\n  - Added gears\n",
            sha256_hex(zip)
        ))
        .unwrap();
        (product, entry)
    }

    #[test]
    fn reads_layout() {
        let t = tempfile::tempdir().unwrap();
        fake_root(t.path());
        let info = read_info(t.path());
        assert!(info.installed);
        assert_eq!(info.default_profiles.get("TmForever").map(String::as_str), Some("default"));
        assert_eq!(info.profiles.len(), 1);
        assert_eq!(info.profiles[0].mods[1].version.as_deref(), Some("1.5.3"));
        assert!(info.products["CoreMod"].versions[0].installed);
    }

    #[test]
    fn install_writes_tmloader_layout_with_backups() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("TMLoader");
        fake_root(&root);
        let zip = make_zip(&[("CenterSpeed.dll", b"dll v1"), ("skids/a.dds", b"dds")]);
        let (product, entry) = index_entry(&zip);
        let iv = IndexVersion { product_id: "CenterSpeed", product: &product, version: "1.4.3", entry: &entry };
        let r = install_from_zip(&root, &iv, &zip, &t.path().join("staging"), &t.path().join("backup1")).unwrap();
        let vdir = products_dir(&root).join("CenterSpeed/1.4.3");
        assert_eq!(std::fs::read(vdir.join("CenterSpeed.dll")).unwrap(), b"dll v1");
        assert!(vdir.join("skids/a.dds").is_file());
        let vdesc = std::fs::read_to_string(vdir.join("description.yaml")).unwrap();
        assert!(vdesc.contains("executable: CenterSpeed.dll"));
        assert!(!vdesc.contains("download_link") && !vdesc.contains("hash_sha256"));
        let pdesc = std::fs::read_to_string(products_dir(&root).join("CenterSpeed/description.yaml")).unwrap();
        assert!(pdesc.contains("name: CenterSpeed") && !pdesc.contains("versions"));
        assert!(r.backups.is_empty());
        assert!(!t.path().join("staging").exists());
        assert!(read_info(&root).products["CenterSpeed"].versions[0].installed);

        // Reinstall over it: the old file is backed up first.
        let zip2 = make_zip(&[("CenterSpeed.dll", b"dll v2")]);
        let (_, entry2) = index_entry(&zip2);
        let iv2 = IndexVersion { entry: &entry2, ..iv };
        let r2 = install_from_zip(&root, &iv2, &zip2, &t.path().join("staging"), &t.path().join("backup2")).unwrap();
        assert_eq!(r2.backups.len(), 1);
        assert_eq!(std::fs::read(&r2.backups[0]).unwrap(), b"dll v1");
        assert_eq!(std::fs::read(vdir.join("CenterSpeed.dll")).unwrap(), b"dll v2");
    }

    #[test]
    fn reinstall_keeps_other_files_and_leaves_no_temp_folders() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("TMLoader");
        fake_root(&root);
        let zip = make_zip(&[("CenterSpeed.dll", b"dll v1")]);
        let (product, entry) = index_entry(&zip);
        let iv = IndexVersion { product_id: "CenterSpeed", product: &product, version: "1.4.3", entry: &entry };
        install_from_zip(&root, &iv, &zip, &t.path().join("s"), &t.path().join("b1")).unwrap();
        let vdir = products_dir(&root).join("CenterSpeed/1.4.3");
        std::fs::write(vdir.join("settings.ini"), b"mine").unwrap();
        install_from_zip(&root, &iv, &zip, &t.path().join("s"), &t.path().join("b2")).unwrap();
        assert_eq!(std::fs::read(vdir.join("settings.ini")).unwrap(), b"mine");
        let names: Vec<String> = std::fs::read_dir(products_dir(&root).join("CenterSpeed")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.contains("tmhub")), "{names:?}");
    }

    #[test]
    fn install_caps_unpacked_size_and_refuses_streams() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("TMLoader");
        fake_root(&root);
        // 64 KiB of zeros compress to almost nothing: a tiny zip bomb.
        let big = vec![0u8; 64 << 10];
        let zip = make_zip(&[("CenterSpeed.dll", b"x"), ("pad.bin", &big)]);
        let (product, entry) = index_entry(&zip);
        let iv = IndexVersion { product_id: "CenterSpeed", product: &product, version: "1.4.3", entry: &entry };
        let e = install_from_zip_limited(&root, &iv, &zip, &t.path().join("s"), &t.path().join("b"), 32 << 10, 1 << 20).unwrap_err();
        assert!(e.contains("more than"), "{e}");
        let e = install_from_zip_limited(&root, &iv, &zip, &t.path().join("s"), &t.path().join("b"), 1 << 20, 40 << 10).unwrap_err();
        assert!(e.contains("more than"), "{e}");
        assert!(!products_dir(&root).join("CenterSpeed").join("1.4.3").exists());

        let ads = make_zip(&[("CenterSpeed.dll", b"x"), ("CenterSpeed.dll:hidden", b"y")]);
        let (_, entry) = index_entry(&ads);
        let iv = IndexVersion { entry: &entry, ..iv };
        assert!(install_from_zip(&root, &iv, &ads, &t.path().join("s"), &t.path().join("b")).is_err());
    }

    #[test]
    fn profiles_with_comments_are_not_rewritten() {
        let t = tempfile::tempdir().unwrap();
        fake_root(t.path());
        let f = profiles_dir(t.path()).join("commented.yaml");
        std::fs::write(&f, "# my cup setup\nprogram:\n  id: TmForever\nmods:\n  - id: CoreMod\n").unwrap();
        assert!(set_profile_mod(t.path(), "commented", "TMUnlimiter", true, &t.path().join("b")).unwrap_err().contains("comments"));
        assert!(set_profile_mod_version(t.path(), "commented", "CoreMod", Some("1.0.12"), &t.path().join("b")).is_err());
        assert!(std::fs::read_to_string(&f).unwrap().starts_with("# my cup setup"));
        assert!(!has_yaml_comment("program:\n  id: TmForever\nargs: '/x #1'\n"));
        assert!(has_yaml_comment("mods:\n  - id: CoreMod # needed\n"));
    }

    #[test]
    fn install_refuses_bad_hash_and_zip_slip() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("TMLoader");
        fake_root(&root);
        let zip = make_zip(&[("CenterSpeed.dll", b"x")]);
        let (product, mut entry) = index_entry(&zip);
        entry.as_mapping_mut().unwrap().insert("hash_sha256".into(), Value::String("00".repeat(32)));
        let iv = IndexVersion { product_id: "CenterSpeed", product: &product, version: "1.4.3", entry: &entry };
        let e = install_from_zip(&root, &iv, &zip, &t.path().join("s"), &t.path().join("b")).unwrap_err();
        assert!(e.contains("SHA-256 mismatch"));
        assert!(!products_dir(&root).join("CenterSpeed").exists());

        let evil = make_zip(&[("../../evil.dll", b"x"), ("CenterSpeed.dll", b"x")]);
        let (_, entry) = index_entry(&evil);
        let iv = IndexVersion { entry: &entry, ..iv };
        assert!(install_from_zip(&root, &iv, &evil, &t.path().join("s"), &t.path().join("b")).unwrap_err().contains("Unsafe path"));
        assert!(!t.path().join("evil.dll").exists());
    }

    #[test]
    fn profile_switch_keeps_other_entries() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("TMLoader");
        fake_root(&root);
        assert!(set_profile_mod(&root, "default", "CenterSpeed", true, &t.path().join("b1")).unwrap());
        assert!(!set_profile_mod(&root, "default", "CenterSpeed", true, &t.path().join("b2")).unwrap());
        let info = read_info(&root);
        let ids: Vec<_> = info.profiles[0].mods.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["TMUnlimiter", "Competition Patch", "CenterSpeed"]);
        assert_eq!(info.profiles[0].mods[1].version.as_deref(), Some("1.5.3"));
        assert_eq!(info.profiles[0].program.as_ref().unwrap().id, "TmForever");
        let backup = t.path().join("b1/database/TmForever/profiles/default.yaml");
        assert!(std::fs::read_to_string(backup).unwrap().contains("TMUnlimiter"));
        assert!(set_profile_mod(&root, "default", "TMUnlimiter", false, &t.path().join("b3")).unwrap());
        assert_eq!(read_info(&root).profiles[0].mods.len(), 2);
        assert!(set_profile_mod(&root, "../config", "x", true, &t.path().join("b4")).is_err());
    }

    /// Real download from a TMLoader server into the sandbox copy (TMHUB_SANDBOX + TMHUB_NET_TESTS):
    /// CenterSpeed (small) into a fresh version folder "1.4.3-tmhubtest".
    #[test]
    fn sandbox_real_download_install() {
        let (Ok(root), Ok(_)) = (std::env::var("TMHUB_SANDBOX"), std::env::var("TMHUB_NET_TESTS")) else { return };
        let root = PathBuf::from(root);
        assert!(default_root().map(|d| fsx::norm(&d) != fsx::norm(&root)).unwrap_or(true));
        let (_, raw) = crate::modindex::fetch(&["https://fullspeed.mooo.com/modloader/".to_string()]);
        let p = raw.products.get("CenterSpeed").expect("CenterSpeed in index");
        let entry = &p["versions"]["1.4.3"];
        let zip = crate::net::get_bytes(entry["download_link"].as_str().unwrap(), 64 << 20).unwrap();
        let product: Value = serde_json::from_value(p.clone()).unwrap();
        let entry: Value = serde_json::from_value(entry.clone()).unwrap();
        let t = tempfile::tempdir().unwrap();
        let iv = IndexVersion { product_id: "CenterSpeed", product: &product, version: "1.4.3-tmhubtest", entry: &entry };
        let r = install_from_zip(&root, &iv, &zip, &t.path().join("s"), &t.path().join("b")).unwrap();
        eprintln!("installed {:?} into {}", r.files, r.folder);
        assert!(Path::new(&r.folder).join("CenterSpeed.dll").is_file());
        assert!(read_info(&root).products["CenterSpeed"].versions.iter().any(|v| v.version == "1.4.3-tmhubtest" && v.installed));
        std::fs::remove_dir_all(&r.folder).unwrap();
    }

    #[test]
    fn emits_profiles_like_tmloader() {
        let a = "program:\r\n  id: TmForever\r\n  version: 2.12.0-compat\r\nmods:\r\n  - id: TMInterface\r\n  - id: CoreMod\r\n    version: 1.0.12\r\n";
        let doc: Value = serde_yaml::from_str(a).unwrap();
        assert_eq!(emit_like_tmloader(&doc).unwrap().replace('\n', "\r\n"), a);
        // Read-only: TM Horizon's writer reproduces every real profile byte for byte.
        if let Some(root) = default_root() {
            for e in fsx::list(&profiles_dir(&root)) {
                let text = std::fs::read_to_string(&e.path).unwrap();
                let doc: Value = serde_yaml::from_str(&text).unwrap();
                let mut out = emit_like_tmloader(&doc).unwrap();
                if text.contains("\r\n") {
                    out = out.replace('\n', "\r\n");
                }
                let norm = |s: &str| s.replace('\'', "");
                assert_eq!(norm(&out), norm(&text), "{}", e.name);
            }
        }
    }

    #[test]
    fn dependency_versions() {
        let v = ["1.0.0", "1.0.12", "1.0.2", "2.0.0"];
        assert_eq!(pick_version(Some("^1.0.7"), v.iter().copied()).as_deref(), Some("1.0.12"));
        assert_eq!(pick_version(None, v.iter().copied()).as_deref(), Some("2.0.0"));
        assert_eq!(pick_version(Some("^3"), v.iter().copied()), None);
    }

    #[test]
    fn busy_processes() {
        assert_eq!(busy(&["explorer.exe".into(), "tmforever.exe".into()]).as_deref(), Some("tmforever.exe"));
        assert_eq!(busy(&["explorer.exe".into()]), None);
    }

    /// Against a copy of the real %LOCALAPPDATA%\TMLoader (set TMHUB_SANDBOX to that copy):
    /// switches a mod in a copied profile and installs a locally built zip.
    #[test]
    fn sandbox_copy_roundtrip() {
        let Ok(root) = std::env::var("TMHUB_SANDBOX") else { return };
        let root = PathBuf::from(root);
        assert!(default_root().map(|d| fsx::norm(&d) != fsx::norm(&root)).unwrap_or(true), "TMHUB_SANDBOX must not be the real TMLoader folder");
        let info = read_info(&root);
        assert!(info.installed && info.sandbox);
        let t = tempfile::tempdir().unwrap();
        let prof = &info.profiles[0].name;
        let before = info.profiles[0].mods.len();
        set_profile_mod(&root, prof, "TM Horizon Test", true, &t.path().join("b")).unwrap();
        assert_eq!(read_info(&root).profiles.iter().find(|p| &p.name == prof).unwrap().mods.len(), before + 1);
        set_profile_mod(&root, prof, "TM Horizon Test", false, &t.path().join("b2")).unwrap();
        let zip = make_zip(&[("CenterSpeed.dll", b"sandbox")]);
        let (product, entry) = index_entry(&zip);
        let iv = IndexVersion { product_id: "TM Horizon Test", product: &product, version: "0.0.1", entry: &entry };
        let r = install_from_zip(&root, &iv, &zip, &t.path().join("s"), &t.path().join("b3")).unwrap();
        assert!(Path::new(&r.folder).join("CenterSpeed.dll").is_file());
        std::fs::remove_dir_all(products_dir(&root).join("TM Horizon Test")).unwrap();
    }
    /// A prefix from the Linux guided setup: TMLoader.exe is there, config.yaml appears at its first start.
    fn fake_prefix(root: &Path, name: &str, exe: bool, config: bool) -> PathBuf {
        let p = root.join(name);
        let tml = p.join("drive_c/users/me/AppData/Local/TMLoader");
        std::fs::create_dir_all(&tml).unwrap();
        if exe {
            std::fs::write(tml.join("TMLoader.exe"), b"MZ").unwrap();
        }
        if config {
            std::fs::write(tml.join("config.yaml"), b"version: 1.0.1
database: ./database
").unwrap();
        }
        p
    }

    #[test]
    fn tmloader_in_a_game_prefix_is_found_before_its_first_start() {
        let t = tempfile::tempdir().unwrap();
        let main = fake_prefix(t.path(), "main", false, false);
        let game = fake_prefix(t.path(), "tmnf", true, false);
        let mut l = crate::platform::wine::LinuxSettings::default();
        l.prefix = Some(main.to_string_lossy().into());
        l.games.insert("tmnf".into(), crate::platform::wine::LinuxGame { prefix: Some(game.to_string_lossy().into()), ..Default::default() });
        let roots = prefix_roots(&l, Some("me"));
        assert_eq!(roots.len(), 2);
        // Main prefix is empty: the game's prefix wins; a started TMLoader (config.yaml) beats a fresh one.
        assert_eq!(pick_root(&roots).unwrap(), roots[1]);
        let started = fake_prefix(t.path(), "other", true, true);
        l.prefixes.push(started.to_string_lossy().into());
        let roots = prefix_roots(&l, Some("me"));
        assert_eq!(pick_root(&roots).unwrap(), roots[2]);
        assert_eq!(pick_root(&[]), None);

        let info = read_info(&roots[1]);
        assert!(info.installed && info.first_run && !info.sandbox, "installed, never started, not a dev sandbox");
        assert!(info.exe.as_deref().unwrap().ends_with("TMLoader.exe"));
        assert!(info.profiles.is_empty());
        let started_info = read_info(&roots[2]);
        assert!(started_info.installed && !started_info.first_run);
        // Nothing there at all: not installed.
        let none = fake_prefix(t.path(), "none", false, false);
        let r = prefix_roots(&crate::platform::wine::LinuxSettings { prefix: Some(none.to_string_lossy().into()), ..Default::default() }, Some("me"));
        assert!(!read_info(&r[0]).installed);
    }
}
