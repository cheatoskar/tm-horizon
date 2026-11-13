//! TAS corner for Forever: TMInterface's folders in Documents (detected, never created), the
//! plugins found there, and an installed ForeverTAS (from its uninstall entry). Read only.
//! TAS tools are for offline use only (TMX rules); the UI warns before joining a server with a
//! profile that has TMInterface on.

use crate::fsx;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TasFolder {
    /// "scripts" | "plugins" | "states" | "config" | "replays"
    pub key: String,
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForeverTas {
    pub installed: bool,
    pub version: Option<String>,
    pub exe: Option<String>,
    /// Public project page (from its uninstall entry, else the known GitHub page).
    pub homepage: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TasInfo {
    /// Documents\TMInterface exists.
    pub tminterface: bool,
    pub dir: Option<String>,
    pub folders: Vec<TasFolder>,
    /// File names in Documents\TMInterface\Plugins (plugins and plugin folders).
    pub plugins: Vec<String>,
    pub forevertas: ForeverTas,
    /// TICK, the Trackmania 2020 TAS tool from TMTAS Exchange.
    pub tick: ForeverTas,
}

pub const FOREVERTAS_HOME: &str = "https://github.com/Skycrafter-dev/ForeverTAS";
/// TICK's download page on TMTAS Exchange's tool list (the user installs it; TM Horizon never does).
pub const TICK_HOME: &str = "https://tmtas.exchange/tas-tools/tick/download";

/// The TICK exe in a folder: an .exe whose name starts with "tick" (not the uninstaller).
fn tick_exe_in(dir: &Path) -> Option<PathBuf> {
    fsx::list(dir)
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| e.name)
        .find(|n| {
            let l = n.to_lowercase();
            l.starts_with("tick") && l.ends_with(".exe")
        })
        .map(|n| dir.join(n))
        .filter(|p| fsx::is_file(p))
}

/// TICK, read only: its uninstall entry ("TICK" / "TICK 2.2.0" / "TICK version 2.2.0"), the usual
/// install folders, or the exe picked by hand (settings). Its installer's exact names are not known
/// yet, so every check is loose; nothing is started or written.
pub fn tick(entries: &[crate::platform::UninstallEntry], local_programs: Option<&Path>, picked: Option<&Path>) -> ForeverTas {
    let found = |exe: PathBuf, version: Option<String>| ForeverTas { installed: true, version, exe: Some(exe.to_string_lossy().into()), homepage: TICK_HOME.into() };
    for e in entries {
        let l = e.name.to_lowercase();
        if !(l == "tick" || l.starts_with("tick ")) {
            continue;
        }
        let version = e.name.rsplit(' ').next().filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit())).map(String::from);
        if let Some(exe) = e.location.as_deref().and_then(tick_exe_in) {
            return found(exe, version);
        }
    }
    if let Some(dir) = local_programs.map(|d| d.join("TICK")).filter(|d| fsx::is_dir(d)) {
        if let Some(exe) = tick_exe_in(&dir) {
            return found(exe, None);
        }
    }
    if let Some(exe) = picked.filter(|p| fsx::is_file(p) && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe"))) {
        return found(exe.to_path_buf(), None);
    }
    ForeverTas { homepage: TICK_HOME.into(), ..Default::default() }
}

pub fn folders(docs: &Path) -> Vec<(String, PathBuf, bool)> {
    let tmi = docs.join("TMInterface");
    vec![
        ("scripts".into(), tmi.join("Scripts"), false),
        ("plugins".into(), tmi.join("Plugins"), false),
        ("states".into(), tmi.join("States"), false),
        ("config".into(), tmi.join("config.txt"), true),
        ("replays".into(), docs.join("TrackMania").join("Tracks").join("Replays"), false),
    ]
}

/// The path behind a quick button, only if it exists.
pub fn target(docs: &Path, key: &str) -> Option<PathBuf> {
    folders(docs).into_iter().find(|(k, _, _)| k == key).map(|(_, p, _)| p).filter(|p| fsx::exists(p))
}

/// ForeverTAS from the system's uninstall list ("ForeverTAS version 0.2.7", Inno Setup).
pub fn forevertas(entries: &[crate::platform::UninstallEntry]) -> ForeverTas {
    for e in entries {
        if !e.name.to_lowercase().starts_with("forevertas") {
            continue;
        }
        let exe = e.location.as_ref().map(|d| d.join("ForeverTAS.exe")).filter(|p| fsx::is_file(p));
        let version = e.name.rsplit(' ').next().filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit())).map(String::from);
        return ForeverTas { installed: exe.is_some(), version, exe: exe.map(|p| p.to_string_lossy().into()), homepage: FOREVERTAS_HOME.into() };
    }
    ForeverTas { homepage: FOREVERTAS_HOME.into(), ..Default::default() }
}

pub fn info(docs: Option<&Path>, entries: &[crate::platform::UninstallEntry], local_programs: Option<&Path>, tick_picked: Option<&Path>) -> TasInfo {
    let mut out = TasInfo { forevertas: forevertas(entries), tick: tick(entries, local_programs, tick_picked), ..Default::default() };
    let Some(docs) = docs else { return out };
    let tmi = docs.join("TMInterface");
    out.tminterface = fsx::is_dir(&tmi);
    out.dir = Some(tmi.to_string_lossy().into());
    out.folders = folders(docs)
        .into_iter()
        .map(|(key, p, is_file)| TasFolder { key, exists: if is_file { fsx::is_file(&p) } else { fsx::is_dir(&p) }, path: p.to_string_lossy().into(), is_file })
        .collect();
    let mut plugins: Vec<String> = fsx::list(&tmi.join("Plugins"))
        .into_iter()
        .filter(|e| e.is_dir || [".as", ".dll", ".py", ".txt"].iter().any(|x| e.name.to_lowercase().ends_with(x)))
        .map(|e| if e.is_dir { format!("{}\\", e.name) } else { e.name })
        .collect();
    plugins.sort_by_key(|n| n.to_lowercase());
    out.plugins = plugins;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::UninstallEntry;

    #[test]
    fn detects_folders_plugins_and_forevertas() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path();
        std::fs::create_dir_all(docs.join("TMInterface").join("Plugins").join("TMDriver")).unwrap();
        std::fs::create_dir_all(docs.join("TMInterface").join("Scripts")).unwrap();
        std::fs::write(docs.join("TMInterface").join("Plugins").join("Python_Link.as"), "").unwrap();
        std::fs::write(docs.join("TMInterface").join("Plugins").join("readme.md"), "").unwrap();
        std::fs::write(docs.join("TMInterface").join("config.txt"), "").unwrap();
        let app = t.path().join("Programs").join("ForeverTAS");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("ForeverTAS.exe"), "MZ").unwrap();
        let entries = vec![
            UninstallEntry { name: "TmNationsForever".into(), location: None },
            UninstallEntry { name: "ForeverTAS version 0.2.7".into(), location: Some(app.clone()) },
        ];
        let i = info(Some(docs), &entries, None, None);
        assert!(i.tminterface);
        assert_eq!(i.plugins, vec!["Python_Link.as".to_string(), "TMDriver\\".to_string()]);
        let f = |k: &str| i.folders.iter().find(|x| x.key == k).unwrap().exists;
        assert!(f("scripts") && f("plugins") && f("config"));
        assert!(!f("states") && !f("replays"));
        assert!(!docs.join("TMInterface").join("States").exists(), "nothing is created");
        assert!(i.forevertas.installed);
        assert_eq!(i.forevertas.version.as_deref(), Some("0.2.7"));
        assert!(target(docs, "states").is_none());
        assert!(target(docs, "config").is_some());
        assert!(target(docs, "nonsense").is_none());
        let none = forevertas(&[]);
        assert!(!none.installed);
        assert_eq!(none.homepage, FOREVERTAS_HOME);
    }

    #[test]
    fn detects_tick_loosely_and_only_real_exes() {
        let t = tempfile::tempdir().unwrap();
        let programs = t.path().join("Programs");
        let dir = programs.join("TICK");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("unins000.exe"), "MZ").unwrap();
        // Nothing yet: only an uninstaller in the folder.
        assert!(!tick(&[], Some(&programs), None).installed);
        std::fs::write(dir.join("TICK.exe"), "MZ").unwrap();
        let found = tick(&[], Some(&programs), None);
        assert!(found.installed && found.exe.unwrap().ends_with("TICK.exe"));
        // From the uninstall list, with its version.
        let other = t.path().join("Elsewhere");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("tick-app.exe"), "MZ").unwrap();
        let e = [UninstallEntry { name: "TICK 2.2.0".into(), location: Some(other.clone()) }, UninstallEntry { name: "Ticket Tool".into(), location: None }];
        let v = tick(&e, None, None);
        assert!(v.installed);
        assert_eq!(v.version.as_deref(), Some("2.2.0"));
        // Picked by hand: only an existing .exe counts.
        assert!(!tick(&[], None, Some(&other.join("missing.exe"))).installed);
        assert!(tick(&[], None, Some(&other.join("tick-app.exe"))).installed);
        assert_eq!(tick(&[], None, None).homepage, TICK_HOME);
    }
}
