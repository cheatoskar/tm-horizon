//! Windows implementation of the platform layer.

use super::{SignatureInfo, UbisoftInstall, UninstallEntry};
use crate::launch::{Arg, CommandSpec};
use std::ffi::{c_void, OsStr};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

pub const NAME: &str = "windows";

pub fn documents_dir() -> Option<PathBuf> {
    super::documents_override().or_else(dirs::document_dir)
}

pub fn local_app_data() -> Option<PathBuf> {
    dirs::data_local_dir()
}

/// "Program Files (x86)" first, then "Program Files".
pub fn program_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for (var, fallback) in [("ProgramFiles(x86)", r"C:\Program Files (x86)"), ("ProgramFiles", r"C:\Program Files")] {
        let p = PathBuf::from(std::env::var(var).unwrap_or_else(|_| fallback.to_string()));
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

pub fn program_files_x86() -> PathBuf {
    program_files().into_iter().next().unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"))
}

pub fn program_data() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into())))
}

fn reg_string(root: winreg::HKEY, path: &str, value: &str) -> Option<String> {
    RegKey::predef(root).open_subkey_with_flags(path, KEY_READ).ok()?.get_value::<String, _>(value).ok()
}

/// "Windows 11 Pro 24H2 (build 26100.2314)" for problem reports.
pub fn os_summary() -> String {
    const CV: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let get = |v: &str| reg_string(HKEY_LOCAL_MACHINE, CV, v);
    let build = get("CurrentBuildNumber").or_else(|| get("CurrentBuild")).unwrap_or_default();
    let ubr = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(CV, KEY_READ).ok().and_then(|k| k.get_value::<u32, _>("UBR").ok());
    let mut name = get("ProductName").unwrap_or_else(|| "Windows".into());
    // ProductName still says "Windows 10" on Windows 11; the build number tells them apart.
    if build.parse::<u32>().unwrap_or(0) >= 22000 {
        name = name.replace("Windows 10", "Windows 11");
    }
    let disp = get("DisplayVersion").map(|d| format!(" {d}")).unwrap_or_default();
    let ubr = ubr.map(|u| format!(".{u}")).unwrap_or_default();
    format!("{name}{disp} (build {build}{ubr})")
}

/// Display adapters with driver version, from the registry's display class.
pub fn gpus() -> Vec<String> {
    const CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(CLASS, KEY_READ) else { return vec![] };
    let mut out = Vec::new();
    for name in key.enum_keys().flatten().filter(|n| n.chars().all(|c| c.is_ascii_digit())) {
        let Ok(sub) = key.open_subkey_with_flags(&name, KEY_READ) else { continue };
        let Ok(desc) = sub.get_value::<String, _>("DriverDesc") else { continue };
        let ver = sub.get_value::<String, _>("DriverVersion").map(|v| format!(" (driver {v})")).unwrap_or_default();
        let line = format!("{desc}{ver}");
        if !out.contains(&line) {
            out.push(line);
        }
    }
    out
}

pub fn steam_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        let key = p.to_string_lossy().replace('/', "\\").to_lowercase();
        if !out.iter().any(|q| q.to_string_lossy().replace('/', "\\").to_lowercase() == key) {
            out.push(PathBuf::from(p.to_string_lossy().replace('/', "\\")));
        }
    };
    if let Some(p) = reg_string(HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath") {
        push(PathBuf::from(p));
    }
    for pf in program_files() {
        push(pf.join("Steam"));
    }
    out
}

pub fn uninstall_entries() -> Vec<UninstallEntry> {
    const KEYS: [(winreg::HKEY, &str); 3] = [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
    ];
    let mut out = Vec::new();
    for (root, path) in KEYS {
        let Ok(key) = RegKey::predef(root).open_subkey_with_flags(path, KEY_READ) else { continue };
        for name in key.enum_keys().flatten() {
            let Ok(sub) = key.open_subkey_with_flags(&name, KEY_READ) else { continue };
            let Ok(display) = sub.get_value::<String, _>("DisplayName") else { continue };
            let mut location = sub
                .get_value::<String, _>("InstallLocation")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|s| PathBuf::from(s.trim().trim_matches('"')));
            if location.is_none() {
                // Many old installers only set DisplayIcon ("C:\...\Game.exe,0").
                if let Ok(icon) = sub.get_value::<String, _>("DisplayIcon") {
                    let exe = icon.split(',').next().unwrap_or("").trim().trim_matches('"').to_string();
                    if exe.to_lowercase().ends_with(".exe") {
                        location = Path::new(&exe).parent().map(Path::to_path_buf);
                    }
                }
            }
            out.push(UninstallEntry { name: display, location });
        }
    }
    out
}

pub fn ubisoft_installs() -> Vec<UbisoftInstall> {
    let mut out = Vec::new();
    for path in [r"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs", r"SOFTWARE\Ubisoft\Launcher\Installs"] {
        let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(path, KEY_READ) else { continue };
        for name in key.enum_keys().flatten() {
            let Ok(id) = name.parse::<u32>() else { continue };
            let Ok(sub) = key.open_subkey_with_flags(&name, KEY_READ) else { continue };
            if let Ok(dir) = sub.get_value::<String, _>("InstallDir") {
                let dir = PathBuf::from(dir.replace('/', "\\").trim_end_matches('\\'));
                if !out.iter().any(|u: &UbisoftInstall| u.id == id) {
                    out.push(UbisoftInstall { id, dir });
                }
            }
        }
    }
    out
}

/// Folder with Ubisoft Connect's games (default install place).
pub fn ubisoft_games_dir() -> PathBuf {
    program_files_x86().join("Ubisoft").join("Ubisoft Game Launcher").join("games")
}

pub fn epic_manifest_dir() -> Option<PathBuf> {
    program_data().map(|p| p.join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests"))
}

/// Root folders of all fixed (non-removable, non-network) drives.
pub fn fixed_drives() -> Vec<PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = OsStr::new(&root).encode_wide().chain(Some(0)).collect();
        if unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_FIXED {
            out.push(PathBuf::from(root));
        }
    }
    out
}

/// Lower-case exe names of all running processes.
pub fn running_process_names() -> Vec<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != 0 {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            out.push(String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase());
            ok = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
    }
    out
}

/// Running processes whose lower-case exe name is in `names`, with the full exe path (read with
/// PROCESS_QUERY_LIMITED_INFORMATION; None when Windows does not allow it, e.g. an elevated game).
pub fn running_processes(names: &[String]) -> Vec<super::Proc> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != 0 {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
            if names.iter().any(|n| *n == name) {
                let pid = entry.th32ProcessID;
                let mut path = None;
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if !h.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut n = buf.len() as u32;
                    if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut n) != 0 {
                        path = Some(PathBuf::from(String::from_utf16_lossy(&buf[..n as usize])));
                    }
                    CloseHandle(h);
                }
                out.push(super::Proc { pid, name, path });
            }
            ok = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
    }
    out
}

fn build(spec: &CommandSpec) -> Command {
    let mut cmd = Command::new(&spec.program);
    for a in &spec.args {
        match a {
            Arg::Plain(s) => {
                cmd.arg(s);
            }
            // Written verbatim, e.g. /file="C:\x y\a.Gbx" exactly as the game's own file association.
            Arg::Raw(s) => {
                cmd.raw_arg(s);
            }
        }
    }
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd
}

/// Starts the program and returns at once (the game outlives the launcher).
pub fn spawn(spec: &CommandSpec) -> io::Result<u32> {
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let child = build(spec).creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).spawn()?;
    Ok(child.id())
}

/// Starts the program and waits for it (game setups).
pub fn run_and_wait(spec: &CommandSpec) -> io::Result<i32> {
    let status = build(spec).status()?;
    Ok(status.code().unwrap_or(-1))
}

/// Store links all go through the shell on Windows.
pub fn url_command(_url: &str) -> Option<CommandSpec> {
    None
}

const PROTOCOL_ROOT: &str = r"Software\Classes";

/// The command registered for `scheme://` under HKCU, if any.
pub fn protocol_command(scheme: &str) -> Option<String> {
    reg_string(HKEY_CURRENT_USER, &format!(r"{PROTOCOL_ROOT}\{scheme}\shell\open\command"), "")
}

/// Registers `scheme://` for the current user only (HKCU\Software\Classes). Called by the app
/// itself, only after the user agreed (first run or Settings).
pub fn register_protocol(scheme: &str, exe: &Path, label: &str) -> io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (root, _) = hkcu.create_subkey(format!(r"{PROTOCOL_ROOT}\{scheme}"))?;
    root.set_value("", &format!("URL:{label}"))?;
    root.set_value("URL Protocol", &"")?;
    let exe = exe.to_string_lossy();
    let (icon, _) = root.create_subkey("DefaultIcon")?;
    icon.set_value("", &format!("\"{exe}\",0"))?;
    let (cmd, _) = root.create_subkey(r"shell\open\command")?;
    cmd.set_value("", &protocol_command_line(&exe))?;
    Ok(())
}

pub fn protocol_command_line(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

pub fn unregister_protocol(scheme: &str) -> io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.delete_subkey_all(format!(r"{PROTOCOL_ROOT}\{scheme}")) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// Authenticode check (WinVerifyTrust, no UI, no revocation lookups).
pub fn verify_signature(path: &Path) -> SignatureInfo {
    use windows_sys::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
        WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut file: WINTRUST_FILE_INFO = std::mem::zeroed();
        file.cbStruct = std::mem::size_of::<WINTRUST_FILE_INFO>() as u32;
        file.pcwszFilePath = wide.as_ptr();
        let mut data: WINTRUST_DATA = std::mem::zeroed();
        data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
        data.dwUIChoice = WTD_UI_NONE;
        data.fdwRevocationChecks = WTD_REVOKE_NONE;
        data.dwUnionChoice = WTD_CHOICE_FILE;
        data.Anonymous.pFile = &mut file;
        data.dwStateAction = WTD_STATEACTION_VERIFY;
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let status = WinVerifyTrust(std::ptr::null_mut(), &mut action, &mut data as *mut _ as *mut c_void);
        let signer = if status == 0 { signer_name(data.hWVTStateData) } else { None };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(std::ptr::null_mut(), &mut action, &mut data as *mut _ as *mut c_void);
        let code = status as u32;
        let detail = match code {
            0 => "Signed and trusted".to_string(),
            0x800B_0100 => "Not signed".to_string(),
            0x800B_0101 => "Signed, certificate expired".to_string(),
            0x800B_0109 => "Signed, untrusted root".to_string(),
            0x8009_6010 => "Signature does not match the file".to_string(),
            other => format!("Signature check failed (0x{other:08X})"),
        };
        SignatureInfo { trusted: code == 0, detail, signer }
    }
}

/// Subject (simple display name) of the leaf certificate of a verified signature.
unsafe fn signer_name(state: windows_sys::Win32::Foundation::HANDLE) -> Option<String> {
    use windows_sys::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE};
    use windows_sys::Win32::Security::WinTrust::{WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData};
    if state.is_null() {
        return None;
    }
    let prov = WTHelperProvDataFromStateData(state);
    if prov.is_null() {
        return None;
    }
    let sgnr = WTHelperGetProvSignerFromChain(prov, 0, 0, 0);
    if sgnr.is_null() {
        return None;
    }
    let cert = WTHelperGetProvCertFromChain(sgnr, 0);
    if cert.is_null() || (*cert).pCert.is_null() {
        return None;
    }
    let mut buf = [0u16; 256];
    let n = CertGetNameStringW((*cert).pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, std::ptr::null(), buf.as_mut_ptr(), buf.len() as u32) as usize;
    (n > 1).then(|| String::from_utf16_lossy(&buf[..n - 1]))
}

/// Runs a setup through ShellExecuteEx (so a setup that asks for administrator rights gets the
/// normal UAC prompt instead of failing with error 740) and waits for it to exit.
pub fn run_setup_and_wait(exe: &Path, cwd: Option<&Path>) -> io::Result<i32> {
    run_setup_and_wait_args(exe, "", cwd)
}

/// Like `run_setup_and_wait`, with a parameter string (e.g. Inno Setup's `/SILENT /DIR="..."`).
/// ShellExecuteEx, so Windows asks for admin rights when the setup needs them.
pub fn run_setup_and_wait_args(exe: &Path, params: &str, cwd: Option<&Path>) -> io::Result<i32> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    if crate::fsx::blocked(exe) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "refusing to start this file"));
    }
    let file: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let dir: Option<Vec<u16>> = cwd.map(|d| d.as_os_str().encode_wide().chain(Some(0)).collect());
    let verb: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
    let par: Vec<u16> = OsStr::new(params).encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpDirectory = dir.as_ref().map(|d| d.as_ptr()).unwrap_or(std::ptr::null());
        info.lpParameters = if params.is_empty() { std::ptr::null() } else { par.as_ptr() };
        info.nShow = SW_SHOWNORMAL;
        if ShellExecuteExW(&mut info) == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.hProcess.is_null() {
            return Ok(0);
        }
        let w = WaitForSingleObject(info.hProcess, INFINITE);
        let mut code: u32 = 0;
        let got = GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if w != WAIT_OBJECT_0 || got == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(code as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads the signer of an embedded Authenticode signature (Git for Windows, when installed).
    #[test]
    fn signer_of_a_signed_exe() {
        let git = Path::new("C:/Program Files/Git/bin/git.exe");
        if !git.is_file() {
            return;
        }
        let s = verify_signature(git);
        assert!(s.trusted, "{}", s.detail);
        assert_eq!(s.signer.as_deref(), Some("Johannes Schindelin"));
        assert!(!crate::gameinstall::trusted_publisher(s.signer.as_deref()));
        assert!(crate::gameinstall::trusted_publisher(Some("Ubisoft Entertainment Sweden AB")));
    }
}
