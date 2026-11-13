//! TM Horizon's own news, pinned at the top of the News page: GitHub releases of cheatoskar/tm-horizon
//! that are marked as announcements (tag `news-...`, or `<!-- news -->` anywhere in the release text).
//! Plain https GET of GitHub's public releases API, no token; cached for six hours. Big launcher releases
//! link to such a post from their notes ("What's new" sheet).

use crate::news::NewsPost;
use crate::{fsx, net};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const RELEASES_URL: &str = "https://api.github.com/repos/cheatoskar/tm-horizon/releases?per_page=30";
pub const HOST: &str = "github.com/cheatoskar/tm-horizon";
const MAX_AGE_S: u64 = 6 * 3600;
const MARK: &str = "<!-- news -->";

/// A release is news when its tag starts with `news-` or its text carries the marker; drafts never are.
pub fn is_news(r: &serde_json::Value) -> bool {
    if r.get("draft").and_then(|v| v.as_bool()).unwrap_or(false) {
        return false;
    }
    let tag = r.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
    let body = r.get("body").and_then(|v| v.as_str()).unwrap_or("");
    tag.to_ascii_lowercase().starts_with("news-") || body.contains(MARK)
}

/// Markdown to a short plain teaser: no comments, images, links reduced to their text, no markup.
pub fn teaser(md: &str) -> String {
    let mut out = String::new();
    let mut rest = md;
    while let Some(a) = rest.find("<!--") {
        out.push_str(&rest[..a]);
        rest = rest[a..].find("-->").map(|e| &rest[a + e + 3..]).unwrap_or("");
    }
    out.push_str(rest);
    let mut s = String::new();
    let mut chars = out.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '!' if chars.peek() == Some(&'[') => {
                // image: drop it entirely
                for x in chars.by_ref() {
                    if x == ')' {
                        break;
                    }
                }
            }
            '[' => {
                let mut text = String::new();
                for x in chars.by_ref() {
                    if x == ']' {
                        break;
                    }
                    text.push(x);
                }
                if chars.peek() == Some(&'(') {
                    for x in chars.by_ref() {
                        if x == ')' {
                            break;
                        }
                    }
                }
                s.push_str(&text);
            }
            '#' | '*' | '_' | '`' | '>' => {}
            _ => s.push(c),
        }
    }
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 280 {
        format!("{}…", flat.chars().take(279).collect::<String>().trim_end())
    } else {
        flat
    }
}

/// First `![..](https://...)` picture of the release text.
pub fn first_image(md: &str) -> Option<String> {
    let at = md.find("![")?;
    let open = md[at..].find("](")? + at + 2;
    let close = md[open..].find(')')? + open;
    let url = md[open..close].split_whitespace().next()?;
    url.starts_with("https://").then(|| url.to_string())
}

pub fn parse(v: &serde_json::Value) -> Vec<NewsPost> {
    let mut out: Vec<NewsPost> = v
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter(|r| is_news(r))
        .filter_map(|r| {
            let s = |k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
            let body = s("body").unwrap_or_default();
            let link = s("html_url").filter(|u| u.starts_with("https://github.com/"))?;
            Some(NewsPost {
                id: format!("horizon-{}", r.get("id").and_then(|v| v.as_i64()).unwrap_or(0)),
                game: "horizon".into(),
                host: HOST.into(),
                title: s("name").filter(|n| !n.trim().is_empty()).or_else(|| s("tag_name"))?,
                date: s("published_at").or_else(|| s("created_at")).unwrap_or_default(),
                author: r.get("author").and_then(|a| a.get("login")).and_then(|v| v.as_str()).map(str::to_string),
                teaser: teaser(&body),
                image: first_image(&body),
                link,
                message: String::new(),
                event: false,
                event_date: None,
            })
        })
        .collect();
    out.sort_by(|a, b| b.date.cmp(&a.date));
    out
}

#[derive(Serialize, Deserialize)]
struct Cache {
    fetched: u64,
    posts: Vec<NewsPost>,
}

fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Announcements, newest first; the cache answers within six hours and whenever GitHub does not.
pub fn fetch(cache_dir: &Path, force: bool, get: &dyn Fn(&str) -> Result<serde_json::Value, String>) -> Result<Vec<NewsPost>, String> {
    let file = cache_dir.join("horizon-news.json");
    let cached: Option<Cache> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(c) = &cached {
        if !force && now_s().saturating_sub(c.fetched) < MAX_AGE_S {
            return Ok(c.posts.clone());
        }
    }
    match get(RELEASES_URL) {
        Ok(v) => {
            let posts = parse(&v);
            let _ = fsx::write(&file, &serde_json::to_vec(&Cache { fetched: now_s(), posts: posts.clone() }).unwrap_or_default());
            Ok(posts)
        }
        Err(e) => cached.map(|c| c.posts).ok_or(e),
    }
}

#[tauri::command]
pub async fn horizon_news(app: tauri::AppHandle, force: Option<bool>) -> Result<Vec<NewsPost>, String> {
    let dir = tauri::Manager::state::<crate::state::AppState>(&app).cache_dir.clone();
    crate::bg::run(move || fetch(&dir, force.unwrap_or(false), &net::get_json)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn releases() -> serde_json::Value {
        json!([
            { "id": 1, "tag_name": "v0.5.1", "name": "TM Horizon 0.5.1", "body": "- fixes", "html_url": "https://github.com/cheatoskar/tm-horizon/releases/tag/v0.5.1", "published_at": "2026-11-20T10:00:00Z", "draft": false },
            { "id": 2, "tag_name": "v0.6.0", "name": "TM Horizon 0.6", "body": "<!-- news -->\n## Big one\n![shot](https://example.com/a.png)\nRead [the post](https://x.y/z) **now**.", "html_url": "https://github.com/cheatoskar/tm-horizon/releases/tag/v0.6.0", "published_at": "2026-12-01T10:00:00Z", "author": { "login": "cheatoskar" } },
            { "id": 3, "tag_name": "news-discord", "name": "", "body": "We have a Discord.", "html_url": "https://github.com/cheatoskar/tm-horizon/releases/tag/news-discord", "published_at": "2026-11-25T10:00:00Z" },
            { "id": 4, "tag_name": "news-draft", "name": "Draft", "body": "x", "html_url": "https://github.com/cheatoskar/tm-horizon/releases/tag/news-draft", "draft": true },
            { "id": 5, "tag_name": "news-evil", "name": "Evil", "body": "x", "html_url": "https://evil.example/x" }
        ])
    }

    #[test]
    fn only_marked_releases_become_news() {
        let p = parse(&releases());
        assert_eq!(p.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["horizon-2", "horizon-3"]);
        assert_eq!(p[0].title, "TM Horizon 0.6");
        assert_eq!(p[0].image.as_deref(), Some("https://example.com/a.png"));
        assert_eq!(p[0].teaser, "Big one Read the post now.");
        assert_eq!(p[0].author.as_deref(), Some("cheatoskar"));
        assert_eq!(p[1].title, "news-discord", "no name: the tag");
        assert_eq!(p[0].game, "horizon");
    }

    #[test]
    fn cache_answers_offline_and_within_six_hours() {
        let t = tempfile::tempdir().unwrap();
        let calls = std::cell::Cell::new(0);
        let ok = |_: &str| -> Result<serde_json::Value, String> {
            calls.set(calls.get() + 1);
            Ok(releases())
        };
        assert_eq!(fetch(t.path(), false, &ok).unwrap().len(), 2);
        assert_eq!(fetch(t.path(), false, &ok).unwrap().len(), 2);
        assert_eq!(calls.get(), 1, "second call from the cache");
        let offline = |_: &str| -> Result<serde_json::Value, String> { Err("offline".into()) };
        assert_eq!(fetch(t.path(), true, &offline).unwrap().len(), 2, "old cache when GitHub does not answer");
        let t2 = tempfile::tempdir().unwrap();
        assert!(fetch(t2.path(), false, &offline).is_err());
    }
}
