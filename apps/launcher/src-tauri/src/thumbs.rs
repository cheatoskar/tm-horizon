//! Media page pictures. The grid never loads the original files: a 2560x1440 BMP is 11 MB, and every
//! asset-protocol answer is copied into the web view on the app's main thread, so a page full of
//! screenshots froze the whole window. Instead each picture gets a small JPEG (480 px) made here,
//! on a background thread, and kept in <cache>/media-thumbs/. The viewer shows JPG/WebP and small
//! PNG originals as they are; BMP, TGA and large PNGs get a full-size JPEG copy there too (the web
//! view cannot draw TGA, and a BMP or a TMVS photo PNG is five to ten times larger than the JPEG).
//!
//! The cache file name is a hash of the path, size and modification time, so a changed file gets a
//! new picture. `prune` removes pictures of files that are gone and keeps the folder under a size cap.

use crate::fsx;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

pub const THUMB_SIZE: u32 = 480;
const VIEW_MAX: u32 = 3840;
const THUMB_QUALITY: u8 = 82;
const VIEW_QUALITY: u8 = 90;
/// Larger files are not decoded (no screenshot is that big).
const MAX_SOURCE: u64 = 400 << 20;
pub const CACHE_CAP: u64 = 300 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// Grid picture, at most 480 px wide or high.
    Thumb,
    /// Viewer picture for formats the web view should not get as they are (BMP, TGA).
    View,
}

pub fn dir(cache: &Path) -> PathBuf {
    cache.join("media-thumbs")
}

fn ext(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// PNGs up to this size go to the viewer as they are.
const PNG_ORIGINAL: u64 = 3 << 20;

/// Does the viewer get the original file (true) or a JPEG copy (false)?
pub fn view_original(path: &Path, size: u64) -> bool {
    match ext(path).as_str() {
        "jpg" | "jpeg" | "webp" => true,
        "png" => size <= PNG_ORIGINAL,
        _ => false,
    }
}

/// Cache file name for one state of a file (path, size, modification time as ISO text).
pub fn key(path: &Path, size: u64, modified: &str, v: Variant) -> String {
    let mut h = Sha256::new();
    h.update(fsx::norm(path).as_bytes());
    h.update(b"|");
    h.update(size.to_le_bytes());
    h.update(b"|");
    h.update(modified.as_bytes());
    let tag = if v == Variant::Thumb { "t" } else { "v" };
    format!("{}-{tag}.jpg", &hex::encode(h.finalize())[..32])
}

/// Size and modification time, read the same way as the listing does.
pub fn stamp(path: &Path) -> Option<(u64, String)> {
    let md = std::fs::metadata(path).ok()?;
    Some((md.len(), md.modified().ok().map(fsx::iso).unwrap_or_default()))
}

// At most a few pictures are decoded at once: each one holds a full-size image in memory.
struct Gate {
    busy: Mutex<usize>,
    cv: Condvar,
}
static GATE: Gate = Gate { busy: Mutex::new(0), cv: Condvar::new() };
struct Pass;
impl Drop for Pass {
    fn drop(&mut self) {
        *GATE.busy.lock().unwrap() -= 1;
        GATE.cv.notify_one();
    }
}
fn pass() -> Pass {
    let max = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(2, 4);
    let mut b = GATE.busy.lock().unwrap();
    while *b >= max {
        b = GATE.cv.wait(b).unwrap();
    }
    *b += 1;
    Pass
}

/// The picture to show for `path`: a cached JPEG (made now if missing) or, for the viewer and a
/// web format, the original file itself. Blocks; call it from a background thread.
pub fn get(cache: &Path, path: &Path, v: Variant) -> Result<PathBuf, String> {
    let (size, modified) = stamp(path).ok_or_else(|| format!("File not found: {}", path.display()))?;
    if v == Variant::View && view_original(path, size) {
        return Ok(path.to_path_buf());
    }
    if size > MAX_SOURCE {
        return Err(format!("Too large for a preview: {}", path.display()));
    }
    let d = dir(cache);
    let out = d.join(key(path, size, &modified, v));
    if out.is_file() {
        return Ok(out);
    }
    let _pass = pass();
    if out.is_file() {
        return Ok(out); // made by another request while this one waited
    }
    let bytes = render(path, v)?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let tmp = d.join(format!("{}.{:?}.tmp", out.file_name().unwrap().to_string_lossy(), std::thread::current().id()).replace(['(', ')'], ""));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    if std::fs::rename(&tmp, &out).is_err() {
        let _ = std::fs::remove_file(&tmp);
        if !out.is_file() {
            return Err(format!("Could not save the preview of {}", path.display()));
        }
    }
    Ok(out)
}

/// Decodes `path` (format by content, not by name) and encodes the JPEG.
pub fn render(path: &Path, v: Variant) -> Result<Vec<u8>, String> {
    let fail = |e: &dyn std::fmt::Display| format!("No preview for {}: {e}", path.display());
    let img = image::ImageReader::open(path).map_err(|e| fail(&e))?.with_guessed_format().map_err(|e| fail(&e))?.decode().map_err(|e| fail(&e))?;
    let img = match v {
        Variant::Thumb => img.thumbnail(THUMB_SIZE, THUMB_SIZE),
        Variant::View if img.width() > VIEW_MAX || img.height() > VIEW_MAX => img.thumbnail(VIEW_MAX, VIEW_MAX),
        Variant::View => img,
    };
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    let q = if v == Variant::Thumb { THUMB_QUALITY } else { VIEW_QUALITY };
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, q).encode_image(&rgb).map_err(|e| fail(&e))?;
    Ok(out)
}

/// Removes cached pictures whose name is not in `keep` (their file is gone or changed), then the
/// oldest ones until the folder is under `cap` bytes. Returns how many files were removed.
pub fn prune(cache: &Path, keep: &HashSet<String>, cap: u64) -> usize {
    let d = dir(cache);
    let Ok(rd) = std::fs::read_dir(&d) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut left: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut removed = 0;
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let t = md.modified().unwrap_or(now);
        let stale_tmp = name.ends_with(".tmp") && now.duration_since(t).map(|a| a.as_secs() > 120).unwrap_or(false);
        if stale_tmp || (!name.ends_with(".tmp") && !keep.contains(&name)) {
            if std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
            continue;
        }
        if !name.ends_with(".tmp") {
            left.push((t, md.len(), e.path()));
        }
    }
    left.sort_by(|a, b| b.0.cmp(&a.0));
    let mut total = 0u64;
    for (_, len, p) in left {
        total += len;
        if total > cap && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bmp(path: &Path, w: u32, h: u32) {
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        img.save(path).unwrap();
    }

    #[test]
    fn thumb_and_view() {
        let t = tempfile::tempdir().unwrap();
        let cache = t.path().join("cache");
        let src = t.path().join("screen_001.bmp");
        bmp(&src, 640, 360);
        let th = get(&cache, &src, Variant::Thumb).unwrap();
        assert!(th.starts_with(dir(&cache)));
        let im = image::open(&th).unwrap();
        assert_eq!((im.width(), im.height()), (480, 270));
        // second call: same file, no new work
        assert_eq!(get(&cache, &src, Variant::Thumb).unwrap(), th);
        let view = get(&cache, &src, Variant::View).unwrap();
        assert_ne!(view, th);
        assert_eq!(image::open(&view).unwrap().width(), 640);
        // small PNGs: the viewer gets the original
        let png = t.path().join("photo_001.png");
        bmp(&png, 64, 36);
        assert_eq!(get(&cache, &png, Variant::View).unwrap(), png);
        assert!(get(&cache, &png, Variant::Thumb).unwrap().starts_with(dir(&cache)));
    }

    #[test]
    fn changed_file_new_key_and_prune() {
        let t = tempfile::tempdir().unwrap();
        let cache = t.path().join("cache");
        let src = t.path().join("a.bmp");
        bmp(&src, 100, 50);
        let first = get(&cache, &src, Variant::Thumb).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        bmp(&src, 120, 50);
        let second = get(&cache, &src, Variant::Thumb).unwrap();
        assert_ne!(first, second);
        let (size, m) = stamp(&src).unwrap();
        let keep: HashSet<String> = [key(&src, size, &m, Variant::Thumb)].into_iter().collect();
        assert_eq!(prune(&cache, &keep, CACHE_CAP), 1);
        assert!(!first.exists() && second.exists());
        // size cap: everything above it goes, oldest first
        assert_eq!(prune(&cache, &keep, 0), 1);
        assert!(!second.exists());
    }

    #[test]
    fn broken_file_is_an_error() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("bad.bmp");
        std::fs::write(&src, b"not a picture").unwrap();
        assert!(get(&t.path().join("cache"), &src, Variant::Thumb).is_err());
    }
}
