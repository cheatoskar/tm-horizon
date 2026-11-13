//! README and releases of a GitHub-hosted mod for its detail page. Both are cached for a day in
//! <cache>/repodoc/. Relative links in the Markdown are made absolute here (pictures to
//! raw.githubusercontent.com, other links to github.com/<o>/<r>/blob/HEAD/), so the frontend only
//! has to sanitize and render. Unauthenticated GitHub API calls: 60 per hour per IP.

use crate::{gallery::parse_repo, net};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Manager};

const DAY: u64 = 24 * 3600;
const MAX_NOTES: usize = 20_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Release {
    pub tag: String,
    pub name: String,
    pub date: String,
    pub prerelease: bool,
    pub url: String,
    pub notes: String,
    pub assets: Vec<Asset>,
}

fn encode_path(p: &str) -> String {
    p.replace(' ', "%20")
}

/// Absolute URL for a link target in a README. `image` targets go to the raw host, others to the
/// repository's file page. Absolute https links stay; anything else (http, javascript:, data:, mailto:,
/// anchors) is returned unchanged, because the frontend sanitizer drops what it does not allow.
pub fn resolve(link: &str, owner: &str, repo: &str, image: bool) -> String {
    let l = link.trim();
    let scheme = l.split(['/', '?', '#']).next().is_some_and(|f| f.contains(':'));
    if l.is_empty() || l.starts_with('#') || l.starts_with("//") || scheme {
        return l.to_string();
    }
    let p = l.trim_start_matches("./").trim_start_matches('/');
    let p = encode_path(p);
    if image {
        format!("https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{p}")
    } else {
        format!("https://github.com/{owner}/{repo}/blob/HEAD/{p}")
    }
}

/// Rewrites relative targets in `![a](t)`, `[a](t)`, `src="t"` and `href="t"`.
pub fn absolutize(md: &str, owner: &str, repo: &str) -> String {
    let mut out = String::with_capacity(md.len() + 256);
    let mut rest = md;
    while !rest.is_empty() {
        // Next candidate: "](" or src=/href= attribute.
        let lower = rest.to_ascii_lowercase();
        let cands = [("](", 0usize), ("src=", 1), ("href=", 2)];
        let mut best: Option<(usize, usize)> = None;
        for (pat, k) in cands {
            if let Some(i) = lower.find(pat) {
                if best.is_none_or(|(b, _)| i < b) {
                    best = Some((i, k));
                }
            }
        }
        let Some((i, k)) = best else {
            out.push_str(rest);
            break;
        };
        if k == 0 {
            let start = i + 2;
            // Is it an image? Look back for the matching "![" on the same line.
            let line_start = rest[..i].rfind('\n').map(|x| x + 1).unwrap_or(0);
            let open = rest[line_start..i].rfind('[').map(|x| line_start + x);
            let image = open.is_some_and(|o| o > 0 && rest.as_bytes()[o - 1] == b'!');
            let Some(end) = rest[start..].find(')') else {
                out.push_str(rest);
                break;
            };
            let inner = &rest[start..start + end];
            let (angled, body) = match inner.trim().strip_prefix('<') {
                Some(b) => (true, b.split('>').next().unwrap_or("")),
                None => (false, inner.trim().split_whitespace().next().unwrap_or("")),
            };
            let tail = &inner.trim()[if angled { body.len() + 2 } else { body.len() }..];
            out.push_str(&rest[..start]);
            out.push_str(&resolve(body, owner, repo, image));
            out.push_str(tail);
            out.push(')');
            rest = &rest[start + end + 1..];
        } else {
            let alen = if k == 1 { 4 } else { 5 };
            let start = i + alen;
            out.push_str(&rest[..start]);
            let after = &rest[start..];
            match after.chars().next() {
                Some(q @ ('"' | '\'')) => {
                    let body = &after[1..];
                    let Some(e) = body.find(q) else {
                        out.push_str(after);
                        break;
                    };
                    out.push(q);
                    out.push_str(&resolve(&body[..e], owner, repo, k == 1));
                    out.push(q);
                    rest = &body[e + 1..];
                }
                _ => rest = after,
            }
        }
    }
    out
}

fn cut(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut e = max;
    while !s.is_char_boundary(e) {
        e -= 1;
    }
    s[..e].to_string()
}

/// Release list from the GitHub API JSON (drafts left out).
pub fn parse_releases(v: &serde_json::Value, owner: &str, repo: &str) -> Vec<Release> {
    let Some(arr) = v.as_array() else { return Vec::new() };
    arr.iter()
        .filter(|r| r["draft"] != true)
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?.to_string();
            let assets = r["assets"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| {
                            Some(Asset { name: x["name"].as_str()?.to_string(), size: x["size"].as_u64().unwrap_or(0), url: x["browser_download_url"].as_str()?.to_string() })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Release {
                name: r["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(&tag).to_string(),
                date: r["published_at"].as_str().or(r["created_at"].as_str()).unwrap_or("").to_string(),
                prerelease: r["prerelease"] == true,
                url: r["html_url"].as_str().map(String::from).unwrap_or_else(|| format!("https://github.com/{owner}/{repo}/releases/tag/{tag}")),
                notes: absolutize(&cut(r["body"].as_str().unwrap_or(""), MAX_NOTES), owner, repo),
                assets,
                tag,
            })
        })
        .collect()
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Cached JSON value `{at, data}` younger than a day.
fn read_cache(file: &Path) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    (now().saturating_sub(v["at"].as_u64()?) < DAY).then(|| v["data"].clone())
}

fn write_cache(file: &Path, data: &serde_json::Value) {
    let _ = std::fs::create_dir_all(file.parent().unwrap_or(Path::new(".")));
    let _ = std::fs::write(file, serde_json::json!({ "at": now(), "data": data }).to_string());
}

pub fn readme_for(cache: &Path, repo_url: &str) -> Result<String, String> {
    let (o, r) = parse_repo(repo_url).ok_or("not a GitHub repository")?;
    let file = cache.join("repodoc").join(format!("{o}__{r}.readme.json").to_ascii_lowercase());
    if let Some(s) = read_cache(&file).and_then(|d| d.as_str().map(String::from)) {
        return Ok(s);
    }
    let b = net::get_bytes(&format!("https://raw.githubusercontent.com/{o}/{r}/HEAD/README.md"), 2 << 20)?;
    let text = absolutize(&String::from_utf8_lossy(&b), &o, &r);
    write_cache(&file, &serde_json::Value::String(text.clone()));
    Ok(text)
}

pub fn releases_for(cache: &Path, repo_url: &str) -> Result<Vec<Release>, String> {
    let (o, r) = parse_repo(repo_url).ok_or("not a GitHub repository")?;
    let file = cache.join("repodoc").join(format!("{o}__{r}.releases.json").to_ascii_lowercase());
    if let Some(list) = read_cache(&file).and_then(|d| serde_json::from_value::<Vec<Release>>(d).ok()) {
        return Ok(list);
    }
    let v = net::get_json(&format!("https://api.github.com/repos/{o}/{r}/releases?per_page=20"))?;
    let list = parse_releases(&v, &o, &r);
    write_cache(&file, &serde_json::to_value(&list).map_err(|e| e.to_string())?);
    Ok(list)
}

/// README text (Markdown, relative links made absolute) of a GitHub-hosted mod.
#[tauri::command(async)]
pub async fn mod_readme(app: AppHandle, repo_url: String) -> Result<String, String> {
    let cache = app.state::<crate::state::AppState>().cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || readme_for(&cache, &repo_url)).await.map_err(|e| e.to_string())?
}

/// The 20 newest GitHub releases of a mod's repository.
#[tauri::command(async)]
pub async fn mod_releases(app: AppHandle, repo_url: String) -> Result<Vec<Release>, String> {
    let cache = app.state::<crate::state::AppState>().cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || releases_for(&cache, &repo_url)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_links() {
        assert_eq!(resolve("docs/a b.png", "o", "r", true), "https://raw.githubusercontent.com/o/r/HEAD/docs/a%20b.png");
        assert_eq!(resolve("./LICENSE", "o", "r", false), "https://github.com/o/r/blob/HEAD/LICENSE");
        assert_eq!(resolve("/x/y.md", "o", "r", false), "https://github.com/o/r/blob/HEAD/x/y.md");
        assert_eq!(resolve("https://x.com/a", "o", "r", false), "https://x.com/a");
        assert_eq!(resolve("#top", "o", "r", false), "#top");
        assert_eq!(resolve("mailto:a@b.c", "o", "r", false), "mailto:a@b.c");
        assert_eq!(resolve("javascript:alert(1)", "o", "r", false), "javascript:alert(1)");
    }

    #[test]
    fn absolutizes_markdown_and_html() {
        let md = "![shot](docs/s.png \"t\") and [guide](docs/G.md) and [web](https://x.com)\n<img src=\"a.png\" width=3> <a href='b.md'>b</a>\nplain (text) ]( ";
        let out = absolutize(md, "o", "r");
        assert!(out.contains("![shot](https://raw.githubusercontent.com/o/r/HEAD/docs/s.png \"t\")"), "{out}");
        assert!(out.contains("[guide](https://github.com/o/r/blob/HEAD/docs/G.md)"), "{out}");
        assert!(out.contains("[web](https://x.com)"), "{out}");
        assert!(out.contains("src=\"https://raw.githubusercontent.com/o/r/HEAD/a.png\""), "{out}");
        assert!(out.contains("href='https://github.com/o/r/blob/HEAD/b.md'"), "{out}");
    }

    #[test]
    fn parses_releases() {
        let v = serde_json::json!([
            { "tag_name": "v1.2", "name": "", "published_at": "2026-01-02T03:04:05Z", "prerelease": false, "draft": false,
              "html_url": "https://github.com/o/r/releases/tag/v1.2", "body": "See [doc](docs/x.md)",
              "assets": [ { "name": "a.zip", "size": 1234, "browser_download_url": "https://github.com/o/r/releases/download/v1.2/a.zip" }, { "name": "bad" } ] },
            { "tag_name": "v1.3", "draft": true },
            { "name": "no tag" }
        ]);
        let l = parse_releases(&v, "o", "r");
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].tag, "v1.2");
        assert_eq!(l[0].name, "v1.2");
        assert_eq!(l[0].assets, vec![Asset { name: "a.zip".into(), size: 1234, url: "https://github.com/o/r/releases/download/v1.2/a.zip".into() }]);
        assert!(l[0].notes.contains("https://github.com/o/r/blob/HEAD/docs/x.md"));
        assert!(parse_releases(&serde_json::json!({}), "o", "r").is_empty());
    }
}
