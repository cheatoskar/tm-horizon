//! What TM Horizon installed outside TMLoader's own index (catalog mods, ESWC proxy-DLL mods), and
//! update checks for them.
//! - `installs.json` in the app data folder: one record per mod and game with source, version,
//!   asset, sha256, files, the backup of the install (= rollback) and the auto-update switch.
//! - GitHub checks use ETags (a 304 does not count against the 60/h limit) and a shared budget:
//!   when GitHub says fewer than 5 calls are left, the cached answer is used until the reset.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};

use crate::net;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub entry_id: String,
    pub game: String,
    /// "catalog" (installSpec) or "eswc" (ESWC proxy-DLL mod).
    pub kind: String,
    /// The catalog installSpec the mod was installed with (catalog kind).
    #[serde(default)]
    pub spec: Option<Value>,
    /// "github:owner/repo" or the download URL.
    pub source: String,
    pub version: String,
    #[serde(default)]
    pub asset: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub files: Vec<String>,
    pub root: String,
    pub installed_at: String,
    /// Backup made by this install; restoring it rolls the install back.
    #[serde(default)]
    pub backup_id: Option<String>,
    pub auto_update: bool,
}

fn manifest(data: &Path) -> PathBuf {
    data.join("installs.json")
}

pub fn list(data: &Path) -> Vec<InstallRecord> {
    std::fs::read_to_string(manifest(data)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(data: &Path, list: &[InstallRecord]) -> Result<(), String> {
    std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let tmp = manifest(data).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, manifest(data)).map_err(|e| e.to_string())
}

/// Adds or replaces the record of a mod in a game. The auto-update choice survives updates.
pub fn record(data: &Path, mut rec: InstallRecord) -> Result<(), String> {
    let mut l = list(data);
    if let Some(old) = l.iter().find(|r| r.entry_id == rec.entry_id && r.game == rec.game) {
        rec.auto_update = old.auto_update;
    }
    l.retain(|r| !(r.entry_id == rec.entry_id && r.game == rec.game));
    l.push(rec);
    save(data, &l)
}

pub fn forget(data: &Path, entry_id: &str, game: &str) -> Result<(), String> {
    let mut l = list(data);
    l.retain(|r| !(r.entry_id == entry_id && r.game == game));
    save(data, &l)
}

pub fn set_auto(data: &Path, entry_id: &str, game: &str, on: bool) -> Result<(), String> {
    let mut l = list(data);
    let r = l.iter_mut().find(|r| r.entry_id == entry_id && r.game == game).ok_or("not installed by TM Horizon")?;
    r.auto_update = on;
    save(data, &l)
}

/// Default for the auto-update switch: on for GitHub releases picked by an asset pattern, off for
/// everything else (plain file mods from a link).
pub fn default_auto(source: &str) -> bool {
    source.starts_with("github:")
}

pub fn norm_version(v: &str) -> String {
    v.trim().trim_start_matches(['v', 'V']).to_string()
}

/// true when `latest` is newer than `installed` (semver when both parse, else "different").
pub fn is_newer(latest: &str, installed: &str) -> bool {
    let (a, b) = (norm_version(latest), norm_version(installed));
    if a.is_empty() || a == "latest" || b == "latest" {
        return false;
    }
    match (semver::Version::parse(&pad(&a)), semver::Version::parse(&pad(&b))) {
        (Ok(x), Ok(y)) => x > y,
        _ => a != b,
    }
}

fn pad(v: &str) -> String {
    // "1.2-beta" -> "1.2.0-beta": semver needs three numbers before any suffix.
    let cut = v.find(['-', '+']).unwrap_or(v.len());
    let (core, rest) = v.split_at(cut);
    let mut parts: Vec<&str> = core.split('.').collect();
    while parts.len() < 3 {
        parts.push("0");
    }
    format!("{}{rest}", parts.join("."))
}

/// Calls left in GitHub's hourly budget (from the last answer; -1 = unknown).
static GH_LEFT: AtomicI64 = AtomicI64::new(-1);

/// Latest release tag of a repo, with ETag caching in `<cache>/gh/`.
pub fn latest_tag(cache: &Path, repo: &str) -> Result<String, String> {
    let file = cache.join("gh").join(format!("{}.json", repo.replace('/', "__").to_lowercase()));
    let cached: Option<Value> = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok());
    let left = GH_LEFT.load(Ordering::Relaxed);
    if (0..5).contains(&left) {
        return cached.and_then(|c| c["tag"].as_str().map(String::from)).ok_or_else(|| "GitHub limit reached; try later".into());
    }
    let etag = cached.as_ref().and_then(|c| c["etag"].as_str().map(String::from));
    let (status, body, new_etag, remaining) = net::get_json_etag(&format!("https://api.github.com/repos/{repo}/releases/latest"), etag.as_deref())?;
    if let Some(r) = remaining {
        GH_LEFT.store(r, Ordering::Relaxed);
    }
    if status == 304 {
        return cached.and_then(|c| c["tag"].as_str().map(String::from)).ok_or_else(|| "no cached tag".into());
    }
    let tag = body.as_ref().and_then(|b| b["tag_name"].as_str()).ok_or("no release")?.to_string();
    let _ = std::fs::create_dir_all(file.parent().unwrap());
    let _ = std::fs::write(&file, serde_json::json!({ "etag": new_etag, "tag": tag }).to_string());
    Ok(tag)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub entry_id: String,
    pub game: String,
    pub installed: String,
    pub latest: Option<String>,
    pub update: bool,
    pub auto_update: bool,
    pub error: Option<String>,
    /// "hub" when the latest version comes from the TM Horizon Hub index.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// The hub revoked the installed file (its sha256): the reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked: Option<String>,
}

/// What the (verified, cached) hub index says about one install: newest stable version and a
/// revocation of the installed file. Projects match by catalog id or "hub-<slug>".
pub fn hub_facts(payload: &Value, entry_id: &str, sha256: &str) -> (Option<String>, Option<String>) {
    let revoked = payload["revoked"].as_array().and_then(|l| {
        l.iter().find(|r| !sha256.is_empty() && r["sha256"].as_str().is_some_and(|s| s.eq_ignore_ascii_case(sha256)))
            .map(|r| r["reason"].as_str().unwrap_or("revoked").to_string())
    });
    let project = payload["projects"].as_array().and_then(|l| {
        l.iter().find(|p| p["catalogId"].as_str() == Some(entry_id) || p["slug"].as_str().map(|s| format!("hub-{s}")).as_deref() == Some(entry_id))
    });
    let latest = project.and_then(|p| {
        let slug = p["slug"].as_str().unwrap_or("");
        let gone = |v: &str| payload["revoked"].as_array().is_some_and(|l| l.iter().any(|r| r["project"].as_str() == Some(slug) && r["version"].as_str() == Some(v)));
        p["versions"].as_array()?.iter()
            .filter(|v| v["channel"].as_str() == Some("stable") && v["files"].as_array().is_some_and(|f| !f.is_empty()))
            .filter_map(|v| v["version"].as_str())
            .find(|v| !gone(v))
            .map(norm_version)
    });
    (latest, revoked)
}

/// Checks every recorded install that comes from a GitHub release.
/// `hub`: the verified hub index payload when the hub source is on. Hub projects are compared with
/// the hub's newest stable version (no GitHub call); everything else as before.
pub fn check(data: &Path, cache: &Path, hub: Option<&Value>) -> Vec<UpdateInfo> {
    list(data)
        .into_iter()
        .map(|r| {
            let (hub_latest, revoked) = hub.map(|p| hub_facts(p, &r.entry_id, &r.sha256)).unwrap_or((None, None));
            let (latest, error, via) = if let Some(l) = hub_latest {
                (Some(l), None, Some("hub".to_string()))
            } else {
                match r.source.strip_prefix("github:") {
                    Some(repo) => match latest_tag(cache, repo) {
                        Ok(t) => (Some(norm_version(&t)), None, None),
                        Err(e) => (None, Some(e), None),
                    },
                    None => (None, None, None),
                }
            };
            // A revoked install is never "updated" automatically to something else here; the UI offers removal.
            let update = revoked.is_none() && latest.as_deref().is_some_and(|l| is_newer(l, &r.version));
            UpdateInfo { entry_id: r.entry_id, game: r.game, installed: r.version, latest, update, auto_update: r.auto_update, error, via, revoked }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_versions_and_revocations() {
        let p = serde_json::json!({
            "projects": [
                { "slug": "clips", "catalogId": null, "versions": [
                    { "version": "2.0.0-beta", "channel": "beta", "files": [{}] },
                    { "version": "1.3.0", "channel": "stable", "files": [{}] },
                    { "version": "1.2.0", "channel": "stable", "files": [{}] } ] },
                { "slug": "snow", "catalogId": "mod-newsnowcar", "versions": [ { "version": "1.1", "channel": "stable", "files": [{}] } ] }
            ],
            "revoked": [ { "project": "clips", "version": "1.3.0", "sha256": "AB12", "reason": "malware" } ]
        });
        // 1.3.0 is revoked: the newest usable stable is 1.2.0; the beta is skipped.
        assert_eq!(hub_facts(&p, "hub-clips", "ff"), (Some("1.2.0".into()), None));
        assert_eq!(hub_facts(&p, "hub-clips", "ab12").1.as_deref(), Some("malware"));
        assert_eq!(hub_facts(&p, "mod-newsnowcar", "").0.as_deref(), Some("1.1"));
        assert_eq!(hub_facts(&p, "other", ""), (None, None));
    }

    #[test]
    fn versions() {
        assert!(is_newer("v1.4.3", "1.4.2"));
        assert!(!is_newer("1.4.2", "1.4.3"));
        assert!(is_newer("1.2", "1.1.9"));
        assert!(!is_newer("latest", "1.0"));
        assert!(is_newer("2.0.0-beta", "1.9"));
        assert!(!is_newer("v0.2.4", "0.2.4"));
    }

    #[test]
    fn records_keep_the_auto_choice() {
        let d = std::env::temp_dir().join(format!("tmh-upd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let rec = |v: &str| InstallRecord {
            entry_id: "x".into(), game: "tmnf".into(), kind: "catalog".into(), spec: None, source: "github:o/r".into(), version: v.into(),
            asset: "a.zip".into(), sha256: String::new(), files: vec![], root: "R".into(), installed_at: "t".into(), backup_id: None, auto_update: true,
        };
        record(&d, rec("1.0")).unwrap();
        set_auto(&d, "x", "tmnf", false).unwrap();
        record(&d, rec("1.1")).unwrap();
        let l = list(&d);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].version, "1.1");
        assert!(!l[0].auto_update, "the user's choice stays");
        forget(&d, "x", "tmnf").unwrap();
        assert!(list(&d).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
