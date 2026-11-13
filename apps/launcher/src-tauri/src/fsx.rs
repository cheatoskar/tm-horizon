//! Guarded file system access. Every read, list and write of the scanner, the mod installer
//! and the map router goes through here.
//!
//! Hard rules (same as scanner/scan.mjs):
//! - Nothing inside the StarForce-protected "Program Files (x86)\TrackMania Nations ESWC" is
//!   ever opened, listed, hashed or started. Only the folder itself may be checked for existence.
//! - No file named dinput8.dll is ever read, written, hashed or listed into results.

use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

pub fn eswc_protected_dir() -> PathBuf {
    crate::platform::program_files_x86().join("TrackMania Nations ESWC")
}

/// Lexical normalisation: lower case, one separator, `.`/`..` resolved. No disk access.
pub fn norm(p: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut prefix = String::new();
    for c in p.components() {
        match c {
            Component::Prefix(x) => prefix = x.as_os_str().to_string_lossy().to_lowercase().replace('/', "\\"),
            Component::RootDir => {}
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(s) => parts.push(s.to_string_lossy().to_lowercase()),
        }
    }
    format!("{prefix}\\{}", parts.join("\\"))
}

pub fn is_inside(child: &Path, dir: &Path) -> bool {
    let c = norm(child);
    let d = norm(dir);
    c == d || c.starts_with(&(d.clone() + "\\"))
}

pub fn is_dinput8(p: &Path) -> bool {
    p.file_name().map(|n| n.to_string_lossy().trim_end_matches(['.', ' ']).eq_ignore_ascii_case("dinput8.dll")).unwrap_or(false)
}

#[cfg(windows)]
fn strip_prefix_ci<'a>(s: &'a str, pre: &str) -> Option<&'a str> {
    (s.len() >= pre.len() && s.is_char_boundary(pre.len()) && s[..pre.len()].eq_ignore_ascii_case(pre)).then(|| &s[pre.len()..])
}

/// Lexical clean-up of the forms Windows accepts for the same file: `\\?\` / `\\.\` / `\??\`
/// prefixes, `\\?\UNC\`, the administrative share of this machine (`\\localhost\C$\`,
/// `\\127.0.0.1\c$`, `\\<computer>\c$`), forward slashes, and trailing dots and spaces of each
/// component (Win32 drops them, so `dinput8.dll.` is `dinput8.dll`). No disk access.
#[cfg(windows)]
pub fn clean(p: &Path) -> PathBuf {
    let mut s = p.to_string_lossy().replace('/', "\\");
    for pre in [r"\\?\UNC\", r"\\.\UNC\", r"\??\UNC\"] {
        if let Some(rest) = strip_prefix_ci(&s, pre) {
            s = format!(r"\\{rest}");
        }
    }
    for pre in [r"\\?\", r"\\.\", r"\??\"] {
        if let Some(rest) = strip_prefix_ci(&s, pre) {
            s = rest.to_string();
        }
    }
    if let Some(rest) = s.strip_prefix(r"\\") {
        let mut it = rest.splitn(3, '\\');
        let (host, share, tail) = (it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or(""));
        let me = std::env::var("COMPUTERNAME").unwrap_or_default();
        let local = ["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"].iter().any(|h| host.eq_ignore_ascii_case(h)) || (!me.is_empty() && host.eq_ignore_ascii_case(&me));
        let sb = share.as_bytes();
        if local && sb.len() == 2 && sb[0].is_ascii_alphabetic() && sb[1] == b'$' {
            s = format!(r"{}:\{tail}", sb[0] as char);
        }
    }
    let parts: Vec<&str> = s.split('\\').map(|c| if c == "." || c == ".." { c } else { c.trim_end_matches(['.', ' ']) }).collect();
    PathBuf::from(parts.join("\\"))
}

/// Linux: Windows-style separators from data (`GameData\Skins`) become `/`; nothing else
/// changes (no drive letters or UNC forms; trailing dots are real names there, the dinput8 check
/// trims them itself).
#[cfg(not(windows))]
pub fn clean(p: &Path) -> PathBuf {
    PathBuf::from(p.to_string_lossy().replace('\\', "/"))
}

/// A colon after the drive letter means an alternate data stream (`file:stream`).
pub fn has_ads(clean_path: &Path) -> bool {
    let s = clean_path.to_string_lossy();
    let b = s.as_bytes();
    let rest = if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' { &s[2..] } else { &s[..] };
    rest.contains(':')
}

/// `.`/`..` resolved lexically (as Win32 does), prefix and root kept.
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The real path: the existing part resolved by the file system (junctions, symlinks, subst
/// drives and 8.3 short names; std's canonicalize uses GetFinalPathNameByHandle), plus the
/// components that do not exist yet. None when nothing of it exists or it is blocked.
pub fn resolve(p: &Path) -> Option<PathBuf> {
    match walk(&lexical(&clean(p))) {
        Walk::Real(r) => Some(r),
        Walk::Blocked | Walk::Nothing => None,
    }
}

/// canonicalize with a short-lived cache (scans check thousands of paths under the same
/// folders). None = does not exist; Some(None) = exists but cannot be resolved.
fn canonical_cached(p: &Path) -> Option<Option<PathBuf>> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, (Instant, Option<Option<PathBuf>>)>>> = std::sync::OnceLock::new();
    const TTL: Duration = Duration::from_secs(10);
    let key = norm(p);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((t, v)) = cache.lock().unwrap().get(&key) {
        if t.elapsed() < TTL {
            return v.clone();
        }
    }
    let v = std::fs::symlink_metadata(p).ok().map(|_| std::fs::canonicalize(p).ok());
    let mut c = cache.lock().unwrap();
    if c.len() > 20_000 {
        c.clear();
    }
    c.insert(key, (Instant::now(), v.clone()));
    v
}

enum Walk {
    Real(PathBuf),
    Blocked,
    Nothing,
}

/// Resolves a path from the root down, one component at a time: each existing prefix is
/// canonicalised and checked before the next component is looked at, so nothing below a path
/// that resolves into the protected folder is ever opened or even stat'ed.
fn walk(lex: &Path) -> Walk {
    let comps: Vec<Component> = lex.components().collect();
    let mut acc = PathBuf::new();
    let mut real: Option<PathBuf> = None;
    let mut any = false;
    for (i, c) in comps.iter().enumerate() {
        acc.push(c.as_os_str());
        if matches!(c, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        let cand = match &real {
            Some(r) => clean(&r.join(c.as_os_str())),
            None => clean(&acc),
        };
        if lexical_blocked(&cand) {
            return Walk::Blocked;
        }
        if let Some(canon) = canonical_cached(&acc) {
            let Some(canon) = canon else { return Walk::Nothing };
            let r = clean(&canon);
            if lexical_blocked(&r) {
                return Walk::Blocked;
            }
            real = Some(r);
            any = true;
        } else {
            // The rest does not exist yet: append it as written.
            let mut r = cand;
            for rest in &comps[i + 1..] {
                r.push(rest.as_os_str());
            }
            let r = clean(&r);
            if lexical_blocked(&r) {
                return Walk::Blocked;
            }
            return if any { Walk::Real(r) } else { Walk::Nothing };
        }
    }
    match real {
        Some(r) => Walk::Real(r),
        None => Walk::Nothing,
    }
}

/// The protected ESWC folder, as written and with Program Files (x86) resolved by the file
/// system (the folder itself is never opened for this).
fn protected_dirs() -> &'static [String] {
    static DIRS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    DIRS.get_or_init(|| {
        let d = eswc_protected_dir();
        let mut v = vec![norm(&clean(&d))];
        if let Ok(pf) = std::fs::canonicalize(crate::platform::program_files_x86()) {
            let n = norm(&clean(&pf.join("TrackMania Nations ESWC")));
            if !v.contains(&n) {
                v.push(n);
            }
        }
        v
    })
}

fn lexical_blocked(clean_path: &Path) -> bool {
    let c = norm(clean_path);
    is_dinput8(clean_path) || protected_dirs().iter().any(|d| c == *d || c.starts_with(&format!("{d}\\"))) || other_os_protected(&c)
}

/// Linux (and WSL, where /mnt/c is the Windows drive): the StarForce folder under any
/// "Program Files (x86)", wherever it is mounted or inside whichever prefix.
#[cfg(not(windows))]
fn other_os_protected(normed: &str) -> bool {
    let n = normed.replace('/', r"\");
    let key = r"\program files (x86)\trackmania nations eswc";
    n.match_indices(key).any(|(i, _)| matches!(n[i + key.len()..].chars().next(), None | Some('\\')))
}

#[cfg(windows)]
fn other_os_protected(_normed: &str) -> bool {
    false
}

/// true when the path must not be touched at all. Checked on the cleaned path and, walking from
/// the root down, on what the file system resolves each part to, so short names, junctions,
/// symlinks, subst drives, `\\?\` and admin-share spellings and trailing dots cannot reach the
/// protected folder or a dinput8.dll. Alternate data streams are refused outright.
pub fn blocked(p: &Path) -> bool {
    let c = clean(p);
    if has_ads(&c) || lexical_blocked(&c) {
        return true;
    }
    matches!(walk(&lexical(&c)), Walk::Blocked)
}

pub fn check(p: &Path) -> Result<(), String> {
    if blocked(p) {
        Err(format!("refusing to touch {}", p.display()))
    } else {
        Ok(())
    }
}

/// Existence check of the protected folder itself (the one allowed operation on it).
pub fn eswc_protected_exists() -> bool {
    eswc_protected_dir().is_dir()
}

pub fn exists(p: &Path) -> bool {
    let p = &*crate::platform::ci(p);
    !blocked(p) && p.exists()
}

pub fn is_file(p: &Path) -> bool {
    let p = &*crate::platform::ci(p);
    !blocked(p) && p.is_file()
}

pub fn is_dir(p: &Path) -> bool {
    let p = &*crate::platform::ci(p);
    !blocked(p) && p.is_dir()
}

pub fn read_string(p: &Path) -> Option<String> {
    let p = &*crate::platform::ci(p);
    if blocked(p) {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn read_bytes_prefix(p: &Path, n: usize) -> Option<Vec<u8>> {
    let p = &*crate::platform::ci(p);
    use std::io::Read;
    if blocked(p) {
        return None;
    }
    let mut f = std::fs::File::open(p).ok()?;
    let mut buf = vec![0u8; n];
    let got = f.read(&mut buf).ok()?;
    buf.truncate(got);
    Some(buf)
}

pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub is_file: bool,
    /// From the folder listing itself (no extra file access on Windows).
    pub modified: Option<std::time::SystemTime>,
    /// Size in bytes, from the listing as well.
    pub len: u64,
}

/// Lists a folder. Blocked folders give nothing; blocked children (dinput8.dll, the protected
/// ESWC folder when listing Program Files) are left out.
pub fn list(dir: &Path) -> Vec<Entry> {
    let dir = &*crate::platform::ci(dir);
    if blocked(dir) {
        return Vec::new();
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    // The folder is resolved once; plain children are checked lexically under it (read_dir
    // gives long names), links and junctions get the full check.
    let real = resolve(dir).unwrap_or_else(|| clean(dir));
    let mut out = Vec::new();
    for e in rd.flatten() {
        let path = e.path();
        let Ok(ft) = e.file_type() else { continue };
        let bad = if ft.is_symlink() { blocked(&path) } else { lexical_blocked(&clean(&real.join(e.file_name()))) || lexical_blocked(&clean(&path)) };
        if bad {
            continue;
        }
        let md = e.metadata().ok();
        out.push(Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            path,
            is_dir: ft.is_dir(),
            is_file: ft.is_file(),
            modified: md.as_ref().and_then(|m| m.modified().ok()),
            len: md.as_ref().map(|m| m.len()).unwrap_or(0),
        });
    }
    out
}

pub fn mtime(p: &Path) -> Option<SystemTime> {
    let p = &*crate::platform::ci(p);
    if blocked(p) {
        return None;
    }
    std::fs::metadata(p).ok()?.modified().ok()
}

pub fn mtime_iso(p: &Path) -> Option<String> {
    mtime(p).map(iso)
}

/// ISO 8601 UTC with milliseconds, like JavaScript's toISOString().
pub fn iso(t: SystemTime) -> String {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(d.as_millis() as i64)
}

pub fn iso_from_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn now_iso() -> String {
    iso(SystemTime::now())
}

static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Unique timestamp for folder and file names: 20261110-153012-123-1 (UTC, milliseconds and a
/// per-run counter, so two backups in the same second never share a folder).
pub fn stamp() -> String {
    let s = now_iso();
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}{}{}-{}{}{}-{}-{n}", &s[0..4], &s[5..7], &s[8..10], &s[11..13], &s[14..16], &s[17..19], &s[20..23])
}

/// Writes a file after the guard check, creating parent folders. Atomic: the data goes to a
/// temporary file next to it, which then replaces the target (MoveFileEx with replace), so a
/// crash never leaves a half-written profile or settings file.
pub fn write(p: &Path, data: &[u8]) -> Result<(), String> {
    let p = &*crate::platform::ci(p);
    check(p)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = p.with_file_name(format!(".{name}.{}-{}.tmhub-tmp", std::process::id(), COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let r = (|| {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, p)
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r.map_err(|e| format!("{}: {e}", p.display()))
}

pub fn copy(from: &Path, to: &Path) -> Result<(), String> {
    let from = &*crate::platform::ci(from);
    let to = &*crate::platform::ci(to);
    check(from)?;
    check(to)?;
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::copy(from, to).map(|_| ()).map_err(|e| format!("{} -> {}: {e}", from.display(), to.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_js() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_794_326_400_123), "2026-11-10T16:00:00.123Z");
    }

    #[cfg(windows)]
    #[test]
    fn protected_eswc_folder_is_blocked() {
        let pf = crate::platform::program_files_x86();
        let inside = pf.join("TrackMania Nations ESWC").join("TmNationsESWC.exe");
        assert!(blocked(&inside));
        assert!(blocked(&pf.join("trackmania nations eswc")));
        assert!(blocked(&pf.join("Other").join("..").join("TrackMania Nations ESWC").join("x")));
        assert!(!blocked(&pf.join("TrackMania Nations ESWC Fan")));
        assert!(!blocked(&pf.join("TmNationsForever").join("TmForever.exe")));
        assert!(read_string(&inside).is_none());
        assert!(list(&pf.join("TrackMania Nations ESWC")).is_empty());
        assert!(write(&inside, b"x").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn eswc_folder_blocked_on_linux_mounts_and_prefixes() {
        assert!(blocked(Path::new("/mnt/c/Program Files (x86)/TrackMania Nations ESWC/TmNationsESWC.exe")));
        assert!(blocked(Path::new("/mnt/c/Program Files (x86)/TrackMania Nations ESWC")));
        assert!(blocked(Path::new("/home/u/.wine/drive_c/program files (x86)/trackmania nations eswc/x.dll")));
        assert!(!blocked(Path::new("/mnt/c/Program Files (x86)/TrackMania Nations ESWC Fan/x")));
        assert!(list(Path::new("/mnt/c/Program Files (x86)/TrackMania Nations ESWC")).is_empty());
        assert!(blocked(Path::new("/home/u/Games/TMNF/dinput8.dll")));
    }

    #[cfg(windows)]
    #[test]
    fn clean_handles_windows_spellings() {
        assert_eq!(clean(Path::new(r"\\?\C:\Program Files (x86)\x")), PathBuf::from(r"C:\Program Files (x86)\x"));
        assert_eq!(clean(Path::new(r"\\.\c:\a")), PathBuf::from(r"c:\a"));
        assert_eq!(clean(Path::new(r"\\localhost\C$\Games\a")), PathBuf::from(r"C:\Games\a"));
        assert_eq!(clean(Path::new(r"\\127.0.0.1\d$\x")), PathBuf::from(r"d:\x"));
        assert_eq!(clean(Path::new(r"\\?\UNC\server\share\x")), PathBuf::from(r"\\server\share\x"));
        assert_eq!(clean(Path::new(r"C:\Games\ESWC. \dinput8.dll. ")), PathBuf::from(r"C:\Games\ESWC\dinput8.dll"));
        assert_eq!(clean(Path::new("C:/a/../b")), PathBuf::from(r"C:\a\..\b"));
        assert!(has_ads(&clean(Path::new(r"C:\Games\dinput8.dll:stream"))));
        assert!(has_ads(&clean(Path::new(r"C:\Games\a.txt::$DATA"))));
        assert!(!has_ads(&clean(Path::new(r"C:\Games\a.txt"))));
    }

    #[cfg(windows)]
    #[test]
    fn protected_folder_spellings_are_blocked() {
        let pf = crate::platform::program_files_x86();
        let pfs = pf.to_string_lossy().to_string();
        for p in [
            format!(r"\\?\{pfs}\TrackMania Nations ESWC\TmNationsESWC.exe"),
            format!(r"{pfs}\TrackMania Nations ESWC.\TmNationsESWC.exe"),
            format!(r"{pfs}\TrackMania Nations ESWC \x"),
            format!(r"\\localhost\{}$\{}\TrackMania Nations ESWC\x", &pfs[..1], &pfs[3..]),
            format!(r"{pfs}\TrackMania Nations ESWC\x.exe:evil"),
        ] {
            assert!(blocked(Path::new(&p)), "{p}");
        }
        // 8.3 short name of Program Files (x86), e.g. C:\PROGRA~2.
        if let Some(short) = short_name(&pf) {
            if short != pf {
                assert!(blocked(&short.join("TrackMania Nations ESWC").join("x")), "{}", short.display());
            }
        }
        // A junction pointing at Program Files (x86).
        let t = tempfile::tempdir().unwrap();
        let j = t.path().join("pf");
        let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&j).arg(&pf).output().map(|o| o.status.success()).unwrap_or(false);
        if made {
            assert!(blocked(&j.join("TrackMania Nations ESWC").join("TmNationsESWC.exe")));
            assert!(!blocked(&j.join("TmNationsForever")));
            let _ = std::fs::remove_dir(&j);
        }
    }

    #[cfg(windows)]
    fn short_name(p: &Path) -> Option<PathBuf> {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let wide: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut buf = vec![0u16; 1024];
        let n = unsafe { windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
        (n > 0 && n < buf.len()).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])))
    }

    #[test]
    fn dinput8_variants_and_links() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("game");
        std::fs::create_dir_all(&d).unwrap();
        for n in ["dinput8.dll.", "dinput8.dll ", "DINPUT8.DLL::$DATA", "dinput8.dll:x"] {
            assert!(blocked(&d.join(n)), "{n}");
        }
        assert!(write(&d.join("dinput8.dll."), b"x").is_err());
        assert!(!d.join("dinput8.dll").exists());
        // No file named dinput8.dll is created even in a test folder; the 8.3 case is covered by
        // resolve() (same code path as the Program Files short-name test above).
    }

    #[test]
    fn writes_are_atomic_and_stamps_unique() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("profile.yaml");
        write(&f, b"one").unwrap();
        write(&f, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "two");
        assert_eq!(std::fs::read_dir(t.path()).unwrap().count(), 1, "no temp files left");
        let a = stamp();
        let b = stamp();
        assert_ne!(a, b);
    }

    #[test]
    fn dinput8_is_blocked_everywhere() {
        let p = Path::new("C:/Users/x/Games/TMN-ESWC-inoffiziell/DINPUT8.DLL");
        assert!(blocked(p));
        assert!(read_string(p).is_none());
        assert!(write(p, b"x").is_err());
        assert!(!blocked(Path::new("C:/Users/x/Games/TMN-ESWC-inoffiziell/dinput8.dll.v1.0.0")));
    }
}
