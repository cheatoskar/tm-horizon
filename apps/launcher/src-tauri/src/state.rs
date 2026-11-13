//! Shared app state.

use crate::gameinstall::Verdict;
use crate::modindex::RawIndex;
use crate::scan::Snapshot;
use crate::settings::{self, Settings};
use crate::web::WebState;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

pub struct PreparedSetup {
    pub url: String,
    pub path: PathBuf,
    pub verdict: Verdict,
}

pub struct AppState {
    pub settings_path: PathBuf,
    pub settings: Mutex<Settings>,
    pub snapshot: Mutex<Option<Snapshot>>,
    pub raw_index: Mutex<RawIndex>,
    pub web: Mutex<WebState>,
    pub web_page: Mutex<String>,
    pub web_force_nav: AtomicBool,
    /// Paths the embedded browser was told to save to (to tell "ours" from normal downloads).
    pub routed: Mutex<Vec<PathBuf>>,
    pub pending_links: Mutex<Vec<String>>,
    /// .Gbx files handed over on the command line ("Open with"), for the open dialog.
    pub pending_files: Mutex<Vec<String>>,
    pub setups: Mutex<HashMap<String, PreparedSetup>>,
    pub drive_scan_cancel: Arc<AtomicBool>,
    pub drive_scan_running: AtomicBool,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
}

impl AppState {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        let settings_path = settings::file_in(&config_dir);
        let mut s = settings::load(&settings_path);
        if !settings_path.exists() {
            // Fresh install: the setup wizard opens once.
            s.setup_done = Some(false);
        }
        crate::platform::configure(&s.linux, Some(&data_dir));
        AppState {
            settings_path,
            settings: Mutex::new(s),
            snapshot: Mutex::new(None),
            raw_index: Mutex::new(RawIndex::default()),
            web: Mutex::new(WebState::default()),
            web_page: Mutex::new(String::new()),
            web_force_nav: AtomicBool::new(false),
            routed: Mutex::new(Vec::new()),
            pending_links: Mutex::new(Vec::new()),
            pending_files: Mutex::new(Vec::new()),
            setups: Mutex::new(HashMap::new()),
            drive_scan_cancel: Arc::new(AtomicBool::new(false)),
            drive_scan_running: AtomicBool::new(false),
            data_dir,
            cache_dir,
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut s = self.settings.lock().unwrap();
        f(&mut s);
        settings::save(&self.settings_path, &s)?;
        Ok(s.clone())
    }

    pub fn tmloader_root(&self) -> Option<PathBuf> {
        let s = self.settings();
        // Linux: TMLoader that the guided setup put into a game's own prefix counts too.
        #[cfg(not(windows))]
        let extra = crate::tmloader::prefix_roots(&s.linux, std::env::var("USER").ok().as_deref());
        #[cfg(windows)]
        let extra: Vec<PathBuf> = vec![];
        crate::tmloader::resolve_root_in(s.tmloader_dir.as_deref(), &extra)
    }

    /// First install folder of a game (ManiaPlanet titles share ManiaPlanet's).
    pub fn install_dir(&self, game: &str) -> Option<PathBuf> {
        self.install(game).map(|i| PathBuf::from(i.path))
    }

    pub fn install(&self, game: &str) -> Option<crate::scan::InstallInfo> {
        let selected = self.settings.lock().unwrap().selected_install.get(game).cloned();
        let snap = self.snapshot.lock().unwrap();
        let g = &snap.as_ref()?.games;
        let list = match game {
            "tmnf" => &g.tmnf.installs,
            "tmuf" => &g.tmuf.installs,
            "tmn-eswc" => &g.eswc.installs,
            "tm2020" => &g.tm2020.installs,
            "tm-turbo" => &g.turbo.installs,
            "tm-original" => &g.original.installs,
            "tm-sunrise" => &g.sunrise.installs,
            "tm-2003" => &g.tm2003.installs,
            "tm-ds" => &g.ds.installs,
            "tm-turbo-ds" => &g.turbo_ds.installs,
            "tm-wii" => &g.wii.installs,
            g2 if crate::launch::title_id(g2).is_some() => &g.maniaplanet.installs,
            _ => return None,
        };
        pick_install(list, selected.as_deref()).cloned()
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.data_dir.join("backups").join(crate::fsx::stamp())
    }

    pub fn was_routed(&self, p: &Path) -> bool {
        let n = crate::fsx::norm(p);
        self.routed.lock().unwrap().iter().any(|r| crate::fsx::norm(r) == n)
    }
}

/// The install a game starts: the one the player picked when it is still in the list, else the first.
pub fn pick_install<'a>(list: &'a [crate::scan::InstallInfo], selected: Option<&str>) -> Option<&'a crate::scan::InstallInfo> {
    selected
        .and_then(|sel| list.iter().find(|i| crate::fsx::norm(Path::new(&i.path)) == crate::fsx::norm(Path::new(sel))))
        .or_else(|| list.first())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst(p: &str) -> crate::scan::InstallInfo {
        crate::scan::InstallInfo { source: "x".into(), path: p.into(), exe: None, launcher: None, launch: None, modified: None, note: None, steam_app_id: None, rom: None, extra_args: vec![] }
    }

    #[test]
    fn picked_install_wins_until_it_is_gone() {
        let l = vec![inst("C:/Games/A"), inst("D:/Games/B")];
        assert_eq!(pick_install(&l, None).unwrap().path, "C:/Games/A");
        assert_eq!(pick_install(&l, Some(r"D:\Games\B")).unwrap().path, "D:/Games/B");
        assert_eq!(pick_install(&l, Some("E:/gone")).unwrap().path, "C:/Games/A", "a removed folder falls back");
        assert!(pick_install(&[], Some("D:/Games/B")).is_none());
    }
}
