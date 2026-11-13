//! Settings > Linux: which prefixes were found, which runners exist, and saving the choice
//! (runner and prefix, also per game). On Windows the commands answer with empty lists.

use crate::platform::{self, wine};
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefixInfo {
    pub path: String,
    pub source: String,
    pub steam_app_id: Option<u32>,
    pub documents: Option<String>,
    pub tmloader: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxInfo {
    pub platform: String,
    pub prefixes: Vec<PrefixInfo>,
    pub main_prefix: Option<String>,
    pub wine: Option<String>,
    pub umu: Option<String>,
    pub protons: Vec<String>,
    pub settings: wine::LinuxSettings,
}

#[cfg(not(windows))]
fn s(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(not(windows))]
fn info(settings: wine::LinuxSettings) -> LinuxInfo {
    let user = std::env::var("USER").ok();
    let prefixes = platform::prefixes()
        .into_iter()
        .map(|p| {
            let tml = wine::local_app_data(&p.path, user.as_deref()).map(|l| wine::resolve_ci(&l.join("TMLoader")).is_dir()).unwrap_or(false);
            PrefixInfo { documents: wine::documents(&p.path, user.as_deref()).map(|d| s(&d)), tmloader: tml, path: s(&p.path), source: p.source, steam_app_id: p.steam_app_id }
        })
        .collect();
    let tools = platform::tools();
    LinuxInfo {
        platform: platform::NAME.into(),
        prefixes,
        main_prefix: platform::main_prefix().map(|p| s(&p)),
        wine: tools.wine.map(|p| s(&p)),
        umu: tools.umu.map(|p| s(&p)),
        protons: tools.protons.iter().map(|p| s(p)).collect(),
        settings,
    }
}

#[cfg(windows)]
fn info(settings: wine::LinuxSettings) -> LinuxInfo {
    LinuxInfo { platform: platform::NAME.into(), prefixes: vec![], main_prefix: None, wine: None, umu: None, protons: vec![], settings }
}

#[tauri::command(async)]
pub fn linux_info(st: State<AppState>) -> LinuxInfo {
    info(st.settings().linux)
}

const RUNNERS: &[&str] = &["", "auto", "wine", "umu", "proton"];

/// Saves Settings > Linux. Paths must be absolute folders (or empty); runners one of RUNNERS.
#[tauri::command(async)]
pub fn linux_save(st: State<AppState>, settings: wine::LinuxSettings) -> Result<LinuxInfo, String> {
    let clean = validate(settings)?;
    let saved = st.update_settings(|s| s.linux = clean.clone())?;
    platform::configure(&saved.linux, None);
    Ok(info(saved.linux))
}

fn valid_path(p: &Option<String>) -> Result<Option<String>, String> {
    match p.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(x) if x.starts_with('/') || x.starts_with("~/") || std::path::Path::new(x).is_absolute() => Ok(Some(x.to_string())),
        Some(x) => Err(format!("Not a full path: {x}")),
    }
}

pub fn validate(mut l: wine::LinuxSettings) -> Result<wine::LinuxSettings, String> {
    let runner_ok = |r: &str| RUNNERS.contains(&r.trim().to_lowercase().as_str());
    if !runner_ok(&l.runner) {
        return Err(format!("Unknown runner {}", l.runner));
    }
    l.runner = l.runner.trim().to_lowercase();
    l.wine = valid_path(&l.wine)?;
    l.proton = valid_path(&l.proton)?;
    l.prefix = valid_path(&l.prefix)?;
    l.prefixes = l.prefixes.iter().map(|p| valid_path(&Some(p.clone()))).collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect();
    for (id, g) in l.games.iter_mut() {
        if crate::launch::family(id).is_none() {
            return Err(format!("Unknown game {id}"));
        }
        if let Some(r) = &g.runner {
            if !runner_ok(r) {
                return Err(format!("Unknown runner {r}"));
            }
        }
        g.runner = g.runner.as_deref().map(|r| r.trim().to_lowercase()).filter(|r| !r.is_empty() && r != "auto");
        g.prefix = valid_path(&g.prefix)?;
        g.proton = valid_path(&g.proton)?;
    }
    l.games.retain(|_, g| g.runner.is_some() || g.prefix.is_some() || g.proton.is_some());
    Ok(l)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_linux_settings() {
        let mut l = wine::LinuxSettings { runner: "Proton".into(), prefix: Some("~/Games/tmuf".into()), ..Default::default() };
        l.games.insert("tmnf".into(), wine::LinuxGame { runner: Some("auto".into()), prefix: Some(" ".into()), proton: None });
        l.games.insert("tmuf".into(), wine::LinuxGame { runner: Some("umu".into()), prefix: None, proton: None });
        let v = validate(l.clone()).unwrap();
        assert_eq!(v.runner, "proton");
        assert!(!v.games.contains_key("tmnf"));
        assert_eq!(v.games["tmuf"].runner.as_deref(), Some("umu"));
        l.runner = "dosbox".into();
        assert!(validate(l.clone()).is_err());
        l.runner = "wine".into();
        l.prefix = Some("relative/pfx".into());
        assert!(validate(l.clone()).is_err());
        l.prefix = None;
        l.games.insert("not-a-game".into(), wine::LinuxGame::default());
        assert!(validate(l).is_err());
    }
}
