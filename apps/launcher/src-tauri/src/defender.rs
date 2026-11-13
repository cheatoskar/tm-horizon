//! Windows Defender blocks: when a start fails with "access denied" (os error 5) or "virus" (225, 226), the
//! launcher asks Defender's own detection list (`Get-MpThreatDetection`, read only, works without admin) whether
//! that file is in it, and then says so with a link to Windows Security's protection history. TM Horizon never
//! adds exclusions or changes Defender settings.

use std::path::Path;

/// Link that opens Windows Security > Protection history.
pub const THREAT_HISTORY: &str = "windowsdefender://threathistory";
/// Marker at the start of a start error that the UI turns into the Defender message with its button.
pub const MARK: &str = "DEFENDER_BLOCK:";

/// Error codes a Defender block can show up as.
pub fn could_be_block(code: Option<i32>) -> bool {
    matches!(code, Some(5) | Some(225) | Some(226))
}

/// True when `resources` (Defender's resource strings, e.g. `file:_C:\...\TMLoader.exe`) name `path`.
pub fn lists(resources: &str, path: &Path) -> bool {
    let want = path.to_string_lossy().replace('/', "\\").to_lowercase();
    resources
        .split(['\n', ';'])
        .map(|r| r.trim().to_lowercase())
        .any(|r| r.strip_prefix("file:_").is_some_and(|f| f == want || f.starts_with(&(want.clone() + "->"))))
}

/// Defender's detected resources (one per line), or None when they cannot be read.
#[cfg(windows)]
pub fn detected_resources() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-MpThreatDetection -ErrorAction Stop | ForEach-Object { $_.Resources }"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(windows))]
pub fn detected_resources() -> Option<String> {
    None
}

/// True when Defender has a detection for this file.
pub fn blocks(path: &Path) -> bool {
    detected_resources().is_some_and(|r| lists(&r, path))
}

/// The start error for a file that failed with `code`: Defender's block when it lists the file (or the code is
/// one of Defender's own), else None (the caller keeps its error).
pub fn start_error(path: &Path, code: Option<i32>) -> Option<String> {
    if !could_be_block(code) {
        return None;
    }
    // Split on both separators: a Windows path seen on another OS (tests on Linux CI) has no `file_name`.
    let full = path.to_string_lossy();
    let name = full.rsplit(['\\', '/']).next().unwrap_or_default().to_string();
    (matches!(code, Some(225) | Some(226)) || blocks(path)).then(|| format!("{MARK}{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_file_in_defender_resources() {
        let r = "file:_C:\\Users\\x\\Downloads\\a.crdownload;webfile:_C:\\Users\\x\\Downloads\\a.crdownload|https://e.x\nfile:_C:\\Users\\x\\AppData\\Local\\TMLoader\\TMLoader.exe\n";
        assert!(lists(r, Path::new("C:\\Users\\x\\AppData\\Local\\TMLoader\\TMLoader.exe")));
        assert!(lists(r, Path::new("c:/users/x/appdata/local/tmloader/TMLoader.exe")));
        assert!(!lists(r, Path::new("C:\\Users\\x\\AppData\\Local\\TMLoader\\Other.exe")));
        assert!(!lists("CmdLine:_C:\\Windows\\System32\\wsl.exe TMLoader.exe", Path::new("C:\\TMLoader.exe")));
    }

    #[test]
    fn only_block_codes_are_looked_at() {
        assert!(could_be_block(Some(5)) && could_be_block(Some(225)) && could_be_block(Some(226)));
        assert!(!could_be_block(Some(2)) && !could_be_block(None));
        assert_eq!(start_error(Path::new("C:\\x\\TMLoader.exe"), Some(225)).as_deref(), Some("DEFENDER_BLOCK:TMLoader.exe"));
        assert_eq!(start_error(Path::new("C:\\x\\TMLoader.exe"), Some(2)), None);
    }
}
