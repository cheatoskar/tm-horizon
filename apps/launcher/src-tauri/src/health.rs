//! Health check per game: is the game where TM Horizon thinks it is, are its helpers in order,
//! can the user folder be written, is there room on the disk. Each line has a status and a one-line
//! hint what to do. Nothing is changed or repaired here.
//!
//! The write test creates and removes one small file (`.tmhorizon-write-test`) in the user folder;
//! it is the only write.

use crate::scan::InstallInfo;
use crate::tmloader::TmLoaderInfo;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Below this the disk is reported as low / as full.
pub const LOW_BYTES: u64 = 2 << 30;
pub const FULL_BYTES: u64 = 500 << 20;
const HASH_MAX: u64 = 96 << 20;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// "exe" | "tmloader" | "loader" | "openplanet" | "userdir" | "disk"
    pub id: String,
    /// "ok" | "info" | "warn" | "fail"
    pub status: String,
    pub detail: String,
    /// One line: what to do. None when ok.
    pub fix: Option<String>,
    /// UI text key of `detail` (health.d.*) with its values; the English `detail` stays as the fallback.
    pub key: Option<String>,
    pub args: std::collections::BTreeMap<String, String>,
    /// UI text key of `fix` (health.f.*).
    pub fix_key: Option<String>,
}

fn c(id: &str, status: &str, detail: impl Into<String>, fix: Option<&str>) -> Check {
    Check { id: id.into(), status: status.into(), detail: detail.into(), fix: fix.map(String::from), key: None, args: Default::default(), fix_key: None }
}

impl Check {
    /// The detail's text key and values (health.d.<key>).
    fn tk(mut self, key: &str, args: &[(&str, String)]) -> Self {
        self.key = Some(format!("health.d.{key}"));
        self.args = args.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        self
    }
    /// The fix's text key (health.f.<key>).
    fn fk(mut self, key: &str) -> Self {
        self.fix_key = Some(format!("health.f.{key}"));
        self
    }
}

pub struct Input<'a> {
    pub family: crate::launch::Family,
    pub install: Option<&'a InstallInfo>,
    /// The folder the game writes profiles, replays and maps to.
    pub user_dir: Option<PathBuf>,
    pub tmloader: &'a TmLoaderInfo,
    /// Openplanet state for ManiaPlanet / Trackmania (2020).
    pub openplanet: Option<bool>,
    /// Free bytes on the install's disk (None = could not be read).
    pub free_bytes: Option<u64>,
    /// Horizon Host's record in the game folder (version, loader size), legacy games.
    pub host: Option<(String, Option<u64>)>,
}

pub fn run(i: &Input) -> Vec<Check> {
    use crate::launch::Family::*;
    let mut out = vec![exe(i.install)];
    if i.install.is_none() {
        return out;
    }
    if i.family == Forever {
        out.push(tmloader(i.tmloader));
    }
    if matches!(i.family, Eswc | Legacy) {
        out.push(loader(i.install.map(|x| Path::new(&x.path)), i.host.as_ref()));
    }
    if let (Some(op), true) = (i.openplanet, matches!(i.family, ManiaPlanet | Tm2020)) {
        out.push(if op {
            c("openplanet", "ok", "Openplanet is installed", None).tk("opOk", &[])
        } else {
            c("openplanet", "info", "Openplanet is not installed (only needed for plugins)", Some("Install it from the game page if you want plugins.")).tk("opMissing", &[]).fk("opInstall")
        });
    }
    out.push(userdir(i.user_dir.as_deref()));
    out.push(disk(i.free_bytes));
    out
}

fn exe(install: Option<&InstallInfo>) -> Check {
    let Some(inst) = install else { return c("exe", "fail", "No installation found", Some("Install the game, or use Add folder if it is somewhere else.")).tk("noInstall", &[]).fk("install") };
    let Some(exe) = inst.exe.as_deref() else {
        // Store games start through the store's URL; there is no exe to look at.
        return if inst.launch.is_some() { c("exe", "ok", format!("Starts through the store ({})", inst.source), None).tk("store", &[("source", inst.source.to_string())]) } else { c("exe", "warn", "The folder has no game program", Some("Check the folder or install the game again.")).tk("noExe", &[]).fk("checkFolder") };
    };
    let p = Path::new(exe);
    let Ok(meta) = std::fs::metadata(p) else {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return c("exe", "fail", format!("{name} is missing"), Some("The game was moved or removed: scan again or add its new folder.")).tk("exeMissing", &[("file", name)]).fk("moved");
    };
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let sha = if meta.len() <= HASH_MAX && !crate::fsx::blocked(p) {
        std::fs::read(p).ok().map(|b| hex::encode(Sha256::digest(&b))[..12].to_string())
    } else {
        None
    };
    let mb = (meta.len() >> 20).to_string();
    let detail = format!("{name}, {mb} MB{}", sha.as_ref().map(|s| format!(", SHA-256 {s}...")).unwrap_or_default());
    c("exe", "ok", detail, None).tk(if sha.is_some() { "exeOkSha" } else { "exeOk" }, &[("file", name), ("mb", mb), ("sha", sha.unwrap_or_default())])
}

fn tmloader(t: &TmLoaderInfo) -> Check {
    if !t.installed {
        c("tmloader", "fail", "TMLoader is not installed", Some("Install it from the game page (Forever mods need it).")).tk("tmlMissing", &[]).fk("tmlInstall")
    } else if t.first_run {
        c("tmloader", "warn", "TMLoader is installed but has not started yet", Some("Start TMLoader once so it creates its settings.")).tk("tmlFirst", &[]).fk("tmlStart")
    } else if t.profiles.is_empty() {
        c("tmloader", "warn", "TMLoader has no profile", Some("Create a profile in TMLoader or on the Mods page.")).tk("tmlNoProfile", &[]).fk("tmlProfile")
    } else {
        let v = t.version.as_deref().unwrap_or("?").to_string();
        let n = t.profiles.len().to_string();
        c("tmloader", "ok", format!("TMLoader {v} with {n} profile(s)"), None).tk("tmlOk", &[("version", v), ("n", n)])
    }
}

/// dinput8.dll next to the game's program (never read, only its size): Horizon Host's loader,
/// somebody else's, or none.
fn loader(dir: Option<&Path>, host: Option<&(String, Option<u64>)>) -> Check {
    let size = dir.and_then(|d| std::fs::metadata(d.join("dinput8.dll")).ok()).map(|m| m.len());
    match (size, host) {
        (Some(s), Some((v, Some(want)))) if s == *want => c("loader", "ok", format!("Horizon Client {v} loader is in place"), None).tk("loaderOk", &[("version", v.clone())]),
        (Some(_), Some((v, _))) => c("loader", "warn", format!("dinput8.dll differs from Horizon Client {v}'s loader"), Some("Another mod replaced it: reinstall Horizon Client on the game page (the other loader is chained).")).tk("loaderOther", &[("version", v.clone())]).fk("reinstallChain"),
        (Some(_), None) => c("loader", "info", "A dinput8.dll is in the game folder (another mod loader)", Some("Fine if you installed it; Horizon Client can chain it.")).tk("loaderForeign", &[]).fk("chainOk"),
        (None, Some((v, _))) => c("loader", "warn", format!("Horizon Client {v} is installed but its dinput8.dll is gone"), Some("Reinstall Horizon Client on the game page.")).tk("loaderGone", &[("version", v.clone())]).fk("reinstall"),
        (None, None) => c("loader", "info", "No mod loader (dinput8.dll) in the game folder", None).tk("loaderNone", &[]),
    }
}

/// Creates and removes one file in the folder.
pub fn writable(dir: &Path) -> Result<(), String> {
    let f = dir.join(".tmhorizon-write-test");
    std::fs::write(&f, b"x").map_err(|e| e.to_string())?;
    std::fs::remove_file(&f).map_err(|e| e.to_string())
}

fn userdir(dir: Option<&Path>) -> Check {
    let Some(d) = dir else { return c("userdir", "warn", "The game's user folder is unknown", Some("Start the game once so it creates its folder.")).tk("userUnknown", &[]).fk("startOnce") };
    let path = d.display().to_string();
    if !d.is_dir() {
        return c("userdir", "warn", format!("{path} does not exist yet"), Some("Start the game once so it creates its folder.")).tk("userMissing", &[("path", path)]).fk("startOnce");
    }
    match writable(d) {
        Ok(()) => c("userdir", "ok", format!("{path} can be written"), None).tk("userOk", &[("path", path)]),
        Err(e) => c("userdir", "fail", format!("{path} can't be written ({e})"), Some("Check the folder's permissions, or that no virus scanner or cloud sync blocks it.")).tk("userFail", &[("path", path), ("error", e)]).fk("permissions"),
    }
}

fn disk(free: Option<u64>) -> Check {
    match free {
        None => c("disk", "info", "Free disk space could not be read", None).tk("diskUnknown", &[]),
        Some(b) if b < FULL_BYTES => c("disk", "fail", format!("Only {} MB free", b >> 20), Some("Free some space; replays, videos and mods need room.")).tk("diskFull", &[("mb", (b >> 20).to_string())]).fk("freeSpace"),
        Some(b) if b < LOW_BYTES => c("disk", "warn", format!("{} MB free", b >> 20), Some("Free some space soon; videos and replays grow fast.")).tk("diskLow", &[("mb", (b >> 20).to_string())]).fk("freeSoon"),
        Some(b) => c("disk", "ok", format!("{} GB free", b >> 30), None).tk("diskOk", &[("gb", (b >> 30).to_string())]),
    }
}

/// Windows Defender: one row, failing when Defender has a detection for one of `files` (TMLoader, the game's
/// program, the mod loader DLLs). `resources` is Defender's detection list (None = could not be read).
pub fn defender(files: &[PathBuf], resources: Option<&str>) -> Check {
    let Some(r) = resources else { return c("defender", "info", "Windows Defender's list could not be read", None).tk("defUnknown", &[]) };
    match files.iter().find(|f| crate::defender::lists(r, f)) {
        Some(f) => {
            let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            c("defender", "fail", format!("Windows Defender blocks {name}"), Some("Allow it in Windows Security > Protection history.")).tk("defBlocks", &[("file", name)]).fk("defAllow")
        }
        None => c("defender", "ok", "Nothing of this game is blocked", None).tk("defOk", &[]),
    }
}

/// Free bytes on the volume that holds `p`.
#[cfg(windows)]
pub fn free_bytes(p: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut dir = p;
    while !dir.is_dir() {
        dir = dir.parent()?;
    }
    let w: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    // SAFETY: `w` is NUL-terminated and outlives the call; the out pointers are valid or null.
    let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
pub fn free_bytes(p: &Path) -> Option<u64> {
    let mut dir = p;
    while !dir.is_dir() {
        dir = dir.parent()?;
    }
    let out = std::process::Command::new("df").args(["-Pk"]).arg(dir).output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout).lines().nth(1)?.to_string();
    line.split_whitespace().nth(3)?.parse::<u64>().ok().map(|k| k * 1024)
}

// ------------------------------------------------------------------ command

#[tauri::command]
pub async fn health_check(app: tauri::AppHandle, game_id: String) -> Result<Vec<Check>, String> {
    crate::bg::run(move || -> Result<Vec<Check>, String> {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let family = crate::launch::family(&game_id).ok_or("Unknown game")?;
        let install = st.install(&game_id);
        let snap = st.snapshot.lock().unwrap().clone();
        let tml = snap.as_ref().map(|s| s.tmloader.clone()).unwrap_or_default();
        let docs = crate::platform::documents_dir();
        use crate::launch::Family::*;
        let user_dir = match family {
            Forever => docs.as_ref().map(|d| d.join("TrackMania")),
            ManiaPlanet => docs.as_ref().map(|d| d.join("ManiaPlanet")),
            Tm2020 => docs.as_deref().map(crate::maps::tm2020_user_dir),
            Eswc | Legacy | Classic => install.as_ref().map(|i| Path::new(&i.path).join("GameData")),
            Turbo | Console => None,
        };
        let openplanet = snap.as_ref().and_then(|s| match family {
            Tm2020 => Some(s.openplanet.get("tm2020")?.installed),
            ManiaPlanet => Some(s.openplanet.get("maniaplanet")?.installed),
            _ => None,
        });
        let host = install.as_ref().and_then(|i| crate::horizonhost::read_record(&Path::new(&i.path).join(crate::horizonhost::format::HOST_DIR))).map(|r| (r.version, r.loader_size));
        let free = install.as_ref().and_then(|i| free_bytes(Path::new(&i.path)));
        let mut out = run(&Input { family, install: install.as_ref(), user_dir, tmloader: &tml, openplanet, free_bytes: free, host });
        if cfg!(windows) && install.is_some() {
            let mut files: Vec<PathBuf> = Vec::new();
            if family == Forever {
                files.extend(crate::commands::tmloader_exe(&st));
            }
            if let Some(i) = install.as_ref() {
                files.extend(i.exe.as_ref().map(PathBuf::from));
                let dir = Path::new(&i.path);
                files.push(dir.join("dinput8.dll"));
                files.push(dir.join(crate::horizonhost::format::HOST_DIR).join(crate::horizonhost::format::HOST_DLL));
            }
            out.push(defender(&files, crate::defender::detected_resources().as_deref()));
        }
        Ok(out)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::Family;

    fn inst(dir: &Path, exe: Option<&str>) -> InstallInfo {
        InstallInfo { source: "test".into(), path: dir.to_string_lossy().into(), exe: exe.map(|e| dir.join(e).to_string_lossy().into_owned()), launcher: None, launch: None, modified: None, note: None, steam_app_id: None, rom: None, extra_args: vec![] }
    }

    fn input<'a>(f: Family, i: Option<&'a InstallInfo>, user: Option<PathBuf>, t: &'a TmLoaderInfo) -> Input<'a> {
        Input { family: f, install: i, user_dir: user, tmloader: t, openplanet: None, free_bytes: Some(50 << 30), host: None }
    }

    fn by<'a>(v: &'a [Check], id: &str) -> &'a Check {
        v.iter().find(|x| x.id == id).unwrap_or_else(|| panic!("no {id}"))
    }

    #[test]
    fn healthy_forever_game() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("TmForever.exe"), vec![1u8; 3 << 20]).unwrap();
        let user = t.path().join("Documents");
        std::fs::create_dir_all(&user).unwrap();
        let i = inst(t.path(), Some("TmForever.exe"));
        let tml = TmLoaderInfo { installed: true, version: Some("1.0.1".into()), profiles: vec![crate::tmloader::TmlProfile { name: "default".into(), program: None, args: None, mods: vec![], modified: None }], ..Default::default() };
        let r = run(&input(Family::Forever, Some(&i), Some(user.clone()), &tml));
        assert!(r.iter().all(|x| x.status == "ok" && x.fix.is_none()), "{r:?}");
        assert!(by(&r, "exe").detail.contains("TmForever.exe, 3 MB, SHA-256"));
        assert!(!user.join(".tmhorizon-write-test").exists(), "the test file is removed");
    }

    #[test]
    fn problems_come_with_a_hint() {
        let t = tempfile::tempdir().unwrap();
        let missing = inst(t.path(), Some("Gone.exe"));
        let tml = TmLoaderInfo::default();
        let mut inp = input(Family::Forever, Some(&missing), Some(t.path().join("nope")), &tml);
        inp.free_bytes = Some(100 << 20);
        let r = run(&inp);
        assert_eq!(by(&r, "exe").status, "fail");
        assert_eq!(by(&r, "tmloader").status, "fail");
        assert_eq!(by(&r, "userdir").status, "warn");
        assert_eq!(by(&r, "disk").status, "fail");
        assert!(r.iter().all(|x| x.fix.is_some()), "every problem says what to do");
        // Not installed at all: one line.
        let none = run(&input(Family::Forever, None, None, &tml));
        assert_eq!(none.len(), 1);
        assert_eq!(none[0].status, "fail");
        // TMLoader there but never started / low disk.
        let first = TmLoaderInfo { installed: true, first_run: true, ..Default::default() };
        assert_eq!(tmloader(&first).status, "warn");
        assert_eq!(disk(Some(1 << 30)).status, "warn");
        assert_eq!(disk(None).status, "info");
    }

    #[test]
    fn user_folder_that_cannot_be_written() {
        let t = tempfile::tempdir().unwrap();
        // A file where the folder should be: not a folder.
        let f = t.path().join("file");
        std::fs::write(&f, b"x").unwrap();
        assert_eq!(userdir(Some(&f)).status, "warn");
        // A read-only folder is a failure where the OS enforces it; the check at least runs.
        let d = t.path().join("ro");
        std::fs::create_dir_all(&d).unwrap();
        assert!(writable(&d).is_ok());
        assert_eq!(userdir(Some(&d)).status, "ok");
    }

    #[test]
    fn dinput8_chain_states() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path();
        assert_eq!(loader(Some(p), None).status, "info");
        assert_eq!(loader(Some(p), Some(&("0.2.0".into(), Some(4)))).status, "warn", "record but no file");
        std::fs::write(p.join("dinput8.dll"), b"abcd").unwrap();
        assert_eq!(loader(Some(p), Some(&("0.2.0".into(), Some(4)))).status, "ok");
        assert_eq!(loader(Some(p), Some(&("0.2.0".into(), Some(9)))).status, "warn", "replaced by another loader");
        assert_eq!(loader(Some(p), None).status, "info", "somebody else's loader");
    }

    #[test]
    fn free_space_is_readable() {
        let t = tempfile::tempdir().unwrap();
        assert!(free_bytes(t.path()).is_some_and(|b| b > 0));
        assert!(free_bytes(&t.path().join("a/b/c")).is_some(), "a folder that does not exist yet: its parent counts");
    }

    #[test]
    fn openplanet_only_for_its_games() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("Trackmania.exe"), b"x").unwrap();
        let i = inst(t.path(), Some("Trackmania.exe"));
        let tml = TmLoaderInfo::default();
        let mut inp = input(Family::Tm2020, Some(&i), None, &tml);
        inp.openplanet = Some(false);
        assert_eq!(by(&run(&inp), "openplanet").status, "info");
        inp.family = Family::Forever;
        assert!(run(&inp).iter().all(|x| x.id != "openplanet"));
    }
}
