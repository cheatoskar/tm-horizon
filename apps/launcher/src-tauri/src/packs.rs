//! Shareable packs: a profile (game, mods with exact versions and the TMLoader server they come
//! from, optionally a TM Vibrant Shaders preset share code) as a short `tmhub://pack/<data>` link
//! or a `.tmhubpack` JSON file.
//!
//! Link data = base64url (no padding) of the raw-deflated compact JSON. Importing never trusts
//! the pack: every mod is looked up in the TMLoader indexes the user already has (servers from
//! TMLoader's config), installed with the same SHA-256 check as a normal install, and a server
//! named in the pack that is not one of those is refused. Forever packs become TMLoader
//! profiles; packs for other games are kept in TM Horizon's own data folder.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const LINK_PREFIX: &str = "tmhub://pack/";
pub const MAX_LINK: usize = 8 << 10;
pub const MAX_JSON: u64 = 64 << 10;
pub const MAX_MODS: usize = 64;
pub const GAMES: [&str; 12] = [
    "tmnf", "tmuf", "tmn-eswc", "tm2-stadium", "tm2-canyon", "tm2-valley", "tm2-lagoon", "sm-storm", "tm2020", "tm-turbo", "tm-sunrise", "tm-original",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackMod {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// TMLoader server the version was taken from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    /// Always "pack" (tells a .tmhubpack from other JSON).
    pub tmhub: String,
    pub v: u32,
    pub name: String,
    pub game: String,
    /// Forever: TMLoader's game program version (TmForever), when the profile pins one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(default)]
    pub mods: Vec<PackMod>,
    /// TM Vibrant Shaders preset share code (copied from its F8 menu).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmvs: Option<String>,
}

fn clean_text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(|c| c.is_control())
}

fn safe_id(s: &str) -> bool {
    clean_text(s, 80) && !s.contains(['/', '\\', ':']) && !s.contains("..") && s != "."
}

pub fn validate(p: &Pack) -> Result<(), String> {
    if p.tmhub != "pack" || p.v != 1 {
        return Err("Not a TM Horizon pack (or a newer format)".into());
    }
    if !safe_id(&p.name) || p.name.len() > 60 {
        return Err("The pack name is not usable as a profile name".into());
    }
    if !GAMES.contains(&p.game.as_str()) {
        return Err(format!("Unknown game {}", p.game));
    }
    if p.mods.len() > MAX_MODS {
        return Err("Too many mods".into());
    }
    for m in &p.mods {
        if !safe_id(&m.id) || m.version.as_deref().is_some_and(|v| !safe_id(v)) {
            return Err(format!("Invalid mod entry {}", m.id));
        }
        if let Some(s) = &m.server {
            if !s.starts_with("https://") || !clean_text(s, 300) {
                return Err(format!("Server of {} must be an https:// URL", m.id));
            }
        }
    }
    if p.program.as_deref().is_some_and(|v| !safe_id(v)) || p.args.as_deref().is_some_and(|a| !clean_text(a, 300)) {
        return Err("Invalid program version or arguments".into());
    }
    if p.tmvs.as_deref().is_some_and(|c| !clean_text(c, 4000)) {
        return Err("Invalid TM Vibrant Shaders share code".into());
    }
    Ok(())
}

pub fn encode_link(p: &Pack) -> Result<String, String> {
    validate(p)?;
    let json = serde_json::to_vec(p).map_err(|e| e.to_string())?;
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(&json).map_err(|e| e.to_string())?;
    let data = enc.finish().map_err(|e| e.to_string())?;
    let link = format!("{LINK_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data));
    if link.len() > MAX_LINK {
        return Err("The pack is too big for a link; share the .tmhubpack file".into());
    }
    Ok(link)
}

/// Reads a `tmhub://pack/...` link or the text of a `.tmhubpack` file.
pub fn decode(input: &str) -> Result<Pack, String> {
    let t = input.trim();
    let pack: Pack = if t.starts_with('{') {
        if t.len() as u64 > MAX_JSON {
            return Err("The pack file is too big".into());
        }
        serde_json::from_str(t).map_err(|e| format!("Not a TM Horizon pack: {e}"))?
    } else {
        let lower = t.to_ascii_lowercase();
        let rest = if lower.starts_with(LINK_PREFIX) {
            &t[LINK_PREFIX.len()..]
        } else if lower.starts_with("tmhub:pack/") {
            &t["tmhub:pack/".len()..]
        } else {
            return Err("Not a tmhub://pack/ link".into());
        };
        if t.len() > MAX_LINK {
            return Err("The link is too long".into());
        }
        let rest = rest.trim_end_matches('/');
        let data = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(rest.trim_end_matches('=')).map_err(|_| "The link is damaged".to_string())?;
        let mut json = Vec::new();
        flate2::read::DeflateDecoder::new(&data[..]).take(MAX_JSON + 1).read_to_end(&mut json).map_err(|_| "The link is damaged".to_string())?;
        if json.len() as u64 > MAX_JSON {
            return Err("The pack is too big".into());
        }
        serde_json::from_slice(&json).map_err(|e| format!("Not a TM Horizon pack: {e}"))?
    };
    validate(&pack)?;
    Ok(pack)
}

pub fn is_forever(game: &str) -> bool {
    game == "tmnf" || game == "tmuf"
}

/// What importing one mod would do.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModCheck {
    pub id: String,
    pub version: Option<String>,
    pub server: Option<String>,
    /// "installed" | "download" | "missing" (not in any index) | "noHash" (index has no SHA-256)
    /// | "unknownServer" (the pack names a server TMLoader is not set up for) | "other" (not Forever).
    pub status: String,
    pub sha256: Option<String>,
}

/// Checks one mod against the local install and the user's indexes.
/// `index_servers` = servers that list this product; `entry` = the index entry of that version.
pub fn check_mod(m: &PackMod, installed: &[String], index_servers: &[String], entry: Option<&serde_json::Value>) -> ModCheck {
    let norm = |s: &str| s.trim_end_matches('/').to_ascii_lowercase();
    let sha = entry.and_then(|e| e.get("hash_sha256")).and_then(|h| h.as_str()).map(String::from);
    let status = if m.server.as_deref().is_some_and(|s| !index_servers.iter().any(|x| norm(x) == norm(s))) && !index_servers.is_empty() {
        "unknownServer"
    } else if m.version.as_ref().is_some_and(|v| installed.contains(v)) || (m.version.is_none() && !installed.is_empty()) {
        "installed"
    } else if index_servers.is_empty() || entry.is_none() {
        "missing"
    } else if sha.is_none() {
        "noHash"
    } else {
        "download"
    };
    ModCheck { id: m.id.clone(), version: m.version.clone(), server: m.server.clone(), status: status.into(), sha256: sha }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pack() -> Pack {
        Pack {
            tmhub: "pack".into(),
            v: 1,
            name: "Cup night".into(),
            game: "tmnf".into(),
            program: None,
            args: None,
            mods: vec![
                PackMod { id: "Competition Patch".into(), version: Some("2.0.1".into()), server: Some("https://donadigo.com/modloader/".into()) },
                PackMod { id: "CoreMod".into(), version: Some("1.0.12".into()), server: Some("https://modloader.tomashu.dev/modloader/TmForever/v1/".into()) },
            ],
            tmvs: Some("TMVS1:abcDEF".into()),
        }
    }

    #[test]
    fn link_roundtrip_and_short() {
        let p = pack();
        let link = encode_link(&p).unwrap();
        assert!(link.starts_with(LINK_PREFIX));
        assert!(link.len() < 400, "{} chars", link.len());
        assert!(!link[LINK_PREFIX.len()..].contains(['+', '/', '=']));
        assert_eq!(decode(&link).unwrap(), p);
        let file = serde_json::to_string_pretty(&p).unwrap();
        assert_eq!(decode(&file).unwrap(), p);
    }

    #[test]
    fn rejects_bad_packs() {
        assert!(decode("tmhub://pack/!!!").is_err());
        assert!(decode("https://example.com").is_err());
        let mut p = pack();
        p.name = "../evil".into();
        assert!(encode_link(&p).is_err());
        let mut p = pack();
        p.mods[0].server = Some("http://plain.example/".into());
        assert!(validate(&p).is_err());
        let mut p = pack();
        p.game = "minecraft".into();
        assert!(validate(&p).is_err());
        let mut p = pack();
        p.mods[0].version = Some("1/../../x".into());
        assert!(validate(&p).is_err());
        assert!(decode(r#"{"tmhub":"pack","v":2,"name":"x","game":"tmnf"}"#).is_err());
    }

    #[test]
    fn mod_checks() {
        let p = pack();
        let servers = vec!["https://donadigo.com/modloader".to_string()];
        let entry = json!({ "hash_sha256": "ab", "download_link": "https://donadigo.com/x.zip" });
        assert_eq!(check_mod(&p.mods[0], &[], &servers, Some(&entry)).status, "download");
        assert_eq!(check_mod(&p.mods[0], &["2.0.1".into()], &servers, Some(&entry)).status, "installed");
        assert_eq!(check_mod(&p.mods[0], &[], &servers, Some(&json!({}))).status, "noHash");
        assert_eq!(check_mod(&p.mods[0], &[], &[], None).status, "missing");
        let evil = PackMod { id: "CoreMod".into(), version: Some("1.0.12".into()), server: Some("https://evil.example/".into()) };
        assert_eq!(check_mod(&evil, &[], &servers, Some(&entry)).status, "unknownServer");
    }
}
