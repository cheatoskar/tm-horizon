//! "More projects" on the game pages: TrackMania projects on GitHub that the hub lists as link-only
//! entries (`GET <hub>/v1/github-projects?game=<id>`, apps/server routes/discover.ts). Shown as
//! name, short text and one link (GitHub or openplanet.dev) that opens in the browser; nothing is
//! installed and no picture of the project is loaded.
//!
//! - Openplanet plugins (and every openplanet.dev link) only on Trackmania (2020), ManiaPlanet and
//!   Turbo pages.
//! - Links: https on github.com or openplanet.dev only; other entries are left out.
//! - Cached per game in `<cache>/more-projects/<game>.json` for 12 hours; when the hub does not
//!   answer, the last list stays. A hub that asks for a login (401/403: the list is not public yet)
//!   gives an empty list, and the page shows no section.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_PAGES: u32 = 5;
const PAGE: u32 = 200;
const FRESH_SECS: u64 = 12 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub summary: Option<String>,
    pub link: String,
    pub repo: Option<String>,
    pub kind: Option<String>,
    pub stars: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cached {
    pub at: u64,
    pub items: Vec<Project>,
}

/// The hub's game id of a launcher game (None: the hub has no list for it).
pub fn hub_game(game: &str) -> Option<&'static str> {
    Some(match game {
        "tmnf" => "tmnf",
        "tmuf" => "tmuf",
        "tmn-eswc" => "eswc",
        "tm-original" => "tmo",
        "tm-sunrise" => "tms",
        "tm2020" => "tm2020",
        "tm-turbo" => "turbo",
        "tm2-stadium" => "tm2-stadium",
        "tm2-canyon" => "tm2-canyon",
        "tm2-valley" => "tm2-valley",
        "tm2-lagoon" => "tm2-lagoon",
        "sm-storm" => "sm-storm",
        _ => return None,
    })
}

/// Games whose pages show Openplanet plugins and openplanet.dev links.
pub fn openplanet_game(game: &str) -> bool {
    matches!(game, "tm2020" | "tm-turbo" | "maniaplanet" | "sm-storm") || game.starts_with("tm2-")
}

pub fn url(base: &str, hub_game: &str, page: u32) -> String {
    format!("{}/v1/github-projects?game={hub_game}&limit={PAGE}&page={page}", base.trim().trim_end_matches('/'))
}

fn link_ok(u: &str) -> bool {
    let Ok(p) = url::Url::parse(u) else { return false };
    p.scheme() == "https" && p.username().is_empty() && p.port().is_none() && matches!(p.host_str(), Some("github.com") | Some("openplanet.dev") | Some("www.openplanet.dev"))
}

fn short(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max {
        return s;
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out = out.trim_end().to_string();
    out.push('…');
    out
}

/// The entries of one answer page that fit the game.
pub fn parse_page(v: &Value, game: &str) -> Vec<Project> {
    let op_ok = openplanet_game(game);
    let mut out = vec![];
    for it in v.get("items").and_then(Value::as_array).into_iter().flatten() {
        let s = |k: &str| it.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty());
        let Some(link) = s("link").or_else(|| s("url")) else { continue };
        if !link_ok(link) {
            continue;
        }
        let kind = s("type").map(String::from);
        let openplanet = kind.as_deref() == Some("openplanet-plugin") || link.contains("openplanet.dev") || s("openplanetPage").is_some();
        if openplanet && !op_ok {
            continue;
        }
        let name = s("name").map(String::from).unwrap_or_else(|| link.rsplit('/').next().unwrap_or(link).to_string());
        let summary = s("summary").or_else(|| s("description")).map(|d| short(d, 140));
        out.push(Project { name: short(&name, 60), summary, link: link.to_string(), repo: s("repo").map(String::from), kind, stars: it.get("stars").and_then(Value::as_u64) });
    }
    out
}

/// Every page of the list (`get` answers a URL: the network in the app, a fake in tests).
/// Ok(None): the hub wants a login (the list is not public): no section.
pub fn fetch(base: &str, game: &str, get: &dyn Fn(&str) -> Result<Value, String>) -> Result<Option<Vec<Project>>, String> {
    let Some(hg) = hub_game(game) else { return Ok(Some(vec![])) };
    let mut out: Vec<Project> = vec![];
    for page in 1..=MAX_PAGES {
        let v = match get(&url(base, hg, page)) {
            Ok(v) => v,
            Err(e) if e.contains("401") || e.contains("403") => return Ok(None),
            Err(e) => return Err(e),
        };
        let items = parse_page(&v, game);
        let n = v.get("items").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
        for p in items {
            if !out.iter().any(|x| x.link == p.link) {
                out.push(p);
            }
        }
        let total = v.get("total").and_then(Value::as_u64).unwrap_or(0);
        if n < PAGE as usize || (page * PAGE) as u64 >= total {
            break;
        }
    }
    out.sort_by(|a, b| b.stars.unwrap_or(0).cmp(&a.stars.unwrap_or(0)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(Some(out))
}

fn cache_path(cache: &Path, game: &str) -> PathBuf {
    cache.join("more-projects").join(format!("{}.json", game.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_")))
}

/// From the cache while fresh, else from the hub (the old list when the hub does not answer).
pub fn load(cache: &Path, base: &str, game: &str, now: u64, get: &dyn Fn(&str) -> Result<Value, String>) -> Vec<Project> {
    let p = cache_path(cache, game);
    let old: Option<Cached> = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(c) = old.as_ref().filter(|c| now.saturating_sub(c.at) < FRESH_SECS) {
        return c.items.clone();
    }
    match fetch(base, game, get) {
        Ok(Some(items)) => {
            let _ = crate::fsx::write(&p, &serde_json::to_vec(&Cached { at: now, items: items.clone() }).unwrap_or_default());
            items
        }
        Ok(None) => {
            let _ = crate::fsx::write(&p, &serde_json::to_vec(&Cached { at: now, items: vec![] }).unwrap_or_default());
            vec![]
        }
        Err(_) => old.map(|c| c.items).unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn more_projects(app: tauri::AppHandle, game: String) -> Vec<Project> {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let base = crate::hubindex::PRODUCTION_HUB;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        load(&st.cache_dir, base, &game, now, &|u| crate::net::get_json(u))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/hub/github-projects.json");

    #[test]
    fn fixture_per_game() {
        let v: Value = serde_json::from_str(FIXTURE).unwrap();
        let tmnf = parse_page(&v, "tmnf");
        let names: Vec<&str> = tmnf.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"tmnf-replay-tools"), "{names:?}");
        assert!(!names.contains(&"Better Chat"), "Openplanet plugins only on Openplanet games");
        assert!(!names.iter().any(|n| n.contains("evil")), "only github.com / openplanet.dev links");
        let tm20 = parse_page(&v, "tm2020");
        let bc = tm20.iter().find(|p| p.name == "Better Chat").unwrap();
        assert_eq!(bc.link, "https://openplanet.dev/plugin/betterchat");
        assert!(tm20.iter().all(|p| p.summary.as_ref().is_none_or(|s| s.chars().count() <= 140)));
    }

    #[test]
    fn paging_login_and_cache() {
        let v: Value = serde_json::from_str(FIXTURE).unwrap();
        let calls = std::cell::RefCell::new(vec![]);
        let get = |u: &str| -> Result<Value, String> {
            calls.borrow_mut().push(u.to_string());
            Ok(v.clone())
        };
        let list = fetch("https://hub.example/", "tmnf", &get).unwrap().unwrap();
        assert_eq!(calls.borrow().len(), 1, "a short page is the last one");
        assert_eq!(calls.borrow()[0], "https://hub.example/v1/github-projects?game=tmnf&limit=200&page=1");
        assert!(list.len() >= 2);
        // Sorted by stars.
        assert!(list.windows(2).all(|w| w[0].stars.unwrap_or(0) >= w[1].stars.unwrap_or(0)));
        // Behind the site password: no section.
        assert_eq!(fetch("https://hub.example", "tmnf", &|u| Err(format!("{u}: status code 401"))).unwrap(), None);
        assert!(fetch("https://hub.example", "tmnf", &|_| Err("offline".into())).is_err());
        // Unknown game: nothing, no request.
        assert_eq!(fetch("https://hub.example", "tm-ds", &|_| panic!("no request")).unwrap(), Some(vec![]));
        // Cache: fresh list is used, a failing hub keeps the old one.
        let t = tempfile::tempdir().unwrap();
        let first = load(t.path(), "https://hub.example", "tmnf", 1000, &get);
        assert_eq!(first, list);
        let again = load(t.path(), "https://hub.example", "tmnf", 2000, &|_| panic!("cached"));
        assert_eq!(again, list);
        let stale = load(t.path(), "https://hub.example", "tmnf", 1000 + FRESH_SECS + 1, &|_| Err("offline".into()));
        assert_eq!(stale, list);
        let hidden = load(t.path(), "https://hub.example", "tmnf", 1000 + 2 * FRESH_SECS, &|_| Err("x: status code 403".into()));
        assert!(hidden.is_empty());
    }

    #[test]
    fn game_ids() {
        assert_eq!(hub_game("tmn-eswc"), Some("eswc"));
        assert_eq!(hub_game("tm-sunrise"), Some("tms"));
        assert!(openplanet_game("tm2-canyon") && openplanet_game("tm-turbo") && !openplanet_game("tmuf"));
    }
}
