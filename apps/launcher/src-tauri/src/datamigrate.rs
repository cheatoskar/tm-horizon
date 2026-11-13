//! One-time move of the data folders from the old identifier (`app.tmhub.launcher`, up to the 0.5.0 tests) to
//! the new one (`com.tmhorizon.launcher`). Runs in `run()` before Tauri, its plugins or the webview open any of
//! them. Per base folder (Roaming, Local, cache; on Linux ~/.config, ~/.local/share, ~/.cache): only when the old
//! folder exists and the new one does not. A rename first (keeps WebView2's localStorage, backups, instances in
//! one step); when that fails (the old launcher still runs and holds files) a copy, skipping locked files. JSON
//! files that name the old folder (stored paths) get the new name. The old folder is left as it is after a copy.
use std::path::{Path, PathBuf};

pub const OLD_ID: &str = "app.tmhub.launcher";
pub const NEW_ID: &str = "com.tmhorizon.launcher";
/// Set when this start moved the old folders: the server autostart task then gets the new exe path.
pub static MIGRATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The base folders Tauri puts `<identifier>` folders in (app_config/data/local_data/cache), without duplicates.
pub fn bases() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir(), dirs::cache_dir()].into_iter().flatten().collect();
    v.sort();
    v.dedup();
    v
}

/// Moves `<base>/<old>` to `<base>/<new>` for every base. Returns what it did (for the log).
pub fn migrate(bases: &[PathBuf], old: &str, new: &str) -> Vec<String> {
    let mut done = Vec::new();
    for b in bases {
        let (from, to) = (b.join(old), b.join(new));
        if !from.is_dir() || to.exists() {
            continue;
        }
        let how = if std::fs::rename(&from, &to).is_ok() {
            "moved"
        } else {
            copy_dir(&from, &to);
            "copied"
        };
        rewrite_paths(&to, old, new, 2);
        done.push(format!("{how} {} -> {}", from.display(), to.display()));
    }
    done
}

fn copy_dir(from: &Path, to: &Path) {
    let _ = std::fs::create_dir_all(to);
    let Ok(rd) = std::fs::read_dir(from) else { return };
    for e in rd.flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        match e.file_type() {
            Ok(t) if t.is_dir() => copy_dir(&src, &dst),
            Ok(t) if t.is_file() => {
                let _ = std::fs::copy(&src, &dst); // a file the old launcher holds open is skipped
            }
            _ => {}
        }
    }
}

/// Stored absolute paths (settings, instances, hosting) in JSON files up to `depth` folders deep.
fn rewrite_paths(dir: &Path, old: &str, new: &str, depth: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            if depth > 0 && e.file_name() != "EBWebView" && e.file_name() != "EmbeddedWeb" {
                rewrite_paths(&p, old, new, depth - 1);
            }
        } else if t.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("json")) && e.metadata().map(|m| m.len() < 8 << 20).unwrap_or(false) {
            if let Ok(s) = std::fs::read_to_string(&p) {
                if s.contains(old) {
                    let _ = std::fs::write(&p, s.replace(old, new));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_once_and_rewrites_stored_paths() {
        let t = tempfile::tempdir().unwrap();
        let (roaming, local) = (t.path().join("Roaming"), t.path().join("Local"));
        let old_local = local.join(OLD_ID);
        std::fs::create_dir_all(old_local.join("TM Horizon backups").join("eswc")).unwrap();
        std::fs::create_dir_all(old_local.join("EBWebView").join("Default")).unwrap();
        std::fs::write(old_local.join("EBWebView").join("Default").join("ls.json"), format!("{{\"p\":\"C:\\\\x\\\\{OLD_ID}\"}}")).unwrap();
        std::fs::write(old_local.join("instances.json"), format!("{{\"dir\":\"C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\{OLD_ID}\\\\instances\\\\a\"}}")).unwrap();
        std::fs::create_dir_all(roaming.join(OLD_ID)).unwrap();
        std::fs::write(roaming.join(OLD_ID).join("settings.json"), "{}").unwrap();
        let done = migrate(&[roaming.clone(), local.clone()], OLD_ID, NEW_ID);
        assert_eq!(done.len(), 2, "{done:?}");
        let new_local = local.join(NEW_ID);
        assert!(!old_local.exists() && new_local.join("TM Horizon backups").join("eswc").is_dir());
        assert!(std::fs::read_to_string(new_local.join("instances.json")).unwrap().contains(NEW_ID));
        // WebView2's own files are left alone.
        assert!(std::fs::read_to_string(new_local.join("EBWebView").join("Default").join("ls.json")).unwrap().contains(OLD_ID));
        assert!(roaming.join(NEW_ID).join("settings.json").is_file());
        // Second start: nothing to do; an existing new folder is never overwritten.
        std::fs::create_dir_all(local.join(OLD_ID)).unwrap();
        assert!(migrate(&[roaming, local.clone()], OLD_ID, NEW_ID).is_empty());
        assert!(local.join(OLD_ID).is_dir());
    }

    #[test]
    fn copy_keeps_the_old_folder() {
        let t = tempfile::tempdir().unwrap();
        let from = t.path().join("a");
        std::fs::create_dir_all(from.join("x")).unwrap();
        std::fs::write(from.join("x").join("f.txt"), "1").unwrap();
        copy_dir(&from, &t.path().join("b"));
        assert_eq!(std::fs::read_to_string(t.path().join("b").join("x").join("f.txt")).unwrap(), "1");
        assert!(from.is_dir());
    }
}
