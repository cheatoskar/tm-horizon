//! TMLoader repository indexes (`<server>/index.json`, api 1) from the servers in TMLoader's
//! config.yaml. Gives the UI the same shape as scanner/fetch-mods.mjs and keeps the raw
//! entries (download_link, hash_sha256) for installs.

use crate::{fsx, net};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Servers TM Horizon reads in addition to the ones in TMLoader's config.yaml (config.yaml is not
/// changed). Always Official (BigBang1112) is published on its own TMLoader server, per its README.
pub const EXTRA_SERVERS: [&str; 1] = ["https://bigbang1112.github.io/always-official/modloader/"];

/// config.yaml's servers (or the fallback list) plus `EXTRA_SERVERS`, without duplicates.
pub fn with_extra(mut servers: Vec<String>) -> Vec<String> {
    let key = |s: &str| s.trim_end_matches('/').to_ascii_lowercase();
    for x in EXTRA_SERVERS {
        if !servers.iter().any(|s| key(s) == key(x)) {
            servers.push(x.to_string());
        }
    }
    servers
}

pub const FALLBACK_SERVERS: [&str; 7] = [
    "https://modloader.tomashu.dev/modloader/TmForever/v1/",
    "https://tomashu.pages.dev/modloader/TmForever/v1/",
    "https://unlimiter.net/modloader/",
    "https://donadigo.com/modloader/",
    "https://fullspeed.mooo.com/modloader/",
    "https://cheatoskar.github.io/TM-Vibrant-Shaders/modloader/",
    "https://home.koyaanis.com/modloader/",
];

#[derive(Default, Clone)]
pub struct RawIndex {
    /// product id -> the index's product object (with "versions").
    pub products: BTreeMap<String, Value>,
    /// product id -> servers that list it (first = the one `products` was taken from).
    pub servers: BTreeMap<String, Vec<String>>,
}

impl RawIndex {
    /// Fills `servers` from the UI index (cached mod-index.json keeps it there).
    pub fn servers_from_index(&mut self, index: &Value) {
        if let Some(ps) = index.get("products").and_then(Value::as_object) {
            for (id, p) in ps {
                let list = p.get("servers").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default();
                self.servers.insert(id.clone(), list);
            }
        }
    }
}

pub fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        _ => a.cmp(b),
    }
}

/// Merges index documents (server, json) into the UI's ModIndex and the raw product map.
pub fn build(results: Vec<(String, Result<Value, String>)>) -> (Value, RawIndex) {
    let mut status = Vec::new();
    let mut products: BTreeMap<String, Value> = BTreeMap::new();
    let mut raw = RawIndex::default();
    for (server, r) in results {
        match r {
            Err(e) => status.push(json!({ "server": server, "ok": false, "error": e })),
            Ok(doc) => {
                let ps = doc.get("products").and_then(Value::as_object).cloned().unwrap_or_default();
                status.push(json!({ "server": server, "ok": true, "count": ps.len() }));
                for (id, p) in ps {
                    if let Some(existing) = products.get_mut(&id) {
                        // Mirror: same product on another server.
                        existing["servers"].as_array_mut().unwrap().push(json!(server));
                        raw.servers.entry(id.clone()).or_default().push(server.clone());
                        continue;
                    }
                    raw.servers.entry(id.clone()).or_default().push(server.clone());
                    let mut versions: Vec<Value> = p
                        .get("versions")
                        .and_then(Value::as_object)
                        .map(|vs| {
                            vs.iter()
                                .map(|(v, d)| {
                                    json!({
                                        "version": v,
                                        "executable": d.get("executable"),
                                        "dependencies": d.get("dependencies").cloned().unwrap_or(json!([])),
                                        "changelog": d.get("changelog"),
                                        "download": d.get("download_link"),
                                        "sha256": d.get("hash_sha256"),
                                        "size": null,
                                        "updated": null,
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    versions.sort_by(|a, b| cmp_version(b["version"].as_str().unwrap_or(""), a["version"].as_str().unwrap_or("")));
                    let g = |k: &str| p.get(k).cloned().unwrap_or(Value::Null);
                    products.insert(
                        id.clone(),
                        json!({
                            "id": id, "name": p.get("name").cloned().unwrap_or(json!(id)), "author": g("author"), "type": g("type"),
                            "description": g("description"), "homepage": g("homepage"), "icon_link": g("icon_link"), "icon": g("icon_link"),
                            "external": p.get("external").and_then(Value::as_bool).unwrap_or(false),
                            "servers": [server], "versions": versions,
                        }),
                    );
                    raw.products.insert(id, p);
                }
            }
        }
    }
    (json!({ "fetchedAt": fsx::now_iso(), "servers": status, "products": products }), raw)
}

/// GETs every server's index.json in parallel.
pub fn fetch(servers: &[String]) -> (Value, RawIndex) {
    let results = std::thread::scope(|s| {
        let handles: Vec<_> = servers
            .iter()
            .map(|srv| {
                let url = format!("{}/index.json", srv.trim_end_matches('/'));
                (srv.clone(), s.spawn(move || net::get_json(&url)))
            })
            .collect();
        handles.into_iter().map(|(srv, h)| (srv, h.join().unwrap_or_else(|_| Err("panic".into())))).collect::<Vec<_>>()
    });
    build(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_mirrors_and_sorts_versions() {
        let doc = json!({ "api": 1, "products": { "CoreMod": { "name": "CoreMod", "versions": {
            "1.0.2": { "executable": "CoreMod.dll", "hash_sha256": "aa", "download_link": "https://x/1.0.2.zip" },
            "1.0.12": { "executable": "CoreMod.dll", "hash_sha256": "bb", "download_link": "https://x/1.0.12.zip" } } } } });
        let (idx, raw) = build(vec![("https://a/".into(), Ok(doc.clone())), ("https://b/".into(), Ok(doc)), ("https://c/".into(), Err("timeout".into()))]);
        let p = &idx["products"]["CoreMod"];
        assert_eq!(p["servers"].as_array().unwrap().len(), 2);
        assert_eq!(p["versions"][0]["version"], "1.0.12");
        assert_eq!(p["versions"][0]["sha256"], "bb");
        assert_eq!(idx["servers"][2]["ok"], false);
        assert!(raw.products["CoreMod"]["versions"]["1.0.12"]["download_link"].is_string());
        assert_eq!(raw.servers["CoreMod"], vec!["https://a/".to_string(), "https://b/".to_string()]);
        let s = with_extra(vec!["https://a/".into(), "https://bigbang1112.github.io/always-official/modloader".into()]);
        assert_eq!(s.len(), 2, "no duplicate when config.yaml already lists it");
        assert_eq!(with_extra(vec![]).len(), 1);
        let mut back = RawIndex::default();
        back.servers_from_index(&idx);
        assert_eq!(back.servers["CoreMod"], raw.servers["CoreMod"]);
    }
}
