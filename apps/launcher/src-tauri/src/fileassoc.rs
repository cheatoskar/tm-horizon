//! "Open .Gbx files with TM Horizon" (opt-in, Settings): a per-user file association under
//! HKCU\Software\Classes, no admin rights, fully reversible.
//!
//! On:  ProgID `TMHorizon.Gbx` (`"<exe>" --open-gbx "%1"`, the exe's icon); `.gbx` lists it under
//!      OpenWithProgids; the `.gbx` default of the user's Classes becomes `TMHorizon.Gbx`. The default
//!      that was there before is kept in `.gbx` as `TMHorizon.Previous` (a `-` when there was none).
//! Off: the old default comes back (or the value goes when there was none), the OpenWithProgids
//!      entry and the ProgID are removed. Nothing of the game's own association (HKLM, the
//!      TmForever.Gbx ProgID) is ever changed.
//!
//! Before switching on, the page shows what opens .Gbx files now (`current`). Windows keeps a user
//! choice from "Open with > Always" (`FileExts\.gbx\UserChoice`, hash-protected): while one is set
//! it wins over the Classes default, so the page asks the player to pick TM Horizon there once.
//! Registry access goes through `Reg`, so the tests run against an in-memory registry.

use serde::Serialize;

pub const PROGID: &str = "TMHorizon.Gbx";
pub const PREVIOUS: &str = "TMHorizon.Previous";
pub const FLAG: &str = "--open-gbx";
const CLASSES: &str = r"Software\Classes";
const USER_CHOICE: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.gbx\UserChoice";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Root {
    User,
    Machine,
}

/// The few registry operations needed (string values only; "" = the key's default value).
pub trait Reg {
    fn get(&self, root: Root, key: &str, name: &str) -> Option<String>;
    fn set(&mut self, key: &str, name: &str, value: &str) -> Result<(), String>;
    fn delete_value(&mut self, key: &str, name: &str) -> Result<(), String>;
    fn delete_tree(&mut self, key: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Handler {
    pub progid: String,
    /// The open command of that ProgID.
    pub command: Option<String>,
    /// The program's file name ("TmForever.exe"), from the command.
    pub program: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// TM Horizon is the .gbx default of the user's Classes.
    pub on: bool,
    /// What opens .Gbx files now (None: nothing set). While `on`: what will come back when switched off.
    pub current: Option<Handler>,
    /// A choice from "Open with > Always" that Windows prefers (its ProgID), if any.
    pub user_choice: Option<String>,
    /// That choice is TM Horizon.
    pub user_choice_ours: bool,
}

fn ext_key() -> String {
    format!(r"{CLASSES}\.gbx")
}

fn progid_key(p: &str) -> String {
    format!(r"{CLASSES}\{p}")
}

/// The default value of a key, user first, then machine (what Windows merges into HKCR).
fn merged(reg: &dyn Reg, key: &str, name: &str) -> Option<String> {
    reg.get(Root::User, key, name).or_else(|| reg.get(Root::Machine, key, name)).filter(|v| !v.trim().is_empty())
}

pub fn program_of(command: &str) -> Option<String> {
    let c = command.trim();
    let exe = if let Some(rest) = c.strip_prefix('"') { rest.split('"').next()? } else { c.split_whitespace().next()? };
    exe.rsplit(['\\', '/']).next().map(String::from).filter(|s| !s.is_empty())
}

fn handler(reg: &dyn Reg, progid: &str) -> Handler {
    let command = merged(reg, &format!(r"{}\shell\open\command", progid_key(progid)), "");
    Handler { progid: progid.into(), program: command.as_deref().and_then(program_of), command, name: merged(reg, &progid_key(progid), "") }
}

pub fn status(reg: &dyn Reg) -> Status {
    let user_default = reg.get(Root::User, &ext_key(), "").filter(|v| !v.trim().is_empty());
    let on = user_default.as_deref() == Some(PROGID);
    let current = if on {
        match reg.get(Root::User, &ext_key(), PREVIOUS).filter(|p| p != "-" && !p.is_empty()) {
            Some(p) => Some(handler(reg, &p)),
            // No user default before: the machine's comes back.
            None => reg.get(Root::Machine, &ext_key(), "").filter(|v| !v.trim().is_empty()).map(|p| handler(reg, &p)),
        }
    } else {
        merged(reg, &ext_key(), "").map(|p| handler(reg, &p))
    };
    let user_choice = reg.get(Root::User, USER_CHOICE, "ProgId").filter(|v| !v.trim().is_empty());
    Status { on, user_choice_ours: user_choice.as_deref() == Some(PROGID), current, user_choice }
}

pub fn open_command(exe: &str) -> String {
    format!("\"{exe}\" {FLAG} \"%1\"")
}

/// Switches it on. Keeps the old user default to put back later; doing it twice changes nothing.
pub fn enable(reg: &mut dyn Reg, exe: &str) -> Result<(), String> {
    let ek = ext_key();
    let pk = progid_key(PROGID);
    reg.set(&pk, "", "TrackMania file")?;
    reg.set(&format!(r"{pk}\DefaultIcon"), "", &format!("\"{exe}\",0"))?;
    reg.set(&format!(r"{pk}\shell\open\command"), "", &open_command(exe))?;
    reg.set(&format!(r"{ek}\OpenWithProgids"), PROGID, "")?;
    let old = reg.get(Root::User, &ek, "").filter(|v| !v.trim().is_empty());
    if old.as_deref() != Some(PROGID) {
        reg.set(&ek, PREVIOUS, old.as_deref().unwrap_or("-"))?;
        reg.set(&ek, "", PROGID)?;
    }
    Ok(())
}

/// Switches it off: the old default back, our entries gone.
pub fn disable(reg: &mut dyn Reg) -> Result<(), String> {
    let ek = ext_key();
    if reg.get(Root::User, &ek, "").as_deref() == Some(PROGID) {
        match reg.get(Root::User, &ek, PREVIOUS).filter(|p| p != "-" && !p.is_empty() && p != PROGID) {
            Some(p) => reg.set(&ek, "", &p)?,
            None => reg.delete_value(&ek, "")?,
        }
    }
    reg.delete_value(&ek, PREVIOUS)?;
    reg.delete_value(&format!(r"{ek}\OpenWithProgids"), PROGID)?;
    reg.delete_tree(&progid_key(PROGID))
}

/// .Gbx paths in a command line: after `--open-gbx`, or any existing file ending in .gbx.
pub fn files_in_args(args: &[String]) -> Vec<String> {
    let mut out = vec![];
    let mut next = false;
    for a in args.iter().skip(1) {
        let a = a.trim().trim_matches('"').to_string();
        if a == FLAG {
            next = true;
            continue;
        }
        if (next || a.to_lowercase().ends_with(".gbx")) && a.to_lowercase().ends_with(".gbx") && std::path::Path::new(&a).is_file() && !out.contains(&a) {
            out.push(a);
        }
        next = false;
    }
    out
}

// ------------------------------------------------------------------ the real registry (Windows)

#[cfg(windows)]
pub struct WinReg;

#[cfg(windows)]
impl Reg for WinReg {
    fn get(&self, root: Root, key: &str, name: &str) -> Option<String> {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
        let r = winreg::RegKey::predef(if root == Root::User { HKEY_CURRENT_USER } else { HKEY_LOCAL_MACHINE });
        r.open_subkey_with_flags(key, KEY_READ).ok()?.get_value::<String, _>(name).ok()
    }
    fn set(&mut self, key: &str, name: &str, value: &str) -> Result<(), String> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let (k, _) = hkcu.create_subkey(key).map_err(|e| e.to_string())?;
        k.set_value(name, &value.to_string()).map_err(|e| e.to_string())
    }
    fn delete_value(&mut self, key: &str, name: &str) -> Result<(), String> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        let Ok(k) = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(key, KEY_SET_VALUE) else { return Ok(()) };
        match k.delete_value(name) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
    fn delete_tree(&mut self, key: &str) -> Result<(), String> {
        match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).delete_subkey_all(key) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// Tells Explorer that file associations changed (icons, "Open with").
#[cfg(windows)]
fn notify_shell() {
    use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null()) };
}

#[tauri::command(async)]
pub fn gbx_assoc_status() -> Option<Status> {
    #[cfg(windows)]
    {
        Some(status(&WinReg))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[tauri::command(async)]
pub fn gbx_assoc_set(on: bool) -> Result<Status, String> {
    #[cfg(windows)]
    {
        let mut r = WinReg;
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            enable(&mut r, &exe.to_string_lossy())?;
        } else {
            disable(&mut r)?;
        }
        notify_shell();
        Ok(status(&r))
    }
    #[cfg(not(windows))]
    {
        let _ = on;
        Err("Only on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default, Clone)]
    struct Mem(BTreeMap<(Root, String, String), String>);
    impl Reg for Mem {
        fn get(&self, root: Root, key: &str, name: &str) -> Option<String> {
            self.0.get(&(root, key.to_lowercase(), name.to_lowercase())).cloned()
        }
        fn set(&mut self, key: &str, name: &str, value: &str) -> Result<(), String> {
            self.0.insert((Root::User, key.to_lowercase(), name.to_lowercase()), value.into());
            Ok(())
        }
        fn delete_value(&mut self, key: &str, name: &str) -> Result<(), String> {
            self.0.remove(&(Root::User, key.to_lowercase(), name.to_lowercase()));
            Ok(())
        }
        fn delete_tree(&mut self, key: &str) -> Result<(), String> {
            let k = key.to_lowercase();
            self.0.retain(|(r, kk, _), _| !(*r == Root::User && (*kk == k || kk.starts_with(&format!("{k}\\")))));
            Ok(())
        }
    }

    fn machine(m: &mut Mem, key: &str, name: &str, v: &str) {
        m.0.insert((Root::Machine, key.to_lowercase(), name.to_lowercase()), v.into());
    }

    fn with_tmforever() -> Mem {
        let mut m = Mem::default();
        machine(&mut m, r"Software\Classes\.gbx", "", "TmForever.Gbx");
        machine(&mut m, r"Software\Classes\TmForever.Gbx", "", "TrackMania file");
        machine(&mut m, r"Software\Classes\TmForever.Gbx\shell\open\command", "", r#""C:\Program Files (x86)\TmNationsForever\TmForever.exe" /useexedir /singleinst /file="%1""#);
        m
    }

    #[test]
    fn on_and_off_put_everything_back() {
        let mut m = with_tmforever();
        let before = m.clone().0;
        let s = status(&m);
        assert!(!s.on);
        assert_eq!(s.current.as_ref().unwrap().program.as_deref(), Some("TmForever.exe"), "the page says what it replaces");
        enable(&mut m, r"C:\Apps\TM Horizon\tm-horizon.exe").unwrap();
        let s = status(&m);
        assert!(s.on);
        assert_eq!(s.current.unwrap().progid, "TmForever.Gbx", "what comes back when switched off");
        assert_eq!(m.get(Root::User, r"Software\Classes\TMHorizon.Gbx\shell\open\command", "").unwrap(), r#""C:\Apps\TM Horizon\tm-horizon.exe" --open-gbx "%1""#);
        // Twice: no change (the remembered default stays the game's, not ours).
        enable(&mut m, r"C:\Apps\TM Horizon\tm-horizon.exe").unwrap();
        assert_eq!(m.get(Root::User, r"Software\Classes\.gbx", PREVIOUS).as_deref(), Some("-"));
        disable(&mut m).unwrap();
        assert_eq!(m.0, before, "off = exactly as before");
        assert!(!status(&m).on);
    }

    #[test]
    fn a_previous_user_default_comes_back() {
        let mut m = with_tmforever();
        m.set(r"Software\Classes\.gbx", "", "ManiaPlanet.Gbx").unwrap();
        m.set(r"Software\Classes\ManiaPlanet.Gbx\shell\open\command", "", r#""D:\MP\ManiaPlanet.exe" "%1""#).unwrap();
        assert_eq!(status(&m).current.unwrap().program.as_deref(), Some("ManiaPlanet.exe"));
        enable(&mut m, r"C:\h.exe").unwrap();
        disable(&mut m).unwrap();
        assert_eq!(m.get(Root::User, r"Software\Classes\.gbx", "").as_deref(), Some("ManiaPlanet.Gbx"));
        assert!(m.get(Root::User, r"Software\Classes\TMHorizon.Gbx", "").is_none());
    }

    #[test]
    fn user_choice_is_reported() {
        let mut m = with_tmforever();
        m.set(USER_CHOICE, "ProgId", "Applications\\notepad.exe").unwrap();
        let s = status(&m);
        assert_eq!(s.user_choice.as_deref(), Some("Applications\\notepad.exe"));
        assert!(!s.user_choice_ours);
    }

    #[test]
    fn command_lines() {
        assert_eq!(program_of(r#""C:\A B\x.exe" /a"#).as_deref(), Some("x.exe"));
        assert_eq!(program_of(r"C:\x\y.exe %1").as_deref(), Some("y.exe"));
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("A01.Challenge.Gbx");
        std::fs::write(&f, b"GBX").unwrap();
        let fs = f.to_string_lossy().to_string();
        assert_eq!(files_in_args(&["tm-horizon.exe".into(), FLAG.into(), fs.clone()]), vec![fs.clone()]);
        assert_eq!(files_in_args(&["tm-horizon.exe".into(), format!("\"{fs}\"")]), vec![fs.clone()]);
        assert!(files_in_args(&["tm-horizon.exe".into(), "tmhub://mod/x".into(), FLAG.into(), "C:\\nope.Gbx".into()]).is_empty());
        assert!(files_in_args(&["tm-horizon.exe".into(), FLAG.into(), t.path().join("x.txt").to_string_lossy().into()]).is_empty());
    }
}
