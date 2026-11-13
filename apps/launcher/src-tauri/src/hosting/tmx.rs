//! TMX for the server's map list: what the player pastes (map id, map URL, map pack id/URL, a TMX
//! search URL, or plain words) becomes a preview list; "add" downloads the picked maps into the
//! server's own folder (`servers/<id>/maps/tmx-<id>.Gbx`, never a game folder), checks each file is
//! a map, and keeps the TMX id for later updates.
//!
//! Hosts per game: tmnf.exchange, tmuf.exchange, nations./sunrise./original.tm-exchange.com (TMX
//! API `/api/tracks`, `/api/trackpacks`) and tm.mania.exchange / trackmania.exchange (MX API
//! `/api/maps`, `/api/mappacks`). Facts: tm-modding-knowledge/tmx/api.md (fields are required,
//! `packid` is the only pack filter that works, paging with `after=<last id>`).
//!
//! Politeness: the launcher's user agent, one request at a time with at least 350 ms between
//! requests, and on 429/5xx up to three retries with a growing pause.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    Map(u64),
    Pack(u64),
    /// API filters taken over from a TMX search URL.
    Search(Vec<(String, String)>),
    Name(String),
}

/// MX-era site (maps) or TMX-era site (tracks).
pub fn is_mx(site: &str) -> bool {
    matches!(site, "tm.mania.exchange" | "trackmania.exchange" | "sm.mania.exchange")
}

/// Every exchange host we know (to tell "wrong exchange" from "not a TMX link").
const ALL_SITES: &[&str] = &["tmnf.exchange", "tmuf.exchange", "nations.tm-exchange.com", "sunrise.tm-exchange.com", "original.tm-exchange.com", "tm.mania.exchange", "trackmania.exchange", "sm.mania.exchange"];

/// Search filters a TMX/MX search page passes on that the API understands under the same name.
const FILTERS: &[&str] = &[
    "name", "author", "tag", "etag", "difficulty", "environment", "mood", "vehicle", "primarytype", "authortimemin", "authortimemax", "order1", "order2", "inhasrecord", "inunlimiter", "uploadedafter", "uploadedbefore", "routes", "lbtype", "inauthortimebeaten", "packid", "mappackid", "collection", "titlepack", "maptype", "intrackpack",
];

fn digits(s: &str) -> Option<u64> {
    let s = s.trim();
    (!s.is_empty() && s.len() <= 12 && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// What the input means for the exchange `site` of the server's game.
pub fn parse_input(site: &str, input: &str) -> Result<Source, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("host.err.tmxEmpty".into());
    }
    if let Some(id) = digits(s) {
        return Ok(Source::Map(id));
    }
    let low = s.to_ascii_lowercase();
    for p in ["pack:", "pack ", "p:", "mappack:", "trackpack:"] {
        if let Some(id) = low.strip_prefix(p).and_then(digits) {
            return Ok(Source::Pack(id));
        }
    }
    let looks_url = low.starts_with("http://") || low.starts_with("https://") || ALL_SITES.iter().any(|h| low.starts_with(h) || low.starts_with(&format!("www.{h}")));
    if !looks_url {
        return Ok(Source::Name(s.to_string()));
    }
    let full = if low.starts_with("http") { s.to_string() } else { format!("https://{s}") };
    let u = url::Url::parse(&full).map_err(|_| "host.err.tmxLink".to_string())?;
    let host = u.host_str().unwrap_or("").trim_start_matches("www.").to_ascii_lowercase();
    if host != site {
        return Err(if ALL_SITES.contains(&host.as_str()) { format!("host.err.tmxOtherSite:{host}") } else { "host.err.tmxLink".into() });
    }
    let segs: Vec<String> = u.path_segments().map(|x| x.filter(|p| !p.is_empty()).map(|p| p.to_ascii_lowercase()).collect()).unwrap_or_default();
    let seg = |i: usize| segs.get(i).map(String::as_str).unwrap_or("");
    let id_at = |i: usize| segs.get(i).and_then(|x| digits(x));
    let q: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.to_ascii_lowercase(), v.into_owned())).collect();
    let qv = |k: &str| q.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
    // old links: main.aspx?action=trackshow&id=1 / action=trackpackshow
    if let (Some(a), Some(id)) = (qv("action"), qv("id").and_then(|x| digits(&x))) {
        match a.to_ascii_lowercase().as_str() {
            "trackshow" | "trackgbx" => return Ok(Source::Map(id)),
            "trackpackshow" => return Ok(Source::Pack(id)),
            _ => {}
        }
    }
    match (seg(0), seg(1)) {
        ("trackshow" | "trackgbx" | "mapshow" | "mapgbx" | "maps", _) if id_at(1).is_some() => return Ok(Source::Map(id_at(1).unwrap())),
        ("s", "tr" | "m") if id_at(2).is_some() => return Ok(Source::Map(id_at(2).unwrap())),
        ("trackpackshow" | "mappackshow" | "trackpack" | "mappack", _) if id_at(1).is_some() => return Ok(Source::Pack(id_at(1).unwrap())),
        ("mappack", "view") | ("trackpack", "view") if id_at(2).is_some() => return Ok(Source::Pack(id_at(2).unwrap())),
        ("s", "p" | "mp") if id_at(2).is_some() => return Ok(Source::Pack(id_at(2).unwrap())),
        _ => {}
    }
    if seg(0).ends_with("search") || seg(0) == "tracks" || seg(0) == "maps" {
        let mut f: Vec<(String, String)> = vec![];
        for (k, v) in &q {
            let k = match k.as_str() {
                "trackname" | "mapname" | "query" | "q" => "name",
                "anyauthor" | "authorname" | "username" => "author",
                "tags" => "tag",
                "excludetags" => "etag",
                other => other,
            };
            if FILTERS.contains(&k) && !v.trim().is_empty() && v.len() <= 200 && !f.iter().any(|(a, _)| a == k) {
                f.push((k.to_string(), v.clone()));
            }
        }
        if f.is_empty() {
            return Err("host.err.tmxSearchEmpty".into());
        }
        // the API knows the pack filter under one name per family
        for (k, _) in f.iter_mut() {
            if k == "intrackpack" || (k == "mappackid" && !is_mx(site)) {
                *k = "packid".into();
            }
            if k == "packid" && is_mx(site) {
                *k = "mappackid".into();
            }
        }
        return Ok(Source::Search(f));
    }
    Err("host.err.tmxLink".into())
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: u64,
    pub name: String,
    pub author: String,
    pub author_time: Option<u32>,
    pub environment: String,
    /// TMX picture of the map (shown through the launcher's picture cache).
    pub thumb: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// "map" | "pack" | "search" | "name"
    pub kind: String,
    /// Pack name, when a pack was pasted.
    pub title: Option<String>,
    pub owner: Option<String>,
    pub hits: Vec<Hit>,
    /// TMX has more results than we list.
    pub more: bool,
}

const FIELDS_TMX: &str = "TrackId,TrackName,Uploader.Name,Authors,AuthorTime,Environment,HasThumbnail";
const FIELDS_MX: &str = "MapId,Name,Uploader.Name,Medals.Author,Environment,HasThumbnail";
/// Most maps one paste lists (5 pages of 100).
pub const MAX_LIST: usize = 500;

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// API list URL for `filters` (already API names), page after `after`.
pub fn list_url(site: &str, filters: &[(String, String)], count: usize, after: Option<u64>) -> String {
    let (path, fields) = if is_mx(site) { ("maps", FIELDS_MX) } else { ("tracks", FIELDS_TMX) };
    let mut q = format!("fields={}&count={count}", enc(fields));
    for (k, v) in filters {
        q.push_str(&format!("&{k}={}", enc(v)));
    }
    if let Some(a) = after {
        q.push_str(&format!("&after={a}"));
    }
    format!("https://{site}/api/{path}?{q}")
}

pub fn pack_url(site: &str, id: u64) -> String {
    if is_mx(site) {
        format!("https://{site}/api/mappacks?id={id}&fields=MappackId%2CName%2COwner.Name")
    } else {
        format!("https://{site}/api/trackpacks?id={id}&fields=PackId%2CPackName%2CCreator.Name")
    }
}

pub fn thumb_url(site: &str, id: u64) -> String {
    if is_mx(site) {
        format!("https://{site}/mapthumb/{id}")
    } else {
        format!("https://{site}/trackshow/{id}/thumbnail")
    }
}

/// TMX `Environment` is 1-based (1 Snow .. 7 Stadium); MX numbers are not mapped (left empty).
fn env_name(site: &str, n: i64) -> String {
    if site == "trackmania.exchange" {
        return "Stadium".into();
    }
    if is_mx(site) {
        return String::new();
    }
    ["", "Snow", "Desert", "Rally", "Island", "Coast", "Bay", "Stadium"].get(n as usize).copied().unwrap_or("").to_string()
}

pub fn parse_hits(site: &str, v: &serde_json::Value) -> Vec<Hit> {
    v["Results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let id = r["TrackId"].as_u64().or_else(|| r["MapId"].as_u64())?;
            let author = r["Authors"][0]["User"]["Name"].as_str().or_else(|| r["Uploader"]["Name"].as_str()).unwrap_or("").to_string();
            let at = r["AuthorTime"].as_i64().or_else(|| r["Medals"]["Author"].as_i64()).filter(|t| *t > 0).map(|t| t as u32);
            let thumb = (r["HasThumbnail"].as_bool() != Some(false)).then(|| thumb_url(site, id));
            Some(Hit {
                id,
                name: r["TrackName"].as_str().or_else(|| r["Name"].as_str()).unwrap_or("").to_string(),
                author,
                author_time: at,
                environment: env_name(site, r["Environment"].as_i64().unwrap_or(0)),
                thumb,
            })
        })
        .collect()
}

// ------------------------------------------------------------------ fetching (rate limited)

fn gate() -> &'static Mutex<Option<Instant>> {
    static G: std::sync::OnceLock<Mutex<Option<Instant>>> = std::sync::OnceLock::new();
    G.get_or_init(|| Mutex::new(None))
}

const GAP: Duration = Duration::from_millis(350);

/// One request at a time, a pause between requests, retries on "slow down" and server errors.
pub fn polite<T>(mut f: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut g = gate().lock().unwrap();
    let mut wait = Duration::from_secs(2);
    for attempt in 0..4 {
        if let Some(t) = *g {
            let since = t.elapsed();
            if since < GAP {
                std::thread::sleep(GAP - since);
            }
        }
        let r = f();
        *g = Some(Instant::now());
        match r {
            Err(e) if attempt < 3 && retryable(&e) => {
                std::thread::sleep(wait);
                wait *= 2;
            }
            r => return r,
        }
    }
    Err("host.err.tmxBusy".into())
}

fn retryable(e: &str) -> bool {
    ["status code 429", "status code 500", "status code 502", "status code 503", "status code 504", "timed out"].iter().any(|s| e.contains(s))
}

fn get_json(url: &str) -> Result<serde_json::Value, String> {
    polite(|| crate::net::get_json(url)).map_err(|e| if e.starts_with("host.err.") { e } else { format!("host.err.tmx:{e}") })
}

/// Preview for a pasted input (network). `fetch` is the JSON getter (tests pass a fake).
pub fn preview(site: &str, input: &str, fetch: &dyn Fn(&str) -> Result<serde_json::Value, String>) -> Result<Preview, String> {
    let src = parse_input(site, input)?;
    let list = |filters: Vec<(String, String)>, kind: &str| -> Result<Preview, String> {
        let mut out = Preview { kind: kind.into(), ..Default::default() };
        let mut after = None;
        while out.hits.len() < MAX_LIST {
            let v = fetch(&list_url(site, &filters, 100, after))?;
            let page = parse_hits(site, &v);
            let before = out.hits.len();
            for h in page {
                if !out.hits.iter().any(|x| x.id == h.id) {
                    out.hits.push(h);
                }
            }
            let more = v["More"].as_bool().unwrap_or(false);
            if !more || out.hits.len() == before {
                out.more = more && out.hits.len() >= MAX_LIST;
                break;
            }
            after = out.hits.last().map(|h| h.id);
            out.more = true;
        }
        out.hits.truncate(MAX_LIST);
        Ok(out)
    };
    match src {
        Source::Map(id) => {
            let v = fetch(&list_url(site, &[("id".into(), id.to_string())], 1, None))?;
            let hits = parse_hits(site, &v);
            if hits.is_empty() {
                return Err(format!("host.err.tmxNotFound:{id}"));
            }
            Ok(Preview { kind: "map".into(), hits, ..Default::default() })
        }
        Source::Pack(id) => {
            let p = fetch(&pack_url(site, id))?;
            let r = &p["Results"][0];
            if r.is_null() {
                return Err(format!("host.err.tmxPackNotFound:{id}"));
            }
            let key = if is_mx(site) { "mappackid" } else { "packid" };
            let mut out = list(vec![(key.into(), id.to_string())], "pack")?;
            out.title = r["PackName"].as_str().or_else(|| r["Name"].as_str()).map(String::from);
            out.owner = r["Creator"]["Name"].as_str().or_else(|| r["Owner"]["Name"].as_str()).map(String::from);
            Ok(out)
        }
        Source::Search(f) => list(f, "search"),
        Source::Name(n) => {
            let v = fetch(&list_url(site, &[("name".into(), n)], 50, None))?;
            Ok(Preview { kind: "name".into(), hits: parse_hits(site, &v), more: v["More"].as_bool().unwrap_or(false), ..Default::default() })
        }
    }
}

pub fn preview_live(site: &str, input: &str) -> Result<Preview, String> {
    preview(site, input, &get_json)
}

/// Download URL of a map.
pub fn gbx_url(site: &str, id: u64) -> String {
    super::engines::tmx_url(site, id)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub id: u64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failed {
    pub id: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub added: Vec<Added>,
    pub failed: Vec<Failed>,
}

/// Downloads `ids` into `<server dir>/maps/` (already there: kept), checks each file is a map.
/// `get` fetches bytes; `progress(done, total)`.
pub fn add(dir: &std::path::Path, site: &str, ids: &[u64], get: &dyn Fn(&str) -> Result<Vec<u8>, String>, progress: &dyn Fn(usize, usize)) -> AddResult {
    let mut out = AddResult::default();
    let maps = dir.join("maps");
    if let Err(e) = std::fs::create_dir_all(&maps) {
        out.failed = ids.iter().map(|id| Failed { id: *id, reason: e.to_string() }).collect();
        return out;
    }
    for (n, id) in ids.iter().enumerate() {
        progress(n, ids.len());
        let f = super::mapfiles::tmx_file(dir, *id);
        let r = (|| -> Result<String, String> {
            if let Ok(i) = super::mapfiles::check_map_bytes(&std::fs::read(&f).unwrap_or_default()) {
                return Ok(i.name.unwrap_or_default());
            }
            let b = get(&gbx_url(site, *id))?;
            let i = super::mapfiles::check_map_bytes(&b).map_err(|_| "host.err.tmxNotMap".to_string())?;
            let tmp = f.with_extension("part");
            std::fs::write(&tmp, &b).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &f).map_err(|e| e.to_string())?;
            Ok(i.name.unwrap_or_default())
        })();
        match r {
            Ok(name) => out.added.push(Added { id: *id, name: if name.trim().is_empty() { format!("TMX {id}") } else { name } }),
            Err(reason) => out.failed.push(Failed { id: *id, reason }),
        }
    }
    progress(ids.len(), ids.len());
    out
}

pub fn get_gbx(url: &str) -> Result<Vec<u8>, String> {
    polite(|| crate::net::get_bytes(url, 8 << 20))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const NF: &str = "tmnf.exchange";

    #[test]
    fn inputs() {
        assert_eq!(parse_input(NF, " 12345 "), Ok(Source::Map(12345)));
        assert_eq!(parse_input(NF, "https://tmnf.exchange/trackshow/13775293"), Ok(Source::Map(13775293)));
        assert_eq!(parse_input(NF, "tmnf.exchange/trackshow/77#comments"), Ok(Source::Map(77)));
        assert_eq!(parse_input(NF, "https://www.tmnf.exchange/trackpackshow/13775310"), Ok(Source::Pack(13775310)));
        assert_eq!(parse_input(NF, "pack:42"), Ok(Source::Pack(42)));
        assert_eq!(parse_input(NF, "Pack 42"), Ok(Source::Pack(42)));
        assert_eq!(parse_input(NF, "A01 race"), Ok(Source::Name("A01 race".into())));
        assert_eq!(parse_input("tm.mania.exchange", "https://tm.mania.exchange/mapshow/267572"), Ok(Source::Map(267572)));
        assert_eq!(parse_input("tm.mania.exchange", "https://tm.mania.exchange/mappackshow/2032"), Ok(Source::Pack(2032)));
        assert_eq!(parse_input("nations.tm-exchange.com", "https://nations.tm-exchange.com/main.aspx?action=trackshow&id=99"), Ok(Source::Map(99)));
        // another game's exchange is refused with its name
        assert_eq!(parse_input(NF, "https://tmuf.exchange/trackshow/1"), Err("host.err.tmxOtherSite:tmuf.exchange".into()));
        assert_eq!(parse_input(NF, "https://example.org/trackshow/1"), Err("host.err.tmxLink".into()));
        assert_eq!(parse_input(NF, ""), Err("host.err.tmxEmpty".into()));
        // search links: known filters only, website names mapped
        let s = parse_input(NF, "https://tmnf.exchange/tracksearch?trackname=speed&tag=5,7&difficulty=3&evil=1&order1=10").unwrap();
        assert_eq!(s, Source::Search(vec![("name".into(), "speed".into()), ("tag".into(), "5,7".into()), ("difficulty".into(), "3".into()), ("order1".into(), "10".into())]));
        assert_eq!(parse_input(NF, "https://tmnf.exchange/tracksearch"), Err("host.err.tmxSearchEmpty".into()));
        assert_eq!(parse_input("trackmania.exchange", "https://trackmania.exchange/mapsearch?intrackpack=5"), Ok(Source::Search(vec![("mappackid".into(), "5".into())])));
    }

    #[test]
    fn urls_and_hits() {
        let u = list_url(NF, &[("packid".into(), "7".into())], 100, Some(55));
        assert_eq!(u, "https://tmnf.exchange/api/tracks?fields=TrackId%2CTrackName%2CUploader.Name%2CAuthors%2CAuthorTime%2CEnvironment%2CHasThumbnail&count=100&packid=7&after=55");
        assert!(list_url("trackmania.exchange", &[], 1, None).starts_with("https://trackmania.exchange/api/maps?fields=MapId%2CName"));
        assert_eq!(pack_url("tm.mania.exchange", 3), "https://tm.mania.exchange/api/mappacks?id=3&fields=MappackId%2CName%2COwner.Name");
        let v = serde_json::json!({"Results":[
            {"TrackId":5,"TrackName":"$f00A","Uploader":{"Name":"up"},"Authors":[{"User":{"Name":"au"}}],"AuthorTime":55400,"Environment":7,"HasThumbnail":true},
            {"TrackId":6,"TrackName":"B","Uploader":{"Name":"up"},"AuthorTime":-1,"Environment":1,"HasThumbnail":false}]});
        let h = parse_hits(NF, &v);
        assert_eq!(h[0], Hit { id: 5, name: "$f00A".into(), author: "au".into(), author_time: Some(55400), environment: "Stadium".into(), thumb: Some("https://tmnf.exchange/trackshow/5/thumbnail".into()) });
        assert_eq!((h[1].author.as_str(), h[1].author_time, h[1].environment.as_str(), h[1].thumb.is_none()), ("up", None, "Snow", true));
        let m = parse_hits("tm.mania.exchange", &serde_json::json!({"Results":[{"MapId":9,"Name":"Dovre","Uploader":{"Name":"S"},"Medals":{"Author":18138},"Environment":1,"HasThumbnail":true}]}));
        assert_eq!((m[0].author_time, m[0].thumb.as_deref()), (Some(18138), Some("https://tm.mania.exchange/mapthumb/9")));
    }

    #[test]
    fn pack_preview_pages_until_done() {
        let calls = RefCell::new(vec![]);
        let fetch = |u: &str| -> Result<serde_json::Value, String> {
            calls.borrow_mut().push(u.to_string());
            Ok(if u.contains("/api/trackpacks") {
                serde_json::json!({"Results":[{"PackId":7,"PackName":"FSE 1","Creator":{"Name":"me"}}]})
            } else if u.contains("after=101") {
                serde_json::json!({"More":false,"Results":[{"TrackId":102,"TrackName":"c"}]})
            } else {
                serde_json::json!({"More":true,"Results":[{"TrackId":100,"TrackName":"a"},{"TrackId":101,"TrackName":"b"}]})
            })
        };
        let p = preview(NF, "https://tmnf.exchange/trackpackshow/7", &fetch).unwrap();
        assert_eq!((p.kind.as_str(), p.title.as_deref(), p.owner.as_deref()), ("pack", Some("FSE 1"), Some("me")));
        assert_eq!(p.hits.iter().map(|h| h.id).collect::<Vec<_>>(), vec![100, 101, 102]);
        assert!(!p.more);
        assert_eq!(calls.borrow().len(), 3);
        // a page that repeats itself ends the loop
        let same = |_: &str| -> Result<serde_json::Value, String> { Ok(serde_json::json!({"More":true,"Results":[{"TrackId":1,"TrackName":"a"}]})) };
        assert_eq!(preview(NF, "speed", &same).unwrap().hits.len(), 1);
        assert_eq!(preview(NF, "https://tmnf.exchange/tracksearch?name=x", &same).unwrap().hits.len(), 1);
        let none = |_: &str| -> Result<serde_json::Value, String> { Ok(serde_json::json!({"Results":[]})) };
        assert_eq!(preview(NF, "5", &none).unwrap_err(), "host.err.tmxNotFound:5");
        assert_eq!(preview(NF, "pack:5", &none).unwrap_err(), "host.err.tmxPackNotFound:5");
    }

    #[test]
    fn add_downloads_into_the_server_folder_and_checks() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("servers").join("s1");
        let got = RefCell::new(vec![]);
        let get = |u: &str| -> Result<Vec<u8>, String> {
            got.borrow_mut().push(u.to_string());
            if u.ends_with("/2") {
                Ok(super::super::mapfiles::tests::replay_bytes())
            } else if u.ends_with("/3") {
                Err("status code 404".into())
            } else {
                Ok(super::super::mapfiles::tests::map_bytes("$0f0Green", "me", 1000))
            }
        };
        let steps = RefCell::new(vec![]);
        let r = add(&dir, NF, &[1, 2, 3], &get, &|d, n| steps.borrow_mut().push((d, n)));
        assert_eq!(r.added, vec![Added { id: 1, name: "$0f0Green".into() }]);
        assert_eq!(r.failed.iter().map(|f| (f.id, f.reason.as_str())).collect::<Vec<_>>(), vec![(2, "host.err.tmxNotMap"), (3, "status code 404")]);
        assert!(dir.join("maps").join("tmx-1.Gbx").is_file());
        assert!(!dir.join("maps").join("tmx-2.Gbx").exists(), "a replay is never kept");
        assert_eq!(steps.borrow().last(), Some(&(3, 3)));
        // already there: no second download
        got.borrow_mut().clear();
        let r = add(&dir, NF, &[1], &get, &|_, _| {});
        assert_eq!(r.added.len(), 1);
        assert!(got.borrow().is_empty());
    }

    #[test]
    fn polite_retries_on_429() {
        let n = RefCell::new(0);
        let r = polite(|| {
            *n.borrow_mut() += 1;
            if *n.borrow() < 2 { Err("https://x: status code 429".to_string()) } else { Ok(7) }
        });
        assert_eq!(r, Ok(7));
        let r: Result<(), String> = polite(|| Err("status code 404".into()));
        assert_eq!(r, Err("status code 404".into()));
    }
}
