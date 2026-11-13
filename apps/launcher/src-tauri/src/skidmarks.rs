//! Skid marks "Classic / Clean" for Nations and United Forever.
//!
//! Community tweak: `GameData\Vehicles\Media\Texture\Image\AsphaltMarks.dds` is replaced by a copy of
//! `GrassMarkFenceIntens.dds`, which gives clean, visible marks on Stadium road. The texture is
//! visual only and client-side (like skins).
//!
//! State is read by SHA-256 of the file: Classic (the original), Clean (= GrassMarkFenceIntens, the
//! game's own file) or Custom (anything else). Switching writes only that one file, atomically, and
//! goes through the change history, so the original is in the History store and Settings > History can
//! undo it. An existing `AsphaltMarks.bak` that holds the original also counts as the backup.
//!
//! Known hashes (MD5 as the community lists them): original `cfce03a39422e08c856dd36376227cf2`,
//! clean `f137127c1d507472c5bc3544a2ced4d4`. Both games ship identical files.
//!
//! DirtMarks.dds is left alone: it is 64x256 DXT5 (9 mips), the road texture is 128x256, so the
//! clean texture does not fit its layout.

use crate::fsx;
use crate::history::{self, Op, Recorder};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const ORIG_SHA: &str = "06fad4801b51d1ffea6e35b987c19aa4cbcc6053cd1ddc8266e839f1f3b229a8";
const CLEAN_SHA: &str = "dc1ab218e0176731fc5f69c99125069bbe3f8813a4f23af520e2908a9e6ac24e";

/// The two known contents; tests use their own.
pub struct Known {
    pub orig: String,
    pub clean: String,
}

pub fn known() -> Known {
    Known { orig: ORIG_SHA.into(), clean: CLEAN_SHA.into() }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mark {
    Classic,
    Clean,
    Custom,
    /// No AsphaltMarks.dds in the folder.
    Missing,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkidState {
    pub mark: Mark,
    /// The game's GrassMarkFenceIntens.dds is there and unchanged, so Clean can be written.
    pub can_clean: bool,
    /// The original can be put back (backup file or History copy).
    pub can_restore: bool,
    /// The game folder is under Program Files: a direct switch needs admin.
    pub protected: bool,
    /// The TMLoader product way (filled by the commands; default in `state`).
    pub tml: TmlSkid,
}

fn img_dir(game_dir: &Path) -> PathBuf {
    game_dir.join("GameData").join("Vehicles").join("Media").join("Texture").join("Image")
}

fn sha_of(p: &Path) -> Option<String> {
    if fsx::blocked(p) || !fsx::is_file(p) {
        return None;
    }
    let b = std::fs::read(p).ok()?;
    Some(format!("{:x}", Sha256::digest(&b)))
}

fn bak_with_original(dir: &Path, k: &Known) -> Option<PathBuf> {
    let p = dir.join("AsphaltMarks.bak");
    (sha_of(&p).as_deref() == Some(k.orig.as_str())).then_some(p)
}

/// Newest History entry of ours that can be undone now and started from the original.
fn history_entry(data: &Path, game: &str, asphalt: &Path, k: &Known) -> Option<String> {
    let me = fsx::norm(asphalt);
    history::list(data, Some(game), true)
        .into_iter()
        .find(|v| v.blocked.is_none() && v.change.kind.starts_with("skid-") && v.change.files.iter().any(|f| fsx::norm(Path::new(&f.path)) == me && f.before.as_deref() == Some(k.orig.as_str())))
        .map(|v| v.change.id)
}

pub fn state(data: &Path, game: &str, game_dir: &Path, k: &Known) -> SkidState {
    let dir = img_dir(game_dir);
    let asphalt = dir.join("AsphaltMarks.dds");
    let mark = match sha_of(&asphalt) {
        None => Mark::Missing,
        Some(h) if h == k.orig => Mark::Classic,
        Some(h) if h == k.clean => Mark::Clean,
        Some(_) => Mark::Custom,
    };
    let can_clean = sha_of(&dir.join("GrassMarkFenceIntens.dds")).as_deref() == Some(k.clean.as_str());
    let can_restore = mark != Mark::Classic && mark != Mark::Missing && (bak_with_original(&dir, k).is_some() || history_entry(data, game, &asphalt, k).is_some());
    SkidState { mark, can_clean, can_restore, protected: protected(game_dir), tml: TmlSkid::default() }
}

fn friendly(e: String, game: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("os error 5") || l.contains("denied") || l.contains("zugriff") {
        let name = if game == "tmnf" { "Nations Forever" } else { "United Forever" };
        format!("{name} is in a protected folder. Run TM Horizon as administrator once to change this.")
    } else {
        format!("{e} Nothing was changed.")
    }
}

/// Writes `bytes` over AsphaltMarks.dds as one History entry. The write is atomic (temporary file,
/// then rename), a failure leaves the old file.
fn write_marks(data: &Path, game: &str, dir: &Path, bytes: &[u8], kind: &str) -> Result<(), String> {
    let asphalt = dir.join("AsphaltMarks.dds");
    let rec = Recorder::start(data, Op::for_game(game, kind, "Skid marks"), vec![history::Watch::File(asphalt.clone())]);
    let r = fsx::write(&asphalt, bytes);
    rec.finish();
    r.map_err(|e| friendly(e, game))
}

/// Classic or Custom -> Clean.
pub fn set_clean(data: &Path, game: &str, game_dir: &Path, k: &Known) -> Result<SkidState, String> {
    let dir = img_dir(game_dir);
    if sha_of(&dir.join("AsphaltMarks.dds")).is_none() {
        return Err("AsphaltMarks.dds is missing in this game folder.".into());
    }
    let src = dir.join("GrassMarkFenceIntens.dds");
    let bytes = std::fs::read(&src).map_err(|e| format!("GrassMarkFenceIntens.dds: {e}"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != k.clean {
        return Err("GrassMarkFenceIntens.dds in this game folder is not the known file, nothing was changed.".into());
    }
    write_marks(data, game, &dir, &bytes, "skid-clean")?;
    Ok(state(data, game, game_dir, k))
}

/// Clean or Custom -> Classic: from AsphaltMarks.bak when it holds the original, else by undoing our History entry.
pub fn restore(data: &Path, game: &str, game_dir: &Path, k: &Known, running: &[String]) -> Result<SkidState, String> {
    let dir = img_dir(game_dir);
    if let Some(bak) = bak_with_original(&dir, k) {
        let bytes = std::fs::read(&bak).map_err(|e| format!("AsphaltMarks.bak: {e}"))?;
        write_marks(data, game, &dir, &bytes, "skid-classic")?;
    } else if let Some(id) = history_entry(data, game, &dir.join("AsphaltMarks.dds"), k) {
        let r = history::undo(data, &id, running);
        if !r.ok {
            return Err(format!("Could not put the original back ({}). Use Settings > History.", r.code));
        }
    } else {
        return Err("No copy of the original texture found.".into());
    }
    Ok(state(data, game, game_dir, k))
}

// ------------------------------------------------------------------ commands

// ------------------------------------------------------------------ TMLoader product (no admin)
//
// Forever under Program Files needs admin to change one texture. With TMLoader there is another way:
// a product "Skid Marks" whose version folder carries `GameData\Vehicles\Media\Texture\Image\AsphaltMarks.dds`
// (the game's own GrassMarkFenceIntens.dds, checked by SHA-256), switched on in a profile. TMLoader's
// TmForever product carries a GameData folder of its own, so products can bring game files; whether
// TMLoader also lays an extra product's GameData over the game is NOT verified yet (the card says so).
// Nothing is written into the game folder. Classic removes the product (backup folder + History).

pub const TML_PRODUCT: &str = "Skid Marks";
pub const TML_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TmlSkid {
    /// TMLoader was found.
    pub available: bool,
    /// products\Skid Marks\1.0.0 holds the clean texture.
    pub installed: bool,
    /// Profiles that have the product switched on.
    pub profiles_on: Vec<String>,
    pub profiles: Vec<String>,
}

fn tml_rel() -> PathBuf {
    PathBuf::from("GameData").join("Vehicles").join("Media").join("Texture").join("Image").join("AsphaltMarks.dds")
}

pub fn tml_product_dir(tml_root: &Path) -> PathBuf {
    crate::tmloader::products_dir(tml_root).join(TML_PRODUCT)
}

/// The game folder is one Windows protects (Program Files): writing there needs admin.
pub fn protected(game_dir: &Path) -> bool {
    let n = format!("{}\\", fsx::norm(game_dir));
    n.contains("\\program files\\") || n.contains("\\program files (x86)\\")
}

pub fn tml_state(tml_root: Option<&Path>, k: &Known) -> TmlSkid {
    let Some(root) = tml_root.filter(|r| fsx::is_dir(&crate::tmloader::products_dir(r))) else { return TmlSkid::default() };
    let file = tml_product_dir(root).join(TML_VERSION).join(tml_rel());
    let info = crate::tmloader::read_info(root);
    TmlSkid {
        available: true,
        installed: sha_of(&file).as_deref() == Some(k.clean.as_str()),
        profiles_on: info.profiles.iter().filter(|p| p.mods.iter().any(|m| m.id == TML_PRODUCT)).map(|p| p.name.clone()).collect(),
        profiles: info.profiles.iter().map(|p| p.name.clone()).collect(),
    }
}

/// Writes the product (the clean texture is read from the game folder, never written there) and switches
/// it on in `profiles`.
pub fn tml_install(tml_root: &Path, game_dir: &Path, k: &Known, profiles: &[String], backup_dir: &Path) -> Result<String, String> {
    let src = img_dir(game_dir).join("GrassMarkFenceIntens.dds");
    let bytes = std::fs::read(&src).map_err(|e| format!("GrassMarkFenceIntens.dds: {e}"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != k.clean {
        return Err("GrassMarkFenceIntens.dds in this game folder is not the known file, nothing was changed.".into());
    }
    {
        let _g = crate::tmloader::write_lock();
        let pdir = tml_product_dir(tml_root);
        let vdir = pdir.join(TML_VERSION);
        fsx::write(&vdir.join(tml_rel()), &bytes)?;
        // No executable: the product only brings a game file (whether TMLoader accepts that is part of the owner test).
        fsx::write(&vdir.join("description.yaml"), b"dependencies: []\nchangelog: Clean skid marks on Stadium road (AsphaltMarks.dds = the game's GrassMarkFenceIntens.dds).\n")?;
        fsx::write(
            &pdir.join("description.yaml"),
            b"name: Skid Marks\nauthor: TM Horizon\ntype: modification\ndescription: 'Clean skid marks on Stadium road. Brings one game texture, no DLL.'\n",
        )?;
    }
    let mut on = vec![];
    for p in profiles {
        crate::tmloader::set_profile_mod(tml_root, p, TML_PRODUCT, true, backup_dir)?;
        on.push(p.clone());
    }
    Ok(if on.is_empty() { "Skid Marks installed in TMLoader.".into() } else { format!("Skid Marks installed in TMLoader and switched on in {}.", on.join(", ")) })
}

/// Switches the product off in every profile and moves its folder into the backup folder.
pub fn tml_remove(tml_root: &Path, backup_dir: &Path) -> Result<String, String> {
    let pdir = tml_product_dir(tml_root);
    for p in crate::tmloader::read_info(tml_root).profiles {
        if p.mods.iter().any(|m| m.id == TML_PRODUCT) {
            crate::tmloader::set_profile_mod(tml_root, &p.name, TML_PRODUCT, false, backup_dir)?;
        }
    }
    if !fsx::is_dir(&pdir) {
        return Ok("Skid Marks switched off.".into());
    }
    if !fsx::is_inside(&pdir, &crate::tmloader::products_dir(tml_root)) {
        return Err("refusing".into());
    }
    let _g = crate::tmloader::write_lock();
    let to = backup_dir.join(TML_PRODUCT);
    std::fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&to);
    if std::fs::rename(&pdir, &to).is_err() {
        copy_dir(&pdir, &to)?;
        std::fs::remove_dir_all(&pdir).map_err(|e| format!("{}: {e}", pdir.display()))?;
    }
    Ok(format!("Skid Marks removed from TMLoader. Backup: {}", to.display()))
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in fsx::list(from) {
        if e.is_dir {
            copy_dir(&e.path, &to.join(&e.name))?;
        } else if e.is_file {
            fsx::copy(&e.path, &to.join(&e.name))?;
        }
    }
    Ok(())
}

fn dir_of(st: &crate::state::AppState, game: &str) -> Result<PathBuf, String> {
    if game != "tmnf" && game != "tmuf" {
        return Err("Only for Nations and United Forever".into());
    }
    let dir = st.install_dir(game).ok_or("Not installed")?;
    if fsx::blocked(&dir) {
        return Err("Refusing this folder".into());
    }
    Ok(dir)
}

#[tauri::command]
pub async fn skid_state(app: tauri::AppHandle, game: String) -> Option<SkidState> {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        dir_of(&st, &game).ok().map(|d| {
            let mut s = state(&st.data_dir, &game, &d, &known());
            s.tml = tml_state(st.tmloader_root().as_deref(), &known());
            s
        })
    })
    .await
}

fn game_closed(game: &str) -> Result<Vec<String>, String> {
    let running = crate::platform::running_process_names();
    let procs = history::processes_for(&[game.to_string()]);
    if let Some(p) = running.iter().find(|r| procs.iter().any(|x| x.eq_ignore_ascii_case(r))) {
        return Err(format!("Close the game first ({p} is running)."));
    }
    Ok(running)
}

/// Install the "Skid Marks" TMLoader product and switch it on in `profiles` (no admin, nothing in the game folder).
#[tauri::command]
pub async fn skid_tml_install(app: tauri::AppHandle, game: String, profiles: Vec<String>) -> Result<SkidState, String> {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let dir = dir_of(&st, &game)?;
        let root = st.tmloader_root().ok_or("TMLoader not found")?;
        crate::tmloader::ensure_idle()?;
        game_closed(&game)?;
        let mut w = history::tml_profiles(&root);
        w.push(history::Watch::Tree(tml_product_dir(&root)));
        let rec = Recorder::start(&st.data_dir, Op::for_game(&game, "skid-tml", "Skid marks (TMLoader)"), w);
        let r = tml_install(&root, &dir, &known(), &profiles, &st.backup_dir());
        rec.finish();
        r?;
        crate::commands::refresh_tmloader(&st);
        let mut s = state(&st.data_dir, &game, &dir, &known());
        s.tml = tml_state(Some(&root), &known());
        Ok(s)
    })
    .await
}

/// Remove the "Skid Marks" TMLoader product (switched off everywhere, folder into the backups).
#[tauri::command]
pub async fn skid_tml_remove(app: tauri::AppHandle, game: String) -> Result<SkidState, String> {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let dir = dir_of(&st, &game)?;
        let root = st.tmloader_root().ok_or("TMLoader not found")?;
        crate::tmloader::ensure_idle()?;
        game_closed(&game)?;
        let mut w = history::tml_profiles(&root);
        w.push(history::Watch::Tree(tml_product_dir(&root)));
        let rec = Recorder::start(&st.data_dir, Op::for_game(&game, "skid-tml-remove", "Skid marks (TMLoader)"), w);
        let r = tml_remove(&root, &st.backup_dir());
        rec.finish();
        r?;
        crate::commands::refresh_tmloader(&st);
        let mut s = state(&st.data_dir, &game, &dir, &known());
        s.tml = tml_state(Some(&root), &known());
        Ok(s)
    })
    .await
}

/// `clean` true = clean marks, false = classic (original) marks.
#[tauri::command]
pub async fn skid_set(app: tauri::AppHandle, game: String, clean: bool) -> Result<SkidState, String> {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<crate::state::AppState>(&app);
        let dir = dir_of(&st, &game)?;
        let running = crate::platform::running_process_names();
        let procs = history::processes_for(&[game.clone()]);
        if let Some(p) = running.iter().find(|r| procs.iter().any(|x| x.eq_ignore_ascii_case(r))) {
            return Err(format!("Close the game first ({p} is running)."));
        }
        if clean { set_clean(&st.data_dir, &game, &dir, &known()) } else { restore(&st.data_dir, &game, &dir, &known(), &running) }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(b: &[u8]) -> String {
        format!("{:x}", Sha256::digest(b))
    }

    /// (data dir, game dir, known) with an original AsphaltMarks and the clean source.
    fn setup(t: &Path) -> (PathBuf, PathBuf, Known) {
        let data = t.join("data");
        let game = t.join("game");
        let img = img_dir(&game);
        std::fs::create_dir_all(&img).unwrap();
        std::fs::write(img.join("AsphaltMarks.dds"), b"original").unwrap();
        std::fs::write(img.join("GrassMarkFenceIntens.dds"), b"clean-marks").unwrap();
        (data, game, Known { orig: sha(b"original"), clean: sha(b"clean-marks") })
    }

    #[test]
    fn constants_are_sha256() {
        assert!(known().orig.len() == 64 && known().clean.len() == 64 && known().orig != known().clean);
    }

    #[test]
    fn detects_classic_clean_custom_missing() {
        let t = tempfile::tempdir().unwrap();
        let (data, game, k) = setup(t.path());
        let a = img_dir(&game).join("AsphaltMarks.dds");
        let s = state(&data, "tmnf", &game, &k);
        assert_eq!((s.mark, s.can_clean, s.can_restore), (Mark::Classic, true, false));
        std::fs::write(&a, b"clean-marks").unwrap();
        assert_eq!(state(&data, "tmnf", &game, &k).mark, Mark::Clean);
        std::fs::write(&a, b"something else").unwrap();
        let s = state(&data, "tmnf", &game, &k);
        assert_eq!((s.mark, s.can_restore), (Mark::Custom, false));
        std::fs::remove_file(&a).unwrap();
        assert_eq!(state(&data, "tmnf", &game, &k).mark, Mark::Missing);
        // A source that was changed cannot be used.
        std::fs::write(img_dir(&game).join("GrassMarkFenceIntens.dds"), b"x").unwrap();
        assert!(!state(&data, "tmnf", &game, &k).can_clean);
    }

    #[test]
    fn switch_and_restore_through_history() {
        let t = tempfile::tempdir().unwrap();
        let (data, game, k) = setup(t.path());
        let img = img_dir(&game);
        let s = set_clean(&data, "tmnf", &game, &k).unwrap();
        assert_eq!((s.mark, s.can_restore), (Mark::Clean, true));
        assert_eq!(std::fs::read(img.join("AsphaltMarks.dds")).unwrap(), b"clean-marks");
        // Only that file changed: no backup file next to it, source untouched.
        let mut names: Vec<String> = std::fs::read_dir(&img).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["AsphaltMarks.dds", "GrassMarkFenceIntens.dds"]);
        assert!(history::list(&data, Some("tmnf"), false).iter().any(|v| v.change.kind == "skid-clean"));
        let s = restore(&data, "tmnf", &game, &k, &[]).unwrap();
        assert_eq!(s.mark, Mark::Classic);
        assert_eq!(std::fs::read(img.join("AsphaltMarks.dds")).unwrap(), b"original");
    }

    #[test]
    fn restore_from_hand_made_bak_and_custom_overwrite() {
        let t = tempfile::tempdir().unwrap();
        let (data, game, k) = setup(t.path());
        let img = img_dir(&game);
        // Hand-made state like United: dds == clean, bak == original, no History.
        std::fs::write(img.join("AsphaltMarks.bak"), b"original").unwrap();
        std::fs::write(img.join("AsphaltMarks.dds"), b"clean-marks").unwrap();
        let s = state(&data, "tmuf", &game, &k);
        assert_eq!((s.mark, s.can_restore), (Mark::Clean, true));
        assert_eq!(restore(&data, "tmuf", &game, &k, &[]).unwrap().mark, Mark::Classic);
        assert!(history::list(&data, Some("tmuf"), false).iter().any(|v| v.change.kind == "skid-classic"));
        assert_eq!(std::fs::read(img.join("AsphaltMarks.bak")).unwrap(), b"original");
        // Custom file, no backup anywhere: Restore refuses, Clean works.
        std::fs::remove_file(img.join("AsphaltMarks.bak")).unwrap();
        std::fs::write(img.join("AsphaltMarks.dds"), b"custom").unwrap();
        let data2 = t.path().join("data2");
        assert!(!state(&data2, "tmuf", &game, &k).can_restore);
        assert!(restore(&data2, "tmuf", &game, &k, &[]).is_err());
        assert_eq!(std::fs::read(img.join("AsphaltMarks.dds")).unwrap(), b"custom");
        assert_eq!(set_clean(&data2, "tmuf", &game, &k).unwrap().mark, Mark::Clean);
    }

    #[test]
    fn failed_write_changes_nothing() {
        let t = tempfile::tempdir().unwrap();
        let (data, game, k) = setup(t.path());
        let img = img_dir(&game);
        // A read-only target cannot be replaced by rename on Windows; elsewhere the write may succeed.
        let a = img.join("AsphaltMarks.dds");
        let mut p = std::fs::metadata(&a).unwrap().permissions();
        p.set_readonly(true);
        std::fs::set_permissions(&a, p.clone()).unwrap();
        let r = set_clean(&data, "tmnf", &game, &k);
        if r.is_err() {
            assert_eq!(std::fs::read(&a).unwrap(), b"original");
            assert!(std::fs::read_dir(&img).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmhub-tmp")));
        }
        #[allow(clippy::permissions_set_readonly_false)]
        p.set_readonly(false);
        std::fs::set_permissions(&a, p).unwrap();
        // Missing texture: clear message.
        std::fs::remove_file(&a).unwrap();
        assert!(set_clean(&data, "tmnf", &game, &k).unwrap_err().contains("missing"));
    }
    #[test]
    fn protected_folders() {
        assert!(protected(Path::new(r"C:\Program Files (x86)\TmNationsForever")));
        assert!(protected(Path::new(r"C:\Program Files\TmUnitedForever")));
        assert!(!protected(Path::new(r"D:\Games\TmNationsForever")));
        assert!(!protected(Path::new(r"D:\Program Files Backup\TmNationsForever")));
    }

    #[test]
    fn tmloader_product_install_and_remove() {
        let t = tempfile::tempdir().unwrap();
        let (data, game, k) = setup(t.path());
        let root = t.path().join("TMLoader");
        crate::tmloader::tests::fake_root(&root);
        let backups = t.path().join("backups");
        assert_eq!(tml_state(None, &k), TmlSkid::default());
        let s = tml_state(Some(&root), &k);
        assert!(s.available && !s.installed && s.profiles == ["default"]);

        tml_install(&root, &game, &k, &["default".to_string()], &backups).unwrap();
        let v = tml_product_dir(&root).join(TML_VERSION);
        assert_eq!(std::fs::read(v.join("GameData/Vehicles/Media/Texture/Image/AsphaltMarks.dds")).unwrap(), b"clean-marks");
        assert!(std::fs::read_to_string(tml_product_dir(&root).join("description.yaml")).unwrap().contains("type: modification"));
        let s = tml_state(Some(&root), &k);
        assert!(s.installed);
        assert_eq!(s.profiles_on, ["default"]);
        // The game folder is untouched, and TMLoader reads the product like its own.
        assert_eq!(std::fs::read(img_dir(&game).join("AsphaltMarks.dds")).unwrap(), b"original");
        let info = crate::tmloader::read_info(&root);
        assert!(info.products.contains_key(TML_PRODUCT));
        assert!(info.profiles[0].mods.iter().any(|m| m.id == "TMUnlimiter"), "other mods stay");
        let _ = data;

        tml_remove(&root, &backups).unwrap();
        assert!(!tml_product_dir(&root).exists());
        assert!(backups.join(TML_PRODUCT).join(TML_VERSION).join("description.yaml").is_file());
        let s = tml_state(Some(&root), &k);
        assert!(!s.installed && s.profiles_on.is_empty());
    }

    #[test]
    fn tmloader_product_refuses_unknown_source() {
        let t = tempfile::tempdir().unwrap();
        let (_, game, k) = setup(t.path());
        let root = t.path().join("TMLoader");
        crate::tmloader::tests::fake_root(&root);
        std::fs::write(img_dir(&game).join("GrassMarkFenceIntens.dds"), b"changed").unwrap();
        assert!(tml_install(&root, &game, &k, &["default".to_string()], &t.path().join("b")).is_err());
        assert!(!tml_product_dir(&root).exists());
    }
}
