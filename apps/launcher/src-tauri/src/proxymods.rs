//! Read-only detection of proxy-DLL mods next to a game's exe (ESWC and the old games have no mod
//! loader; mods there are DLLs the game loads by name, e.g. d3d9.dll for TM Vibrant Shaders).
//! Nothing is written. dinput8.dll is never opened (house rule): ESWC Autosave is recognised by its
//! own eswc_autosave.dll / .ini next to it.
use serde::Serialize;
use std::path::Path;

use crate::fsx;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyMod {
    /// Catalog/mod id, e.g. "TM Vibrant Shaders".
    pub id: String,
    /// The DLL the game loads (d3d9.dll, dinput8.dll, ...).
    pub file: String,
    pub version: Option<String>,
    /// Extra files that belong to it (ini, logs).
    pub files: Vec<String>,
    /// Backups found next to it (e.g. d3d9.dll.before-1.5.0).
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyScan {
    pub mods: Vec<ProxyMod>,
    /// Proxy DLLs present that we do not recognise (possible conflicts).
    pub unknown: Vec<String>,
}

/// Proxy DLL names a DirectX 9 game loads from its own folder.
pub const PROXY_DLLS: [&str; 4] = ["d3d9.dll", "dxgi.dll", "d3d11.dll", "opengl32.dll"];

/// SHA-256 of eswc_autosave.dll in the GitHub releases of cheatoskar/eswc-autosave -> version (checked 2026-11-12
/// against the release asset eswc-autosave-1.1.0.zip). Legacy Essentials 1.3.x DLLs have no version resource, so their
/// hashes are listed too (1.3.1: release v1.3.1, assets eswc-autosave-1.3.1-ESWC/Sunrise/Original.zip, one zip
/// content for all three, SHA-256 6fc3e109...; dinput8.dll 9e3a9653..., eswc_autosave.ini 6580dc79...).
const AUTOSAVE_RELEASES: [(&str, &str); 3] = [
    ("14121e2337824e8b50bbe115e96f6c0a3cb3e9a4eb0b358aafd6ff563244bf1b", "1.1.0"),
    ("b823d59b13bef8dd9524ee6e2dd0cb87de10d93eb4e98f27b665829a715ebe1b", "1.3.0"),
    ("5e789a132868d739aae89cfa0f71387c2ae4499f696c29382e8f7b145cfdcdc6", "1.3.1"),
];

fn autosave_release_of(dll: &[u8]) -> Option<&'static str> {
    use sha2::{Digest, Sha256};
    let h = hex::encode(Sha256::digest(dll));
    AUTOSAVE_RELEASES.iter().find(|(sha, _)| *sha == h).map(|(_, v)| *v)
}

/// UTF-16LE string value of a version-resource key (FileVersion, ProductName) in a PE file.
pub fn version_value(bytes: &[u8], key: &str) -> Option<String> {
    let needle: Vec<u8> = key.encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect();
    let pos = bytes.windows(needle.len()).rposition(|w| w == needle.as_slice())?;
    let mut i = pos + needle.len();
    // Padding to a 4-byte boundary (zeros), then the value up to a UTF-16 NUL.
    while i + 1 < bytes.len() && bytes[i] == 0 && bytes[i + 1] == 0 {
        i += 2;
    }
    let mut out = Vec::new();
    while i + 1 < bytes.len() {
        let u = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
        if u == 0 || out.len() > 64 {
            break;
        }
        out.push(u);
        i += 2;
    }
    let s = String::from_utf16(&out).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn contains_text(bytes: &[u8], text: &str) -> bool {
    let ascii = text.as_bytes();
    let wide: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    bytes.windows(ascii.len()).any(|w| w.eq_ignore_ascii_case(ascii)) || bytes.windows(wide.len()).any(|w| w == wide.as_slice())
}

/// What a proxy DLL is, from its bytes.
pub fn identify(bytes: &[u8]) -> Option<&'static str> {
    if contains_text(bytes, "Vibrant Shaders") || contains_text(bytes, "TMVibrantShaders") || contains_text(bytes, "tmvs.ini") {
        return Some("TM Vibrant Shaders");
    }
    None
}

pub fn scan_dir(dir: &Path) -> ProxyScan {
    let mut out = ProxyScan::default();
    let names: Vec<String> = fsx::list(dir).into_iter().filter(|e| e.is_file).map(|e| e.name).collect();
    let has = |n: &str| names.iter().any(|x| x.eq_ignore_ascii_case(n));
    let backups_of = |n: &str| -> Vec<String> {
        let pre = format!("{}.", n.to_lowercase());
        names.iter().filter(|x| x.to_lowercase().starts_with(&pre)).cloned().collect()
    };
    for dll in PROXY_DLLS {
        if !has(dll) {
            continue;
        }
        let path = dir.join(dll);
        let bytes = if fsx::blocked(&path) { None } else { std::fs::read(&path).ok() };
        match bytes.as_deref().and_then(identify) {
            Some(id) => out.mods.push(ProxyMod {
                id: id.into(),
                file: dll.into(),
                version: bytes.as_deref().and_then(|b| version_value(b, "ProductVersion").or_else(|| version_value(b, "FileVersion"))),
                files: names.iter().filter(|n| n.to_lowercase().starts_with("tmvs")).cloned().collect(),
                backups: backups_of(dll),
            }),
            None => out.unknown.push(dll.into()),
        }
    }
    // ESWC Autosave: dinput8.dll (not opened) loads eswc_autosave.dll; the ini/log sit next to it.
    if has("eswc_autosave.dll") || has("eswc_autosave.ini") {
        let dll = dir.join("eswc_autosave.dll");
        // The released DLLs carry no version resource: known release files are recognised by their SHA-256,
        // so an unchanged install of the latest release is "current" and offers no endless Update.
        let version = std::fs::read(&dll).ok().and_then(|b| {
            version_value(&b, "ProductVersion").or_else(|| version_value(&b, "FileVersion")).or_else(|| autosave_release_of(&b).map(String::from))
        });
        out.mods.push(ProxyMod {
            id: "ESWC Autosave".into(),
            file: "dinput8.dll".into(),
            version,
            files: names.iter().filter(|n| n.to_lowercase().starts_with("eswc_autosave")).cloned().collect(),
            backups: backups_of("dinput8.dll"),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn reads_version_values_and_names() {
        let mut b = b"MZ....".to_vec();
        b.extend(wide("ProductName\0"));
        b.extend(wide("TM Vibrant Shaders\0"));
        b.extend(wide("ProductVersion\0"));
        b.extend([0, 0]);
        b.extend(wide("1.5.0\0"));
        assert_eq!(version_value(&b, "ProductVersion").as_deref(), Some("1.5.0"));
        assert_eq!(identify(&b), Some("TM Vibrant Shaders"));
        assert_eq!(identify(b"MZ plain d3d9 wrapper"), None);
    }

    #[test]
    fn finds_eswc_mods_without_opening_dinput8() {
        let dir = std::env::temp_dir().join(format!("tmhub-proxy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut d3d9 = b"MZ".to_vec();
        d3d9.extend(wide("TM Vibrant Shaders"));
        std::fs::write(dir.join("d3d9.dll"), &d3d9).unwrap();
        std::fs::write(dir.join("d3d9.dll.before-1.5.0"), b"MZ").unwrap();
        std::fs::write(dir.join("eswc_autosave.dll"), b"MZ").unwrap();
        std::fs::write(dir.join("eswc_autosave.ini"), b"[x]").unwrap();
        std::fs::write(dir.join("dxgi.dll"), b"MZ other").unwrap();
        let s = scan_dir(&dir);
        let ids: Vec<&str> = s.mods.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["TM Vibrant Shaders", "ESWC Autosave"]);
        assert_eq!(s.mods[0].backups, ["d3d9.dll.before-1.5.0"]);
        assert_eq!(s.unknown, ["dxgi.dll"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `cargo test real_eswc -- --ignored --nocapture`: the scan of my real ESWC folder (read-only).
    #[test]
    #[ignore]
    fn real_eswc() {
        let dir = dirs::home_dir().unwrap().join("Games").join("TMN-ESWC-inoffiziell");
        println!("{:#?}", scan_dir(&dir));
    }
}
