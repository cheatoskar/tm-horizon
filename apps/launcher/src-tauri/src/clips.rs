//! Clips page: videos in Documents\TrackMania\Clips (written by the clip-recording mod).
//! Thumbnails are the video's first frame, drawn by the page's own <video> element.

use crate::fsx;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: Option<String>,
}

pub fn clips_dir(docs: Option<&Path>) -> Option<PathBuf> {
    if let Ok(d) = std::env::var("TMHUB_CLIPS_DIR") {
        if !d.trim().is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    docs.map(|d| d.join("TrackMania").join("Clips"))
}

pub fn list(dir: &Path) -> Vec<Clip> {
    let mut out: Vec<(Option<std::time::SystemTime>, Clip)> = Vec::new();
    for e in fsx::list(dir) {
        let l = e.name.to_lowercase();
        if !e.is_file || !(l.ends_with(".mp4") || l.ends_with(".webm") || l.ends_with(".mkv")) {
            continue;
        }
        let t = fsx::mtime(&e.path);
        let size = std::fs::metadata(&e.path).map(|m| m.len()).unwrap_or(0);
        out.push((t, Clip { name: e.name, path: e.path.to_string_lossy().into(), size, modified: t.map(fsx::iso) }));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, c)| c).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_videos_newest_first() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("a.mp4"), b"1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(t.path().join("b.MP4"), b"22").unwrap();
        std::fs::write(t.path().join("notes.txt"), b"x").unwrap();
        let l = list(t.path());
        assert_eq!(l.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["b.MP4", "a.mp4"]);
        assert_eq!(l[0].size, 2);
        assert!(list(&t.path().join("missing")).is_empty());
    }
}
