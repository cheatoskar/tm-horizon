//! TMLoader mods for a separate installation (instance). TMLoader stores the game folder once per
//! product (`database\TmForever\products\TmForever\settings.yaml` -> `install:`), and its config,
//! database and profiles are read relative to TMLoader.exe (`./config.yaml`, `./database` in the exe's
//! strings; `portable` is a config key, loader.d.ts `Config.portable`). So an instance gets its own
//! small TMLoader next to its game files:
//!
//! ```text
//! <instance>\TMLoader\TMLoader.exe, sciter.dll, ui\        copies of the installed TMLoader
//! <instance>\TMLoader\config.yaml                           portable: true, no auto update/upgrade
//! <instance>\TMLoader\database\TmForever\products\...       hard links to the installed products
//! <instance>\TMLoader\database\TmForever\products\TmForever\settings.yaml   install: <instance>
//! <instance>\TMLoader\database\TmForever\profiles\<profile>.yaml           copy of the chosen profile
//! ```
//!
//! Play then runs `<instance>\TMLoader\TMLoader.exe run TmForever "<profile>"`. The installed TMLoader
//! (`%LOCALAPPDATA%\TMLoader`) is only read. Small and writable files (mod ini files, yaml) are real
//! copies, so a mod writing its settings does not write through a link into the original; auto update
//! and upgrade are off in the copy, so it never writes into linked product files. The database is
//! rebuilt before every start (links are cheap), which also picks up mods installed since.
//!
//! Not verified by a start (needs my test round): that TMLoader really reads the copy's config.yaml
//! instead of %LOCALAPPDATA%\TMLoader's, and that it accepts the instance as `install`.
use crate::fsx;
use std::path::{Path, PathBuf};

pub const DIR: &str = "TMLoader";
const PROGRAM_FILES: [&str; 2] = ["TMLoader.exe", "sciter.dll"];
const SMALL: u64 = 64 * 1024;
const COPY_EXT: [&str; 7] = ["ini", "cfg", "txt", "log", "yaml", "yml", "json"];

/// A TMLoader profile name as TMLoader stores it (file name without .yaml; no paths).
pub fn valid_profile(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 80
        && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && !name.contains("..")
        && !name.chars().any(char::is_control)
}

fn must_copy(p: &Path, size: u64) -> bool {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    size < SMALL || COPY_EXT.contains(&ext.as_str())
}

/// Links (or copies) every file under `from` into `to`; symbolic links and junctions are skipped.
fn mirror(from: &Path, to: &Path, skip: &dyn Fn(&Path) -> bool) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    for e in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let e = e.map_err(|e| e.to_string())?;
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() {
            continue;
        }
        let src = e.path();
        let dst = to.join(e.file_name());
        if skip(&src) {
            continue;
        }
        fsx::check(&dst)?;
        if ft.is_dir() {
            mirror(&src, &dst, skip)?;
        } else if fsx::is_dinput8(&src) {
            continue;
        } else {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            if must_copy(&src, size) || std::fs::hard_link(&src, &dst).is_err() {
                fsx::copy(&src, &dst)?;
            }
        }
    }
    Ok(())
}

/// The portable config: the installed one's servers and settings, plus portable, own database,
/// no auto update/upgrade, the chosen profile as default.
pub fn portable_config(main: &str, profile: &str) -> Result<String, String> {
    let mut v: serde_yaml::Value = serde_yaml::from_str(main).map_err(|e| format!("config.yaml: {e}"))?;
    let m = v.as_mapping_mut().ok_or("config.yaml is not a mapping")?;
    let s = |x: &str| serde_yaml::Value::String(x.into());
    m.insert(s("portable"), serde_yaml::Value::Bool(true));
    m.insert(s("database"), s("./database"));
    m.insert(s("auto_update"), s("false"));
    m.insert(s("auto_upgrade"), s("false"));
    m.insert(s("default_game"), s("TmForever"));
    let mut dp = serde_yaml::Mapping::new();
    dp.insert(s("TmForever"), s(profile));
    m.insert(s("default_profiles"), serde_yaml::Value::Mapping(dp));
    serde_yaml::to_string(&v).map_err(|e| e.to_string())
}

/// Builds (or rebuilds) the instance's own TMLoader. `main` = the installed TMLoader folder (read
/// only), `inst` = the instance folder. Returns the copy's TMLoader.exe.
pub fn prepare(main: &Path, inst: &Path, profile: &str) -> Result<PathBuf, String> {
    if !valid_profile(profile) {
        return Err(format!("Invalid TMLoader profile name: {profile}"));
    }
    let main_db = main.join("database").join("TmForever");
    let profile_file = main_db.join("profiles").join(format!("{profile}.yaml"));
    if !fsx::is_file(&profile_file) {
        return Err(format!("TMLoader profile \"{profile}\" not found"));
    }
    let dest = inst.join(DIR);
    if fsx::norm(&dest).starts_with(&fsx::norm(main)) || fsx::norm(main).starts_with(&fsx::norm(inst)) {
        return Err("The instance and TMLoader folders overlap".into());
    }
    fsx::check(&dest)?;
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for f in PROGRAM_FILES {
        let (src, dst) = (main.join(f), dest.join(f));
        let same = std::fs::metadata(&src).ok().zip(std::fs::metadata(&dst).ok()).is_some_and(|(a, b)| a.len() == b.len() && a.modified().ok() <= b.modified().ok());
        if !same {
            fsx::copy(&src, &dst).map_err(|e| format!("{f}: {e}"))?;
        }
    }
    let ui = dest.join("ui");
    if fsx::is_dir(&main.join("ui")) {
        remove_inside(&ui, &dest)?;
        copy_tree(&main.join("ui"), &ui)?;
    }
    let cfg = std::fs::read_to_string(main.join("config.yaml")).map_err(|e| format!("config.yaml: {e}"))?;
    fsx::write(&dest.join("config.yaml"), portable_config(&cfg, profile)?.as_bytes())?;

    // Database: rebuilt each time from the installed products (links), own settings and profile.
    let db = dest.join("database");
    remove_inside(&db, &dest)?;
    let game = db.join("TmForever");
    let own_settings = main_db.join("products").join("TmForever").join("settings.yaml");
    mirror(&main_db.join("products"), &game.join("products"), &|p| fsx::norm(p) == fsx::norm(&own_settings))?;
    let install = inst.to_string_lossy().replace('\\', "/");
    fsx::write(&game.join("products").join("TmForever").join("settings.yaml"), format!("install: '{}'\n", install.replace('\'', "''")).as_bytes())?;
    std::fs::create_dir_all(game.join("profiles")).map_err(|e| e.to_string())?;
    fsx::copy(&profile_file, &game.join("profiles").join(format!("{profile}.yaml")))?;
    Ok(dest.join("TMLoader.exe"))
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        } else {
            fsx::copy(&e.path(), &to.join(e.file_name()))?;
        }
    }
    Ok(())
}

/// Removes `p` (a real folder, no junction) when it lies inside `parent`. Removing hard links never
/// touches the files they share with the installed TMLoader.
fn remove_inside(p: &Path, parent: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(p) else { return Ok(()) };
    if meta.file_type().is_symlink() || !fsx::is_inside(p, parent) || fsx::norm(p) == fsx::norm(parent) {
        return Err(format!("refusing to remove {}", p.display()));
    }
    std::fs::remove_dir_all(p).map_err(|e| format!("{}: {e} (is TMLoader or the game still running?)", p.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_tmloader(root: &Path) {
        let db = root.join("database/TmForever");
        std::fs::create_dir_all(db.join("products/TmForever/2.12.0")).unwrap();
        std::fs::create_dir_all(db.join("products/CenterSpeed/1.4.3")).unwrap();
        std::fs::create_dir_all(db.join("profiles")).unwrap();
        std::fs::create_dir_all(root.join("ui/layouts")).unwrap();
        std::fs::write(root.join("TMLoader.exe"), b"MZ tmloader").unwrap();
        std::fs::write(root.join("sciter.dll"), b"MZ sciter").unwrap();
        std::fs::write(root.join("ui/layouts/loader.d.ts"), b"declare").unwrap();
        std::fs::write(root.join("config.yaml"), "version: 1.0.1\nportable: false\ndatabase: ./database\nauto_update: after\nauto_upgrade: after\ndefault_game: TmForever\ndefault_profiles:\n  TmForever: default\nservers:\n  - 'https://example.invalid/modloader/'\n").unwrap();
        std::fs::write(db.join("products/TmForever/settings.yaml"), "install: 'C:/Program Files (x86)/TmUnitedForever'\n").unwrap();
        std::fs::write(db.join("products/TmForever/2.12.0/TmForever.exe"), vec![7u8; 200 * 1024]).unwrap();
        std::fs::write(db.join("products/CenterSpeed/1.4.3/CenterSpeed.dll"), vec![1u8; 100 * 1024]).unwrap();
        std::fs::write(db.join("products/CenterSpeed/CenterSpeed.ini"), b"[a]\nx=1\n").unwrap();
        std::fs::write(db.join("profiles/Speed.yaml"), "program:\n  id: TmForever\nmods:\n  - id: CenterSpeed\n").unwrap();
    }

    #[test]
    fn builds_a_portable_tmloader_inside_the_instance_only() {
        let t = tempfile::tempdir().unwrap();
        let main = t.path().join("TMLoader");
        let inst = t.path().join("instances/my-tmuf");
        fake_tmloader(&main);
        std::fs::create_dir_all(&inst).unwrap();
        let before: Vec<(PathBuf, Vec<u8>)> = walk(&main).into_iter().map(|p| { let b = std::fs::read(&p).unwrap(); (p, b) }).collect();

        let exe = prepare(&main, &inst, "Speed").unwrap();
        assert_eq!(exe, inst.join("TMLoader/TMLoader.exe"));
        assert!(exe.is_file() && inst.join("TMLoader/ui/layouts/loader.d.ts").is_file());
        let cfg = std::fs::read_to_string(inst.join("TMLoader/config.yaml")).unwrap();
        assert!(cfg.contains("portable: true") && cfg.contains("auto_update: 'false'") && cfg.contains("TmForever: Speed") && cfg.contains("example.invalid"));
        let settings = std::fs::read_to_string(inst.join("TMLoader/database/TmForever/products/TmForever/settings.yaml")).unwrap();
        assert!(settings.contains(&inst.to_string_lossy().replace('\\', "/")));
        let big = inst.join("TMLoader/database/TmForever/products/TmForever/2.12.0/TmForever.exe");
        assert_eq!(crate::instances::link_count(&big), 2, "big product files are hard links");
        let ini = inst.join("TMLoader/database/TmForever/products/CenterSpeed/CenterSpeed.ini");
        assert_eq!(crate::instances::link_count(&ini), 1, "mod settings are real copies");
        std::fs::write(&ini, b"[changed]").unwrap();
        assert!(inst.join("TMLoader/database/TmForever/profiles/Speed.yaml").is_file());

        // Rebuild: works again, and the installed TMLoader is byte-for-byte unchanged.
        prepare(&main, &inst, "Speed").unwrap();
        for (p, b) in before {
            assert_eq!(std::fs::read(&p).unwrap(), b, "{} changed", p.display());
        }
        assert!(prepare(&main, &inst, "../evil").is_err());
        assert!(prepare(&main, &inst, "Missing").is_err());
    }

    fn walk(p: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        for e in std::fs::read_dir(p).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() { out.extend(walk(&e.path())); } else { out.push(e.path()); }
        }
        out
    }
}
