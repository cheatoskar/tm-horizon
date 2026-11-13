//! Remote pictures (mod and plugin icons, Discord server icons, gallery screenshots) are fetched once
//! over https, checked to be a real raster image, and kept in <cache>/img/<sha256 of the URL>.<ext>.
//! The UI then shows the local copy through the asset protocol, so pages work offline and the same
//! picture is not downloaded again. SVG is not accepted (it can carry scripts).

use crate::{fsx, net};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const MAX_IMAGE: u64 = 8 << 20;

pub fn ext_of(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG") {
        Some("png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if b.starts_with(b"GIF8") {
        Some("gif")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("webp")
    } else if b.starts_with(&[0, 0, 1, 0]) {
        Some("ico")
    } else {
        None
    }
}

pub fn dir(cache: &Path) -> PathBuf {
    cache.join("img")
}

/// The cache keeps at most this much; the least recently used pictures go first.
pub const MAX_TOTAL: u64 = 300 << 20;
/// Pictures older than this are fetched again in the background (the cached copy is shown meanwhile).
const REVALIDATE_AFTER: std::time::Duration = std::time::Duration::from_secs(30 * 86_400);
const DAY: std::time::Duration = std::time::Duration::from_secs(86_400);

fn age(t: std::io::Result<std::time::SystemTime>) -> Option<std::time::Duration> {
    t.ok().and_then(|t| t.elapsed().ok())
}

/// Local file for `url`, downloading it the first time. A hit marks the file as used (its modification
/// time, at most once a day) and, when the copy is older than 30 days, fetches it again in the background.
pub fn get(cache: &Path, url: &str) -> Result<PathBuf, String> {
    if !url.starts_with("https://") {
        return Err("Only https pictures".into());
    }
    let key = hex::encode(Sha256::digest(url.as_bytes()));
    let d = dir(cache);
    for e in ["png", "jpg", "gif", "webp", "ico"] {
        let p = d.join(format!("{key}.{e}"));
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if !meta.is_file() {
            continue;
        }
        if age(meta.modified()).is_some_and(|a| a > DAY) {
            if let Ok(f) = std::fs::File::options().write(true).open(&p) {
                let _ = f.set_modified(std::time::SystemTime::now());
            }
        }
        if age(meta.created()).is_some_and(|a| a > REVALIDATE_AFTER) {
            revalidate(d.clone(), key.clone(), url.to_string());
        }
        return Ok(p);
    }
    fetch(&d, &key, url)
}

fn fetch(d: &Path, key: &str, url: &str) -> Result<PathBuf, String> {
    let b = net::get_bytes(url, MAX_IMAGE)?;
    let ext = ext_of(&b).ok_or("Not a picture")?;
    std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    let p = d.join(format!("{key}.{ext}"));
    fsx::write(&p, &b)?;
    // Same picture under another extension (the site changed the format): only the new one stays.
    for e in ["png", "jpg", "gif", "webp", "ico"].iter().filter(|e| **e != ext) {
        let _ = std::fs::remove_file(d.join(format!("{key}.{e}")));
    }
    Ok(p)
}

/// One background refresh per picture at a time; a failed refresh keeps the old copy.
fn revalidate(d: PathBuf, key: String, url: String) {
    static BUSY: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    {
        let mut b = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        if b.contains(&key) || b.len() > 8 {
            return;
        }
        b.push(key.clone());
    }
    std::thread::spawn(move || {
        let _ = fetch(&d, &key, &url);
        BUSY.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| *k != key);
    });
}

/// Size of the cache: (bytes, files).
pub fn usage(cache: &Path) -> (u64, u32) {
    fsx::list(&dir(cache)).into_iter().filter(|e| e.is_file).fold((0, 0), |(b, n), e| (b + e.len, n + 1))
}

/// Deletes the least recently used pictures until the cache is at most `max` bytes. Returns the bytes freed.
pub fn prune(cache: &Path, max: u64) -> u64 {
    let mut files: Vec<_> = fsx::list(&dir(cache)).into_iter().filter(|e| e.is_file).collect();
    let mut total: u64 = files.iter().map(|e| e.len).sum();
    files.sort_by_key(|e| e.modified);
    let mut freed = 0;
    for e in files {
        if total <= max {
            break;
        }
        if std::fs::remove_file(&e.path).is_ok() {
            total -= e.len;
            freed += e.len;
        }
    }
    freed
}

/// Empties the picture cache (Settings). Returns the bytes freed.
pub fn clear(cache: &Path) -> u64 {
    prune(cache, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_drops_the_least_recently_used_first() {
        let t = tempfile::tempdir().unwrap();
        let d = dir(t.path());
        std::fs::create_dir_all(&d).unwrap();
        let now = std::time::SystemTime::now();
        for (i, name) in ["old.png", "mid.png", "new.png"].iter().enumerate() {
            std::fs::write(d.join(name), vec![0u8; 100]).unwrap();
            let f = std::fs::File::options().write(true).open(d.join(name)).unwrap();
            f.set_modified(now - std::time::Duration::from_secs(1000 * (3 - i as u64))).unwrap();
        }
        assert_eq!(usage(t.path()), (300, 3));
        assert_eq!(prune(t.path(), 250), 100);
        assert!(!d.join("old.png").exists() && d.join("mid.png").exists() && d.join("new.png").exists());
        assert_eq!(clear(t.path()), 200);
        assert_eq!(usage(t.path()), (0, 0));
    }

    #[test]
    fn only_raster_pictures_over_https() {
        assert_eq!(ext_of(b"\x89PNG\r\n"), Some("png"));
        assert_eq!(ext_of(b"<svg onload=x>"), None);
        let t = tempfile::tempdir().unwrap();
        assert!(get(t.path(), "http://example.com/a.png").is_err());
        // A cached file is returned without any download.
        let key = hex::encode(Sha256::digest(b"https://example.com/a.png"));
        std::fs::create_dir_all(dir(t.path())).unwrap();
        std::fs::write(dir(t.path()).join(format!("{key}.png")), b"\x89PNG").unwrap();
        assert!(get(t.path(), "https://example.com/a.png").unwrap().ends_with(format!("{key}.png")));
    }
}
