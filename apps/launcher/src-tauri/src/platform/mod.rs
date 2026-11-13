//! Everything that differs between operating systems: known folders, registry/uninstall
//! data, store manifests, processes, spawning, the URL protocol and code signatures.
//! Commands and the scanner only use the functions re-exported here, never Windows types.
//! `windows` is the Windows implementation; `linux` finds the games inside Wine/Proton
//! prefixes (`wine` holds the OS-independent prefix logic, see docs/linux.md).

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub mod wine;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod linux;
#[cfg(not(windows))]
pub use self::linux::*;

/// A running process: id, lower-case exe name and (when it could be read) the full exe path.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    pub path: Option<PathBuf>,
}

/// One entry of the system's "installed programs" list.
#[derive(Debug, Clone)]
pub struct UninstallEntry {
    pub name: String,
    pub location: Option<PathBuf>,
}

/// A Ubisoft Connect install (launcher game id + folder).
#[derive(Debug, Clone)]
pub struct UbisoftInstall {
    pub id: u32,
    pub dir: PathBuf,
}

/// Result of a code-signature check on a downloaded setup.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    /// The signature is present and the chain is trusted.
    pub trusted: bool,
    /// Human readable result ("Signed and trusted", "Not signed", ...).
    pub detail: String,
    /// Subject name of the signing certificate ("Nadeo", "Ubisoft Entertainment"), when signed.
    pub signer: Option<String>,
}

// ------------------------------------------------------------------ Linux settings hook

struct LinuxConfig {
    settings: wine::LinuxSettings,
    data_dir: Option<PathBuf>,
    generation: u64,
}

static CONFIG: RwLock<LinuxConfig> = RwLock::new(LinuxConfig { settings: wine::LinuxSettings { runner: String::new(), wine: None, proton: None, prefix: None, prefixes: Vec::new(), games: std::collections::BTreeMap::new() }, data_dir: None, generation: 0 });

/// Hands the Linux settings (runner, prefixes) to the platform layer. Called when the settings
/// are loaded and saved; does nothing useful on Windows.
/// Dev/test: `TMHUB_DOCUMENTS_DIR` stands in for the Documents folder (sandbox runs and screenshots).
pub fn documents_override() -> Option<std::path::PathBuf> {
    std::env::var_os("TMHUB_DOCUMENTS_DIR").filter(|d| !d.is_empty()).map(std::path::PathBuf::from)
}

pub fn configure(settings: &wine::LinuxSettings, data_dir: Option<&Path>) {
    let mut c = CONFIG.write().unwrap();
    c.settings = settings.clone();
    if let Some(d) = data_dir {
        c.data_dir = Some(d.to_path_buf());
    }
    c.generation += 1;
}

/// (settings, app data dir, generation): the generation changes on every `configure`.
#[allow(dead_code)]
pub(crate) fn config() -> (wine::LinuxSettings, Option<PathBuf>, u64) {
    let c = CONFIG.read().unwrap();
    (c.settings.clone(), c.data_dir.clone(), c.generation)
}

/// The path with the letter case it has on disk (Linux: games and mods spell folders in any
/// case). Windows file systems ignore case already, so there it is the path itself.
pub fn ci(p: &Path) -> Cow<'_, Path> {
    #[cfg(windows)]
    {
        Cow::Borrowed(p)
    }
    #[cfg(not(windows))]
    {
        wine::resolve_ci(p)
    }
}
