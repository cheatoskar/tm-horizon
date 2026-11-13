//! Per-exe Windows settings for the classic games (no admin, current user only):
//! fullscreen optimisations off, DPI override, GPU preference "high performance".
//!
//! Everything is a value in HKCU, named by the full path of the game exe:
//! - `...\AppCompatFlags\Layers`: `~ DISABLEDXMAXIMIZEDWINDOWEDMODE HIGHDPIAWARE` (other flags that are
//!   already there are kept; undo removes only mine),
//! - `...\DirectX\UserGpuPreferences`: `GpuPreference=2;` (other `key=value;` parts are kept).
//!
//! Apply shows a diff first (the UI asks), every write records the previous value (or "absent") in
//! `optimize-journal.json` in the launcher data folder, "Undo" puts exactly those values back.
//! Shared small preferences of the performance panel live in `perf-prefs.json` (same folder).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const LAYERS_PATH: &str = r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";
pub const GPU_PATH: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";
pub const FLAG_FSO: &str = "DISABLEDXMAXIMIZEDWINDOWEDMODE";
pub const FLAG_DPI: &str = "HIGHDPIAWARE";

/// Games this panel is for, with the exe name each one runs.
pub fn game_exe_name(game: &str) -> Option<&'static str> {
    match game {
        "tmnf" | "tmuf" => Some("TmForever.exe"),
        "tmn-eswc" => Some("TmNationsESWC.exe"),
        "tm-sunrise" => Some("TmSunrise.exe"),
        _ => None,
    }
}

// ------------------------------------------------------------------ pure value helpers

fn tokens(v: &str) -> Vec<String> {
    v.split_whitespace().filter(|t| *t != "~").map(String::from).collect()
}

fn has_token(toks: &[String], flag: &str) -> bool {
    toks.iter().any(|t| t.eq_ignore_ascii_case(flag))
}

/// Adds (`on`) or removes (`!on`) one flag of an AppCompat Layers value. The result always starts
/// with the `~ ` marker; `None` = nothing is left, the value should be deleted.
pub fn layers_set(old: Option<&str>, flag: &str, on: bool) -> Option<String> {
    let mut t = old.map(tokens).unwrap_or_default();
    if on {
        if !has_token(&t, flag) {
            t.push(flag.to_string());
        }
    } else {
        t.retain(|x| !x.eq_ignore_ascii_case(flag));
    }
    if t.is_empty() {
        None
    } else {
        Some(format!("~ {}", t.join(" ")))
    }
}

pub fn layers_has(v: Option<&str>, flag: &str) -> bool {
    v.map(|s| has_token(&tokens(s), flag)).unwrap_or(false)
}

fn gpu_parts(v: &str) -> Vec<(String, String)> {
    v.split(';')
        .filter_map(|p| {
            let p = p.trim();
            if p.is_empty() {
                return None;
            }
            let (k, val) = p.split_once('=').unwrap_or((p, ""));
            Some((k.trim().to_string(), val.trim().to_string()))
        })
        .collect()
}

/// Sets `GpuPreference=2;` (`on`) or removes the key, keeping all other `key=value;` parts.
pub fn gpu_set(old: Option<&str>, on: bool) -> Option<String> {
    let mut parts = old.map(gpu_parts).unwrap_or_default();
    let pos = parts.iter().position(|(k, _)| k.eq_ignore_ascii_case("GpuPreference"));
    if on {
        match pos {
            Some(i) => parts[i].1 = "2".into(),
            None => parts.insert(0, ("GpuPreference".into(), "2".into())),
        }
    } else if let Some(i) = pos {
        parts.remove(i);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.iter().map(|(k, v)| format!("{k}={v};")).collect::<String>())
    }
}

pub fn gpu_is_high(v: Option<&str>) -> bool {
    v.map(|s| gpu_parts(s).iter().any(|(k, val)| k.eq_ignore_ascii_case("GpuPreference") && val == "2")).unwrap_or(false)
}

// ------------------------------------------------------------------ registry store

pub trait Store {
    fn get(&self, path: &str, name: &str) -> Option<String>;
    fn set(&mut self, path: &str, name: &str, value: &str) -> Result<(), String>;
    fn delete(&mut self, path: &str, name: &str) -> Result<(), String>;
}

#[cfg(windows)]
pub struct Hkcu;

#[cfg(windows)]
impl Store for Hkcu {
    fn get(&self, path: &str, name: &str) -> Option<String> {
        use winreg::{enums::*, RegKey};
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(path, KEY_READ).ok()?.get_value::<String, _>(name).ok()
    }
    fn set(&mut self, path: &str, name: &str, value: &str) -> Result<(), String> {
        use winreg::{enums::*, RegKey};
        let (k, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey_with_flags(path, KEY_WRITE).map_err(|e| e.to_string())?;
        k.set_value(name, &value.to_string()).map_err(|e| e.to_string())
    }
    fn delete(&mut self, path: &str, name: &str) -> Result<(), String> {
        use winreg::{enums::*, RegKey};
        match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(path, KEY_WRITE) {
            Ok(k) => match k.delete_value(name) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ------------------------------------------------------------------ plan / apply / undo

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Change {
    /// "layers" | "gpu"
    pub kind: String,
    pub path: String,
    pub name: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

impl Default for Change {
    fn default() -> Self {
        Change { kind: String::new(), path: String::new(), name: String::new(), old: None, new: None }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Want {
    pub fso: bool,
    pub dpi: bool,
    pub gpu: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub fso: bool,
    pub dpi: bool,
    pub gpu: bool,
}

pub fn read_state(s: &dyn Store, layers: &str, gpu: &str, exe: &str) -> State {
    let l = s.get(layers, exe);
    State { fso: layers_has(l.as_deref(), FLAG_FSO), dpi: layers_has(l.as_deref(), FLAG_DPI), gpu: gpu_is_high(s.get(gpu, exe).as_deref()) }
}

/// What would change for the wanted state (empty = already so).
pub fn plan(s: &dyn Store, layers: &str, gpu: &str, exe: &str, want: Want) -> Vec<Change> {
    let mut out = vec![];
    let old_l = s.get(layers, exe);
    let mut t = old_l.as_deref().map(tokens).unwrap_or_default();
    for (flag, on) in [(FLAG_FSO, want.fso), (FLAG_DPI, want.dpi)] {
        if on {
            if !has_token(&t, flag) {
                t.push(flag.into());
            }
        } else {
            t.retain(|x| !x.eq_ignore_ascii_case(flag));
        }
    }
    let new_l = if t.is_empty() { None } else { Some(format!("~ {}", t.join(" "))) };
    let same_flags = {
        let mut a: Vec<String> = old_l.as_deref().map(tokens).unwrap_or_default().iter().map(|x| x.to_uppercase()).collect();
        let mut b: Vec<String> = new_l.as_deref().map(tokens).unwrap_or_default().iter().map(|x| x.to_uppercase()).collect();
        a.sort();
        b.sort();
        a == b
    };
    if !same_flags {
        out.push(Change { kind: "layers".into(), path: layers.into(), name: exe.into(), old: old_l, new: new_l });
    }
    let old_g = s.get(gpu, exe);
    if gpu_is_high(old_g.as_deref()) != want.gpu {
        out.push(Change { kind: "gpu".into(), path: gpu.into(), name: exe.into(), new: gpu_set(old_g.as_deref(), want.gpu), old: old_g });
    }
    out
}

fn write_value(s: &mut dyn Store, path: &str, name: &str, v: &Option<String>) -> Result<(), String> {
    match v {
        Some(x) => s.set(path, name, x),
        None => s.delete(path, name),
    }
}

pub fn write_changes(s: &mut dyn Store, changes: &[Change]) -> Result<(), String> {
    for c in changes {
        write_value(s, &c.path, &c.name, &c.new)?;
    }
    Ok(())
}

pub fn restore_changes(s: &mut dyn Store, changes: &[Change]) -> Result<(), String> {
    for c in changes {
        write_value(s, &c.path, &c.name, &c.old)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ journal

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    pub id: String,
    pub time: String,
    pub game: String,
    pub exe: String,
    pub changes: Vec<Change>,
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Journal {
    pub entries: Vec<Entry>,
}

pub fn journal_path(data: &Path) -> PathBuf {
    data.join("optimize-journal.json")
}

pub fn load_journal(data: &Path) -> Journal {
    std::fs::read_to_string(journal_path(data)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_journal(data: &Path, j: &Journal) -> Result<(), String> {
    crate::fsx::write(&journal_path(data), serde_json::to_string_pretty(j).map_err(|e| e.to_string())?.as_bytes())
}

/// Applies the wanted state: writes, journals the old values. Returns the changes.
pub fn apply(s: &mut dyn Store, data: &Path, layers: &str, gpu: &str, game: &str, exe: &str, want: Want) -> Result<Vec<Change>, String> {
    let ch = plan(s, layers, gpu, exe, want);
    if ch.is_empty() {
        return Ok(ch);
    }
    // Journal first: if the write fails half way, the old values are still on record.
    let mut j = load_journal(data);
    j.entries.push(Entry { id: crate::fsx::stamp(), time: crate::fsx::now_iso(), game: game.into(), exe: exe.into(), changes: ch.clone(), undone: false });
    save_journal(data, &j)?;
    write_changes(s, &ch)?;
    Ok(ch)
}

/// Puts back the values of the newest entry of this game that is not undone yet.
pub fn undo(s: &mut dyn Store, data: &Path, game: &str) -> Result<Vec<Change>, String> {
    let mut j = load_journal(data);
    let Some(e) = j.entries.iter_mut().rev().find(|e| e.game == game && !e.undone) else { return Err("Nothing to undo".into()) };
    restore_changes(s, &e.changes)?;
    e.undone = true;
    let ch = e.changes.clone();
    save_journal(data, &j)?;
    Ok(ch)
}

pub fn can_undo(data: &Path, game: &str) -> bool {
    load_journal(data).entries.iter().any(|e| e.game == game && !e.undone)
}

// ------------------------------------------------------------------ small shared prefs

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub last_map: Option<String>,
    pub archive_days: u32,
    pub archive_keep: u32,
    pub record_start: BTreeMap<String, bool>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { last_map: None, archive_days: 60, archive_keep: 300, record_start: BTreeMap::new() }
    }
}

pub fn load_prefs(data: &Path) -> Prefs {
    std::fs::read_to_string(data.join("perf-prefs.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_prefs(data: &Path, p: &Prefs) -> Result<(), String> {
    crate::fsx::write(&data.join("perf-prefs.json"), serde_json::to_string_pretty(p).map_err(|e| e.to_string())?.as_bytes())
}

/// Is the game itself running? Only the game's exe counts (`TmForever.exe` for TMNF/TMUF): TMLoader's
/// window or tray icon often stays open after the game closed, and nothing the callers write (files next to
/// the game exe, the config in Documents, replays, the Play button's state) belongs to TMLoader.
pub fn game_running(st: &crate::state::AppState, game: &str) -> bool {
    let exe = st.install(game).and_then(|i| i.exe);
    game_running_in(&crate::platform::running_process_names(), game, exe.as_deref())
}

/// `game_running` on a given process list.
pub fn game_running_in(running: &[String], game: &str, exe: Option<&str>) -> bool {
    let want = crate::discord::process_names(game, exe);
    running.iter().any(|p| want.iter().any(|w| p.eq_ignore_ascii_case(w)))
}

/// Why a change has to wait, as a message (None: go ahead). `exes` = the game's own processes; `tmloader` =
/// the change writes into TMLoader's install (its products or profiles): only then an open TMLoader counts.
pub fn close_first(running: &[String], exes: &[&str], tmloader: bool) -> Option<String> {
    if let Some(p) = running.iter().find(|p| exes.iter().any(|e| p.eq_ignore_ascii_case(e))) {
        return Some(format!("{p} is running. Close the game first."));
    }
    if tmloader && running.iter().any(|p| p.eq_ignore_ascii_case("tmloader.exe")) {
        return Some("TMLoader is open. Close it first (also its tray icon).".into());
    }
    None
}

// ------------------------------------------------------------------ commands

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptState {
    pub supported: bool,
    pub reason: Option<String>,
    pub exe: Option<String>,
    pub fso: bool,
    pub dpi: bool,
    pub gpu: bool,
    pub can_undo: bool,
}

fn exe_of(st: &crate::state::AppState, game: &str) -> Result<String, String> {
    let want = game_exe_name(game).ok_or("Not available for this game")?;
    let exe = st.install(game).and_then(|i| i.exe).ok_or("The game is not installed")?;
    let p = Path::new(&exe);
    if crate::fsx::blocked(p) {
        return Err("This folder is protected".into());
    }
    if !p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(want)).unwrap_or(false) {
        return Err(format!("{want} not found"));
    }
    Ok(exe)
}

#[tauri::command]
pub async fn optimize_state(app: tauri::AppHandle, game_id: String) -> OptState {
    crate::bg::run(move || -> OptState {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let mut o = OptState { supported: false, reason: None, exe: None, fso: false, dpi: false, gpu: false, can_undo: false };
        #[cfg(not(windows))]
        {
            o.reason = Some("Windows only".into());
            let _ = (&st, &game_id);
            return o;
        }
        #[cfg(windows)]
        {
            match exe_of(&st, &game_id) {
                Ok(exe) => {
                    let s = read_state(&Hkcu, LAYERS_PATH, GPU_PATH, &exe);
                    o.supported = true;
                    o.fso = s.fso;
                    o.dpi = s.dpi;
                    o.gpu = s.gpu;
                    o.can_undo = can_undo(&st.data_dir, &game_id);
                    o.exe = Some(exe);
                }
                Err(e) => o.reason = Some(e),
            }
            o
        }
    })
    .await
}

#[tauri::command]
pub async fn optimize_plan(app: tauri::AppHandle, game_id: String, want: Want) -> Result<Vec<Change>, String> {
    crate::bg::run(move || -> Result<Vec<Change>, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        #[cfg(not(windows))]
        {
            let _ = (&st, &game_id, &want);
            Err("Windows only".into())
        }
        #[cfg(windows)]
        {
            let exe = exe_of(&st, &game_id)?;
            Ok(plan(&Hkcu, LAYERS_PATH, GPU_PATH, &exe, want))
        }
    })
    .await
}

#[tauri::command]
pub async fn optimize_apply(app: tauri::AppHandle, game_id: String, want: Want) -> Result<Vec<Change>, String> {
    crate::bg::run(move || -> Result<Vec<Change>, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        #[cfg(not(windows))]
        {
            let _ = (&st, &game_id, &want);
            Err("Windows only".into())
        }
        #[cfg(windows)]
        {
            let exe = exe_of(&st, &game_id)?;
            apply(&mut Hkcu, &st.data_dir, LAYERS_PATH, GPU_PATH, &game_id, &exe, want)
        }
    })
    .await
}

#[tauri::command]
pub async fn optimize_undo(app: tauri::AppHandle, game_id: String) -> Result<Vec<Change>, String> {
    crate::bg::run(move || -> Result<Vec<Change>, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        #[cfg(not(windows))]
        {
            let _ = (&st, &game_id);
            Err("Windows only".into())
        }
        #[cfg(windows)]
        {
            undo(&mut Hkcu, &st.data_dir, &game_id)
        }
    })
    .await
}

#[tauri::command(async)]
pub fn perf_prefs(st: tauri::State<crate::state::AppState>) -> Prefs {
    load_prefs(&st.data_dir)
}

#[tauri::command(async)]
pub fn perf_prefs_set(st: tauri::State<crate::state::AppState>, prefs: Prefs) -> Result<(), String> {
    save_prefs(&st.data_dir, &prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn procs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_game_exe_counts_as_running() {
        // TMLoader's window or tray icon alone: the game is closed.
        assert!(!game_running_in(&procs(&["explorer.exe", "TMLoader.exe"]), "tmnf", Some(r"C:\TmNationsForever\TmForever.exe")));
        assert!(!game_running_in(&procs(&["TMLoader.exe"]), "tmuf", None));
        assert!(game_running_in(&procs(&["TMLoader.exe", "TmForever.exe"]), "tmuf", None));
        assert!(game_running_in(&procs(&["TmSunrise.exe"]), "tm-sunrise", None));
        assert!(!game_running_in(&procs(&["TmForever.exe"]), "tm-sunrise", None));
    }

    #[test]
    fn close_first_names_tmloader_only_where_it_matters() {
        let exes = ["tmforever.exe"];
        assert_eq!(close_first(&procs(&["TMLoader.exe"]), &exes, false), None);
        assert!(close_first(&procs(&["TMLoader.exe"]), &exes, true).unwrap().starts_with("TMLoader is open"));
        assert!(close_first(&procs(&["TMLoader.exe", "TmForever.exe"]), &exes, true).unwrap().starts_with("TmForever.exe is running"));
        assert_eq!(close_first(&procs(&["explorer.exe"]), &exes, true), None);
    }
    use std::collections::HashMap;

    #[derive(Default)]
    struct Mem(HashMap<(String, String), String>);
    impl Store for Mem {
        fn get(&self, p: &str, n: &str) -> Option<String> {
            self.0.get(&(p.into(), n.into())).cloned()
        }
        fn set(&mut self, p: &str, n: &str, v: &str) -> Result<(), String> {
            self.0.insert((p.into(), n.into()), v.into());
            Ok(())
        }
        fn delete(&mut self, p: &str, n: &str) -> Result<(), String> {
            self.0.remove(&(p.into(), n.into()));
            Ok(())
        }
    }

    const EXE: &str = r"D:\Games\TMNF\TmForever.exe";
    const ALL: Want = Want { fso: true, dpi: true, gpu: true };

    #[test]
    fn layers_merge_keeps_other_flags() {
        assert_eq!(layers_set(None, FLAG_FSO, true).as_deref(), Some("~ DISABLEDXMAXIMIZEDWINDOWEDMODE"));
        assert_eq!(layers_set(Some("~ WIN7RTM"), FLAG_DPI, true).as_deref(), Some("~ WIN7RTM HIGHDPIAWARE"));
        assert_eq!(layers_set(Some("WIN7RTM HIGHDPIAWARE"), FLAG_DPI, true).as_deref(), Some("~ WIN7RTM HIGHDPIAWARE"), "no duplicate, marker added");
        assert_eq!(layers_set(Some("~ WIN7RTM highdpiaware"), FLAG_DPI, false).as_deref(), Some("~ WIN7RTM"), "case-insensitive removal");
        assert_eq!(layers_set(Some("~ HIGHDPIAWARE"), FLAG_DPI, false), None, "nothing left = delete the value");
        assert!(layers_has(Some("~ A HIGHDPIAWARE"), FLAG_DPI));
        assert!(!layers_has(None, FLAG_DPI));
    }

    #[test]
    fn gpu_merge_keeps_other_parts() {
        assert_eq!(gpu_set(None, true).as_deref(), Some("GpuPreference=2;"));
        assert_eq!(gpu_set(Some("GpuPreference=1;"), true).as_deref(), Some("GpuPreference=2;"));
        assert_eq!(gpu_set(Some("SwapEffectUpgradeEnable=1;"), true).as_deref(), Some("GpuPreference=2;SwapEffectUpgradeEnable=1;"));
        assert_eq!(gpu_set(Some("GpuPreference=2;SwapEffectUpgradeEnable=1;"), false).as_deref(), Some("SwapEffectUpgradeEnable=1;"));
        assert_eq!(gpu_set(Some("GpuPreference=2;"), false), None);
        assert!(gpu_is_high(Some("A=1;GpuPreference=2;")));
        assert!(!gpu_is_high(Some("GpuPreference=1;")));
    }

    #[test]
    fn plan_apply_undo_roundtrip() {
        let t = tempfile::tempdir().unwrap();
        let mut s = Mem::default();
        s.set("L", EXE, "~ WIN7RTM").unwrap();
        s.set("G", EXE, "SwapEffectUpgradeEnable=1;").unwrap();
        let ch = plan(&s, "L", "G", EXE, ALL);
        assert_eq!(ch.len(), 2);
        assert_eq!(ch[0].old.as_deref(), Some("~ WIN7RTM"));
        assert_eq!(ch[0].new.as_deref(), Some("~ WIN7RTM DISABLEDXMAXIMIZEDWINDOWEDMODE HIGHDPIAWARE"));
        let done = apply(&mut s, t.path(), "L", "G", "tmnf", EXE, ALL).unwrap();
        assert_eq!(done, ch);
        assert_eq!(read_state(&s, "L", "G", EXE), State { fso: true, dpi: true, gpu: true });
        assert!(plan(&s, "L", "G", EXE, ALL).is_empty(), "second apply changes nothing");
        assert!(can_undo(t.path(), "tmnf"));
        assert!(!can_undo(t.path(), "tmuf"));
        undo(&mut s, t.path(), "tmnf").unwrap();
        assert_eq!(s.get("L", EXE).as_deref(), Some("~ WIN7RTM"));
        assert_eq!(s.get("G", EXE).as_deref(), Some("SwapEffectUpgradeEnable=1;"));
        assert!(undo(&mut s, t.path(), "tmnf").is_err(), "already undone");
    }

    #[test]
    fn absent_values_come_back_as_absent() {
        let t = tempfile::tempdir().unwrap();
        let mut s = Mem::default();
        apply(&mut s, t.path(), "L", "G", "tmnf", EXE, Want { fso: true, dpi: false, gpu: true }).unwrap();
        assert_eq!(s.get("L", EXE).as_deref(), Some("~ DISABLEDXMAXIMIZEDWINDOWEDMODE"));
        undo(&mut s, t.path(), "tmnf").unwrap();
        assert_eq!(s.get("L", EXE), None);
        assert_eq!(s.get("G", EXE), None);
    }

    #[test]
    fn unchecking_removes_only_my_flags() {
        let t = tempfile::tempdir().unwrap();
        let mut s = Mem::default();
        s.set("L", EXE, "~ WIN7RTM DISABLEDXMAXIMIZEDWINDOWEDMODE HIGHDPIAWARE").unwrap();
        apply(&mut s, t.path(), "L", "G", "tmnf", EXE, Want { fso: false, dpi: false, gpu: false }).unwrap();
        assert_eq!(s.get("L", EXE).as_deref(), Some("~ WIN7RTM"));
    }

    #[test]
    fn journal_survives_garbage() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(journal_path(t.path()), "{ nope").unwrap();
        assert!(load_journal(t.path()).entries.is_empty());
        let mut p = load_prefs(t.path());
        assert_eq!((p.archive_days, p.archive_keep), (60, 300));
        p.last_map = Some("x".into());
        save_prefs(t.path(), &p).unwrap();
        assert_eq!(load_prefs(t.path()).last_map.as_deref(), Some("x"));
    }

    #[cfg(windows)]
    #[test]
    fn real_registry_with_test_key() {
        use winreg::{enums::*, RegKey};
        let base = r"Software\TMHorizonTest\optimize";
        let (layers, gpu) = (format!(r"{base}\Layers"), format!(r"{base}\Gpu"));
        let t = tempfile::tempdir().unwrap();
        let mut s = Hkcu;
        s.set(&layers, EXE, "~ WIN7RTM").unwrap();
        apply(&mut s, t.path(), &layers, &gpu, "tmnf", EXE, ALL).unwrap();
        assert_eq!(s.get(&gpu, EXE).as_deref(), Some("GpuPreference=2;"));
        assert!(layers_has(s.get(&layers, EXE).as_deref(), FLAG_FSO));
        undo(&mut s, t.path(), "tmnf").unwrap();
        assert_eq!(s.get(&layers, EXE).as_deref(), Some("~ WIN7RTM"));
        assert_eq!(s.get(&gpu, EXE), None);
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(r"Software\TMHorizonTest");
    }
}
