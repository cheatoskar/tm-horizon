//! One elevated step for files that have to go into a folder only an administrator may write (the game
//! folder under `C:\Program Files (x86)`): one UAC prompt runs `cmd.exe` with nothing but `copy` and `del`
//! of the exact files the caller names. The launcher itself never runs elevated, no folder permissions are
//! changed, and the bookkeeping (journal, backups, staged files) stays in the user's app data.
//!
//! The caller stages verified files in its own data folder, runs the step and then checks the result from
//! the normal (unelevated) side: hashes of the copied files, deleted files gone. A cancelled UAC prompt
//! comes back as `cancelled` and nothing was changed.
//!
//! Refused before any prompt: relative paths, paths with `"`, `%` or control characters (they could break
//! out of the quoted cmd argument or expand variables), and targets in the protected ESWC folder
//! (`fsx::blocked`).

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// Copy a staged file over (or to) `to`.
    Copy { from: PathBuf, to: PathBuf },
    /// Delete one file.
    Delete(PathBuf),
}

fn safe(p: &Path) -> Result<String, String> {
    let s = p.to_string_lossy();
    if !p.is_absolute() && !(s.len() > 2 && s.as_bytes()[1] == b':') {
        return Err(format!("unsafe:{s}"));
    }
    if s.chars().any(|c| c == '"' || c == '%' || c.is_control()) {
        return Err(format!("unsafe:{s}"));
    }
    Ok(s.replace('/', "\\"))
}

/// The parameters for `cmd.exe`: `/d /v:off /s /c "<op> && <op> ..."`. `/d` skips AutoRun commands, `/v:off`
/// keeps `!` literal; every path is quoted. The step stops at the first failing copy.
pub fn cmd_params(ops: &[Op]) -> Result<String, String> {
    if ops.is_empty() {
        return Err("nothing to do".into());
    }
    let mut parts = vec![];
    for op in ops {
        match op {
            Op::Copy { from, to } => {
                if crate::fsx::blocked(to) {
                    return Err("blocked".into());
                }
                parts.push(format!("copy /b /y \"{}\" \"{}\" >nul", safe(from)?, safe(to)?));
            }
            Op::Delete(p) => {
                if crate::fsx::blocked(p) {
                    return Err("blocked".into());
                }
                parts.push(format!("del /f /q \"{}\"", safe(p)?));
            }
        }
    }
    Ok(format!("/d /v:off /s /c \"{}\"", parts.join(" && ")))
}

/// Can the current user write into `dir`? Ok(false) = access denied (needs admin), Err = something else
/// (folder missing, disk error). Writes and removes a probe file.
pub fn writable(dir: &Path) -> Result<bool, String> {
    let probe = dir.join(".tmhub-write-probe");
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // A probe left over from a crash: the folder was writable then; try once more after removing it.
            let _ = std::fs::remove_file(&probe);
            Ok(std::fs::OpenOptions::new().write(true).create_new(true).open(&probe).map(|_| std::fs::remove_file(&probe)).is_ok())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Runs the ops in one elevated `cmd.exe` (one UAC prompt) and waits. Errors: `cancelled` (the prompt was
/// declined), `elevate:<os error>`, `failed:<exit code>`. Windows only.
#[cfg(windows)]
pub fn run(ops: &[Op]) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    let params = cmd_params(ops)?;
    let root = std::env::var("SystemRoot").or_else(|_| std::env::var("windir")).unwrap_or_else(|_| r"C:\Windows".into());
    let cmd = Path::new(&root).join("System32").join("cmd.exe");
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, file, par) = (w("runas"), w(&cmd.to_string_lossy()), w(&params));
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = par.as_ptr();
        info.nShow = 0; // SW_HIDE
        if ShellExecuteExW(&mut info) == 0 {
            let e = GetLastError();
            return Err(if e == ERROR_CANCELLED { "cancelled".into() } else { format!("elevate:{}", std::io::Error::from_raw_os_error(e as i32)) });
        }
        if info.hProcess.is_null() {
            return Err("elevate:no process".into());
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 0u32;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if code != 0 {
            return Err(format!("failed:{code}"));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn run(_ops: &[Op]) -> Result<(), String> {
    Err("unsupported".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_one_quoted_command() {
        let ops = vec![
            Op::Copy { from: r"C:\Users\me\AppData\Local\x\stage\d3d9.dll".into(), to: r"C:\Program Files (x86)\TmUnitedForever\d3d9.dll".into() },
            Op::Delete(r"C:\Program Files (x86)\TmUnitedForever\dxvk.conf".into()),
        ];
        let p = cmd_params(&ops).unwrap();
        assert_eq!(
            p,
            r#"/d /v:off /s /c "copy /b /y "C:\Users\me\AppData\Local\x\stage\d3d9.dll" "C:\Program Files (x86)\TmUnitedForever\d3d9.dll" >nul && del /f /q "C:\Program Files (x86)\TmUnitedForever\dxvk.conf"""#
        );
        // & and ( inside a quoted path are plain characters for cmd.
        assert!(cmd_params(&[Op::Delete(r"C:\Games\Tom & Jerry (1)\d3d9.dll".into())]).is_ok());
    }

    #[test]
    fn refuses_unsafe_paths_and_the_protected_folder() {
        assert!(cmd_params(&[]).is_err());
        assert!(cmd_params(&[Op::Delete(r#"C:\a"b\d3d9.dll"#.into())]).unwrap_err().starts_with("unsafe"));
        assert!(cmd_params(&[Op::Delete(r"C:\%TEMP%\d3d9.dll".into())]).unwrap_err().starts_with("unsafe"));
        assert!(cmd_params(&[Op::Delete("relative\\d3d9.dll".into())]).unwrap_err().starts_with("unsafe"));
        assert!(cmd_params(&[Op::Delete("C:\\a\nb".into())]).unwrap_err().starts_with("unsafe"));
        let eswc = crate::fsx::eswc_protected_dir();
        assert_eq!(cmd_params(&[Op::Copy { from: r"C:\x\d3d9.dll".into(), to: eswc.join("d3d9.dll") }]).unwrap_err(), "blocked");
        assert_eq!(cmd_params(&[Op::Delete(eswc.join("d3d9.dll"))]).unwrap_err(), "blocked");
    }

    #[test]
    fn writable_probe() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(writable(t.path()), Ok(true));
        assert!(!t.path().join(".tmhub-write-probe").exists());
        std::fs::write(t.path().join(".tmhub-write-probe"), b"left over").unwrap();
        assert_eq!(writable(t.path()), Ok(true));
        assert!(writable(&t.path().join("missing")).is_err());
    }
}
