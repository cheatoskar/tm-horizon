//! Openplanet plugins for Trackmania (2020), ManiaPlanet 4 and Trackmania Turbo: the public plugin
//! list (openplanet.dev/api/plugins, all pages, cached for a day), the plugins installed per game
//! (%USERPROFILE%\<Openplanet folder>\Plugins, per openplanet.dev/docs), and installing one plugin = saving its .op file from
//! cdn.openplanet.dev into that Plugins folder. Openplanet itself is installed only by its official installer (opsetup.rs).
//!
//! An installed .op is a zip with an `info.toml`; its `version` tells whether openplanet.dev has a newer
//! one (Update = the same install again). Remove deletes only `<identifier>.op` files, never a plugin
//! folder (those are the player's own or a developer's).

use crate::{fsx, net};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const API: &str = "https://openplanet.dev/api/plugins";
const MAX_PLUGIN: u64 = 32 << 20;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpPlugin {
    pub id: u64,
    pub identifier: String,
    pub name: String,
    pub authors: Vec<String>,
    pub short: String,
    /// Full https URL of the main image, if any.
    pub image: Option<String>,
    /// As the API names them: "Trackmania", "Maniaplanet 4", "Trackmania Turbo", ...
    pub games: Vec<String>,
    pub downloads: u64,
    pub version: String,
    pub signed: bool,
    /// "regular", "school", ... (the API's signtype).
    pub sign_type: String,
    /// Direct .op download (cdn.openplanet.dev).
    pub download: Option<String>,
    /// Plugin page on openplanet.dev.
    pub page: String,
    pub updated: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpInstalled {
    /// File or folder name in Plugins.
    pub file: String,
    /// Name without .op (matches the API's identifier for .op files from openplanet.dev).
    pub identifier: String,
    pub is_dir: bool,
    /// `version` from the .op's info.toml (None for folders and unreadable files).
    pub version: Option<String>,
}

/// `version = "..."` of an .op file's info.toml ([meta] section, or the first version line).
pub fn op_version(bytes: &[u8]) -> Option<String> {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut text = String::new();
    {
        let idx = (0..z.len()).find(|i| z.by_index(*i).map(|f| f.name().replace('\\', "/").trim_start_matches('/').eq_ignore_ascii_case("info.toml")).unwrap_or(false))?;
        let f = z.by_index(idx).ok()?;
        f.take(64 << 10).read_to_string(&mut text).ok()?;
    }
    let mut section = String::new();
    let mut first: Option<String> = None;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            section = l.trim_matches(['[', ']']).trim().to_lowercase();
            continue;
        }
        let Some((k, v)) = l.split_once('=') else { continue };
        if k.trim() != "version" {
            continue;
        }
        let v = v.trim().trim_matches('"').trim().to_string();
        if v.is_empty() || v.len() > 40 {
            continue;
        }
        if section == "meta" {
            return Some(v);
        }
        first.get_or_insert(v);
    }
    first
}

/// a > b for plugin versions ("1.10.2" > "1.9"; non-numbers compared as text).
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |s: &str| s.trim_start_matches(['v', 'V']).split(['.', '-', '+']).map(|p| p.parse::<u64>().map_err(|_| p.to_string())).collect::<Vec<_>>();
    let (x, y) = (parts(a), parts(b));
    for i in 0..x.len().max(y.len()) {
        match (x.get(i), y.get(i)) {
            (Some(Ok(p)), Some(Ok(q))) if p != q => return p > q,
            (Some(Err(p)), Some(Err(q))) if p != q => return p > q,
            (Some(Ok(_)), Some(Err(_))) => return true,
            (Some(Err(_)), Some(Ok(_))) => return false,
            (Some(Ok(p)), None) => return *p > 0 || x[i + 1..].iter().any(|r| matches!(r, Ok(n) if *n > 0)),
            (None, Some(Ok(_))) => return false,
            (Some(Err(_)), None) => return false,
            (None, Some(Err(_))) => return true,
            _ => {}
        }
    }
    false
}

/// Launcher games a plugin can go into (one per Openplanet folder): Trackmania, ManiaPlanet 4, Turbo.
pub fn games_of(p: &OpPlugin) -> Vec<&'static str> {
    let mut out = vec![];
    for g in &p.games {
        let l = g.to_lowercase();
        let id = if l == "trackmania" {
            "tm2020"
        } else if l.contains("turbo") {
            "tm-turbo"
        } else if l.starts_with("maniaplanet") {
            "tm2-stadium"
        } else {
            continue;
        };
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Where the Openplanet user folders live: the user profile (C:/Users/<name>/OpenplanetNext, per
/// openplanet.dev/docs/tutorials/installing-plugins), not Documents. `TMHUB_OPENPLANET_HOME`
/// points it at a sandbox for tests.
pub fn user_root() -> PathBuf {
    std::env::var_os("TMHUB_OPENPLANET_HOME").map(PathBuf::from).or_else(dirs::home_dir).unwrap_or_default()
}

/// The Openplanet user folder per game (in the user profile).
pub fn folder_name(game: &str) -> Option<&'static str> {
    match game {
        "tm2020" => Some("OpenplanetNext"),
        "tm-turbo" => Some("OpenplanetTurbo"),
        g if g.starts_with("tm2-") || g == "sm-storm" => Some("Openplanet4"),
        _ => None,
    }
}

/// How the API names the game.
pub fn api_game(game: &str) -> Option<&'static str> {
    match game {
        "tm2020" => Some("Trackmania"),
        "tm-turbo" => Some("Trackmania Turbo"),
        g if g.starts_with("tm2-") || g == "sm-storm" => Some("Maniaplanet 4"),
        _ => None,
    }
}

pub fn plugin_dir(docs: &Path, game: &str) -> Option<PathBuf> {
    Some(docs.join(folder_name(game)?).join("Plugins"))
}

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn n(v: &Value, k: &str) -> u64 {
    v[k].as_u64().or_else(|| v[k].as_str().and_then(|x| x.parse().ok())).unwrap_or(0)
}

/// One API page's items. Unknown or broken entries are skipped.
pub fn parse_page(v: &Value) -> Vec<OpPlugin> {
    let Some(items) = v["items"].as_array() else { return vec![] };
    items
        .iter()
        .filter(|x| !x["broken"].as_bool().unwrap_or(false))
        .filter_map(|x| {
            let id = n(x, "id");
            let identifier = s(x, "identifier");
            if id == 0 || identifier.is_empty() {
                return None;
            }
            let img = s(x, "image");
            let download = x["links"]["download"].as_str().filter(|u| u.starts_with("https://cdn.openplanet.dev/")).map(String::from);
            Some(OpPlugin {
                id,
                identifier,
                name: s(x, "name"),
                authors: x["authors"].as_array().map(|a| a.iter().map(|p| s(p, "displayname")).filter(|d| !d.is_empty()).collect()).unwrap_or_default(),
                short: s(x, "shortdescription"),
                image: (!img.is_empty()).then(|| format!("https://openplanet.dev/{}", img.trim_start_matches('/'))),
                games: x["games"].as_array().map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect()).unwrap_or_default(),
                downloads: n(x, "downloads"),
                version: s(x, "version"),
                signed: x["signed"].as_bool().unwrap_or(false),
                sign_type: s(x, "signtype"),
                download,
                page: format!("https://openplanet.dev/{}", s(x, "url").trim_start_matches('/')),
                updated: n(x, "updatetime"),
            })
        })
        .collect()
}

/// Every plugin, read page by page. Cached in `cache` for a day; the cache is used when offline.
pub fn catalog(cache: &Path, force: bool) -> Result<Vec<OpPlugin>, String> {
    let file = cache.join("openplanet-plugins.json");
    let fresh = std::fs::metadata(&file).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|e| e.as_secs() < 86_400).unwrap_or(false);
    let cached = || std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Vec<OpPlugin>>(&b).ok());
    if fresh && !force {
        if let Some(c) = cached() {
            return Ok(c);
        }
    }
    let mut all = Vec::new();
    let mut page = 1;
    loop {
        let v = match net::get_json(&format!("{API}?page={page}")) {
            Ok(v) => v,
            Err(e) => return cached().ok_or(e),
        };
        all.extend(parse_page(&v));
        let pages = n(&v, "pages").max(1);
        page += 1;
        if page > pages || page > 200 {
            break;
        }
    }
    let _ = std::fs::create_dir_all(cache);
    let _ = fsx::write(&file, &serde_json::to_vec(&all).unwrap_or_default());
    Ok(all)
}

/// Plugins in a Plugins folder: .op files and plugin folders.
pub fn installed(dir: &Path) -> Vec<OpInstalled> {
    let mut out: Vec<OpInstalled> = fsx::list(dir)
        .into_iter()
        .filter(|e| e.is_dir || e.name.to_lowercase().ends_with(".op"))
        .map(|e| OpInstalled {
            identifier: e.name.trim_end_matches(".op").trim_end_matches(".OP").to_string(),
            version: if e.is_dir { None } else { fsx::read_bytes_prefix(&e.path, MAX_PLUGIN as usize).and_then(|b| op_version(&b)) },
            file: e.name,
            is_dir: e.is_dir,
        })
        .collect();
    out.sort_by_key(|p| p.file.to_lowercase());
    out
}

/// Saves the plugin's .op into the game's Plugins folder. Refused when Openplanet's folder for that
/// game does not exist (Openplanet not installed) or the download is not on cdn.openplanet.dev.
pub fn install(docs: &Path, game: &str, p: &OpPlugin) -> Result<PathBuf, String> {
    install_with(docs, game, p, &|u, max| net::get_bytes(u, max))
}

/// `install` with the download done by `get` (the network in the app, a fake in tests). The file is
/// written next to the old one and renamed over it (an update never leaves half a plugin).
pub fn install_with(docs: &Path, game: &str, p: &OpPlugin, get: &dyn Fn(&str, u64) -> Result<Vec<u8>, String>) -> Result<PathBuf, String> {
    let dir = plugin_dir(docs, game).ok_or("No Openplanet for this game")?;
    let root = dir.parent().ok_or("No Openplanet folder")?;
    if !fsx::is_dir(root) {
        return Err(format!("Openplanet not found ({})", root.display()));
    }
    if let Some(g) = api_game(game) {
        if !p.games.is_empty() && !p.games.iter().any(|x| x == g) {
            return Err(format!("{} is not made for {g}", p.name));
        }
    }
    let url = p.download.as_deref().ok_or("No download for this plugin")?;
    let name = crate::maps::sanitize(url.rsplit('/').next().unwrap_or(""));
    if !name.to_lowercase().ends_with(".op") {
        return Err("Not an .op file".into());
    }
    if fsx::blocked(&dir) {
        return Err("Refusing to write there".into());
    }
    if !url.starts_with("https://cdn.openplanet.dev/") {
        return Err("Plugins come only from cdn.openplanet.dev".into());
    }
    let bytes = get(url, MAX_PLUGIN)?;
    if !bytes.starts_with(b"PK") {
        return Err("The download is not an Openplanet plugin".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // The same plugin under the name openplanet.dev gives it: an older copy with another file name goes.
    let dest = dir.join(&name);
    fsx::write(&dest, &bytes)?;
    let want = format!("{}.op", p.identifier).to_lowercase();
    if name.to_lowercase() != want {
        let old = dir.join(format!("{}.op", p.identifier));
        if old.is_file() && fsx::norm(&old) != fsx::norm(&dest) {
            let _ = std::fs::remove_file(old);
        }
    }
    Ok(dest)
}

/// Removes an installed plugin (`<identifier>.op` in the game's Plugins folder). Plugin folders are
/// never removed. Returns the removed file.
pub fn remove(docs: &Path, game: &str, identifier: &str) -> Result<PathBuf, String> {
    if identifier.is_empty() || identifier.len() > 100 || !identifier.chars().all(|c| c.is_ascii_alphanumeric() || "_-. ".contains(c)) || identifier.contains("..") {
        return Err("Not a plugin name".into());
    }
    let dir = plugin_dir(docs, game).ok_or("No Openplanet for this game")?;
    let f = installed(&dir).into_iter().find(|x| !x.is_dir && x.identifier.eq_ignore_ascii_case(identifier)).ok_or("This plugin is not installed as an .op file")?;
    let p = dir.join(&f.file);
    if fsx::blocked(&p) {
        return Err("Refusing to touch this file".into());
    }
    std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_api_items_and_folders() {
        let v: Value = serde_json::json!({ "items": [
            { "id": 934, "identifier": "MedalDistribution", "name": "Medal Distribution", "authors": [{ "displayname": "Tritium" }],
              "shortdescription": "Medals", "image": "imgu/x.jpg", "games": ["Trackmania"], "downloads": 174, "version": "0.1.2",
              "signed": true, "signtype": "regular", "links": { "download": "https://cdn.openplanet.dev/plugins/934/2749/MedalDistribution.op" },
              "url": "plugin/medaldistribution", "updatetime": 1789465066, "broken": false },
            { "id": 5, "identifier": "Evil", "links": { "download": "https://evil.example/x.op" } },
            { "id": 0, "identifier": "" }
        ], "pages": 1 });
        let p = parse_page(&v);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].image.as_deref(), Some("https://openplanet.dev/imgu/x.jpg"));
        assert_eq!(p[0].page, "https://openplanet.dev/plugin/medaldistribution");
        assert!(p[0].signed && p[0].download.is_some());
        assert_eq!(p[1].download, None, "downloads only from cdn.openplanet.dev");
        assert_eq!(folder_name("tm2020"), Some("OpenplanetNext"));
        assert_eq!(folder_name("tm2-canyon"), Some("Openplanet4"));
        assert_eq!(folder_name("tmnf"), None);

        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("Plugins");
        std::fs::create_dir_all(dir.join("MyDevPlugin")).unwrap();
        std::fs::write(dir.join("MedalDistribution.op"), "x").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        let i = installed(&dir);
        assert_eq!(i.len(), 2);
        assert_eq!(i[0].identifier, "MedalDistribution");
        // Not installed: no Openplanet folder, nothing written.
        assert!(install(t.path(), "tm2020", &p[0]).is_err());
        assert!(!t.path().join("OpenplanetNext").exists());
    }

    fn op_zip(version: &str) -> Vec<u8> {
        use std::io::Write;
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        z.start_file("info.toml", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(format!("[meta]\nname = \"Medal Distribution\"\nversion = \"{version}\"\n\n[script]\ndependencies = []\n").as_bytes()).unwrap();
        z.start_file("Main.as", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"void Main() {}").unwrap();
        z.finish().unwrap().into_inner()
    }

    fn plugin(version: &str) -> OpPlugin {
        OpPlugin { id: 934, identifier: "MedalDistribution".into(), name: "Medal Distribution".into(), games: vec!["Trackmania".into()], version: version.into(), download: Some("https://cdn.openplanet.dev/plugins/934/2749/MedalDistribution.op".into()), ..Default::default() }
    }

    #[test]
    fn install_update_and_remove_in_a_sandbox() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("OpenplanetNext")).unwrap();
        let calls = std::cell::Cell::new(0);
        let get = |u: &str, _max: u64| -> Result<Vec<u8>, String> {
            calls.set(calls.get() + 1);
            assert!(u.starts_with("https://cdn.openplanet.dev/"));
            Ok(op_zip(if calls.get() == 1 { "0.1.2" } else { "0.2.0" }))
        };
        let dest = install_with(t.path(), "tm2020", &plugin("0.1.2"), &get).unwrap();
        assert!(dest.ends_with("MedalDistribution.op"));
        let dir = t.path().join("OpenplanetNext").join("Plugins");
        let i = installed(&dir);
        assert_eq!(i[0].version.as_deref(), Some("0.1.2"));
        // openplanet.dev has 0.2.0: Update = install again.
        assert!(newer("0.2.0", i[0].version.as_deref().unwrap()));
        install_with(t.path(), "tm2020", &plugin("0.2.0"), &get).unwrap();
        assert_eq!(installed(&dir)[0].version.as_deref(), Some("0.2.0"));
        assert_eq!(installed(&dir).len(), 1);
        // Not for ManiaPlanet; not a zip; not from the CDN.
        assert!(install_with(t.path(), "tm2-stadium", &plugin("0.2.0"), &get).is_err());
        assert!(install_with(t.path(), "tm2020", &plugin("0.2.0"), &|_, _| Ok(b"<html>".to_vec())).is_err());
        let mut evil = plugin("1");
        evil.download = Some("https://evil.example/x.op".into());
        assert!(install_with(t.path(), "tm2020", &evil, &get).is_err());
        // Remove: only .op files, never folders or other names.
        std::fs::create_dir_all(dir.join("MyDev")).unwrap();
        assert!(remove(t.path(), "tm2020", "MyDev").is_err());
        assert!(remove(t.path(), "tm2020", "..\\x").is_err());
        remove(t.path(), "tm2020", "medaldistribution").unwrap();
        assert!(!dir.join("MedalDistribution.op").exists());
        assert!(dir.join("MyDev").is_dir());
    }

    #[test]
    fn versions_and_games() {
        assert!(newer("1.10.0", "1.9.5"));
        assert!(!newer("1.2", "1.2.0"));
        assert!(newer("1.2.1", "1.2"));
        assert!(!newer("0.1.2", "0.1.2"));
        assert!(newer("v2.0", "1.99"));
        assert_eq!(op_version(&op_zip("3.4.5")).as_deref(), Some("3.4.5"));
        assert_eq!(op_version(b"not a zip"), None);
        let mut p = plugin("1");
        p.games = vec!["Trackmania".into(), "Maniaplanet 4".into(), "Trackmania Turbo".into(), "Something".into()];
        assert_eq!(games_of(&p), vec!["tm2020", "tm2-stadium", "tm-turbo"]);
    }
}
