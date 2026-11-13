//! "Get" for games that are not installed: official sources only.
//!
//! Download flow: official setup -> SHA-256 + Authenticode check -> the user confirms when the
//! setup is not signed by a trusted publisher -> the setup runs with its normal UI (no silent
//! switches: none were verified by reading the installers) -> rescan when it exits.
//! The SHA-256 of each setup URL is recorded the first time; a later download with another
//! hash is refused unless it is signed by Nadeo or Ubisoft (then the record is updated).
//! Setups only served over plain http (TMUF) ship with their known SHA-256 and are refused when
//! the bytes differ. Right before the setup runs it is hashed again.

use crate::launch::{Arg, CommandSpec};
use crate::platform::SignatureInfo;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// Official setup downloaded and run by the hub.
    Download {
        url: &'static str,
        file: &'static str,
        size: u64,
        note: &'static str,
        /// Known SHA-256 of the file (required for plain-http URLs).
        #[serde(skip)]
        sha256: Option<&'static str>,
    },
    /// Store pages; the store installs the game.
    Stores { stores: Vec<Store>, note: &'static str },
    /// Nothing legal to download; the hub only detects it.
    None { note: &'static str },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Store {
    pub label: &'static str,
    pub url: &'static str,
    /// One or two words under the name: "Free", "Paid".
    pub sub: &'static str,
}


pub const TMUF_SHA256: &str = "f8a4d09c64d65be271c0346f5b0e41529cb25eb8c605d4602d0f34f27fb1355f";

/// Publishers whose signature makes a setup trusted without asking.
pub fn trusted_publisher(signer: Option<&str>) -> bool {
    signer.is_some_and(|s| {
        let l = s.to_lowercase();
        l.contains("nadeo") || l.contains("ubisoft")
    })
}

pub fn source(game: &str) -> Source {
    match game {
        "tmnf" => Source::Download {
            url: "https://nadeo-download.cdn.ubi.com/trackmaniaforever/tmnationsforever_setup.exe",
            file: "tmnationsforever_setup.exe",
            size: 530_600_781,
            note: "Free. Official setup from Nadeo (Ubisoft CDN).",
            sha256: None,
        },
        "tmuf" => Source::Download {
            url: "http://files.trackmaniaforever.com/tmunitedforever_setup.exe",
            file: "tmunitedforever_setup.exe",
            size: 1_211_926_014,
            note: "Official setup from Nadeo. United needs a paid key the first time you start it.",
            // Nadeo serves this file over plain http only and it is not signed; this is its SHA-256
            // (downloaded and checked on 2026-11-10, 1 211 926 014 bytes).
            sha256: Some(TMUF_SHA256),
        },
        "tm2-stadium" | "tm2-canyon" | "tm2-valley" | "tm2-lagoon" | "sm-storm" => Source::Download {
            url: "https://nadeo-download.cdn.ubi.com/maniaplanet/Maniaplanet_Setup.exe",
            file: "Maniaplanet_Setup.exe",
            size: 94_482_296,
            note: "Official ManiaPlanet setup. Title packs are added inside ManiaPlanet.",
            sha256: None,
        },
        "tm2020" => Source::Stores {
            stores: vec![
                Store { label: "Ubisoft Connect", url: "https://www.ubisoft.com/en-us/game/trackmania/trackmania", sub: "Free · Ubisoft account" },
                Store { label: "Steam", url: "https://store.steampowered.com/app/2225070/", sub: "Free · Ubisoft account" },
                Store { label: "Epic Games", url: "https://store.epicgames.com/p/trackmania", sub: "Free · Ubisoft account" },
            ],
            note: "Free to play. Install it from a store.",
        },
        "tm-turbo" => Source::Stores {
            stores: vec![
                Store { label: "Steam", url: "https://store.steampowered.com/app/375900/", sub: "Paid" },
                Store { label: "Ubisoft Connect", url: "https://www.ubisoft.com/en-us/games/trackmania-turbo", sub: "Paid" },
            ],
            note: "Install it from a store.",
        },
        _ => Source::None { note: "Not sold anymore. The hub finds it when it is installed." },
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub sha256: String,
    pub signature: String,
    pub signed: bool,
    /// First download of this URL: the hash gets recorded when the setup is run.
    pub first_time: bool,
    /// May run (after confirmation when `needs_confirm`).
    pub ok: bool,
    pub needs_confirm: bool,
    pub message: String,
    /// The recorded hash should be replaced by this one (a new signed release of the setup).
    #[serde(skip)]
    pub update_record: bool,
}

pub fn decide(url: &str, sha256: &str, sig: &SignatureInfo, recorded: Option<&str>, known: Option<&str>) -> Verdict {
    let mismatch = recorded.map(|r| !r.eq_ignore_ascii_case(sha256)).unwrap_or(false);
    let https = url.starts_with("https://");
    let publisher = sig.trusted && trusted_publisher(sig.signer.as_deref());
    let mut update_record = false;
    let (ok, needs_confirm, message) = if let Some(k) = known {
        if k.eq_ignore_ascii_case(sha256) {
            (true, false, format!("SHA-256 matches the known setup. {}.", sig.detail))
        } else {
            (false, false, format!("The setup is not the known file (SHA-256 {sha256}). Not run."))
        }
    } else if !https {
        (false, false, "Downloaded over plain http without a known SHA-256. Not run.".to_string())
    } else if mismatch && publisher {
        update_record = true;
        (true, false, format!("New version of the setup, signed by {}.", sig.signer.as_deref().unwrap_or("")))
    } else if mismatch {
        (false, false, format!("The setup changed since the first download (SHA-256 {sha256}, recorded {}). Not run.", recorded.unwrap_or("")))
    } else if publisher {
        (true, false, format!("{} by {}.", sig.detail, sig.signer.as_deref().unwrap_or("")))
    } else if sig.trusted {
        (true, true, format!("Signed by {}, not Nadeo or Ubisoft. Run it anyway?", sig.signer.as_deref().unwrap_or("an unknown publisher")))
    } else {
        (
            true,
            true,
            format!(
                "{} ({}). Downloaded over {}. Run it anyway?",
                sig.detail,
                if recorded.is_some() { "same file as last time" } else { "first download, hash recorded" },
                if https { "HTTPS" } else { "plain HTTP" }
            ),
        )
    };
    Verdict { sha256: sha256.into(), signature: sig.detail.clone(), signed: sig.trusted, first_time: recorded.is_none(), ok, needs_confirm, message, update_record }
}

pub fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

pub trait Fetch {
    fn fetch(&self, url: &str, dest: &Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<u64, String>;
}

pub struct HttpFetch;

impl Fetch for HttpFetch {
    fn fetch(&self, url: &str, dest: &Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<u64, String> {
        crate::net::download_to(url, dest, crate::net::MAX_DOWNLOAD, |a, b| progress(a, b))
    }
}

/// Downloads the setup into `dir` and checks it.
pub fn download_and_verify(
    url: &str,
    file: &str,
    dir: &Path,
    fetch: &dyn Fetch,
    sig: &dyn Fn(&Path) -> SignatureInfo,
    recorded: Option<&str>,
    known: Option<&str>,
    progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(PathBuf, Verdict), String> {
    let dest = dir.join(file);
    fetch.fetch(url, &dest, progress)?;
    let sha = sha256_file(&dest)?;
    let v = decide(url, &sha, &sig(&dest), recorded, known);
    if !v.ok {
        let _ = std::fs::remove_file(&dest);
    }
    Ok((dest, v))
}

/// The setup with its own UI, waited for.
pub fn setup_command(setup: &Path) -> CommandSpec {
    CommandSpec { program: setup.to_path_buf(), args: Vec::<Arg>::new(), cwd: setup.parent().map(Path::to_path_buf), env: vec![] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Dummy(&'static [u8]);
    impl Fetch for Dummy {
        fn fetch(&self, _url: &str, dest: &Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<u64, String> {
            std::fs::write(dest, self.0).map_err(|e| e.to_string())?;
            progress(self.0.len() as u64, Some(self.0.len() as u64));
            Ok(self.0.len() as u64)
        }
    }

    fn signed(_: &Path) -> SignatureInfo {
        SignatureInfo { trusted: true, detail: "Signed and trusted".into(), signer: Some("Nadeo".into()) }
    }
    fn other_signer(_: &Path) -> SignatureInfo {
        SignatureInfo { trusted: true, detail: "Signed and trusted".into(), signer: Some("Someone Else Ltd".into()) }
    }
    fn unsigned(_: &Path) -> SignatureInfo {
        SignatureInfo { trusted: false, detail: "Not signed".into(), signer: None }
    }

    #[test]
    fn flow_with_dummy_setup() {
        let t = tempfile::tempdir().unwrap();
        let calls = RefCell::new(Vec::new());
        let mut prog = |a: u64, b: Option<u64>| calls.borrow_mut().push((a, b));
        let (p, v) = download_and_verify("https://x/setup.exe", "setup.exe", t.path(), &Dummy(b"MZ dummy"), &signed, None, None, &mut prog).unwrap();
        assert!(p.is_file() && v.ok && !v.needs_confirm && v.first_time);
        assert_eq!(v.sha256, crate::tmloader::sha256_hex(b"MZ dummy"));
        assert_eq!(calls.borrow().last(), Some(&(8, Some(8))));

        // Unsigned over https: allowed only after the user confirms.
        let (_, v) = download_and_verify("https://x/setup.exe", "setup.exe", t.path(), &Dummy(b"MZ dummy"), &unsigned, None, None, &mut |_, _| {}).unwrap();
        assert!(v.ok && v.needs_confirm);
        // Signed by someone else: also asks.
        let (_, v) = download_and_verify("https://x/setup.exe", "setup.exe", t.path(), &Dummy(b"MZ dummy"), &other_signer, None, None, &mut |_, _| {}).unwrap();
        assert!(v.ok && v.needs_confirm);
        // Plain http without a known hash: refused.
        let (p, v) = download_and_verify("http://x/setup.exe", "setup.exe", t.path(), &Dummy(b"MZ dummy"), &signed, None, None, &mut |_, _| {}).unwrap();
        assert!(!v.ok && !p.exists());
        // Plain http with the known hash: fine; other bytes: refused.
        let known = crate::tmloader::sha256_hex(b"MZ dummy");
        let (_, v) = download_and_verify("http://x/setup.exe", "setup.exe", t.path(), &Dummy(b"MZ dummy"), &unsigned, None, Some(&known), &mut |_, _| {}).unwrap();
        assert!(v.ok && !v.needs_confirm);
        let (p, v) = download_and_verify("http://x/setup.exe", "setup.exe", t.path(), &Dummy(b"MZ evil"), &unsigned, None, Some(&known), &mut |_, _| {}).unwrap();
        assert!(!v.ok && !p.exists());

        // Same URL, other bytes than recorded: refused and deleted unless Nadeo/Ubisoft signed it.
        let rec = crate::tmloader::sha256_hex(b"MZ dummy");
        let (p, v) = download_and_verify("https://x/setup.exe", "setup.exe", t.path(), &Dummy(b"MZ evil"), &other_signer, Some(&rec), None, &mut |_, _| {}).unwrap();
        assert!(!v.ok && !p.exists());
        let (_, v) = download_and_verify("https://x/setup.exe", "setup.exe", t.path(), &Dummy(b"MZ new"), &signed, Some(&rec), None, &mut |_, _| {}).unwrap();
        assert!(v.ok && v.update_record && !v.needs_confirm);

        // The command runs the setup itself, no switches.
        let c = setup_command(&t.path().join("setup.exe"));
        assert!(c.args.is_empty());
        assert_eq!(c.cwd.as_deref(), Some(t.path()));
    }

    #[test]
    fn sources_are_official_or_store_only() {
        for g in ["tmnf", "tmuf", "tm2-canyon"] {
            match source(g) {
                Source::Download { url, .. } => assert!(url.contains("nadeo-download.cdn.ubi.com") || url.contains("files.trackmaniaforever.com")),
                other => panic!("{other:?}"),
            }
        }
        // Never a link to patched exes (copy-protection workarounds): ESWC is "not sold anymore" like Sunrise.
        assert!(matches!(source("tmn-eswc"), Source::None { .. }));
        assert!(matches!(source("tm-sunrise"), Source::None { .. }));
        assert!(matches!(source("tm2020"), Source::Stores { .. }));
    }

    /// HEAD only (no body): the official URLs answer. Run with TMHUB_NET_TESTS=1.
    #[test]
    fn official_urls_answer_head() {
        if std::env::var("TMHUB_NET_TESTS").is_err() {
            return;
        }
        for g in ["tmnf", "tmuf", "tm2-stadium"] {
            if let Source::Download { url, size, .. } = source(g) {
                let (status, len) = crate::net::head(url).unwrap();
                assert_eq!(status, 200, "{url}");
                assert_eq!(len, Some(size), "{url}");
            }
        }
    }
}
