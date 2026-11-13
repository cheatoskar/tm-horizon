//! News page: the Exchange sites' own news posts (tmnf.exchange, tmuf.exchange, tm.mania.exchange,
//! trackmania.exchange). The sites' public API serves them at `/api/news` (the same call their
//! front page makes); no page parsing is needed. Plain https GETs, cached for an hour.

use crate::{fsx, net};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// (hub game id for the embedded browser, host)
pub const SITES: [(&str, &str); 4] = [
    ("tmnf", "tmnf.exchange"),
    ("tmuf", "tmuf.exchange"),
    ("tm2-stadium", "tm.mania.exchange"),
    ("tm2020", "trackmania.exchange"),
];

const FIELDS: &str = "NewsId,PostedAt,Title,Message,User.UserId,User.Name";
/// Only the ManiaPlanet and Trackmania sites know a `Link` field; tmnf/tmuf answer a request that
/// names it with an HTML error page (so their posts never showed up).
const FIELDS_LINK: &str = "NewsId,PostedAt,Title,Message,User.UserId,User.Name,Link";
// Enough to reach this month's event posts on busy sites (the News page shows the newest few).
const PER_SITE: usize = 20;
const MAX_AGE_S: u64 = 3600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewsPost {
    pub id: String,
    pub game: String,
    pub host: String,
    pub title: String,
    /// ISO 8601, UTC.
    pub date: String,
    pub author: Option<String>,
    pub teaser: String,
    pub image: Option<String>,
    pub link: String,
    /// The post's BBCode (shortened), rendered safely by the launcher for event previews.
    #[serde(default)]
    pub message: String,
    /// Looks like an event post (events of the month, MTC, cups, calendar projects, sign-ups).
    #[serde(default)]
    pub event: bool,
    /// The one unambiguous date the post names (YYYY-MM-DD), if exactly one is found.
    #[serde(default)]
    pub event_date: Option<String>,
}

/// Event posts by title: "Events of the month", "MTC ...", "... Cup", "Calendar Project - SIGN UP",
/// tournaments and competitions, but not "Competition Patch" announcements.
pub fn is_event(title: &str) -> bool {
    let t = title.to_lowercase();
    if t.contains("competition patch") {
        return false;
    }
    let words: Vec<&str> = t.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let has = |w: &str| words.contains(&w);
    t.contains("events of the month")
        || t.contains("calendar project")
        || t.contains("sign up")
        || t.contains("signup")
        || t.contains("sign-up")
        || has("mtc")
        || has("cup")
        || has("tournament")
        || has("competition")
        || has("competitions")
        || has("event")
        || has("events")
}

const MONTHS: [&str; 12] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

fn month_of(w: &str) -> Option<u32> {
    let w = w.to_lowercase();
    MONTHS.iter().position(|m| *m == w || (w.len() == 3 && m.starts_with(&w)) || (w == "sept")).map(|i| if w == "sept" { 9 } else { i as u32 + 1 })
}

fn day_of(w: &str) -> Option<u32> {
    let w = w.to_lowercase();
    let digits: String = w.chars().take_while(|c| c.is_ascii_digit()).collect();
    let rest = &w[digits.len()..];
    if digits.is_empty() || digits.len() > 2 || !(rest.is_empty() || ["st", "nd", "rd", "th"].contains(&rest)) {
        return None;
    }
    digits.parse().ok().filter(|d| (1..=31).contains(d))
}

fn year_of(w: &str) -> Option<i32> {
    (w.len() == 4).then(|| w.parse().ok()).flatten().filter(|y| (2000..=2100).contains(y))
}

fn valid(y: i32, m: u32, d: u32) -> bool {
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let max = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(m - 1) as usize];
    d >= 1 && d <= max
}

/// The single date a post names in an unambiguous form ("November 19th 2026", "19 November 2026",
/// "2026-11-19"); None when there is none or more than one (an event list), never from "11/12/2026".
pub fn event_date(text: &str) -> Option<String> {
    let plain = plain_text(text);
    let words: Vec<&str> = plain.split(|c: char| !(c.is_alphanumeric() || c == '-')).filter(|w| !w.is_empty()).collect();
    let mut found: Vec<String> = Vec::new();
    let mut push = |y: i32, m: u32, d: u32| {
        if valid(y, m, d) {
            let s = format!("{y:04}-{m:02}-{d:02}");
            if !found.contains(&s) {
                found.push(s);
            }
        }
    };
    for i in 0..words.len() {
        let w = words[i];
        // ISO 2026-11-19
        let parts: Vec<&str> = w.split('-').collect();
        if parts.len() == 3 && parts[0].len() == 4 && parts[1].len() == 2 && parts[2].len() == 2 {
            if let (Some(y), Ok(m), Ok(d)) = (year_of(parts[0]), parts[1].parse::<u32>(), parts[2].parse::<u32>()) {
                if (1..=12).contains(&m) {
                    push(y, m, d);
                }
            }
            continue;
        }
        let at = |k: usize| words.get(i + k).copied().map(|x| x.trim_matches('-'));
        // Month Day Year
        if let Some(m) = month_of(w) {
            if let (Some(d), Some(y)) = (at(1).and_then(day_of), at(2).and_then(year_of)) {
                push(y, m, d);
            }
        }
        // Day [of] Month Year
        if let Some(d) = day_of(w) {
            let k = if at(1).is_some_and(|x| x.eq_ignore_ascii_case("of")) { 2 } else { 1 };
            if let (Some(m), Some(y)) = (at(k).and_then(month_of), at(k + 1).and_then(year_of)) {
                push(y, m, d);
            }
        }
    }
    (found.len() == 1).then(|| found.remove(0))
}

/// BBCode cut to about `max` bytes at a char boundary (enough for a preview).
fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    s[..i].to_string()
}

#[derive(Serialize, Deserialize)]
struct Cache {
    fetched: u64,
    posts: Vec<NewsPost>,
}

fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Text of a post without BBCode: links keep their text, images and user tags vanish.
pub fn plain_text(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut skip_depth: Option<&str> = None;
    let mut rest = msg;
    while let Some(i) = rest.find('[') {
        if skip_depth.is_none() {
            out.push_str(&rest[..i]);
        }
        let after = &rest[i + 1..];
        match after.find(']') {
            // A real tag: letters, optional "/" in front, optional "=value".
            Some(j) if j < 300 && after[..j].trim_start_matches('/').chars().next().map_or(false, |c| c.is_ascii_alphabetic()) => {
                let tag = after[..j].trim_start_matches('/');
                let name = tag.split('=').next().unwrap_or("").to_ascii_lowercase();
                let closing = after.starts_with('/');
                match (skip_depth, closing, name.as_str()) {
                    (None, false, "img" | "user" | "youtube" | "video" | "hr") => {
                        if name != "hr" {
                            skip_depth = Some(match name.as_str() { "img" => "img", "user" => "user", "youtube" => "youtube", _ => "video" });
                        }
                    }
                    (Some(s), true, n) if s == n => skip_depth = None,
                    _ => {}
                }
                rest = &after[j + 1..];
            }
            _ => {
                if skip_depth.is_none() {
                    out.push('[');
                }
                rest = after;
            }
        }
    }
    if skip_depth.is_none() {
        out.push_str(rest);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    let cut = match cut.rfind(' ') {
        Some(i) if i > max / 2 => cut[..i].to_string(),
        _ => cut,
    };
    format!("{}...", cut.trim_end_matches(|c: char| c.is_ascii_punctuation() || c == ' '))
}

/// First https picture in a post: `[img]url[/img]` or `[img=url]`.
pub fn first_image(msg: &str) -> Option<String> {
    let lower = msg.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("[img") {
        let s = from + i + 4;
        from = s;
        let rest = &msg[s..];
        let url = if let Some(r) = rest.strip_prefix('=') {
            r.split(']').next()
        } else if let Some(r) = rest.strip_prefix(']') {
            r.split("[/").next()
        } else {
            // "[img width=..]url[/img]"
            rest.split_once(']').and_then(|(_, r)| r.split("[/").next())
        };
        if let Some(u) = url.map(str::trim) {
            if u.to_ascii_lowercase().starts_with("https://") && !u.contains(char::is_whitespace) && u.len() < 600 {
                return Some(u.to_string());
            }
        }
    }
    None
}

fn iso_utc(s: &str) -> String {
    if s.ends_with('Z') || s.contains('+') || s.get(10..).unwrap_or("").contains('-') {
        s.to_string()
    } else {
        format!("{s}Z")
    }
}

/// Posts out of one site's `/api/news` answer.
pub fn parse(game: &str, host: &str, v: &serde_json::Value) -> Vec<NewsPost> {
    let Some(list) = v.get("Results").and_then(|r| r.as_array()) else { return Vec::new() };
    list.iter()
        .filter_map(|p| {
            let id = p.get("NewsId")?.as_i64()?;
            let title = p.get("Title")?.as_str()?.trim().to_string();
            let date = iso_utc(p.get("PostedAt")?.as_str()?);
            if title.is_empty() {
                return None;
            }
            let msg = p.get("Message").and_then(|m| m.as_str()).unwrap_or("");
            let link = p
                .get("Link")
                .and_then(|l| l.as_str())
                .map(str::trim)
                .filter(|l| l.to_ascii_lowercase().starts_with("https://"))
                .map(str::to_string)
                .unwrap_or_else(|| format!("https://{host}/newsshow"));
            let event = is_event(&title);
            let event_date = if event { event_date(&format!("{title}\n{msg}")) } else { None };
            Some(NewsPost {
                id: format!("{host}:{id}"),
                game: game.into(),
                host: host.into(),
                title,
                date,
                author: p.get("User").and_then(|u| u.get("Name")).and_then(|n| n.as_str()).map(str::to_string),
                teaser: truncate(&plain_text(msg), 240),
                image: first_image(msg),
                link,
                event,
                event_date,
                message: clip(msg, 6000),
            })
        })
        .collect()
}

/// All sites' posts, newest first. A site that does not answer is skipped; with none answering the
/// old cache (however old) is better than nothing.
pub fn fetch(cache_dir: &Path, force: bool) -> Result<Vec<NewsPost>, String> {
    // v2: posts carry message and event fields.
    let file = cache_dir.join("exchange-news-v2.json");
    let cached: Option<Cache> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(c) = &cached {
        if !force && now_s().saturating_sub(c.fetched) < MAX_AGE_S {
            return Ok(c.posts.clone());
        }
    }
    let mut all = Vec::new();
    let mut last_err = None;
    for (game, host) in SITES {
        let fields = if game == "tmnf" || game == "tmuf" { FIELDS } else { FIELDS_LINK };
        match net::get_json(&format!("https://{host}/api/news?count={PER_SITE}&fields={fields}")) {
            Ok(v) => all.extend(parse(game, host, &v)),
            Err(e) => last_err = Some(e),
        }
    }
    if all.is_empty() {
        return match (cached, last_err) {
            (Some(c), _) => Ok(c.posts),
            (None, Some(e)) => Err(e),
            (None, None) => Ok(Vec::new()),
        };
    }
    all.sort_by(|a, b| b.date.cmp(&a.date));
    let _ = std::fs::create_dir_all(cache_dir);
    let _ = fsx::write(&file, &serde_json::to_vec(&Cache { fetched: now_s(), posts: all.clone() }).unwrap_or_default());
    Ok(all)
}

/// Posts of two lists without duplicates (same id = same post; the first one wins), newest first.
pub fn merge_posts(a: Vec<NewsPost>, b: Vec<NewsPost>) -> Vec<NewsPost> {
    let mut seen = std::collections::HashSet::new();
    let mut all: Vec<NewsPost> = a.into_iter().chain(b).filter(|p| seen.insert(p.id.clone())).collect();
    all.sort_by(|x, y| y.date.cmp(&x.date));
    all
}

/// Oldest loaded NewsId per site ("host:123" ids), the cursor for the next page.
pub fn oldest_ids(posts: &[NewsPost]) -> std::collections::BTreeMap<String, i64> {
    let mut m = std::collections::BTreeMap::new();
    for p in posts {
        let Some((host, n)) = p.id.rsplit_once(':') else { continue };
        let Ok(n) = n.parse::<i64>() else { continue };
        m.entry(host.to_string()).and_modify(|x: &mut i64| *x = (*x).min(n)).or_insert(n);
    }
    m
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsMore {
    /// Everything loaded so far plus the older page, merged without duplicates, newest first.
    pub posts: Vec<NewsPost>,
    /// Per site: false when the site has no older posts (or did not answer this time).
    pub more: std::collections::BTreeMap<String, bool>,
}

/// "Load older": the next page of every site (the MX news API pages with `after=<oldest NewsId>` and
/// says `More`), skipping sites in `done`. Older pages are not cached (the hour cache keeps the newest).
pub fn fetch_older(current: Vec<NewsPost>, done: &[String], get: &dyn Fn(&str) -> Result<serde_json::Value, String>) -> NewsMore {
    let cursors = oldest_ids(&current);
    let mut older = Vec::new();
    let mut more = std::collections::BTreeMap::new();
    for (game, host) in SITES {
        if done.iter().any(|d| d == host) {
            more.insert(host.to_string(), false);
            continue;
        }
        let Some(after) = cursors.get(host) else { continue };
        let fields = if game == "tmnf" || game == "tmuf" { FIELDS } else { FIELDS_LINK };
        match get(&format!("https://{host}/api/news?count={PER_SITE}&fields={fields}&after={after}")) {
            Ok(v) => {
                let page = parse(game, host, &v);
                more.insert(host.to_string(), !page.is_empty() && v.get("More").and_then(|m| m.as_bool()).unwrap_or(false));
                older.extend(page);
            }
            // A site that fails now may answer next time: keep "more" so the button stays.
            Err(_) => {
                more.insert(host.to_string(), true);
            }
        }
    }
    NewsMore { posts: merge_posts(current, older), more }
}

#[tauri::command(async)]
pub async fn exchange_news_older(current: Vec<NewsPost>, done: Vec<String>) -> Result<NewsMore, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_older(current, &done, &|u| net::get_json(u))).await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn exchange_news(app: tauri::AppHandle, force: Option<bool>) -> Result<Vec<NewsPost>, String> {
    use tauri::Manager;
    let dir = app.state::<crate::state::AppState>().cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || fetch(&dir, force.unwrap_or(false))).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(id: &str, date: &str) -> NewsPost {
        NewsPost { id: id.into(), game: "tmnf".into(), host: id.split(':').next().unwrap().into(), title: id.into(), date: date.into(), author: None, teaser: String::new(), image: None, link: String::new(), message: String::new(), event: false, event_date: None }
    }

    #[test]
    fn merge_drops_duplicates_and_sorts_newest_first() {
        let a = vec![post("tmnf.exchange:30", "2026-11-04T10:00:00Z"), post("tmnf.exchange:20", "2026-10-01T10:00:00Z")];
        let b = vec![post("tmnf.exchange:20", "2026-10-01T10:00:00Z"), post("trackmania.exchange:7", "2026-10-15T10:00:00Z"), post("tmnf.exchange:10", "2026-09-01T10:00:00Z")];
        let m = merge_posts(a, b);
        assert_eq!(m.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["tmnf.exchange:30", "trackmania.exchange:7", "tmnf.exchange:20", "tmnf.exchange:10"]);
        let o = oldest_ids(&m);
        assert_eq!(o["tmnf.exchange"], 10);
        assert_eq!(o["trackmania.exchange"], 7);
    }

    #[test]
    fn older_page_uses_the_cursor_and_the_more_flag() {
        let current = vec![post("tmnf.exchange:300", "2026-11-04T10:00:00Z"), post("tmnf.exchange:200", "2026-10-04T10:00:00Z"), post("tmuf.exchange:50", "2026-10-02T10:00:00Z")];
        let asked = std::cell::RefCell::new(Vec::new());
        let get = |u: &str| -> Result<serde_json::Value, String> {
            asked.borrow_mut().push(u.to_string());
            if u.starts_with("https://tmnf.exchange/") {
                // The page repeats the oldest known post: it must not show twice.
                Ok(serde_json::json!({ "More": true, "Results": [
                    { "NewsId": 200, "PostedAt": "2026-10-04T10:00:00", "Title": "Old" },
                    { "NewsId": 150, "PostedAt": "2026-09-01T10:00:00", "Title": "Older" } ] }))
            } else {
                Ok(serde_json::json!({ "More": false, "Results": [] }))
            }
        };
        let r = fetch_older(current, &["trackmania.exchange".to_string()], &get);
        let asked = asked.into_inner();
        assert!(asked.iter().any(|u| u.starts_with("https://tmnf.exchange/api/news?") && u.ends_with("&after=200")), "{asked:?}");
        assert!(asked.iter().any(|u| u.ends_with("&after=50")));
        assert!(!asked.iter().any(|u| u.contains("trackmania.exchange")), "done sites are not asked again");
        assert!(!asked.iter().any(|u| u.contains("tm.mania.exchange")), "a site with no posts yet has no cursor");
        assert_eq!(r.posts.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["tmnf.exchange:300", "tmnf.exchange:200", "tmuf.exchange:50", "tmnf.exchange:150"]);
        assert_eq!(r.more["tmnf.exchange"], true);
        assert_eq!(r.more["tmuf.exchange"], false);
        assert_eq!(r.more["trackmania.exchange"], false);
    }

    fn fixture(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn event_titles() {
        for t in ["Events of the month - November 2026", "Christmas Calendar Project 2026 - SIGN UP!", "MTC March 2026", "Regular TMNF Competitions Coming!", "Spring Cup 2026", "🏗️ MTC June 2025 - Overturned"] {
            assert!(is_event(t), "{t}");
        }
        for t in ["Important! Competition Patch 2.0 required from November 19th 2026", "New Screenshots Rule - Banning Generative AI", "TrackMania Exchange 2.1 Released", "3D Gbx Tools by BigBang1112"] {
            assert!(!is_event(t), "{t}");
        }
    }

    #[test]
    fn only_one_clear_date() {
        assert_eq!(event_date("Final on November 19th 2026 at 20:00").as_deref(), Some("2026-11-19"));
        assert_eq!(event_date("Starts 3 of December 2026").as_deref(), Some("2026-12-03"));
        assert_eq!(event_date("[b]Date:[/b] 2026-12-01").as_deref(), Some("2026-12-01"));
        assert_eq!(event_date("Events of the month - November 2026"), None, "no day");
        assert_eq!(event_date("Cup on 11/12/2026"), None, "day/month order unclear");
        assert_eq!(event_date("Round 1 November 7th 2026, round 2 November 14th 2026"), None, "a list is no single date");
        assert_eq!(event_date("February 30th 2026"), None);
    }

    #[test]
    fn parses_a_post_with_a_banner() {
        let v = fixture(include_str!("../tests/fixtures/news_tmuf.json"));
        let posts = parse("tmuf", "tmuf.exchange", &v);
        assert_eq!(posts.len(), 3);
        let p = &posts[0];
        assert_eq!(p.id, "tmuf.exchange:7281626");
        assert_eq!(p.title, "Important! Competition Patch 2.0 required from November 19th 2026");
        assert_eq!(p.author.as_deref(), Some("rad"));
        assert_eq!(p.date, "2026-11-04T22:27:03.563Z");
        assert!(p.teaser.starts_with("An important update regarding the TrackMania Competition Patch:"));
        assert!(!p.teaser.contains('[') && !p.teaser.contains("url="));
        assert_eq!(p.image, None);
        assert_eq!(p.link, "https://tmuf.exchange/newsshow");
        let banner = posts.iter().find(|p| p.image.is_some()).expect("a post with [img]");
        assert!(banner.image.as_deref().unwrap().starts_with("https://"));
        assert!(!banner.teaser.contains("[img]") && !banner.teaser.contains("[user]"));
    }

    #[test]
    fn uses_the_posts_own_link() {
        let v = fixture(include_str!("../tests/fixtures/news_tmx.json"));
        let posts = parse("tm2020", "trackmania.exchange", &v);
        assert_eq!(posts[0].link, "https://trackmania.exchange/threadshow/53712");
        assert_eq!(posts[0].image.as_deref(), Some("https://images.mania-exchange.com/banners/mtc-banner-by-keissla.jpg"));
        assert_eq!(posts[1].link, "https://trackmania.exchange/newsshow");
        assert_eq!(posts[0].author.as_deref(), Some("Arkive86"));
    }

    #[test]
    fn bbcode_and_images() {
        assert_eq!(plain_text("[b]Hi[/b] [url=https://x.y/z]there[/url]\r\n\r\nyou [user]12[/user]!"), "Hi there you !");
        assert_eq!(plain_text("a [ b ] c [i]d"), "a [ b ] c d");
        assert_eq!(first_image("x [img]http://a/b.png[/img] [img]https://a/b.png[/img]").as_deref(), Some("https://a/b.png"));
        assert_eq!(first_image("[img=https://a/c.jpg]").as_deref(), Some("https://a/c.jpg"));
        assert_eq!(first_image("none"), None);
        assert!(truncate(&"word ".repeat(100), 50).ends_with("..."));
    }

    #[test]
    fn bad_answers_give_nothing() {
        assert!(parse("tmnf", "tmnf.exchange", &fixture("{}")).is_empty());
        assert!(parse("tmnf", "tmnf.exchange", &fixture(r#"{"Results":[{"NewsId":1}]}"#)).is_empty());
    }
}
