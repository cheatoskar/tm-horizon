//! TM Horizon's own settings (JSON in the app's config folder). No passwords are ever stored;
//! embedded sites keep their logins in their own WebView2 profile (see web.rs).

use crate::scan::FoundInstall;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const DEFAULT_HUB_URL: &str = "https://cheatoskar.github.io/tm-hub/";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Where hub.json, servers.json, ... are fetched from (bundled copy when it fails).
    pub hub_url: String,
    /// JSON with {version, url, notes} for the update check; empty = hub_url + "launcher.json".
    pub update_url: String,
    /// Dev/sandbox: use this TMLoader folder instead of %LOCALAPPDATA%\TMLoader.
    pub tmloader_dir: Option<String>,
    /// ESWC: start TmNationsESWCLauncher.exe (Nadeo's settings dialog) instead of the game.
    pub eswc_use_launcher: bool,
    /// The same choice for the other games with a Nadeo launcher, per game id ("tmnf", "tmuf":
    /// TmForeverLauncher.exe). Missing = off (the game exe directly).
    pub use_launcher: BTreeMap<String, bool>,
    /// The first-run question about tmhub:// links was answered.
    pub protocol_asked: bool,
    /// Folders added with "Add folder".
    pub extra_folders: Vec<String>,
    /// Result of the last "Scan drives".
    pub found_installs: Vec<FoundInstall>,
    /// SHA-256 of each game setup URL, recorded at its first download.
    pub installer_hashes: BTreeMap<String, String>,
    /// Old setting (the player used to type an application id). Still read from old files,
    /// no longer used: the id is baked into the build (`discord::DISCORD_APP_ID`).
    pub discord_app_id: String,
    /// "Show what I play in Discord" (Rich Presence), off by default.
    pub discord_presence: bool,
    /// "Show TAS tool in Discord": TAS sessions show the tool; only counts with the switch above.
    pub discord_tas: bool,
    /// "Load game covers from the internet": the official Steam library covers, fetched once from
    /// Steam's CDN and cached (on by default). Off: only TM Horizon's own covers.
    pub cover_downloads: bool,
    /// UI language: "en", "de", "pl", "fr"; empty = follow Windows.
    pub language: String,
    /// "dark" (default), "midnight" (black backgrounds) or "light".
    pub theme: String,
    /// Accent colour: "orange" (default), "blue", "green", "purple", "red" or "game" (from the
    /// selected game's cover).
    pub accent: String,
    /// "normal" (default) or "compact" (smaller paddings and row heights).
    pub density: String,
    /// Mods page layout: "tiles" (default, cards with description) or "list" (compact rows).
    pub mods_view: String,
    /// Game shown on Home at start ("" = the last one / first installed).
    pub default_game: String,
    /// Play on Home starts at once instead of opening the game's start panel first.
    pub play_from_home: bool,
    /// TICK (Trackmania 2020 TAS tool) picked by hand when it is not found on its own.
    pub tick_exe: Option<String>,
    /// Update channel: "stable" (default) or "beta".
    pub update_channel: String,
    /// Look for a new TM Horizon at start.
    pub update_at_start: bool,
    /// Download updates in the background and install them at the next start or when the launcher closes.
    pub update_auto: bool,
    /// Install folder the player picked per game (Play, the Horizon Host card and the game page use
    /// the same one); a folder that is no longer an install of the game is ignored.
    pub selected_install: BTreeMap<String, String>,
    /// Linux: runner (Wine / umu / Proton) and prefixes, per game (see platform/wine.rs).
    pub linux: crate::platform::wine::LinuxSettings,
    /// First-run setup: Some(false) on a fresh install until the wizard was finished or skipped;
    /// None in settings from before 0.4 (counts as done, no wizard for existing users).
    pub setup_done: Option<bool>,
    /// Console games: emulators, the player's dump files, Dolphin options (consoles.rs).
    pub consoles: crate::consoles::ConsoleSettings,
    /// "Recommended for your game" items the player closed ("<game>:<item>").
    pub suggestions_dismissed: Vec<String>,
    /// Sidebar pages the player hid (Settings > Pages, setup wizard). Only the sidebar entry goes: links
    /// and buttons still open the page. Never Home, Library or Mods (`clean_hidden_pages`).
    pub hidden_pages: Vec<String>,
    /// Extra replay folders for Statistics per game family (`stats::FAMILIES`), e.g. moved Autosaves.
    pub stats_replay_folders: BTreeMap<String, Vec<String>>,
}

/// Sidebar pages that can be hidden (Home, Library and Mods always stay).
pub const OPTIONAL_PAGES: [&str; 8] = ["news", "maps", "skins", "media", "stats", "profiles", "servers", "community"];

/// Known optional pages only, each once, in sidebar order.
pub fn clean_hidden_pages(v: &[String]) -> Vec<String> {
    OPTIONAL_PAGES.iter().filter(|p| v.iter().any(|x| x == *p)).map(|p| p.to_string()).collect()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hub_url: DEFAULT_HUB_URL.into(),
            update_url: String::new(),
            tmloader_dir: None,
            eswc_use_launcher: false,
            use_launcher: BTreeMap::new(),
            protocol_asked: false,
            extra_folders: vec![],
            found_installs: vec![],
            installer_hashes: BTreeMap::new(),
            discord_app_id: String::new(),
            discord_presence: false,
            discord_tas: true,
            cover_downloads: true,
            language: String::new(),
            theme: "dark".into(),
            accent: "orange".into(),
            density: "normal".into(),
            mods_view: "tiles".into(),
            default_game: String::new(),
            play_from_home: false,
            tick_exe: None,
            update_channel: "stable".into(),
            update_at_start: true,
            update_auto: true,
            selected_install: BTreeMap::new(),
            linux: Default::default(),
            setup_done: None,
            consoles: Default::default(),
            suggestions_dismissed: vec![],
            hidden_pages: vec![],
            stats_replay_folders: BTreeMap::new(),
        }
    }
}

impl Settings {
    /// Start this game through its own Nadeo launcher (see `launch::PlanInput::use_launcher`)?
    pub fn uses_launcher(&self, game: &str) -> bool {
        match game {
            "tmn-eswc" => self.eswc_use_launcher,
            g => self.use_launcher.get(g).copied().unwrap_or(false),
        }
    }

    /// Sets the choice for one game (ESWC keeps its old field).
    pub fn set_use_launcher(&mut self, game: &str, on: bool) {
        match game {
            "tmn-eswc" => self.eswc_use_launcher = on,
            g => {
                self.use_launcher.insert(g.to_string(), on);
            }
        }
    }

    /// Adds an extra Statistics replay folder for a family; false for an unknown family or a folder
    /// that is already in the list (same path after normalising).
    pub fn add_replay_folder(&mut self, family: &str, dir: &Path) -> bool {
        if !crate::stats::FAMILIES.contains(&family) {
            return false;
        }
        let list = self.stats_replay_folders.entry(family.to_string()).or_default();
        if list.iter().any(|x| crate::fsx::norm(Path::new(x)) == crate::fsx::norm(dir)) {
            return false;
        }
        list.push(dir.to_string_lossy().into_owned());
        true
    }

    /// Removes an extra Statistics replay folder (an emptied family is dropped from the map).
    pub fn remove_replay_folder(&mut self, family: &str, dir: &Path) {
        if let Some(list) = self.stats_replay_folders.get_mut(family) {
            list.retain(|x| crate::fsx::norm(Path::new(x)) != crate::fsx::norm(dir));
            if list.is_empty() {
                self.stats_replay_folders.remove(family);
            }
        }
    }
}

/// Reads the settings. A file that cannot be parsed is not silently replaced: it is kept as
/// `settings.broken-<time>.json` next to it (and the defaults are used), so nothing is lost.
pub fn load(path: &Path) -> Settings {
    let Ok(text) = std::fs::read_to_string(path) else { return Settings::default() };
    match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(e) => {
            let keep = path.with_file_name(format!("settings.broken-{}.json", crate::fsx::stamp()));
            let _ = std::fs::copy(path, &keep);
            eprintln!("TM Horizon: {} could not be read ({e}); kept as {}", path.display(), keep.display());
            Settings::default()
        }
    }
}

pub fn save(path: &Path, s: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    crate::fsx::write(path, json.as_bytes())
}

pub fn file_in(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_defaults() {
        let t = tempfile::tempdir().unwrap();
        let p = file_in(t.path());
        assert_eq!(load(&p), Settings::default());
        let mut s = Settings::default();
        s.extra_folders.push(r"D:\Games\TMNF".into());
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
        std::fs::write(&p, r#"{"hubUrl":"https://x/"}"#).unwrap();
        let l = load(&p);
        assert_eq!(l.hub_url, "https://x/");
        assert!(!l.eswc_use_launcher);
        assert!(!l.uses_launcher("tmuf") && !l.uses_launcher("tmn-eswc"));
        assert!(!l.discord_presence);
        assert_eq!(l.density, "normal");
        assert_eq!(l.mods_view, "tiles", "old files get the tiles layout");
        // Old files with a typed Discord id still load.
        std::fs::write(&p, r#"{"discordAppId":"123"}"#).unwrap();
        assert_eq!(load(&p).discord_app_id, "123");
        // Broken JSON: defaults, but the file is kept.
        std::fs::write(&p, "{ not json").unwrap();
        assert_eq!(load(&p), Settings::default());
        let kept: Vec<_> = std::fs::read_dir(t.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("settings.broken-")).collect();
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn hidden_pages_and_replay_folders_round_trip() {
        let t = tempfile::tempdir().unwrap();
        let p = file_in(t.path());
        // A settings.json from 0.5.3 (no new fields) loads with every page shown and no extra folders.
        std::fs::write(&p, r#"{"hubUrl":"https://x/","theme":"midnight","setupDone":true,"suggestionsDismissed":["tmnf:x"]}"#).unwrap();
        let old = load(&p);
        assert_eq!(old.theme, "midnight");
        assert!(old.hidden_pages.is_empty());
        assert!(old.stats_replay_folders.is_empty());
        let mut s = old.clone();
        s.hidden_pages = clean_hidden_pages(&["servers".into(), "home".into(), "news".into(), "news".into(), "nope".into(), "mods".into(), "library".into()]);
        assert_eq!(s.hidden_pages, vec!["news".to_string(), "servers".to_string()], "home, library, mods and unknown pages never hidden");
        assert!(s.add_replay_folder("forever", Path::new(r"D:\TM\Autosaves old")));
        assert!(!s.add_replay_folder("forever", Path::new(r"d:\tm\autosaves old")), "same folder twice");
        assert!(!s.add_replay_folder("nope", Path::new(r"D:\X")), "unknown family");
        assert!(s.add_replay_folder("tmn-eswc", Path::new(r"E:\ESWC replays")));
        save(&p, &s).unwrap();
        let back = load(&p);
        assert_eq!(back, s);
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("\"hiddenPages\"") && text.contains("\"statsReplayFolders\""), "camelCase keys");
        let mut r = back;
        r.remove_replay_folder("tmn-eswc", Path::new(r"e:\eswc replays"));
        assert!(!r.stats_replay_folders.contains_key("tmn-eswc"));
        assert_eq!(r.stats_replay_folders["forever"].len(), 1);
    }
}
