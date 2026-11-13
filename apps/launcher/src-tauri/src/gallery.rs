//! Picture galleries for GitHub-hosted mods: screenshots from the repository's docs/images folder
//! (GitHub contents API) and images linked in its README. The result is cached for a day in
//! <cache>/gallery/. Unauthenticated GitHub API calls are limited to 60 per hour per IP; a cached
//! result (also an empty one) avoids repeating them.

use crate::net;
use std::path::Path;
use tauri::{AppHandle, Manager};

const MAX_IMAGES: usize = 24;
const DAY: u64 = 24 * 3600;
const EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// Badges and trackers in READMEs are not screenshots.
const SKIP_HOSTS: [&str; 6] = ["shields.io", "badge.fury.io", "badgen.net", "img.shields.io", "travis-ci.org", "codecov.io"];

/// (owner, repo) of a github.com URL.
pub fn parse_repo(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    let rest = u.strip_prefix("https://github.com/").or_else(|| u.strip_prefix("https://www.github.com/"))?;
    let mut it = rest.split(['/', '?', '#']);
    let o = it.next()?.trim();
    let r = it.next()?.trim().trim_end_matches(".git");
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if ok(o) && ok(r) {
        Some((o.to_string(), r.to_string()))
    } else {
        None
    }
}

fn image_ext(path: &str) -> bool {
    let p = path.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    p.rsplit_once('.').map(|(_, e)| EXTS.contains(&e)).unwrap_or(false)
}

fn encode_path(p: &str) -> String {
    p.replace(' ', "%20")
}

/// A link found in a README as a raw https image URL, or None when it is not a usable picture.
pub fn to_raw_url(link: &str, owner: &str, repo: &str) -> Option<String> {
    let l = link.trim().trim_matches(|c| c == '<' || c == '>');
    if l.is_empty() || l.starts_with("data:") || l.starts_with("http://") || l.starts_with("//") {
        return None;
    }
    let out = if l.starts_with("https://") {
        let rest = &l["https://".len()..];
        let host = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
        if SKIP_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))) {
            return None;
        }
        // github.com/<o>/<r>/blob/<ref>/<path> and .../raw/<ref>/<path> are the page for a file; use the raw host.
        let parts: Vec<&str> = rest.split('/').collect();
        if (host == "github.com" || host == "www.github.com") && parts.len() > 5 && (parts[3] == "blob" || parts[3] == "raw") {
            let path = parts[5..].join("/");
            format!("https://raw.githubusercontent.com/{}/{}/{}/{}", parts[1], parts[2], parts[4], path)
        } else {
            l.to_string()
        }
    } else if l.contains("://") || l.starts_with("mailto:") || l.starts_with('#') {
        return None;
    } else {
        let p = l.trim_start_matches("./").trim_start_matches('/');
        format!("https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{}", encode_path(p))
    };
    if !image_ext(&out) {
        return None;
    }
    // ?raw=true and similar only matter on github.com; the raw host does not need them.
    let out = if out.contains("raw.githubusercontent.com") { out.split(['?', '#']).next().unwrap_or(&out).to_string() } else { out };
    Some(out)
}

/// Raw link targets of `![alt](target "title")` and `<img ... src="target">` in a README.
pub fn readme_links(md: &str) -> Vec<String> {
    let mut out: Vec<(usize, String)> = Vec::new();
    // Markdown images.
    let b = md.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'!' && b[i + 1] == b'[' {
            if let Some(close) = md[i + 2..].find("](") {
                let start = i + 2 + close + 2;
                if let Some(end) = md[start..].find(')') {
                    let inner = md[start..start + end].trim();
                    let target = if let Some(rest) = inner.strip_prefix('<') {
                        rest.split('>').next().unwrap_or("").to_string()
                    } else {
                        inner.split_whitespace().next().unwrap_or("").to_string()
                    };
                    if !target.is_empty() {
                        out.push((i, target));
                    }
                    i = start + end;
                    continue;
                }
            }
        }
        i += 1;
    }
    // HTML images.
    let lower = md.to_ascii_lowercase();
    let mut pos = 0;
    while let Some(p) = lower[pos..].find("<img") {
        let at = pos + p;
        let tag_end = lower[at..].find('>').map(|e| at + e).unwrap_or(lower.len());
        let tag = &md[at..tag_end];
        let tl = &lower[at..tag_end];
        if let Some(s) = tl.find("src=") {
            let rest = &tag[s + 4..];
            let (q, body) = match rest.chars().next() {
                Some(c @ ('"' | '\'')) => (Some(c), &rest[1..]),
                _ => (None, rest),
            };
            let val = match q {
                Some(c) => body.split(c).next().unwrap_or(""),
                None => body.split(|c: char| c.is_whitespace() || c == '/' && false).next().unwrap_or(""),
            };
            if !val.is_empty() {
                out.push((at, val.to_string()));
            }
        }
        pos = tag_end.max(at + 4);
    }
    out.sort_by_key(|(p, _)| *p);
    out.into_iter().map(|(_, l)| l).collect()
}

fn push_unique(list: &mut Vec<String>, url: String) {
    if list.len() < MAX_IMAGES && url.starts_with("https://") && !list.contains(&url) {
        list.push(url);
    }
}

fn fetch(owner: &str, repo: &str) -> Vec<String> {
    let mut list = Vec::new();
    let api = format!("https://api.github.com/repos/{owner}/{repo}/contents/docs/images");
    if let Ok(v) = net::get_json(&api) {
        if let Some(items) = v.as_array() {
            let mut files: Vec<(String, String)> = items
                .iter()
                .filter(|i| i["type"] == "file")
                .filter_map(|i| Some((i["name"].as_str()?.to_string(), i["download_url"].as_str()?.to_string())))
                .filter(|(n, _)| image_ext(n))
                .collect();
            files.sort();
            for (_, u) in files {
                push_unique(&mut list, u);
            }
        }
    }
    let readme = format!("https://raw.githubusercontent.com/{owner}/{repo}/HEAD/README.md");
    if let Ok(b) = net::get_bytes(&readme, 2 << 20) {
        let md = String::from_utf8_lossy(&b);
        for l in readme_links(&md) {
            if let Some(u) = to_raw_url(&l, owner, repo) {
                push_unique(&mut list, u);
            }
        }
    }
    list
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn gallery_for(cache: &Path, repo_url: &str) -> Vec<String> {
    let Some((o, r)) = parse_repo(repo_url) else { return Vec::new() };
    let file = cache.join("gallery").join(format!("{o}__{r}.json").to_ascii_lowercase());
    if let Ok(s) = std::fs::read_to_string(&file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if now().saturating_sub(v["at"].as_u64().unwrap_or(0)) < DAY {
                if let Some(a) = v["images"].as_array() {
                    return a.iter().filter_map(|x| x.as_str().map(String::from)).collect();
                }
            }
        }
    }
    let list = fetch(&o, &r);
    // Do not cache an empty result that may come from a network error or the rate limit for a full day.
    let _ = std::fs::create_dir_all(file.parent().unwrap_or(cache));
    let at = if list.is_empty() { now().saturating_sub(DAY - 600) } else { now() };
    let _ = std::fs::write(&file, serde_json::json!({ "at": at, "images": list }).to_string());
    list
}

/// Screenshot URLs (https, png/jpg/gif/webp, at most 24) of a GitHub-hosted mod.
#[tauri::command(async)]
pub async fn mod_gallery(app: AppHandle, repo_url: String) -> Result<Vec<String>, String> {
    let cache = app.state::<crate::state::AppState>().cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || gallery_for(&cache, &repo_url)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_urls() {
        assert_eq!(parse_repo("https://github.com/cheatoskar/TM-Vibrant-Shaders"), Some(("cheatoskar".into(), "TM-Vibrant-Shaders".into())));
        assert_eq!(parse_repo("https://github.com/a/b.git/releases"), Some(("a".into(), "b".into())));
        assert_eq!(parse_repo("https://example.com/a/b"), None);
        assert_eq!(parse_repo("https://github.com/a"), None);
    }

    #[test]
    fn markdown_and_html() {
        let md = "# T\n![one](docs/images/a.png \"t\")\n<img width=\"300\" src=\"./b.JPG\" alt=x>\n![badge](https://img.shields.io/x.png)\n<img src='https://github.com/o/r/blob/main/c.webp?raw=true'/>\n![l](<my pic.gif>)";
        let links = readme_links(md);
        assert_eq!(links.len(), 5);
        let urls: Vec<String> = links.iter().filter_map(|l| to_raw_url(l, "o", "r")).collect();
        assert_eq!(
            urls,
            vec![
                "https://raw.githubusercontent.com/o/r/HEAD/docs/images/a.png",
                "https://raw.githubusercontent.com/o/r/HEAD/b.JPG",
                "https://raw.githubusercontent.com/o/r/main/c.webp",
                "https://raw.githubusercontent.com/o/r/HEAD/my%20pic.gif",
            ]
        );
    }

    #[test]
    fn rejects() {
        assert_eq!(to_raw_url("http://x.com/a.png", "o", "r"), None);
        assert_eq!(to_raw_url("a.svg", "o", "r"), None);
        assert_eq!(to_raw_url("data:image/png;base64,AAAA", "o", "r"), None);
        assert_eq!(to_raw_url("https://x.com/a.png", "o", "r"), Some("https://x.com/a.png".into()));
    }
}
