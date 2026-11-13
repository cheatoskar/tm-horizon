//! Login to the TM Horizon Hub from the launcher (Discord or GitHub through the hub's own OAuth).
//! Desktop flow after RFC 8252 + RFC 7636: the system browser opens
//! `<hub>/auth/<provider>/start?desktop=1&port&state&challenge`, the hub redirects back to
//! `http://127.0.0.1:<random port>/callback?code&state`, and the launcher swaps the one-time code plus its
//! PKCE verifier for an API token with the scope "desktop" (`POST /auth/desktop/token`).
//! No custom URL scheme is registered. The token is kept in `<data>/hub-login.json` (the per-user app
//! data folder; on Unix the file is 0600). A keyring (Windows Credential Manager) may replace that later.
//! The token is never logged and only ever sent to the hub it was issued by, on paths under /v1/ and /auth/desktop/.

use crate::hubindex::hub_url_ok;
use crate::state::AppState;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

const FILE: &str = "hub-login.json";
const WAIT: Duration = Duration::from_secs(5 * 60);
const MAX_ANSWER: u64 = 1 << 20;

static BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

/// What is kept on disk: the hub the token belongs to, the token and the account shown in Settings.
#[derive(Serialize, Deserialize, Clone)]
pub struct Stored {
    pub hub: String,
    pub token: String,
    #[serde(default)]
    pub expires: Option<String>,
    #[serde(default)]
    pub user: Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    /// Hub address in use (the stored login's hub, else the one from Settings); None: no address set.
    pub hub: Option<String>,
    /// Logged-in account (None: not logged in).
    pub user: Option<Value>,
    /// False when the hub did not answer (a stored account is shown anyway).
    pub reachable: bool,
    /// Login providers the hub offers ("discord", "github").
    pub providers: Vec<String>,
    /// The hub's web portal (for the privacy text), from `/v1/config`.
    pub portal: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub user: Value,
    /// The hub reported a claimed project (Discord id match or GitHub claim).
    pub claimed: bool,
}

// ------------------------------------------------------------------ pure helpers (tested)

pub fn random_b64(bytes: usize) -> Result<String, String> {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).map_err(|e| format!("random: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}

/// PKCE S256 challenge of a verifier.
pub fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Constant-time comparison (the state must not leak through timing).
pub fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, PartialEq)]
pub enum Callback {
    Code { code: String, claimed: bool },
    /// The provider or the hub sent an error back (cancelled, claim refused, ...).
    Error(String),
}

/// Reads the request line of one loopback request. None = not ours (other path, wrong state, junk):
/// answer 404 and keep waiting, so a stray request cannot end or hijack the login.
pub fn parse_callback(request_line: &str, expected_state: &str) -> Option<Callback> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let u = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if u.path() != "/callback" {
        return None;
    }
    let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
    if !same(q.get("state")?, expected_state) {
        return None;
    }
    if let Some(code) = q.get("code").filter(|c| !c.is_empty() && c.len() <= 200) {
        return Some(Callback::Code { code: code.clone(), claimed: q.get("claimed").map(|v| v == "1").unwrap_or(false) });
    }
    Some(Callback::Error(q.get("error").cloned().unwrap_or_else(|| "cancelled".into()).chars().take(60).collect()))
}

/// Path check for `hub_request`: only the hub's API, no tricks.
pub fn api_path_ok(path: &str) -> bool {
    path.starts_with("/v1/")
        && path.len() <= 300
        && !path.contains("..")
        && !path.contains("//")
        && !path.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\\' | '#' | '@'))
}

pub fn start_url(hub: &str, provider: &str, port: u16, state: &str, challenge: &str, intent: Option<&str>, ticket: Option<&str>) -> String {
    let mut u = format!("{}/auth/{provider}/start?desktop=1&port={port}&state={state}&challenge={challenge}", hub.trim_end_matches('/'));
    if let Some(i) = intent {
        u.push_str(&format!("&intent={}", url::form_urlencoded::byte_serialize(i.as_bytes()).collect::<String>()));
    }
    if let Some(t) = ticket {
        u.push_str(&format!("&ticket={t}"));
    }
    u
}

fn page(ok: bool) -> String {
    let (mark, text) = if ok { ("&#10003;", "TM Horizon: OK. You can close this tab.") } else { ("&#10007;", "TM Horizon: login not completed. You can close this tab.") };
    format!(
        "<!doctype html><meta charset=utf-8><title>TM Horizon</title><body style=\"font:16px system-ui;background:#0b0e14;color:#e8ecf3;display:grid;place-items:center;height:90vh\"><div style=\"text-align:center\"><div style=\"font-size:56px\">{mark}</div><p>{text}</p></div>"
    )
}

// ------------------------------------------------------------------ storage

fn file(data: &Path) -> PathBuf {
    data.join(FILE)
}

pub fn load(data: &Path) -> Option<Stored> {
    let b = std::fs::read(file(data)).ok()?;
    serde_json::from_slice(&b).ok()
}

fn save(data: &Path, s: &Stored) -> Result<(), String> {
    let p = file(data);
    let b = serde_json::to_vec(s).map_err(|e| e.to_string())?;
    crate::fsx::write(&p, &b)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn forget(data: &Path) {
    let _ = std::fs::remove_file(file(data));
}

// ------------------------------------------------------------------ HTTP to the hub

enum HubErr {
    Unreachable,
    Status(u16, Value),
    Other(String),
}

impl HubErr {
    /// Stable codes for the UI: unreachable | hub:<status>:<error code>.
    fn code(&self) -> String {
        match self {
            HubErr::Unreachable => "unreachable".into(),
            HubErr::Status(s, v) => format!("hub:{s}:{}", v.get("error").and_then(Value::as_str).unwrap_or("error")),
            HubErr::Other(e) => e.clone(),
        }
    }
}

fn call(method: &str, url: &str, token: Option<&str>, body: Option<&Value>) -> Result<Value, HubErr> {
    if crate::RELEASE_PREVIEW {
        return Err(HubErr::Unreachable);
    }
    let tls = native_tls::TlsConnector::new().map_err(|e| HubErr::Other(e.to_string()))?;
    let agent = ureq::AgentBuilder::new()
        .user_agent(crate::net::UA)
        .redirects(0)
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .tls_connector(std::sync::Arc::new(tls))
        .build();
    let mut req = agent.request(method, url).set("accept", "application/json");
    if let Some(t) = token {
        req = req.set("authorization", &format!("Bearer {t}"));
    }
    let r = match body {
        Some(b) => req.send_json(b.clone()),
        None if method == "GET" || method == "DELETE" => req.call(),
        None => req.send_json(serde_json::json!({})),
    };
    let read = |r: ureq::Response| -> Value {
        let mut buf = Vec::new();
        let _ = r.into_reader().take(MAX_ANSWER).read_to_end(&mut buf);
        serde_json::from_slice(&buf).unwrap_or(Value::Null)
    };
    match r {
        Ok(r) => Ok(read(r)),
        Err(ureq::Error::Status(s, r)) => Err(HubErr::Status(s, read(r))),
        Err(ureq::Error::Transport(_)) => Err(HubErr::Unreachable),
    }
}

fn base(hub: &str) -> Result<String, String> {
    let h = hub.trim();
    if !hub_url_ok(h) {
        return Err("bad-hub".into());
    }
    Ok(h.trim_end_matches('/').to_string())
}

// ------------------------------------------------------------------ loopback

/// Waits for the one callback request; answers every request with a small page.
fn wait_callback(listener: &TcpListener, expected_state: &str) -> Result<Callback, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let end = Instant::now() + WAIT;
    while Instant::now() < end {
        if CANCEL.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(cb) = handle(stream, expected_state) {
                    return Ok(cb);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("timeout".into())
}

fn handle(mut s: TcpStream, expected_state: &str) -> Option<Callback> {
    let _ = s.set_nonblocking(false);
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while buf.len() < 8192 && !buf.windows(2).any(|w| w == b"\r\n") {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let line = text.lines().next().unwrap_or("");
    let cb = parse_callback(line, expected_state);
    let (status, body) = match &cb {
        Some(Callback::Code { .. }) => ("200 OK", page(true)),
        Some(Callback::Error(_)) => ("200 OK", page(false)),
        None => ("404 Not Found", String::new()),
    };
    let _ = write!(
        s,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = s.flush();
    cb
}

struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

fn run_login(app: &AppHandle, data: &Path, provider: &str, hub: &str, claim: Option<&str>) -> Result<LoginResult, String> {
    if provider != "discord" && provider != "github" {
        return Err("bad-provider".into());
    }
    let hub = base(hub)?;
    if let Some(c) = claim {
        if provider != "github" || !c.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-') || !(3..=48).contains(&c.len()) {
            return Err("bad-claim".into());
        }
    }
    // A logged-in launcher links the second login (GitHub claim) to its account with a short ticket.
    let old = load(data).filter(|s| s.hub == hub);
    let ticket = match (&old, claim) {
        (Some(s), Some(_)) => call("POST", &format!("{hub}/auth/desktop/ticket"), Some(&s.token), None)
            .map_err(|e| e.code())?
            .get("ticket")
            .and_then(Value::as_str)
            .map(String::from),
        (None, Some(_)) => return Err("not-logged-in".into()),
        _ => None,
    };
    // Is the hub there at all? (Saves opening a browser tab onto an error page.)
    call("GET", &format!("{hub}/v1/config"), None, None).map_err(|e| e.code())?;

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = random_b64(32)?;
    let verifier = random_b64(32)?;
    let intent = claim.map(|c| format!("claim:{c}"));
    let url = start_url(&hub, provider, port, &state, &challenge_of(&verifier), intent.as_deref(), ticket.as_deref());
    app.opener().open_url(&url, None::<&str>).map_err(|e| format!("browser: {e}"))?;

    let (code, claimed) = match wait_callback(&listener, &state)? {
        Callback::Code { code, claimed } => (code, claimed),
        Callback::Error(e) => return Err(format!("denied:{e}")),
    };
    drop(listener);
    let got = call("POST", &format!("{hub}/auth/desktop/token"), None, Some(&serde_json::json!({ "code": code, "verifier": verifier }))).map_err(|e| e.code())?;
    let token = got.get("token").and_then(Value::as_str).filter(|t| t.starts_with("tmh_")).ok_or("hub:bad-answer")?.to_string();
    let user = got.get("user").cloned().unwrap_or(Value::Null);
    save(data, &Stored { hub: hub.clone(), token, expires: got.get("expires").and_then(Value::as_str).map(String::from), user: user.clone() })?;
    // The claim login made a fresh token for the same account: retire the old one.
    if let Some(o) = old {
        let _ = call("POST", &format!("{hub}/auth/desktop/revoke"), Some(&o.token), None);
    }
    Ok(LoginResult { user, claimed })
}

// ------------------------------------------------------------------ commands

/// Opens the browser for the login and waits (up to 5 minutes) for the hub to send the code back.
/// `claim` (GitHub only, logged in already): also claims that project slug.
/// Runs on a blocking thread, so the wait does not hold an async worker.
#[tauri::command]
pub async fn hub_login_start(app: AppHandle, st: State<'_, AppState>, provider: String, hub_url: String, claim: Option<String>) -> Result<LoginResult, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let data = st.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _g = BusyGuard;
        CANCEL.store(false, Ordering::SeqCst);
        run_login(&app, &data, &provider, &hub_url, claim.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn hub_login_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Whether the hub answers, which logins it offers, and the stored account checked against it
/// (`GET /v1/me`). A refused token is forgotten. `hub_url`: the address from Settings (used while logged out).
#[tauri::command]
pub async fn hub_login_status(app: tauri::AppHandle, hub_url: Option<String>) -> LoginStatus {
    crate::bg::run(move || -> LoginStatus {
        let st = tauri::Manager::state::<AppState>(&app);
        let stored = load(&st.data_dir);
        let hub = match &stored {
            Some(s) => Some(s.hub.clone()),
            None => hub_url.as_deref().and_then(|h| base(h).ok()),
        };
        let mut out = LoginStatus { hub: hub.clone(), user: None, reachable: false, providers: vec![], portal: None };
        let Some(hub) = hub else { return out };
        match call("GET", &format!("{hub}/v1/config"), None, None) {
            Ok(cfg) => {
                out.reachable = true;
                out.providers = cfg.get("providers").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
                out.portal = cfg.get("portalUrl").and_then(Value::as_str).filter(|u| u.starts_with("https://") || cfg!(debug_assertions)).map(String::from);
            }
            Err(_) => {
                out.user = stored.map(|s| s.user);
                return out;
            }
        }
        let Some(s) = stored else { return out };
        match call("GET", &format!("{hub}/v1/me"), Some(&s.token), None) {
            Ok(v) => match v.get("user").filter(|u| !u.is_null()) {
                Some(u) => {
                    let _ = save(&st.data_dir, &Stored { user: u.clone(), ..s });
                    out.user = Some(u.clone());
                }
                None => forget(&st.data_dir),
            },
            Err(HubErr::Status(401, _)) => forget(&st.data_dir),
            Err(_) => {
                out.reachable = false;
                out.user = Some(s.user);
            }
        }
        out
    })
    .await
}

/// Revokes the token at the hub (best effort) and forgets it here.
#[tauri::command]
pub async fn hub_logout(app: tauri::AppHandle) {
    crate::bg::run(move || {
        let st = tauri::Manager::state::<AppState>(&app);
        if let Some(s) = load(&st.data_dir) {
            let _ = call("POST", &format!("{}/auth/desktop/revoke", s.hub), Some(&s.token), None);
        }
        forget(&st.data_dir);
    })
    .await
}

/// A call to the hub's API with the stored login. Only `/v1/...` on the hub the token came from.
/// Errors: not-logged-in | bad-path | bad-method | unreachable | login-expired | hub:<status>:<code>.
#[tauri::command]
pub async fn hub_request(app: tauri::AppHandle, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    crate::bg::run(move || -> Result<Value, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let m = method.to_ascii_uppercase();
        if !matches!(m.as_str(), "GET" | "POST" | "PATCH" | "PUT" | "DELETE") {
            return Err("bad-method".into());
        }
        if !api_path_ok(&path) {
            return Err("bad-path".into());
        }
        let s = load(&st.data_dir).ok_or("not-logged-in")?;
        match call(&m, &format!("{}{path}", s.hub), Some(&s.token), body.as_ref()) {
            Ok(v) => Ok(v),
            Err(HubErr::Status(401, _)) => {
                forget(&st.data_dir);
                Err("login-expired".into())
            }
            Err(e) => Err(e.code()),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_s256_is_unpadded_base64url_of_sha256() {
        // Cross-checked with Node: createHash('sha256').update(v).digest('base64url') (what the hub compares).
        assert_eq!(challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk"), "bwWFMyPfdG9qreDhH2lmftFx_dFeLDalzcT1gb_j68g");
    }

    #[test]
    fn random_values_are_long_and_differ() {
        let a = random_b64(32).unwrap();
        let b = random_b64(32).unwrap();
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn callback_needs_path_and_state() {
        let st = "s".repeat(43);
        assert_eq!(
            parse_callback(&format!("GET /callback?code=abc&state={st} HTTP/1.1"), &st),
            Some(Callback::Code { code: "abc".into(), claimed: false })
        );
        assert_eq!(
            parse_callback(&format!("GET /callback?code=abc&claimed=1&state={st} HTTP/1.1"), &st),
            Some(Callback::Code { code: "abc".into(), claimed: true })
        );
        assert_eq!(parse_callback(&format!("GET /callback?error=access_denied&state={st} HTTP/1.1"), &st), Some(Callback::Error("access_denied".into())));
        // wrong state, other paths, other methods, junk: ignored
        assert_eq!(parse_callback("GET /callback?code=abc&state=other HTTP/1.1", &st), None);
        assert_eq!(parse_callback("GET /callback?code=abc HTTP/1.1", &st), None);
        assert_eq!(parse_callback(&format!("GET /favicon.ico?state={st} HTTP/1.1"), &st), None);
        assert_eq!(parse_callback(&format!("POST /callback?code=abc&state={st} HTTP/1.1"), &st), None);
        assert_eq!(parse_callback("", &st), None);
        assert_eq!(parse_callback("\u{0}\u{1}garbage", &st), None);
    }

    #[test]
    fn constant_time_compare() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }

    #[test]
    fn only_api_paths() {
        assert!(api_path_ok("/v1/servers"));
        assert!(api_path_ok("/v1/projects/some-mod/claim"));
        for bad in ["/auth/desktop/token", "v1/servers", "/v1/../admin", "//evil.example/v1/", "/v1/a b", "/v1/x#y", "/v1/x\\y", "/v1/@evil", "/v1/a//b"] {
            assert!(!api_path_ok(bad), "{bad}");
        }
    }

    #[test]
    fn start_url_carries_desktop_parameters() {
        let u = start_url("https://hub.example/", "github", 50123, "STATE", "CHAL", Some("claim:my-mod"), Some("TICK"));
        assert_eq!(u, "https://hub.example/auth/github/start?desktop=1&port=50123&state=STATE&challenge=CHAL&intent=claim%3Amy-mod&ticket=TICK");
    }

    #[test]
    fn loopback_answers_and_returns_the_code() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let st = "x".repeat(43);
        let st2 = st.clone();
        let t = std::thread::spawn(move || {
            // a stray request first: ignored with 404
            let mut a = TcpStream::connect(("127.0.0.1", port)).unwrap();
            a.write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = a.read_to_string(&mut out);
            assert!(out.starts_with("HTTP/1.1 404"));
            let mut b = TcpStream::connect(("127.0.0.1", port)).unwrap();
            b.write_all(format!("GET /callback?code=c0de&state={st2} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).unwrap();
            let mut out = String::new();
            let _ = b.read_to_string(&mut out);
            assert!(out.starts_with("HTTP/1.1 200"));
        });
        CANCEL.store(false, Ordering::SeqCst);
        let cb = wait_callback(&l, &st).unwrap();
        t.join().unwrap();
        assert_eq!(cb, Callback::Code { code: "c0de".into(), claimed: false });
    }

    #[test]
    fn stored_login_round_trip() {
        let d = tempfile::tempdir().unwrap();
        assert!(load(d.path()).is_none());
        save(d.path(), &Stored { hub: "https://hub.example".into(), token: "tmh_x".into(), expires: None, user: serde_json::json!({ "name": "A" }) }).unwrap();
        let s = load(d.path()).unwrap();
        assert_eq!(s.token, "tmh_x");
        forget(d.path());
        assert!(load(d.path()).is_none());
    }
}
