//! TM Horizon Hub data source: the hub serves one signed index (`<hub>/v1/index.json`, shapes in
//! packages/shared/src/hub.ts). The launcher accepts it only when the Ed25519 signature matches a
//! pinned hub key, refuses an index older than the last good one (rollback) and checks the authors'
//! own signatures on top. Nothing from the index is trusted before `verify` passed.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::State;

use crate::net;
use crate::state::AppState;

/// Base64 Ed25519 public keys of the production hub. EMPTY until the owner adds the production key
/// (`npm run generate-key -w @tm-hub/server` prints it). With no key every index is refused.
pub const PINNED_KEYS: &[&str] = &[];

// ---- Production hub (Launcher Preview: the signed index is the remote catalog, on by default) ----
// Production hub, key id 30e908dace1ecba8 (made 2026-11-12; private part only on the hub server). A release build
// (TMHUB_RELEASE_PREVIEW=1) does not compile while either value is a PLACEHOLDER.
pub const PRODUCTION_HUB: &str = "https://hub.tm-horizon.com";
pub const PRODUCTION_KEY: &str = "yZMyZ/lPyU+7rKCuDHFSxCqGmOcgqU/YBOt+jBgmgjI=";
const fn is_placeholder(s: &str) -> bool {
    let (b, p) = (s.as_bytes(), b"PLACEHOLDER");
    if b.len() < p.len() {
        return false;
    }
    let mut i = 0;
    while i < p.len() {
        if b[i] != p[i] {
            return false;
        }
        i += 1;
    }
    true
}
const _: () = assert!(
    !(crate::RELEASE_PREVIEW && (is_placeholder(PRODUCTION_HUB) || is_placeholder(PRODUCTION_KEY))),
    "release build: set hubindex::PRODUCTION_HUB and PRODUCTION_KEY (production hub URL and public key)"
);

/// Debug builds only: comma-separated extra base64 public keys, to test against a local dev hub.
pub const DEV_KEYS_ENV: &str = "TMHUB_HUB_DEV_PUBKEYS";

const MAX_INDEX: u64 = 16 << 20;
const INDEX_SIG_PREFIX: &[u8] = b"tmhub-index-v1\n";
const CACHE_FILE: &str = "hub-index.json";

pub fn pinned_keys() -> Vec<String> {
    let mut v: Vec<String> = PINNED_KEYS.iter().map(|s| s.to_string()).collect();
    if !is_placeholder(PRODUCTION_KEY) && !v.iter().any(|k| k == PRODUCTION_KEY) {
        v.push(PRODUCTION_KEY.to_string());
    }
    if cfg!(debug_assertions) {
        if let Ok(e) = std::env::var(DEV_KEYS_ENV) {
            v.extend(e.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
        }
    }
    v
}

#[derive(Deserialize)]
struct Envelope {
    format: String,
    v: u32,
    alg: String,
    payload: String,
    sig: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Head {
    format: String,
    schema_version: u32,
    seq: u64,
    expires: String,
    #[serde(default)]
    projects: Vec<Value>,
}

/// A verified index. `payload` is the hub's JSON with `authorVerified` added to every version.
#[derive(Debug, Clone)]
pub struct Verified {
    pub payload: Value,
    pub key_id: String,
    pub seq: u64,
    pub expires: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubIndexResult {
    pub payload: Value,
    pub key_id: String,
    pub seq: u64,
    pub stale: bool,
    pub fetched_at: String,
    /// "cache" | "network"
    pub source: String,
    pub warnings: Vec<String>,
}

fn key_id_of(raw: &[u8]) -> String {
    hex::encode(&Sha256::digest(raw)[..8])
}

fn decode_key(b64: &str) -> Option<VerifyingKey> {
    let raw: [u8; 32] = STANDARD.decode(b64.trim()).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&raw).ok()
}

/// Checks the envelope and signature against the pinned keys and parses the payload.
pub fn verify(doc: &[u8], pinned: &[String]) -> Result<Verified, String> {
    if doc.len() as u64 > MAX_INDEX {
        return Err("The hub index is too large".into());
    }
    let env: Envelope = serde_json::from_slice(doc).map_err(|e| format!("Not a hub index: {e}"))?;
    if env.format != "tmhub-signed-index" || env.v != 1 || env.alg != "ed25519" {
        return Err("Unsupported hub index format".into());
    }
    let payload_bytes = STANDARD.decode(env.payload.trim()).map_err(|_| "The hub index payload is not base64")?;
    let sig_bytes = STANDARD.decode(env.sig.trim()).map_err(|_| "The hub index signature is not base64")?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "Bad hub index signature")?;
    let mut msg = INDEX_SIG_PREFIX.to_vec();
    msg.extend_from_slice(&payload_bytes);
    let mut key_id = None;
    for k in pinned {
        if let Some(vk) = decode_key(k) {
            if vk.verify_strict(&msg, &sig).is_ok() {
                key_id = Some(key_id_of(vk.as_bytes()));
                break;
            }
        }
    }
    let key_id = key_id.ok_or("The hub index is not signed by a trusted key")?;
    let mut payload: Value = serde_json::from_slice(&payload_bytes).map_err(|e| format!("Bad hub index payload: {e}"))?;
    let head: Head = serde_json::from_value(payload.clone()).map_err(|e| format!("Bad hub index payload: {e}"))?;
    if head.format != "tmhub-index" || head.schema_version != 1 {
        return Err("Unsupported hub index version".into());
    }
    let _ = head.projects.len();
    verify_authors(&mut payload);
    Ok(Verified { payload, key_id, seq: head.seq, expires: head.expires })
}

/// Sets `authorVerified` on every version: true only when its authorSignature checks out against
/// one of the project's author keys (the hub's own `verified` flag is not used).
fn verify_authors(payload: &mut Value) {
    let Some(projects) = payload.get_mut("projects").and_then(Value::as_array_mut) else { return };
    for p in projects {
        let slug = p["slug"].as_str().unwrap_or("").to_string();
        let keys: Vec<(String, VerifyingKey)> = p["authorKeys"]
            .as_array()
            .map(|a| a.iter().filter_map(|k| Some((k["keyId"].as_str()?.to_string(), decode_key(k["publicKey"].as_str()?)?))).collect())
            .unwrap_or_default();
        let Some(versions) = p.get_mut("versions").and_then(Value::as_array_mut) else { continue };
        for v in versions {
            let ok = author_ok(&slug, v, &keys);
            if let Some(o) = v.as_object_mut() {
                o.insert("authorVerified".into(), Value::Bool(ok));
            }
        }
    }
}

fn author_ok(slug: &str, v: &Value, keys: &[(String, VerifyingKey)]) -> bool {
    let (Some(kid), Some(sig_b64)) = (v["authorSignature"]["keyId"].as_str(), v["authorSignature"]["sig"].as_str()) else { return false };
    let (Some(version), Some(sha)) = (v["version"].as_str(), v["files"][0]["sha256"].as_str()) else { return false };
    let Some((_, vk)) = keys.iter().find(|(id, vk)| id == kid && key_id_of(vk.as_bytes()) == kid) else { return false };
    let Some(sig) = STANDARD.decode(sig_b64).ok().and_then(|b| Signature::from_slice(&b).ok()) else { return false };
    let msg = format!("tmhub-author-v1\n{slug}\n{version}\n{}", sha.to_lowercase());
    vk.verify_strict(msg.as_bytes(), &sig).is_ok()
}

// ---------------------------------------------------------------- time

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Seconds since 1970 of "YYYY-MM-DDTHH:MM:SS[.fff]Z" (UTC); None when it does not parse.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    Some(days_from_civil(n(0, 4)?, n(5, 7)?, n(8, 10)?) * 86400 + n(11, 13)? * 3600 + n(14, 16)? * 60 + n(17, 19)?)
}

pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn iso_of(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil_from_days
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---------------------------------------------------------------- cache + rollback

fn cache_path(data: &Path) -> PathBuf {
    data.join(CACHE_FILE)
}

fn build(v: Verified, source: &str, now: i64, fetched_at: String) -> HubIndexResult {
    let mut warnings = Vec::new();
    let stale = parse_iso(&v.expires).map(|e| e < now).unwrap_or(true);
    if stale {
        warnings.push("The hub index has expired; it may be out of date.".to_string());
    }
    HubIndexResult { payload: v.payload, key_id: v.key_id, seq: v.seq, stale, fetched_at, source: source.into(), warnings }
}

/// Last good index from disk, verified again (a key change or a tampered file drops it).
pub fn cached(data: &Path, pinned: &[String], now: i64) -> Option<Result<HubIndexResult, String>> {
    let p = cache_path(data);
    let bytes = std::fs::read(&p).ok()?;
    let fetched = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| iso_of(d.as_secs() as i64)).unwrap_or_default();
    Some(verify(&bytes, pinned).map(|v| build(v, "cache", now, fetched)))
}

/// Verifies a freshly downloaded index, refuses it when older than the cached one, saves it.
pub fn accept(data: &Path, doc: &[u8], pinned: &[String], now: i64) -> Result<HubIndexResult, String> {
    let v = verify(doc, pinned)?;
    if let Some(Ok(old)) = cached(data, pinned, now) {
        if v.seq < old.seq {
            return Err(format!("The hub index is older than the one already seen (seq {} < {}); refused", v.seq, old.seq));
        }
    }
    std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let tmp = cache_path(data).with_extension("json.tmp");
    std::fs::write(&tmp, doc).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, cache_path(data)).map_err(|e| e.to_string())?;
    Ok(build(v, "network", now, iso_of(now)))
}

/// https, or (debug builds only) plain http on localhost / 127.0.0.1.
pub fn hub_url_ok(url: &str) -> bool {
    // Launcher Preview: only the production hub, and only for its signed index (hub_index_refresh).
    if crate::RELEASE_PREVIEW {
        return !is_placeholder(PRODUCTION_HUB) && url.trim().trim_end_matches('/') == PRODUCTION_HUB.trim_end_matches('/');
    }
    let Ok(u) = url::Url::parse(url) else { return false };
    match u.scheme() {
        "https" => u.host_str().is_some(),
        "http" => cfg!(debug_assertions) && matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")),
        _ => false,
    }
}

pub fn index_url(base: &str) -> Result<String, String> {
    let base = base.trim();
    if !hub_url_ok(base) {
        return Err("The hub address must start with https://".into());
    }
    Ok(format!("{}/v1/index.json", base.trim_end_matches('/')))
}

/// `<hub>/tmf/servers?game=tmnf|tmuf` (live TMNF/TMUF list the hub polls from the master server).
pub fn tmf_servers_url(base: &str, game: &str) -> Result<String, String> {
    if game != "tmnf" && game != "tmuf" {
        return Err("game must be tmnf or tmuf".into());
    }
    if crate::RELEASE_PREVIEW {
        return Err("No hub server list in this version".into());
    }
    let base = base.trim();
    if !hub_url_ok(base) {
        return Err("The hub address must start with https://".into());
    }
    Ok(format!("{}/tmf/servers?game={game}", base.trim_end_matches('/')))
}

/// The hub's live server list as JSON. Errors (hub off, unreachable, 503 `tmf-disabled`) make the
/// caller fall back to the bundled list. The list is display data only; joining still goes through
/// the `tmtp://#join=` check in launch.rs.
#[tauri::command]
pub async fn hub_tmf_servers(url: String, game: String) -> Result<Value, String> {
    crate::bg::run(move || -> Result<Value, String> {
        let b = net::get_bytes(&tmf_servers_url(&url, &game)?, 4 << 20)?;
        serde_json::from_slice(&b).map_err(|e| format!("tmf/servers: {e}"))
    })
    .await
}

/// `<hub>/v1/servers?game=...`: the hub's live list (the hub asks every listed server directly on its game port).
pub fn live_servers_url(base: &str, game: &str) -> Result<String, String> {
    if !matches!(game, "tmnf" | "tmuf" | "eswc") {
        return Err("game must be tmnf, tmuf or eswc".into());
    }
    let base = base.trim();
    if !hub_url_ok(base) {
        return Err("The hub address must start with https://".into());
    }
    Ok(format!("{}/v1/servers?game={game}", base.trim_end_matches('/')))
}

/// The hub's live server list (read only: nothing is registered from here). In the Launcher Preview the address
/// is pinned to the production hub like the signed index. Errors make the caller keep the bundled list; the
/// list is display data only, joining still goes through the `tmtp://#join=` check in launch.rs.
#[tauri::command]
pub async fn hub_live_servers(url: String, game: String) -> Result<Value, String> {
    crate::bg::run(move || -> Result<Value, String> {
        let base = if crate::RELEASE_PREVIEW { PRODUCTION_HUB.to_string() } else { url };
        let b = net::get_bytes(&live_servers_url(&base, &game)?, 4 << 20)?;
        serde_json::from_slice(&b).map_err(|e| format!("v1/servers: {e}"))
    })
    .await
}

#[tauri::command(async)]
pub fn hub_index_cached(st: State<AppState>) -> Result<Option<HubIndexResult>, String> {
    cached(&st.data_dir, &pinned_keys(), now_secs()).transpose()
}

#[tauri::command]
pub async fn hub_index_refresh(app: tauri::AppHandle, url: String) -> Result<HubIndexResult, String> {
    crate::bg::run(move || -> Result<HubIndexResult, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let pinned = pinned_keys();
        if pinned.is_empty() {
            return Err("No hub key is built into this launcher".into());
        }
        // Launcher Preview: always the pinned production hub, whatever the UI passes.
        let url = if crate::RELEASE_PREVIEW { PRODUCTION_HUB.to_string() } else { url };
        let doc = net::get_bytes(&index_url(&url)?, MAX_INDEX)?;
        accept(&st.data_dir, &doc, &pinned, now_secs())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = include_str!("../tests/fixtures/hub/valid.json");
    const OLDER: &str = include_str!("../tests/fixtures/hub/older.json");
    const TAMPERED: &str = include_str!("../tests/fixtures/hub/tampered.json");
    const WRONG: &str = include_str!("../tests/fixtures/hub/wrong-key.json");
    const HUB_KEY: &str = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
    const NOW: i64 = 1_794_000_000; // 2026-11-06

    fn pin() -> Vec<String> {
        vec![HUB_KEY.to_string()]
    }

    #[test]
    fn tmf_servers_url_checks_game_and_base() {
        assert_eq!(tmf_servers_url(" https://hub.example/ ", "tmnf").unwrap(), "https://hub.example/tmf/servers?game=tmnf");
        assert_eq!(tmf_servers_url("https://hub.example", "tmuf").unwrap(), "https://hub.example/tmf/servers?game=tmuf");
        assert!(tmf_servers_url("https://hub.example", "tm2").is_err());
        assert!(tmf_servers_url("ftp://hub.example", "tmnf").is_err());
        assert!(tmf_servers_url("", "tmnf").is_err());
    }

    #[test]
    fn valid_verifies() {
        let v = verify(VALID.as_bytes(), &pin()).unwrap();
        assert_eq!(v.seq, 7);
        assert_eq!(v.key_id, "21fe31dfa154a261");
    }

    #[test]
    fn tampered_and_wrong_key_fail() {
        assert!(verify(TAMPERED.as_bytes(), &pin()).is_err());
        assert!(verify(WRONG.as_bytes(), &pin()).is_err());
    }

    #[test]
    fn empty_pin_list_fails() {
        assert!(verify(VALID.as_bytes(), &[]).is_err());
    }

    #[test]
    fn wrong_alg_or_format_rejected() {
        let mut j: Value = serde_json::from_str(VALID).unwrap();
        j["alg"] = "rsa".into();
        assert!(verify(j.to_string().as_bytes(), &pin()).is_err());
        let mut j: Value = serde_json::from_str(VALID).unwrap();
        j["format"] = "other".into();
        assert!(verify(j.to_string().as_bytes(), &pin()).is_err());
    }

    #[test]
    fn rollback_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let r = accept(dir.path(), VALID.as_bytes(), &pin(), NOW).unwrap();
        assert_eq!(r.seq, 7);
        assert_eq!(r.source, "network");
        assert!(accept(dir.path(), OLDER.as_bytes(), &pin(), NOW).is_err());
        // same seq again is fine, cache still answers
        assert!(accept(dir.path(), VALID.as_bytes(), &pin(), NOW).is_ok());
        assert_eq!(cached(dir.path(), &pin(), NOW).unwrap().unwrap().seq, 7);
        // a changed pin list drops the cache
        assert!(cached(dir.path(), &[], NOW).unwrap().is_err());
    }

    #[test]
    fn older_alone_is_accepted_without_cache() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(accept(dir.path(), OLDER.as_bytes(), &pin(), NOW).unwrap().seq, 6);
    }

    #[test]
    fn stale_after_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let v = verify(VALID.as_bytes(), &pin()).unwrap();
        let exp = parse_iso(&v.expires).unwrap();
        assert!(!build(v.clone(), "cache", exp - 10, String::new()).stale);
        assert!(build(v, "cache", exp + 10, String::new()).stale);
        let _ = dir;
    }

    #[test]
    fn author_signature_checked() {
        let v = verify(VALID.as_bytes(), &pin()).unwrap();
        let ver = &v.payload["projects"][0]["versions"][0];
        assert_eq!(ver["authorVerified"], Value::Bool(true));

        // flip one character of the sha256: the author signature no longer matches
        let bytes = STANDARD.decode(serde_json::from_str::<Value>(VALID).unwrap()["payload"].as_str().unwrap()).unwrap();
        let mut p: Value = serde_json::from_slice(&bytes).unwrap();
        let sha = p["projects"][0]["versions"][0]["files"][0]["sha256"].as_str().unwrap().to_string();
        let flipped = format!("{}{}", if sha.starts_with('0') { "1" } else { "0" }, &sha[1..]);
        p["projects"][0]["versions"][0]["files"][0]["sha256"] = flipped.into();
        verify_authors(&mut p);
        assert_eq!(p["projects"][0]["versions"][0]["authorVerified"], Value::Bool(false));
    }

    #[test]
    fn urls() {
        if crate::RELEASE_PREVIEW {
            assert!(!hub_url_ok("https://hub.example.org/"));
            return;
        }
        assert!(hub_url_ok("https://hub.example.org/"));
        assert!(!hub_url_ok("http://hub.example.org/"));
        assert!(!hub_url_ok("http://localhost.evil.com/"));
        assert_eq!(index_url("https://h.example/").unwrap(), "https://h.example/v1/index.json");
        assert_eq!(hub_url_ok("http://localhost:8080/"), cfg!(debug_assertions));
    }

    #[test]
    fn live_servers_url_rules() {
        assert_eq!(live_servers_url(PRODUCTION_HUB, "tmuf").unwrap(), "https://hub.tm-horizon.com/v1/servers?game=tmuf");
        assert_eq!(live_servers_url("https://hub.tm-horizon.com/", "eswc").unwrap(), "https://hub.tm-horizon.com/v1/servers?game=eswc");
        assert!(live_servers_url(PRODUCTION_HUB, "tm2020").is_err());
        assert!(live_servers_url(PRODUCTION_HUB, "tmnf&x=1").is_err());
        assert!(live_servers_url("http://hub.example.org", "tmnf").is_err());
    }

    #[test]
    fn production_key_id() {
        assert_eq!(key_id_of(&STANDARD.decode(PRODUCTION_KEY).unwrap()), "30e908dace1ecba8");
        assert!(pinned_keys().iter().any(|k| k == PRODUCTION_KEY));
    }

    #[test]
    fn iso_roundtrip() {
        let t = parse_iso("2026-11-10T12:00:00.000Z").unwrap();
        assert_eq!(iso_of(t), "2026-11-10T12:00:00Z");
    }
}
