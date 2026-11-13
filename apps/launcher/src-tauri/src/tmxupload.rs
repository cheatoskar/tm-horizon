//! TMX replay auto-upload (off by default, per game).
//!
//! TMX has no upload API with tokens: `POST /api/replays/upload` takes the site's own session
//! cookie plus an antiforgery token from `<exchange>/replayupload`. So the upload runs where the
//! player is already signed in: a hidden webview on the embedded browser's WebView2 profile
//! (`EmbeddedWeb`, see web.rs), on the exchange's own origin. Rust hands it the replay bytes and
//! gets back only status codes and the track id; cookies and tokens never leave WebView2.
//!
//! Sources:
//! - the 100% TMX game mod's bridge on 127.0.0.1:27311-27315 (pairing with Allow in the game,
//!   `/v1/next`, `/v1/file`, `/v1/result`), the same protocol as the browser extension;
//! - new replay files of ESWC / Sunrise / Original: the game's replay folder (written by the
//!   Horizon Host's ESWC Autosave plugin or the old ESWC Autosave) and the host's REPLAY_SAVED log
//!   lines (`<game>\horizon\logs\*.log`);
//! - "Upload replay..." by hand.
//!
//! While auto-upload is on, a tiny local endpoint (`GET /v1/uploader` on 127.0.0.1:27321-27325)
//! tells the browser extension that TM Horizon takes the mod's replays, so it stops pulling them
//! and nothing is uploaded twice. Design notes: docs/design/tmx-autoupload.md.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The 100% TMX mod's ports, probed in this order (same list as its bridge.cpp and bridge.js).
pub const MOD_PORTS: [u16; 5] = [27311, 27312, 27313, 27314, 27315];
/// TM Horizon's handover endpoint for the browser extension.
pub const HANDOVER_PORTS: [u16; 5] = [27321, 27322, 27323, 27324, 27325];
/// Games with auto-upload.
pub const GAMES: [&str; 5] = ["tmnf", "tmuf", "tmn-eswc", "tm-original", "tm-sunrise"];
/// At least this long between two uploads.
pub const GAP_MS: u64 = 2_000;
/// Retry delays after a transient failure (network, 5xx, 429); after the last one the job fails.
pub const BACKOFF_S: [u64; 5] = [10, 30, 120, 300, 900];
/// Not signed in: checked again this often (one page load on the exchange).
pub const SIGNIN_RETRY_S: u64 = 90;
/// Largest replay handed to the uploader.
pub const MAX_REPLAY: usize = 8 << 20;
const HISTORY_MAX: usize = 100;
const DONE_MAX: usize = 4000;
const MOD_WAIT_S: u64 = 25;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ------------------------------------------------------------------ sites

/// Exchange host of a game.
pub fn site_of_game(game: &str) -> Option<&'static str> {
    GAMES.contains(&game).then(|| crate::maps::tmx_site(game)).flatten()
}

/// The mod's site code (or a host) -> exchange host.
pub fn site_host(code: &str) -> Option<&'static str> {
    Some(match code.to_ascii_lowercase().as_str() {
        "tmnf" | "tmnf.exchange" => "tmnf.exchange",
        "tmuf" | "tmuf.exchange" => "tmuf.exchange",
        "tmo" | "original.tm-exchange.com" => "original.tm-exchange.com",
        "tms" | "sunrise.tm-exchange.com" => "sunrise.tm-exchange.com",
        "tmn" | "nations.tm-exchange.com" => "nations.tm-exchange.com",
        _ => return None,
    })
}

pub fn game_of_site(host: &str) -> Option<&'static str> {
    GAMES.iter().copied().find(|g| site_of_game(g) == Some(host))
}

/// Games whose replays come from the 100% TMX mod (the others: replay folder / Horizon Host).
pub fn mod_game(game: &str) -> bool {
    game == "tmnf" || game == "tmuf"
}

// ------------------------------------------------------------------ config + history

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GameCfg {
    pub enabled: bool,
    /// Unix ms when it was switched on: only files written after this count.
    pub since: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub at: u64,
    pub game: String,
    pub site: String,
    pub map: String,
    pub time_ms: Option<i64>,
    pub source: String,
    /// "ok" | "refused" | "failed" | "skipped"
    pub result: String,
    pub detail: String,
    pub link: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// The first-enable question was answered.
    pub confirmed: bool,
    pub games: BTreeMap<String, GameCfg>,
    /// Pairing key the 100% TMX mod handed over after Allow (a loopback secret, like the
    /// extension keeps it).
    pub mod_key: String,
    pub history: Vec<HistoryEntry>,
    /// SHA-256 (and "run:<uid>:<ms>") of replays already handled (uploaded, refused or skipped):
    /// never twice.
    pub done: Vec<String>,
    /// Driver logins of the player's own replays, learned from the game's autosaves (Forever
    /// replay folder, see tmxfolder.rs).
    pub logins: Vec<String>,
}

impl Config {
    pub fn enabled(&self, game: &str) -> bool {
        self.games.get(game).is_some_and(|g| g.enabled)
    }
    pub fn any_enabled(&self) -> bool {
        self.games.values().any(|g| g.enabled)
    }
    pub fn add_history(&mut self, h: HistoryEntry) {
        self.history.insert(0, h);
        self.history.truncate(HISTORY_MAX);
    }
    /// Marks a job's replay handled: by file hash and by run (map + time).
    pub fn mark_job_done(&mut self, j: &Job) {
        self.mark_done(&j.sha);
        if let Some(k) = run_key(&j.bytes) {
            self.mark_done(&k);
        }
    }
    pub fn mark_done(&mut self, sha: &str) {
        if !sha.is_empty() && !self.done.iter().any(|d| d == sha) {
            self.done.push(sha.into());
            if self.done.len() > DONE_MAX {
                let cut = self.done.len() - DONE_MAX;
                self.done.drain(..cut);
            }
        }
    }
}

pub fn load_config(path: &Path) -> Config {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_config(path: &Path, c: &Config) -> Result<(), String> {
    let s = serde_json::to_vec_pretty(c).map_err(|e| e.to_string())?;
    crate::fsx::write(path, &s)
}

pub fn sha256(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

// ------------------------------------------------------------------ replay header

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReplayMeta {
    pub uid: Option<String>,
    pub best_ms: Option<i64>,
    /// Header `validable` (TMX refuses replays the game marks as not validable, e.g. several
    /// ghosts of a network race). None = not in the header.
    pub validable: Option<bool>,
}

fn xml_attr(xml: &str, tag: &str, name: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}"))?;
    let end = xml[start..].find('>').map(|e| start + e)?;
    let t = &xml[start..end];
    let key = format!(" {name}=\"");
    let i = t.find(&key)? + key.len();
    let v = &t[i..];
    Some(v[..v.find('"')?].to_string())
}

/// Reads the replay header's XML (`<header type="replay" ...><challenge uid=.../><times
/// best=... validable=.../>`). Only the first 64 KiB are looked at.
pub fn replay_meta(bytes: &[u8]) -> ReplayMeta {
    let head = &bytes[..bytes.len().min(64 * 1024)];
    let text = String::from_utf8_lossy(head);
    let Some(h) = text.find("<header type=\"replay\"") else { return ReplayMeta::default() };
    let xml = &text[h..];
    let xml = match xml.find("</header>") {
        Some(e) => &xml[..e + 9],
        None => xml,
    };
    ReplayMeta {
        uid: xml_attr(xml, "challenge", "uid"),
        best_ms: xml_attr(xml, "times", "best").and_then(|v| v.parse().ok()).filter(|v: &i64| *v >= 0),
        validable: xml_attr(xml, "times", "validable").map(|v| v == "1"),
    }
}

/// "A01(00'25''12).Replay.Gbx" -> "A01(00'25''12)".
pub fn display_name(file_name: &str) -> String {
    let l = file_name.to_ascii_lowercase();
    let stem = if l.ends_with(".replay.gbx") { &file_name[..file_name.len() - 11] } else { file_name };
    stem.to_string()
}

// ------------------------------------------------------------------ queue

#[derive(Debug, Clone, PartialEq)]
pub enum ModRef {
    None,
    /// (port, job id): /v1/result is posted once.
    Bridge { port: u16, id: String, told: bool },
}

#[derive(Debug, Clone)]
pub struct Job {
    pub id: u64,
    pub game: String,
    pub site: String,
    pub map: String,
    pub time_ms: Option<i64>,
    /// "mod" | "folder" | "host" | "manual"
    pub source: String,
    pub file_name: String,
    pub bytes: Arc<Vec<u8>>,
    pub sha: String,
    /// "waiting" | "uploading" | "retry" | "signin"
    pub state: String,
    pub attempts: u32,
    pub due_ms: u64,
    pub detail: Option<String>,
    /// Unix ms when the job was queued (the saved queue drops old ones).
    pub created_ms: u64,
    pub mod_ref: ModRef,
}

/// What one upload attempt came to.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Done { link: Option<String>, track: Option<String> },
    /// TMX said no (slower than the record, wrong track, invalid replay): final, no retry.
    Refused(String),
    /// Network, timeout, 5xx, 429: retried with backoff.
    Retry(String),
    /// Not signed in to that exchange in the embedded browser.
    SignIn,
}

#[derive(Debug, Default)]
pub struct Queue {
    pub jobs: Vec<Job>,
    pub last_upload_ms: u64,
    next_id: u64,
}

/// Same run (map + time) whatever the file: the copy the 100% TMX mod offers and the one in the
/// replay folder are different byte streams for the uploader but one run.
pub fn run_key(bytes: &[u8]) -> Option<String> {
    let m = replay_meta(bytes);
    Some(format!("run:{}:{}", m.uid?, m.best_ms?))
}

impl Queue {
    /// Adds a job unless the same replay is already queued. Returns its id.
    pub fn push(&mut self, mut job: Job, now: u64) -> Option<u64> {
        if !job.sha.is_empty() && self.jobs.iter().any(|j| j.sha == job.sha) {
            return None;
        }
        if let Some(k) = run_key(&job.bytes) {
            if self.jobs.iter().any(|j| run_key(&j.bytes).as_deref() == Some(k.as_str())) {
                return None;
            }
        }
        self.next_id += 1;
        job.id = self.next_id;
        job.created_ms = now;
        job.due_ms = now;
        job.state = "waiting".into();
        self.jobs.push(job);
        Some(self.next_id)
    }

    /// Index of the job to upload now: max one at a time, >= GAP_MS after the last upload, the
    /// oldest due job first.
    pub fn next_due(&self, now: u64) -> Option<usize> {
        if self.jobs.iter().any(|j| j.state == "uploading") || now < self.last_upload_ms + GAP_MS {
            return None;
        }
        self.jobs.iter().enumerate().filter(|(_, j)| j.due_ms <= now).min_by_key(|(_, j)| (j.due_ms, j.id)).map(|(i, _)| i)
    }

    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    /// Puts back jobs read from the saved queue.
    pub fn restore(&mut self, jobs: Vec<Job>, next_id: u64) {
        self.next_id = self.next_id.max(next_id);
        self.jobs = jobs;
    }

    /// Applies an outcome to job `id`. Returns the history entry when the job is finished (it is
    /// then removed), None while it stays queued (retry, sign-in).
    pub fn apply(&mut self, id: u64, out: Outcome, now: u64) -> Option<HistoryEntry> {
        let i = self.jobs.iter().position(|j| j.id == id)?;
        self.last_upload_ms = now;
        let (result, detail, link) = {
            let j = &mut self.jobs[i];
            match out {
                Outcome::Done { link, track } => ("ok", format!("Uploaded{}", track.map(|t| format!(" to {t}")).unwrap_or_default()), link),
                Outcome::Refused(d) => ("refused", d, None),
                Outcome::SignIn => {
                    j.state = "signin".into();
                    j.detail = Some(format!("Sign in to {} in TM Horizon's browser", j.site));
                    j.due_ms = now + SIGNIN_RETRY_S * 1000;
                    return None;
                }
                Outcome::Retry(d) => {
                    j.attempts += 1;
                    if let Some(s) = BACKOFF_S.get(j.attempts as usize - 1) {
                        j.state = "retry".into();
                        j.detail = Some(d);
                        j.due_ms = now + s * 1000;
                        return None;
                    }
                    ("failed", format!("Gave up after {} tries: {d}", j.attempts), None)
                }
            }
        };
        let j = self.jobs.remove(i);
        Some(history_of(&j, result, &detail, link, now))
    }

    /// The user signed in (or asked to retry): waiting jobs go now.
    pub fn wake_signin(&mut self, now: u64) {
        for j in self.jobs.iter_mut().filter(|j| j.state == "signin") {
            j.due_ms = now;
        }
    }
}

pub fn history_of(j: &Job, result: &str, detail: &str, link: Option<String>, now: u64) -> HistoryEntry {
    HistoryEntry {
        at: now,
        game: j.game.clone(),
        site: j.site.clone(),
        map: j.map.clone(),
        time_ms: j.time_ms,
        source: j.source.clone(),
        result: result.into(),
        detail: detail.into(),
        link,
    }
}

// ------------------------------------------------------------------ the uploader's answer

/// What the upload script in the webview reports (status codes and the track, nothing else).
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Raw {
    /// "token" (GET /replayupload), "upload" (POST /api/replays/upload) or "error" (fetch threw).
    pub stage: String,
    pub status: Option<u16>,
    pub no_token: bool,
    pub ok: bool,
    pub track_id: Option<i64>,
    pub track_name: Option<String>,
    pub detail: Option<String>,
}

/// Raw answer -> outcome. Signed out, TMX answers /replayupload with 401 (the page still carries
/// an antiforgery token, so the token alone says nothing).
pub fn classify(host: &str, r: &Raw) -> Outcome {
    let st = r.status.unwrap_or(0);
    let transient = |what: &str| Outcome::Retry(format!("{what} ({})", if st == 0 { "no answer".to_string() } else { st.to_string() }));
    match r.stage.as_str() {
        "token" => match st {
            401 | 403 => Outcome::SignIn,
            200 if r.no_token => Outcome::SignIn,
            200 => Outcome::Retry("Upload page without a form".into()),
            _ => transient("TMX upload page did not load"),
        },
        "upload" if r.ok => Outcome::Done {
            link: r.track_id.map(|id| format!("https://{host}/trackshow/{id}")),
            track: r.track_name.clone().filter(|t| !t.is_empty()),
        },
        "upload" => match st {
            401 | 403 => Outcome::SignIn,
            408 | 429 | 0 => transient("TMX busy"),
            s if s >= 500 => transient("TMX error"),
            _ => Outcome::Refused(r.detail.clone().filter(|d| !d.trim().is_empty()).unwrap_or_else(|| format!("TMX refused the replay ({st})"))),
        },
        _ => Outcome::Retry(r.detail.clone().unwrap_or_else(|| "Upload did not run".into())),
    }
}

pub trait Uploader: Send + Sync {
    /// Uploads on https://<host> (or the test origin) and returns the script's report.
    fn upload(&self, host: &str, file_name: &str, bytes: &[u8]) -> Result<Raw, String>;
    /// Only the sign-in check (GET /replayupload), no upload.
    fn check(&self, host: &str) -> Result<Raw, String>;
}

/// The script run inside the hidden webview on https://<host>/. Reports back by navigating to
/// `tmhub-upload:<nonce>#<json>`, which the webview's navigation handler catches and cancels.
pub fn upload_script(nonce: &str, file_name: &str, bytes_b64: Option<&str>) -> String {
    let name = serde_json::to_string(file_name).unwrap_or_else(|_| "\"replay.Replay.Gbx\"".into());
    let data = bytes_b64.map(|b| format!("\"{b}\"")).unwrap_or_else(|| "null".into());
    format!(
        r#"(async () => {{
  const N = "{nonce}", NAME = {name}, B64 = {data};
  const send = (o) => {{ location.href = 'tmhub-upload:' + N + '#' + encodeURIComponent(JSON.stringify(o)); }};
  try {{
    const page = await fetch('/replayupload', {{ credentials: 'include', cache: 'no-store' }});
    const html = page.ok ? await page.text() : '';
    const m = html.match(/data-antiforgery="([^"]+)"/i);
    if (!page.ok || !m || B64 === null) return send({{ stage: 'token', status: page.status, noToken: !m }});
    const bin = atob(B64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const form = new FormData();
    form.append('file', new Blob([bytes], {{ type: 'application/octet-stream' }}), NAME);
    form.append('__RequestVerificationToken', m[1]);
    const res = await fetch('/api/replays/upload', {{ method: 'POST', body: form, credentials: 'include' }});
    let p = null;
    try {{ p = await res.json(); }} catch (e) {{ p = null; }}
    const t = p && p.Track;
    const d = p && (p.detail || p.title || p.message || p.Message);
    send({{ stage: 'upload', status: res.status, ok: !!t, trackId: t ? (t.TrackId ?? t.TrackID ?? null) : null,
           trackName: t ? (t.TrackName || null) : null, detail: d ? String(d).slice(0, 300) : null }});
  }} catch (e) {{
    send({{ stage: 'error', detail: String((e && e.message) || e).slice(0, 300) }});
  }}
}})();"#
    )
}

// ------------------------------------------------------------------ the 100% TMX mod

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModJob {
    pub id: String,
    pub site: String,
    pub track_id: i64,
    pub map_name: String,
    pub file_name: String,
    pub time_ms: i64,
    pub verified: bool,
}

#[derive(Debug, PartialEq)]
pub enum Next {
    Job(ModJob),
    Empty,
    Unauthorized,
}

/// Parses /v1/next's body: {"ok":true,"upload":{...}|null}.
pub fn parse_next(body: &str) -> Result<Option<ModJob>, String> {
    #[derive(Deserialize)]
    struct R {
        upload: Option<ModJob>,
    }
    let r: R = serde_json::from_str(body).map_err(|e| e.to_string())?;
    Ok(r.upload.filter(|j| !j.id.is_empty()))
}

/// Client of the mod's bridge (plain HTTP on 127.0.0.1).
pub struct ModClient {
    pub ports: Vec<u16>,
    agent: ureq::Agent,
    long: ureq::Agent,
}

impl Default for ModClient {
    fn default() -> Self {
        Self::new(MOD_PORTS.to_vec())
    }
}

impl ModClient {
    pub fn new(ports: Vec<u16>) -> Self {
        let mk = |read: u64| ureq::AgentBuilder::new().timeout_connect(Duration::from_millis(800)).timeout_read(Duration::from_secs(read)).timeout_write(Duration::from_secs(10)).build();
        ModClient { ports, agent: mk(15), long: mk(MOD_WAIT_S + 15) }
    }
    fn url(port: u16, path: &str) -> String {
        format!("http://127.0.0.1:{port}{path}")
    }
    /// First port with the mod: (port, mod version).
    pub fn find(&self) -> Option<(u16, Option<String>)> {
        for &p in &self.ports {
            let Ok(r) = self.agent.get(&Self::url(p, "/v1/ping")).call() else { continue };
            let Ok(v) = r.into_json::<serde_json::Value>() else { continue };
            if v.get("ok").and_then(|o| o.as_bool()) == Some(true) {
                return Some((p, v.get("mod").and_then(|m| m.as_str()).map(String::from)));
            }
        }
        None
    }
    /// Asks for the key; Some(key) once the player allowed it in the game.
    pub fn pair(&self, port: u16) -> Result<Option<String>, String> {
        let v: serde_json::Value = self.agent.post(&Self::url(port, "/v1/pair")).call().map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())?;
        Ok(v.get("key").and_then(|k| k.as_str()).filter(|k| !k.is_empty()).map(String::from))
    }
    pub fn next(&self, port: u16, key: &str, wait: u64) -> Result<Next, String> {
        match self.long.get(&Self::url(port, &format!("/v1/next?wait={wait}"))).set("X-TMX-Key", key).call() {
            Ok(r) => Ok(parse_next(&r.into_string().map_err(|e| e.to_string())?)?.map(Next::Job).unwrap_or(Next::Empty)),
            Err(ureq::Error::Status(401, _)) => Ok(Next::Unauthorized),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn file(&self, port: u16, key: &str, id: &str) -> Result<Vec<u8>, String> {
        let id = url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>();
        let r = self.agent.get(&Self::url(port, &format!("/v1/file?id={id}"))).set("X-TMX-Key", key).call().map_err(|e| e.to_string())?;
        let mut b = Vec::new();
        r.into_reader().take(MAX_REPLAY as u64 + 1).read_to_end(&mut b).map_err(|e| e.to_string())?;
        if b.len() > MAX_REPLAY {
            return Err("replay too large".into());
        }
        Ok(b)
    }
    pub fn result(&self, port: u16, key: &str, id: &str, ok: bool, detail: &str) -> Result<(), String> {
        self.agent
            .post(&Self::url(port, "/v1/result"))
            .set("X-TMX-Key", key)
            .send_json(serde_json::json!({ "id": id, "ok": ok, "detail": detail }))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

// ------------------------------------------------------------------ replay folders + host log

/// Folders watched for a legacy game: `<install>\GameData\Tracks\Replays`, its Autosaves and My Replays (where
/// ESWC Autosave 1.2.0 saves Sunrise and Original personal bests, and where "Save replay" puts them).
pub fn watch_dirs(install: &Path) -> Vec<PathBuf> {
    let r = install.join("GameData").join("Tracks").join("Replays");
    vec![r.join("Autosaves"), r.clone(), r.join("My Replays")]
}

/// New replay files in `dirs`: written after `since_ms`, not seen before, at least 2 s old (so
/// the game has finished writing). `seen` keys are path|mtime|size.
pub fn scan_new(dirs: &[PathBuf], since_ms: u64, now: u64, seen: &mut HashSet<String>) -> Vec<PathBuf> {
    let mut out = vec![];
    for d in dirs {
        for e in crate::fsx::list(d) {
            if !e.is_file || crate::maps::gbx_kind(&e.name) != Some(crate::maps::GbxKind::Replay) {
                continue;
            }
            let Some(m) = e.modified.and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64) else { continue };
            if m < since_ms || m + 2_000 > now {
                continue;
            }
            let size = std::fs::metadata(&e.path).map(|m| m.len()).unwrap_or(0);
            if seen.insert(format!("{}|{m}|{size}", crate::fsx::norm(&e.path))) {
                out.push(e.path);
            }
        }
    }
    out
}

/// REPLAY_SAVED lines of a Horizon Host log: `... event: replay saved by <source>: <path>`.
pub fn parse_host_events(text: &str) -> Vec<(String, String)> {
    const K: &str = "event: replay saved by ";
    text.lines()
        .filter_map(|l| {
            let rest = &l[l.find(K)? + K.len()..];
            let (src, path) = rest.split_once(": ")?;
            let path = path.trim();
            (!path.is_empty()).then(|| (src.trim().to_string(), path.to_string()))
        })
        .collect()
}

/// Newest host log of a legacy game install.
pub fn host_log(install: &Path) -> Option<PathBuf> {
    crate::fsx::list(&install.join("horizon").join("logs"))
        .into_iter()
        .filter(|e| e.is_file && e.name.to_ascii_lowercase().ends_with(".log"))
        .max_by_key(|e| e.modified)
        .map(|e| e.path)
}

// ------------------------------------------------------------------ handover endpoint

/// JSON of `GET /v1/uploader`.
pub fn handover_json(version: &str, uploading: bool, sites: &[String], last: Option<&HistoryEntry>) -> String {
    serde_json::json!({
        "app": "tm-horizon",
        "version": version,
        "uploading": uploading,
        "sites": sites,
        "last": last.map(|h| serde_json::json!({ "at": h.at, "map": h.map, "site": h.site, "ok": h.result == "ok", "result": h.result, "detail": h.detail, "link": h.link })),
    })
    .to_string()
}

fn http(status: u16, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    // No Access-Control-Allow-Origin: the extension asks from its background (host permission),
    // web pages have no business reading this.
    format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len())
}

/// Answers one request. Host must be loopback (a DNS-rebound page carries its own domain).
pub fn handover_answer(request: &str, body: &dyn Fn() -> String) -> String {
    let mut lines = request.split("\r\n");
    let first = lines.next().unwrap_or("");
    let host = lines.find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("host")).map(|(_, v)| v.trim().to_ascii_lowercase())).unwrap_or_default();
    let host_name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(&host);
    if host_name != "127.0.0.1" && host_name != "localhost" {
        return http(403, r#"{"ok":false}"#);
    }
    let mut parts = first.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let path = target.split('?').next().unwrap_or("");
    if method == "GET" && path == "/v1/uploader" {
        http(200, &body())
    } else {
        http(404, r#"{"ok":false}"#)
    }
}

pub struct Handover {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Drop for Handover {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Handover {
    /// Listens on the first free port of `ports` (loopback only).
    pub fn start(ports: &[u16], body: Arc<dyn Fn() -> String + Send + Sync>) -> Result<Handover, String> {
        let (listener, port) = ports.iter().find_map(|&p| TcpListener::bind(("127.0.0.1", p)).ok().map(|l| (l, p))).ok_or("no free port for the handover endpoint")?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        std::thread::spawn(move || {
            while !s2.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((c, _)) => {
                        let b = body.clone();
                        std::thread::spawn(move || serve_one(c, &*b));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(150)),
                }
            }
        });
        Ok(Handover { port, stop })
    }
}

fn serve_one(mut c: TcpStream, body: &dyn Fn() -> String) {
    let _ = c.set_nonblocking(false);
    let _ = c.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while buf.len() < 16 * 1024 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match c.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let answer = handover_answer(&String::from_utf8_lossy(&buf), body);
    let _ = c.write_all(answer.as_bytes());
    let _ = c.shutdown(std::net::Shutdown::Both);
}

// ------------------------------------------------------------------ the service

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameView {
    pub game: String,
    pub site: String,
    pub enabled: bool,
    pub source: String,
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeView {
    pub state: String,
    pub r#mod: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: u64,
    pub game: String,
    pub site: String,
    pub map: String,
    pub time_ms: Option<i64>,
    pub source: String,
    pub state: String,
    pub attempts: u32,
    pub next_in_secs: Option<u64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub games: Vec<GameView>,
    pub confirmed: bool,
    pub bridge: BridgeView,
    pub handover_port: Option<u16>,
    pub signin: Vec<String>,
    pub queue: Vec<JobView>,
    pub history: Vec<HistoryEntry>,
}

#[derive(Default)]
pub struct Inner {
    pub cfg: Config,
    pub queue: Queue,
    pub bridge_state: String,
    pub bridge_mod: Option<String>,
    pub signin: BTreeSet<String>,
    pub handover: Option<Handover>,
    /// Folder entries already looked at (path|mtime|size).
    pub seen: HashSet<String>,
    /// Host log -> bytes already read.
    pub log_pos: HashMap<String, u64>,
    /// Mod job ids taken from the bridge (it keeps offering a job until /v1/result).
    pub pulled: HashSet<String>,
    /// Folders per legacy game (from the scan), for the UI and the watcher.
    pub folders: BTreeMap<String, PathBuf>,
}

pub struct Service {
    pub cfg_path: PathBuf,
    /// Saved queue (tmxqueue.rs) and the copies of the waiting replays.
    pub queue_path: PathBuf,
    pub cache_dir: PathBuf,
    pub inner: Mutex<Inner>,
}

impl Service {
    /// Config and queue in the same folder (tests).
    pub fn new(config_dir: &Path) -> Self {
        Self::with_dirs(config_dir, &config_dir.join("tmx-upload"))
    }

    /// `config_dir`: tmx-upload.json. `data_dir`: queue.json and the cache folder (the saved queue is read
    /// back here: jobs that were waiting continue).
    pub fn with_dirs(config_dir: &Path, data_dir: &Path) -> Self {
        let cfg_path = config_dir.join("tmx-upload.json");
        let (queue_path, cache_dir) = (data_dir.join("queue.json"), data_dir.join("cache"));
        let mut cfg = load_config(&cfg_path);
        let now = now_ms();
        let r = crate::tmxqueue::load(&queue_path, &cache_dir, now);
        let mut inner = Inner { bridge_state: "off".into(), ..Default::default() };
        for d in &r.dropped {
            cfg.add_history(HistoryEntry { at: now, game: d.game.clone(), site: d.site.clone(), map: d.map.clone(), time_ms: d.time_ms, source: d.source.clone(), result: "skipped".into(), detail: d.why.clone(), link: None });
        }
        // The mod keeps offering a job until its /v1/result: don't take it a second time.
        for j in &r.jobs {
            if let ModRef::Bridge { id, told: false, .. } = &j.mod_ref {
                inner.pulled.insert(id.clone());
            }
        }
        inner.queue.restore(r.jobs, r.next_id);
        inner.cfg = cfg;
        let s = Service { cfg_path, queue_path, cache_dir, inner: Mutex::new(inner) };
        if !r.dropped.is_empty() {
            s.save(&s.inner.lock().unwrap());
        }
        s
    }

    pub fn save(&self, i: &Inner) {
        let _ = save_config(&self.cfg_path, &i.cfg);
        if let Err(e) = crate::tmxqueue::save(&self.queue_path, &self.cache_dir, &i.queue) {
            eprintln!("tmx upload queue not saved: {e}");
        }
    }

    pub fn status(&self) -> Status {
        let i = self.inner.lock().unwrap();
        status_of(&i, now_ms())
    }

    /// Queues a replay file (folder, host or manual). Skips with a history line when it can't go.
    pub fn enqueue_file(&self, game: &str, path: &Path, source: &str, time_hint: Option<i64>) -> Result<(), String> {
        let bytes = crate::fsx::read_bytes_prefix(path, MAX_REPLAY + 1).ok_or("Replay not readable")?;
        let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "replay.Replay.Gbx".into());
        self.enqueue_bytes(game, &file_name, bytes, source, time_hint)
    }

    /// Same for a replay that is already read.
    pub fn enqueue_bytes(&self, game: &str, file_name: &str, bytes: Vec<u8>, source: &str, time_hint: Option<i64>) -> Result<(), String> {
        let site = site_of_game(game).ok_or("No TMX site for this game")?;
        if bytes.len() > MAX_REPLAY {
            return Err("Replay too large".into());
        }
        let mut i = self.inner.lock().unwrap();
        let job = make_job(game, site, file_name, display_name(file_name), time_hint, source, bytes, ModRef::None);
        admit(&mut i, job, source == "manual", now_ms())?;
        self.save(&i);
        Ok(())
    }
}

impl Service {
    /// One pass over the Forever replay folder (`<documents>\TrackMania\Tracks\Replays`) for
    /// TMNF / TMUF players without the 100% TMX mod. Rules: tmxfolder.rs. Returns how many replays
    /// were queued.
    pub fn scan_forever(&self, docs: &Path, now: u64) -> usize {
        let dirs = crate::tmxfolder::forever_dirs(docs);
        let (tmnf_on, tmuf_on, since, mut seen) = {
            let mut i = self.inner.lock().unwrap();
            let on = |g: &str| i.cfg.enabled(g);
            let since = ["tmnf", "tmuf"].iter().filter(|g| on(g)).filter_map(|g| i.cfg.games.get(*g).map(|c| c.since)).min();
            let (a, b) = (on("tmnf"), on("tmuf"));
            let Some(since) = since else { return 0 };
            (a, b, since, std::mem::take(&mut i.seen))
        };
        let found = scan_new(&dirs, since, now, &mut seen);
        self.inner.lock().unwrap().seen = seen;
        let mut queued = 0;
        for p in found {
            let Some(bytes) = crate::fsx::read_bytes_prefix(&p, MAX_REPLAY + 1) else { continue };
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let autosave = crate::tmxfolder::is_autosave(&p);
            let mut mine: BTreeSet<String> = self.inner.lock().unwrap().cfg.logins.iter().cloned().collect();
            if !autosave && mine.is_empty() {
                mine = crate::tmxfolder::learn_logins(&dirs[0]);
            }
            match crate::tmxfolder::decide(autosave, &bytes, &mine, tmnf_on, tmuf_on) {
                crate::tmxfolder::Decision::Take { game, login } => {
                    if let Some(l) = login {
                        let mut i = self.inner.lock().unwrap();
                        if !i.cfg.logins.contains(&l) && i.cfg.logins.len() < crate::tmxfolder::MAX_LOGINS {
                            i.cfg.logins.push(l);
                            self.save(&i);
                        }
                    }
                    if self.enqueue_bytes(game, &name, bytes, "folder", None).is_ok() {
                        queued += 1;
                    }
                }
                crate::tmxfolder::Decision::Skip(why) => {
                    let game = if tmnf_on { "tmnf" } else { "tmuf" };
                    let meta = replay_meta(&bytes);
                    let mut i = self.inner.lock().unwrap();
                    i.cfg.add_history(HistoryEntry {
                        at: now,
                        game: game.into(),
                        site: site_of_game(game).unwrap_or("").into(),
                        map: display_name(&name),
                        time_ms: meta.best_ms,
                        source: "folder".into(),
                        result: "skipped".into(),
                        detail: why,
                        link: None,
                    });
                    self.save(&i);
                }
            }
        }
        queued
    }
}

#[allow(clippy::too_many_arguments)]
pub fn make_job(game: &str, site: &str, file_name: &str, map: String, time_ms: Option<i64>, source: &str, bytes: Vec<u8>, mod_ref: ModRef) -> Job {
    let meta = replay_meta(&bytes);
    Job {
        id: 0,
        game: game.into(),
        site: site.into(),
        map,
        time_ms: time_ms.or(meta.best_ms),
        source: source.into(),
        file_name: file_name.into(),
        sha: sha256(&bytes),
        bytes: Arc::new(bytes),
        state: "waiting".into(),
        attempts: 0,
        due_ms: 0,
        detail: None,
        created_ms: 0,
        mod_ref,
    }
}

/// Rules before a job is queued: not handled before (manual uploads may repeat), the header must
/// not say "not validable". Skips go to the history. Err only for manual uploads (shown to the user).
pub fn admit(i: &mut Inner, job: Job, manual: bool, now: u64) -> Result<Option<u64>, String> {
    if !manual && (i.cfg.done.iter().any(|d| *d == job.sha) || run_key(&job.bytes).is_some_and(|k| i.cfg.done.iter().any(|d| *d == k))) {
        return Ok(None);
    }
    if replay_meta(&job.bytes).validable == Some(false) {
        let why = "TMX would refuse it: the replay is not validable (several ghosts or not a full run)";
        if manual {
            return Err(why.into());
        }
        i.cfg.mark_job_done(&job);
        i.cfg.add_history(history_of(&job, "skipped", why, None, now));
        return Ok(None);
    }
    Ok(i.queue.push(job, now))
}

pub fn status_of(i: &Inner, now: u64) -> Status {
    Status {
        games: GAMES
            .iter()
            .map(|g| GameView {
                game: g.to_string(),
                site: site_of_game(g).unwrap_or("").into(),
                enabled: i.cfg.enabled(g),
                source: if mod_game(g) { "mod" } else { "folder" }.into(),
                folder: i.folders.get(*g).map(|p| p.to_string_lossy().into_owned()),
            })
            .collect(),
        confirmed: i.cfg.confirmed,
        bridge: BridgeView { state: i.bridge_state.clone(), r#mod: i.bridge_mod.clone() },
        handover_port: i.handover.as_ref().map(|h| h.port),
        signin: i.signin.iter().cloned().collect(),
        queue: i
            .queue
            .jobs
            .iter()
            .map(|j| JobView {
                id: j.id,
                game: j.game.clone(),
                site: j.site.clone(),
                map: j.map.clone(),
                time_ms: j.time_ms,
                source: j.source.clone(),
                state: j.state.clone(),
                attempts: j.attempts,
                next_in_secs: (j.due_ms > now).then(|| (j.due_ms - now).div_ceil(1000)),
                detail: j.detail.clone(),
            })
            .collect(),
        history: i.cfg.history.iter().take(50).cloned().collect(),
    }
}

/// Mod job that needs a /v1/result now: (port, id, ok, detail).
pub type Tell = (u16, String, bool, String);

/// One worker step: uploads the next due job with `up`. Returns (did something, mod result to post).
pub fn step(svc: &Service, up: &dyn Uploader) -> (bool, Option<Tell>) {
    let now = now_ms();
    let (id, host, name, bytes) = {
        let mut i = svc.inner.lock().unwrap();
        let Some(ix) = i.queue.next_due(now) else { return (false, None) };
        let j = &mut i.queue.jobs[ix];
        j.state = "uploading".into();
        (j.id, j.site.clone(), j.file_name.clone(), j.bytes.clone())
    };
    let out = match up.upload(&host, &name, &bytes) {
        Ok(raw) => classify(&host, &raw),
        Err(e) => Outcome::Retry(e),
    };
    let now = now_ms();
    let mut i = svc.inner.lock().unwrap();
    if out == Outcome::SignIn {
        i.signin.insert(host.clone());
    } else if i.signin.remove(&host) {
        i.queue.wake_signin(now);
    }
    // The mod's overlay hears the first final answer (or that a sign-in is needed).
    let mut tell = None;
    let idx = i.queue.jobs.iter().position(|j| j.id == id);
    let mod_ref = idx.map(|x| i.queue.jobs[x].mod_ref.clone());
    let sha = idx.map(|x| i.queue.jobs[x].sha.clone()).unwrap_or_default();
    let key = idx.and_then(|x| run_key(&i.queue.jobs[x].bytes));
    let done = i.queue.apply(id, out.clone(), now);
    if let Some(ModRef::Bridge { port, id: mid, told: false }) = mod_ref {
        let msg = match (&out, &done) {
            (Outcome::SignIn, _) => Some((false, format!("Sign in to {host} in TM Horizon - the replay waits there."))),
            (_, Some(h)) => Some((h.result == "ok", if h.result == "ok" { "Replay uploaded to TMX by TM Horizon.".to_string() } else { h.detail.clone() })),
            _ => None,
        };
        if let Some((ok, d)) = msg {
            tell = Some((port, mid.clone(), ok, d));
            // The mod drops the job on /v1/result (and may reuse the id after a restart).
            i.pulled.remove(&mid);
            if let Some(j) = i.queue.jobs.iter_mut().find(|j| j.id == id) {
                j.mod_ref = ModRef::Bridge { port, id: mid, told: true };
            }
        }
    }
    if let Some(h) = done {
        crate::clientbridge::notify_upload(&h);
        i.cfg.mark_done(&sha);
        if let Some(k) = key {
            i.cfg.mark_done(&k);
        }
        i.cfg.add_history(h);
    }
    svc.save(&i);
    (true, tell)
}

/// Handles one job the mod offered. Returns a result to post at once (skips), if any.
pub fn take_mod_job(svc: &Service, port: u16, job: ModJob, bytes: Result<Vec<u8>, String>) -> Option<Tell> {
    let now = now_ms();
    let mut i = svc.inner.lock().unwrap();
    if i.pulled.contains(&job.id) {
        return None;
    }
    let host = site_host(&job.site);
    let game = host.and_then(game_of_site);
    let skip = |i: &mut Inner, why: String| {
        i.cfg.add_history(HistoryEntry {
            at: now,
            game: game.unwrap_or("").into(),
            site: host.map(String::from).unwrap_or_else(|| job.site.clone()),
            map: job.map_name.clone(),
            time_ms: Some(job.time_ms).filter(|t| *t > 0),
            source: "mod".into(),
            result: "skipped".into(),
            detail: why.clone(),
            link: None,
        });
        svc.save(i);
        Some((port, job.id.clone(), false, why))
    };
    let (Some(host), Some(game)) = (host, game) else { return skip(&mut *i, format!("Unknown exchange '{}'", job.site)) };
    if !i.cfg.enabled(game) {
        return skip(&mut *i, format!("Auto-upload to {host} is off in TM Horizon"));
    }
    if !job.verified {
        return skip(&mut *i, "Not uploaded: the replay could not be matched to this map".into());
    }
    // The file could not be fetched: try again on the next offer.
    let Ok(bytes) = bytes else { return None };
    let name = if job.file_name.is_empty() { "replay.Replay.Gbx".to_string() } else { job.file_name.clone() };
    let map = if job.map_name.is_empty() { display_name(&name) } else { job.map_name.clone() };
    let j = make_job(game, host, &name, map, Some(job.time_ms).filter(|t| *t > 0), "mod", bytes, ModRef::Bridge { port, id: job.id.clone(), told: false });
    let before = i.cfg.history.len();
    let r = admit(&mut i, j, false, now);
    svc.save(&i);
    match r {
        Ok(Some(_)) => {
            i.pulled.insert(job.id.clone());
            None
        }
        _ => {
            // Already handled or not validable: tell the mod so its queue moves on.
            let why = (i.cfg.history.len() > before).then(|| i.cfg.history[0].detail.clone());
            Some((port, job.id.clone(), false, why.unwrap_or_else(|| "TM Horizon already has this replay".into())))
        }
    }
}

/// Sign-in check verdict: "ok", "signin" or what went wrong.
pub fn check_verdict(r: &Raw) -> String {
    match (r.stage.as_str(), r.status) {
        ("token", Some(401 | 403)) => "signin".into(),
        ("token", Some(200)) if r.no_token => "signin".into(),
        ("token", Some(200)) => "ok".into(),
        ("token", Some(s)) => format!("TMX answered {s}"),
        _ => r.detail.clone().unwrap_or_else(|| "no answer".into()),
    }
}

/// Enables or disables a game. First enable needs `confirm`.
pub fn set_enabled(svc: &Service, game: &str, enabled: bool, confirm: bool) -> Result<(), String> {
    if !GAMES.contains(&game) {
        return Err("Unknown game".into());
    }
    let mut i = svc.inner.lock().unwrap();
    if enabled && !i.cfg.confirmed {
        if !confirm {
            return Err("confirm".into());
        }
        i.cfg.confirmed = true;
    }
    let g = i.cfg.games.entry(game.into()).or_default();
    if enabled && !g.enabled {
        g.since = now_ms();
    }
    g.enabled = enabled;
    if !enabled {
        // Waiting jobs of that game go (the mod hears nothing more; its queue lapses with the game).
        let now = now_ms();
        let gone: Vec<Job> = i.queue.jobs.iter().filter(|j| j.game == game && j.state != "uploading").cloned().collect();
        i.queue.jobs.retain(|j| !(j.game == game && j.state != "uploading"));
        for j in gone {
            i.cfg.add_history(history_of(&j, "skipped", "Auto-upload turned off", None, now));
        }
    }
    svc.save(&i);
    Ok(())
}

// ------------------------------------------------------------------ Tauri glue

pub mod app {
    use super::*;
    use crate::state::AppState;
    use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
    use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, Url, WebviewUrl};

    pub const LABEL: &str = "tmxupload";

    enum WvMsg {
        Loaded(String),
        Result(String, String),
    }

    static CHANNEL: Mutex<Option<std::sync::mpsc::Sender<WvMsg>>> = Mutex::new(None);
    static RUN_LOCK: Mutex<()> = Mutex::new(());

    fn deliver(m: WvMsg) {
        if let Some(tx) = CHANNEL.lock().unwrap().as_ref() {
            let _ = tx.send(m);
        }
    }

    /// Uploads through a hidden webview on the embedded browser's profile.
    pub struct WebUploader<R: Runtime> {
        pub app: AppHandle<R>,
    }

    impl<R: Runtime> WebUploader<R> {
        pub fn new(app: AppHandle<R>) -> Self {
            WebUploader { app }
        }

        fn view(&self, url: Url) -> Result<tauri::Webview<R>, String> {
            if let Some(w) = self.app.get_webview(LABEL) {
                w.navigate(url).map_err(|e| e.to_string())?;
                return Ok(w);
            }
            let window = self.app.get_window("main").ok_or("no main window")?;
            let b = WebviewBuilder::new(LABEL, WebviewUrl::External(url)).data_directory(crate::web::profile_dir(&self.app));
            // Same WebView2 environment options as the embedded browser (one profile, one environment).
            #[cfg(windows)]
            let b = b.browser_extensions_enabled(true);
            let b = b
                .on_navigation(|u| {
                    if u.scheme() == "tmhub-upload" {
                        let nonce = u.path().to_string();
                        let data = u.fragment().map(|f| url::form_urlencoded::parse(format!("x={f}").as_bytes()).find(|(k, _)| k == "x").map(|(_, v)| v.into_owned()).unwrap_or_default()).unwrap_or_default();
                        deliver(WvMsg::Result(nonce, data));
                        return false;
                    }
                    u.scheme() == "about" || (u.scheme() == "https" && u.host_str().is_some_and(|h| site_host(h).is_some()))
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_page_load(|_w, p| {
                    if matches!(p.event(), PageLoadEvent::Finished) {
                        deliver(WvMsg::Loaded(p.url().to_string()));
                    }
                });
            let w = window.add_child(b, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)).map_err(|e| e.to_string())?;
            let _ = w.hide();
            Ok(w)
        }

        fn run(&self, host: &str, file_name: &str, bytes: Option<&[u8]>) -> Result<Raw, String> {
            use base64::Engine;
            if site_host(host) != Some(host) {
                return Err("not an exchange".into());
            }
            // One page job at a time across every uploader (one hidden view, one channel).
            let _g = RUN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let (tx, rx) = std::sync::mpsc::channel();
            *CHANNEL.lock().unwrap() = Some(tx);
            let url = Url::parse(&format!("https://{host}/replayupload")).map_err(|e| e.to_string())?;
            let w = self.view(url)?;
            let deadline = std::time::Instant::now() + Duration::from_secs(45);
            // Wait for the page of that host (its origin is what the fetches need).
            loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(left) {
                    Ok(WvMsg::Loaded(u)) if Url::parse(&u).ok().and_then(|u| u.host_str().map(String::from)).as_deref() == Some(host) => break,
                    Ok(_) => continue,
                    Err(_) => return Err(format!("{host} did not load")),
                }
            }
            let nonce = format!("{:x}{:x}", now_ms(), std::process::id() as u64 ^ (bytes.map(|b| b.len()).unwrap_or(7) as u64));
            let b64 = bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b));
            w.eval(upload_script(&nonce, file_name, b64.as_deref())).map_err(|e| e.to_string())?;
            let deadline = std::time::Instant::now() + Duration::from_secs(120);
            let out = loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(left) {
                    Ok(WvMsg::Result(n, data)) if n == nonce => break serde_json::from_str::<Raw>(&data).map_err(|e| format!("bad answer: {e}")),
                    Ok(_) => continue,
                    Err(_) => break Err("the upload did not answer in time".into()),
                }
            };
            *CHANNEL.lock().unwrap() = None;
            let _ = w.navigate(Url::parse("about:blank").unwrap());
            out
        }
    }

    impl<R: Runtime> Uploader for WebUploader<R> {
        fn upload(&self, host: &str, file_name: &str, bytes: &[u8]) -> Result<Raw, String> {
            self.run(host, file_name, Some(bytes))
        }
        fn check(&self, host: &str) -> Result<Raw, String> {
            self.run(host, "", None)
        }
    }

    pub fn emit<R: Runtime>(app: &AppHandle<R>) {
        let st = app.state::<Service>().status();
        let _ = app.emit_to("main", "tmx-upload", st);
    }

    /// Starts/stops the handover endpoint with the switches; refreshes the legacy folders.
    fn sync<R: Runtime>(app: &AppHandle<R>) {
        let svc = app.state::<Service>();
        let folders: BTreeMap<String, PathBuf> = {
            let st = app.state::<AppState>();
            let mut m: BTreeMap<String, PathBuf> = GAMES.iter().filter(|g| !mod_game(g)).filter_map(|g| st.install_dir(g).map(|d| (g.to_string(), d))).collect();
            // TMNF / TMUF: the shared replay folder in Documents (shown in the settings).
            if let Some(docs) = crate::platform::documents_dir() {
                for g in ["tmnf", "tmuf"] {
                    m.insert(g.into(), crate::tmxfolder::forever_dirs(&docs).remove(1));
                }
            }
            m
        };
        let mut i = svc.inner.lock().unwrap();
        i.folders = folders;
        let on = i.cfg.any_enabled();
        if on && i.handover.is_none() {
            let a = app.clone();
            let body: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(move || {
                let svc = a.state::<Service>();
                let i = svc.inner.lock().unwrap();
                let sites: Vec<String> = GAMES.iter().filter(|g| i.cfg.enabled(g)).filter_map(|g| site_of_game(g)).map(String::from).collect();
                handover_json(env!("CARGO_PKG_VERSION"), i.cfg.any_enabled(), &sites, i.cfg.history.iter().find(|h| h.result != "skipped"))
            });
            i.handover = Handover::start(&HANDOVER_PORTS, body).ok();
        } else if !on {
            i.handover = None;
        }
        if !on {
            i.bridge_state = "off".into();
        }
    }

    /// Background threads: uploader, mod bridge, folder/host-log watcher.
    pub fn start<R: Runtime>(app: &AppHandle<R>) {
        sync(app);
        let a = app.clone();
        std::thread::spawn(move || {
            let up = WebUploader::new(a.clone());
            loop {
                let svc = a.state::<Service>();
                let (did, tell) = step(&svc, &up);
                if did {
                    emit(&a);
                }
                if let Some((port, id, ok, detail)) = tell {
                    let key = svc.inner.lock().unwrap().cfg.mod_key.clone();
                    let _ = ModClient::default().result(port, &key, &id, ok, &detail);
                }
                std::thread::sleep(Duration::from_millis(if did { 200 } else { 700 }));
            }
        });
        let a = app.clone();
        std::thread::spawn(move || mod_loop(a));
        let a = app.clone();
        std::thread::spawn(move || loop {
            // The scan may finish after the start: refresh the folders now and then.
            sync(&a);
            watch_once(&a);
            std::thread::sleep(Duration::from_secs(3));
        });
    }

    fn set_bridge<R: Runtime>(app: &AppHandle<R>, state: &str, m: Option<String>) {
        let svc = app.state::<Service>();
        let changed = {
            let mut i = svc.inner.lock().unwrap();
            let c = i.bridge_state != state || (m.is_some() && i.bridge_mod != m);
            i.bridge_state = state.into();
            if m.is_some() {
                i.bridge_mod = m;
            }
            c
        };
        if changed {
            emit(app);
        }
    }

    fn mod_loop<R: Runtime>(app: AppHandle<R>) {
        let client = ModClient::default();
        loop {
            let svc = app.state::<Service>();
            let (on, key) = {
                let i = svc.inner.lock().unwrap();
                (i.cfg.any_enabled(), i.cfg.mod_key.clone())
            };
            if !on {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            let Some((port, ver)) = client.find() else {
                set_bridge(&app, "no-game", None);
                std::thread::sleep(Duration::from_secs(5));
                continue;
            };
            if key.is_empty() {
                set_bridge(&app, "pairing", ver);
                if let Ok(Some(k)) = client.pair(port) {
                    let mut i = svc.inner.lock().unwrap();
                    i.cfg.mod_key = k;
                    svc.save(&i);
                }
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            match client.next(port, &key, MOD_WAIT_S) {
                Ok(Next::Unauthorized) => {
                    let mut i = svc.inner.lock().unwrap();
                    i.cfg.mod_key.clear();
                    svc.save(&i);
                }
                Ok(Next::Empty) => set_bridge(&app, "connected", ver),
                Ok(Next::Job(job)) => {
                    set_bridge(&app, "connected", ver);
                    let known = svc.inner.lock().unwrap().pulled.contains(&job.id);
                    if known {
                        // Still in the mod's queue until /v1/result: don't spin on it.
                        std::thread::sleep(Duration::from_secs(2));
                        continue;
                    }
                    let bytes = client.file(port, &key, &job.id);
                    if let Some((p, id, ok, d)) = take_mod_job(&svc, port, job, bytes) {
                        let _ = client.result(p, &key, &id, ok, &d);
                    }
                    emit(&app);
                }
                Err(_) => {
                    set_bridge(&app, "no-game", None);
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
    }

    fn watch_once<R: Runtime>(app: &AppHandle<R>) {
        let svc = app.state::<Service>();
        // TMNF / TMUF: the Documents replay folder (works with or without the 100% TMX mod).
        if svc.inner.lock().unwrap().cfg.enabled("tmnf") || svc.inner.lock().unwrap().cfg.enabled("tmuf") {
            if let Some(docs) = crate::platform::documents_dir() {
                if svc.scan_forever(&docs, now_ms()) > 0 {
                    emit(app);
                }
            }
        }
        let (games, folders) = {
            let i = svc.inner.lock().unwrap();
            let g: Vec<(String, u64)> = GAMES.iter().filter(|g| !mod_game(g)).filter_map(|g| i.cfg.games.get(*g).filter(|c| c.enabled).map(|c| (g.to_string(), c.since))).collect();
            (g, i.folders.clone())
        };
        if games.is_empty() {
            return;
        }
        let now = now_ms();
        let mut found: Vec<(String, PathBuf, &'static str)> = vec![];
        for (game, since) in games {
            let Some(install) = folders.get(&game) else { continue };
            let mut seen = std::mem::take(&mut svc.inner.lock().unwrap().seen);
            for p in scan_new(&watch_dirs(install), since, now, &mut seen) {
                found.push((game.clone(), p, "folder"));
            }
            svc.inner.lock().unwrap().seen = seen;
            // Horizon Host: REPLAY_SAVED lines in its newest log (only new lines).
            if let Some(log) = host_log(install) {
                let key = crate::fsx::norm(&log);
                let len = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
                let pos = svc.inner.lock().unwrap().log_pos.get(&key).copied();
                let modified_after = crate::fsx::mtime(&log).and_then(|m| m.duration_since(UNIX_EPOCH).ok()).is_some_and(|d| d.as_millis() as u64 >= since);
                let from = match pos {
                    Some(p) if p <= len => p,
                    // First look at this log: only if it was written after enabling, from the start.
                    _ if modified_after => 0,
                    _ => len,
                };
                if len > from {
                    if let Ok(mut f) = std::fs::File::open(&log) {
                        use std::io::{Seek, SeekFrom};
                        let mut buf = vec![];
                        if f.seek(SeekFrom::Start(from)).is_ok() && f.take(1 << 20).read_to_end(&mut buf).is_ok() {
                            for (_src, path) in parse_host_events(&String::from_utf8_lossy(&buf)) {
                                let p = PathBuf::from(path);
                                let fresh = crate::fsx::mtime(&p).and_then(|m| m.duration_since(UNIX_EPOCH).ok()).is_some_and(|d| d.as_millis() as u64 >= since);
                                if fresh {
                                    found.push((game.clone(), p, "host"));
                                }
                            }
                        }
                    }
                }
                svc.inner.lock().unwrap().log_pos.insert(key, len);
            }
        }
        let mut any = false;
        for (game, p, src) in found {
            if svc.enqueue_file(&game, &p, src, None).is_ok() {
                any = true;
            }
        }
        if any {
            emit(app);
        }
    }

    // -------------------------------------------------------------- commands

    #[tauri::command(async)]
    pub fn tmx_upload_status(svc: State<Service>) -> Status {
        svc.status()
    }

    #[tauri::command(async)]
    pub fn tmx_upload_set<R: Runtime>(app: AppHandle<R>, svc: State<Service>, game: String, enabled: bool, confirm: Option<bool>) -> Result<Status, String> {
        set_enabled(&svc, &game, enabled, confirm.unwrap_or(false))?;
        sync(&app);
        emit(&app);
        Ok(svc.status())
    }

    #[tauri::command(async)]
    pub fn tmx_upload_file<R: Runtime>(app: AppHandle<R>, svc: State<Service>, game: String, path: String) -> Result<Status, String> {
        let p = PathBuf::from(&path);
        if crate::maps::gbx_kind(&path) != Some(crate::maps::GbxKind::Replay) {
            return Err("Not a .Replay.Gbx file".into());
        }
        svc.enqueue_file(&game, &p, "manual", None)?;
        emit(&app);
        Ok(svc.status())
    }

    #[tauri::command(async)]
    pub fn tmx_upload_clear<R: Runtime>(app: AppHandle<R>, svc: State<Service>) -> Status {
        {
            let mut i = svc.inner.lock().unwrap();
            i.cfg.history.clear();
            svc.save(&i);
        }
        emit(&app);
        svc.status()
    }

    /// File picker for "Upload replay…" (replays only).
    #[tauri::command]
    pub async fn tmx_upload_pick<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("Replay file").add_filter("TrackMania replays", &["Replay.Gbx", "Gbx", "gbx"]).blocking_pick_file())
            .await
            .map_err(|e| e.to_string())?;
        Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
    }

    /// Retries jobs that wait for a sign-in (after the user signed in).
    #[tauri::command(async)]
    pub fn tmx_upload_retry<R: Runtime>(app: AppHandle<R>, svc: State<Service>) -> Status {
        {
            let mut i = svc.inner.lock().unwrap();
            i.queue.wake_signin(now_ms());
            for j in i.queue.jobs.iter_mut().filter(|j| j.state == "retry") {
                j.due_ms = 0;
            }
        }
        emit(&app);
        svc.status()
    }

    /// Sign-in check of one exchange (one page load, no upload): "ok" | "signin" | error text.
    #[tauri::command]
    pub async fn tmx_upload_check<R: Runtime>(app: AppHandle<R>, site: String) -> Result<String, String> {
        let host = site_host(&site).ok_or("Unknown exchange")?;
        let a = app.clone();
        let r = tauri::async_runtime::spawn_blocking(move || WebUploader::new(a).check(host)).await.map_err(|e| e.to_string())??;
        let svc = app.state::<Service>();
        let verdict = check_verdict(&r);
        {
            let mut i = svc.inner.lock().unwrap();
            if verdict == "signin" {
                i.signin.insert(host.into());
            } else if verdict == "ok" && i.signin.remove(host) {
                i.queue.wake_signin(now_ms());
            }
        }
        emit(&app);
        Ok(verdict)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    // ------------------------------------------------------------ helpers: fake servers

    /// A tiny HTTP server for tests: `handler(method, path_and_query, headers, body) -> (status, body)`.
    fn serve(handler: Arc<dyn Fn(&str, &str, &str, &[u8]) -> (u16, Vec<u8>) + Send + Sync>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let h = handler.clone();
                std::thread::spawn(move || {
                    let mut c = c;
                    let _ = c.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut buf = vec![];
                    let mut chunk = [0u8; 8192];
                    let head_end = loop {
                        match c.read(&mut chunk) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let len = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    let mut body = buf[head_end + 4..].to_vec();
                    while body.len() < len {
                        match c.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => body.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let first = head.lines().next().unwrap_or("").to_string();
                    let mut p = first.split(' ');
                    let (m, t) = (p.next().unwrap_or("").to_string(), p.next().unwrap_or("").to_string());
                    let (status, out) = h(&m, &t, &head, &body);
                    let resp = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", out.len());
                    let _ = c.write_all(resp.as_bytes());
                    let _ = c.write_all(&out);
                });
            }
        });
        port
    }

    /// Fake exchange: signed in when the request carries `Cookie: session=ok`. Like TMX, the
    /// upload page answers 401 when signed out but still carries a token.
    struct FakeExchange {
        port: u16,
        uploads: Arc<AtomicUsize>,
    }

    fn fake_exchange(fail_first: usize) -> FakeExchange {
        let uploads = Arc::new(AtomicUsize::new(0));
        let u2 = uploads.clone();
        let port = serve(Arc::new(move |m: &str, t: &str, head: &str, body: &[u8]| {
            let signed = head.to_ascii_lowercase().contains("cookie: session=ok");
            match (m, t) {
                ("GET", "/replayupload") => (if signed { 200 } else { 401 }, br#"<body data-antiforgery="tok123">"#.to_vec()),
                ("POST", "/api/replays/upload") => {
                    let n = u2.fetch_add(1, Ordering::SeqCst);
                    let text = String::from_utf8_lossy(body);
                    if !signed {
                        return (401, b"{}".to_vec());
                    }
                    if !text.contains("tok123") || !text.contains("name=\"file\"") {
                        return (400, br#"{"detail":"bad form"}"#.to_vec());
                    }
                    if n < fail_first {
                        return (503, b"busy".to_vec());
                    }
                    if text.contains("SLOWRUN") {
                        return (400, br#"{"detail":"Your replay is not faster than your current record."}"#.to_vec());
                    }
                    (200, br#"{"Track":{"TrackId":4242,"TrackName":"A01-Race"}}"#.to_vec())
                }
                _ => (404, b"{}".to_vec()),
            }
        }));
        FakeExchange { port, uploads }
    }

    /// Test uploader: the same two requests as the webview script, over plain HTTP to the fake
    /// exchange, with or without the session cookie. Never talks to a real exchange.
    struct HttpUploader {
        port: u16,
        signed_in: AtomicBool,
    }

    impl HttpUploader {
        fn get(&self) -> Result<(u16, String), String> {
            let mut r = ureq::get(&format!("http://127.0.0.1:{}/replayupload", self.port));
            if self.signed_in.load(Ordering::SeqCst) {
                r = r.set("Cookie", "session=ok");
            }
            match r.call() {
                Ok(x) => Ok((x.status(), x.into_string().unwrap_or_default())),
                Err(ureq::Error::Status(s, x)) => Ok((s, x.into_string().unwrap_or_default())),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    impl Uploader for HttpUploader {
        fn check(&self, _host: &str) -> Result<Raw, String> {
            let (s, html) = self.get()?;
            Ok(Raw { stage: "token".into(), status: Some(s), no_token: !html.contains("data-antiforgery"), ..Default::default() })
        }
        fn upload(&self, _host: &str, name: &str, bytes: &[u8]) -> Result<Raw, String> {
            let (s, html) = self.get()?;
            let tok = html.split("data-antiforgery=\"").nth(1).and_then(|r| r.split('"').next()).map(String::from);
            if s != 200 || tok.is_none() {
                return Ok(Raw { stage: "token".into(), status: Some(s), no_token: tok.is_none(), ..Default::default() });
            }
            let b = "----tmhubtest";
            let mut body = format!("--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
            body.extend_from_slice(bytes);
            body.extend_from_slice(format!("\r\n--{b}\r\nContent-Disposition: form-data; name=\"__RequestVerificationToken\"\r\n\r\n{}\r\n--{b}--\r\n", tok.unwrap()).as_bytes());
            let mut r = ureq::post(&format!("http://127.0.0.1:{}/api/replays/upload", self.port)).set("Content-Type", &format!("multipart/form-data; boundary={b}"));
            if self.signed_in.load(Ordering::SeqCst) {
                r = r.set("Cookie", "session=ok");
            }
            let (status, text) = match r.send_bytes(&body) {
                Ok(x) => (x.status(), x.into_string().unwrap_or_default()),
                Err(ureq::Error::Status(s, x)) => (s, x.into_string().unwrap_or_default()),
                Err(e) => return Err(e.to_string()),
            };
            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
            let t = v.get("Track");
            Ok(Raw {
                stage: "upload".into(),
                status: Some(status),
                ok: t.is_some(),
                track_id: t.and_then(|t| t.get("TrackId")).and_then(|x| x.as_i64()),
                track_name: t.and_then(|t| t.get("TrackName")).and_then(|x| x.as_str()).map(String::from),
                detail: v.get("detail").and_then(|x| x.as_str()).map(String::from),
                ..Default::default()
            })
        }
    }

    fn replay_bytes(tag: &str, validable: bool) -> Vec<u8> {
        let mut b = b"GBX\x06\x00BUCR".to_vec();
        b.extend_from_slice(format!("<header type=\"replay\" exever=\"2.11.26\"><challenge uid=\"UID123\"/><times best=\"25120\" respawns=\"0\" stuntscore=\"0\" validable=\"{}\"/></header>", if validable { 1 } else { 0 }).as_bytes());
        b.extend_from_slice(tag.as_bytes());
        b
    }

    fn svc() -> (tempfile::TempDir, Service) {
        let t = tempfile::tempdir().unwrap();
        let s = Service::new(t.path());
        (t, s)
    }

    fn run_until_idle(s: &Service, up: &dyn Uploader) -> Vec<Tell> {
        let mut tells = vec![];
        for _ in 0..20 {
            let (did, tell) = step(s, up);
            tells.extend(tell);
            if !did {
                break;
            }
            s.inner.lock().unwrap().queue.last_upload_ms = 0; // tests skip the 2 s gap
        }
        tells
    }

    // ------------------------------------------------------------ tests

    #[test]
    fn sites_and_games() {
        assert_eq!(site_host("tmn"), Some("nations.tm-exchange.com"));
        assert_eq!(site_host("TMNF"), Some("tmnf.exchange"));
        assert_eq!(site_host("tms"), Some("sunrise.tm-exchange.com"));
        assert_eq!(site_host("evil.example"), None);
        assert_eq!(game_of_site("original.tm-exchange.com"), Some("tm-original"));
        assert_eq!(site_of_game("tm2020"), None, "only the classic exchanges");
        assert!(mod_game("tmuf") && !mod_game("tmn-eswc"));
    }

    #[test]
    fn replay_header_and_names() {
        let m = replay_meta(&replay_bytes("x", true));
        assert_eq!(m, ReplayMeta { uid: Some("UID123".into()), best_ms: Some(25120), validable: Some(true) });
        assert_eq!(replay_meta(&replay_bytes("x", false)).validable, Some(false));
        assert_eq!(replay_meta(b"not a replay"), ReplayMeta::default());
        assert_eq!(display_name("A01(00'25''12).Replay.Gbx"), "A01(00'25''12)");
        assert_eq!(display_name("x.replay.gbx"), "x");
    }

    #[test]
    fn classify_answers() {
        let raw = |stage: &str, status: u16| Raw { stage: stage.into(), status: Some(status), ..Default::default() };
        assert_eq!(classify("tmnf.exchange", &raw("token", 401)), Outcome::SignIn);
        assert_eq!(classify("tmnf.exchange", &Raw { no_token: true, ..raw("token", 200) }), Outcome::SignIn);
        assert!(matches!(classify("tmnf.exchange", &raw("token", 502)), Outcome::Retry(_)));
        let ok = Raw { ok: true, track_id: Some(7), track_name: Some("A01".into()), ..raw("upload", 200) };
        assert_eq!(classify("tmnf.exchange", &ok), Outcome::Done { link: Some("https://tmnf.exchange/trackshow/7".into()), track: Some("A01".into()) });
        assert_eq!(classify("tmnf.exchange", &Raw { detail: Some("not faster".into()), ..raw("upload", 400) }), Outcome::Refused("not faster".into()));
        assert!(matches!(classify("x", &raw("upload", 429)), Outcome::Retry(_)));
        assert!(matches!(classify("x", &raw("upload", 503)), Outcome::Retry(_)));
        assert_eq!(classify("x", &raw("upload", 401)), Outcome::SignIn);
        assert!(matches!(classify("x", &Raw { stage: "error".into(), detail: Some("Failed to fetch".into()), ..Default::default() }), Outcome::Retry(_)));
    }

    fn job(sha: &str) -> Job {
        let mut j = make_job("tmnf", "tmnf.exchange", "a.Replay.Gbx", "A".into(), None, "manual", sha.as_bytes().to_vec(), ModRef::None);
        j.sha = sha.into();
        j
    }

    #[test]
    fn queue_gap_backoff_and_dedupe() {
        let mut q = Queue::default();
        let a = q.push(job("a"), 1000).unwrap();
        assert!(q.push(job("a"), 1000).is_none(), "same replay twice");
        let b = q.push(job("b"), 1000).unwrap();
        assert_eq!(q.next_due(1000), None, "2 s after the start (last upload at 0)");
        assert_eq!(q.next_due(3000), Some(0));
        q.jobs[0].state = "uploading".into();
        assert_eq!(q.next_due(3000), None, "one at a time");
        // Transient failures back off 10 s, 30 s, ...
        assert!(q.apply(a, Outcome::Retry("503".into()), 5000).is_none());
        assert_eq!(q.jobs[0].due_ms, 15_000);
        assert_eq!(q.next_due(6000), None, "2 s gap after any upload");
        assert_eq!(q.next_due(7000).map(|i| q.jobs[i].id), Some(b));
        for (n, s) in BACKOFF_S.iter().enumerate().skip(1) {
            assert!(q.apply(a, Outcome::Retry("503".into()), 100_000).is_none());
            assert_eq!(q.jobs[0].attempts as usize, n + 1);
            assert_eq!(q.jobs[0].due_ms, 100_000 + s * 1000);
        }
        let h = q.apply(a, Outcome::Retry("503".into()), 200_000).unwrap();
        assert_eq!(h.result, "failed");
        assert!(h.detail.starts_with("Gave up after 6 tries"));
        // Sign-in: waits without using up tries, wakes when signed in.
        assert!(q.apply(b, Outcome::SignIn, 300_000).is_none());
        assert_eq!(q.jobs[0].state, "signin");
        assert_eq!(q.jobs[0].attempts, 0);
        q.wake_signin(301_000);
        assert_eq!(q.next_due(303_000), Some(0));
        let h = q.apply(b, Outcome::Refused("slower".into()), 304_000).unwrap();
        assert_eq!((h.result.as_str(), h.detail.as_str()), ("refused", "slower"));
        assert!(q.jobs.is_empty());
    }

    #[test]
    fn upload_flow_against_fake_exchange() {
        let ex = fake_exchange(1);
        let up = HttpUploader { port: ex.port, signed_in: AtomicBool::new(false) };
        let (_t, s) = svc();
        set_enabled(&s, "tmnf", true, true).unwrap();
        {
            let mut i = s.inner.lock().unwrap();
            admit(&mut i, make_job("tmnf", "tmnf.exchange", "A01.Replay.Gbx", "A01".into(), None, "manual", replay_bytes("FAST", true), ModRef::None), true, 0).unwrap();
        }
        // Signed out: the job waits for a sign-in, the site is listed.
        run_until_idle(&s, &up);
        assert_eq!(s.status().signin, vec!["tmnf.exchange"]);
        assert_eq!(s.status().queue[0].state, "signin");
        assert_eq!(up.check("tmnf.exchange").map(|r| classify("tmnf.exchange", &r)).unwrap(), Outcome::SignIn);
        // Signed in: first try 503 (retry with backoff), then uploaded.
        up.signed_in.store(true, Ordering::SeqCst);
        s.inner.lock().unwrap().queue.wake_signin(0);
        run_until_idle(&s, &up);
        let st = s.status();
        assert_eq!(st.queue[0].state, "retry");
        assert!(st.signin.is_empty());
        s.inner.lock().unwrap().queue.jobs[0].due_ms = 0;
        run_until_idle(&s, &up);
        let st = s.status();
        assert!(st.queue.is_empty());
        assert_eq!(st.history[0].result, "ok");
        assert_eq!(st.history[0].link.as_deref(), Some("https://tmnf.exchange/trackshow/4242"));
        assert_eq!(st.history[0].time_ms, Some(25120));
        // TMX's "not faster than your record" is final.
        {
            let mut i = s.inner.lock().unwrap();
            admit(&mut i, make_job("tmnf", "tmnf.exchange", "A01.Replay.Gbx", "A01".into(), None, "manual", replay_bytes("SLOWRUN", true), ModRef::None), true, 0).unwrap();
        }
        run_until_idle(&s, &up);
        let st = s.status();
        assert_eq!(st.history[0].result, "refused");
        assert!(st.history[0].detail.contains("not faster"));
        assert_eq!(ex.uploads.load(Ordering::SeqCst), 3);
        // The config was saved with the history and the handled replays.
        let c = load_config(&s.cfg_path);
        assert_eq!(c.history.len(), 2);
        assert_eq!(c.done.len(), 3, "two file hashes and the run (map + time) both replays share");
    }

    #[test]
    fn not_validable_and_duplicates_are_skipped() {
        let (_t, s) = svc();
        let mut i = s.inner.lock().unwrap();
        let j = make_job("tmn-eswc", "nations.tm-exchange.com", "lan.Replay.Gbx", "lan".into(), None, "folder", replay_bytes("x", false), ModRef::None);
        assert_eq!(admit(&mut i, j.clone(), false, 0), Ok(None));
        assert_eq!(i.cfg.history[0].result, "skipped");
        assert!(admit(&mut i, j, true, 0).is_err(), "manual: told why");
        let ok = make_job("tmn-eswc", "nations.tm-exchange.com", "a.Replay.Gbx", "a".into(), None, "folder", replay_bytes("y", true), ModRef::None);
        i.cfg.mark_done(&ok.sha);
        assert_eq!(admit(&mut i, ok.clone(), false, 0), Ok(None), "already handled");
        assert!(admit(&mut i, ok, true, 0).unwrap().is_some(), "manual upload may repeat");
    }

    #[test]
    fn first_enable_needs_confirm() {
        let (_t, s) = svc();
        assert_eq!(set_enabled(&s, "tmnf", true, false), Err("confirm".into()));
        assert!(!s.status().games[0].enabled);
        set_enabled(&s, "tmnf", true, true).unwrap();
        set_enabled(&s, "tmuf", true, false).unwrap();
        assert!(s.status().confirmed && s.status().games[1].enabled);
        assert!(set_enabled(&s, "tm2020", true, true).is_err());
        assert!(load_config(&s.cfg_path).enabled("tmuf"));
    }

    // ------------------------------------------------------------ the fake mod bridge

    struct FakeMod {
        port: u16,
        results: Arc<Mutex<Vec<serde_json::Value>>>,
        queue: Arc<Mutex<Vec<serde_json::Value>>>,
    }

    fn fake_mod(allowed: Arc<AtomicBool>) -> FakeMod {
        let results = Arc::new(Mutex::new(vec![]));
        let queue = Arc::new(Mutex::new(vec![]));
        let (r2, q2) = (results.clone(), queue.clone());
        let port = serve(Arc::new(move |m: &str, t: &str, head: &str, body: &[u8]| {
            let key_ok = head.to_ascii_lowercase().contains("x-tmx-key: k1");
            let path = t.split('?').next().unwrap();
            match (m, path) {
                ("GET", "/v1/ping") => (200, br#"{"ok":true,"mod":"1.1.1"}"#.to_vec()),
                ("POST", "/v1/pair") => {
                    if allowed.load(Ordering::SeqCst) {
                        (200, br#"{"ok":true,"key":"k1"}"#.to_vec())
                    } else {
                        (200, br#"{"ok":false,"status":"pending"}"#.to_vec())
                    }
                }
                _ if !key_ok => (401, br#"{"ok":false}"#.to_vec()),
                ("GET", "/v1/next") => {
                    let q = q2.lock().unwrap();
                    (200, serde_json::json!({ "ok": true, "upload": q.first().cloned() }).to_string().into_bytes())
                }
                ("GET", "/v1/file") => (200, replay_bytes("FROMMOD", true)),
                ("POST", "/v1/result") => {
                    let v: serde_json::Value = serde_json::from_slice(body).unwrap();
                    q2.lock().unwrap().retain(|j: &serde_json::Value| j["id"] != v["id"]);
                    r2.lock().unwrap().push(v);
                    (200, br#"{"ok":true}"#.to_vec())
                }
                _ => (404, b"{}".to_vec()),
            }
        }));
        FakeMod { port, results, queue }
    }

    #[test]
    fn mod_bridge_pairing_jobs_and_results() {
        let allowed = Arc::new(AtomicBool::new(false));
        let fm = fake_mod(allowed.clone());
        let c = ModClient::new(vec![1, fm.port]);
        let (port, ver) = c.find().unwrap();
        assert_eq!((port, ver.as_deref()), (fm.port, Some("1.1.1")));
        assert_eq!(c.pair(port), Ok(None), "waits for Allow in the game");
        allowed.store(true, Ordering::SeqCst);
        let key = c.pair(port).unwrap().unwrap();
        assert_eq!(c.next(port, "wrong", 0), Ok(Next::Unauthorized));
        assert_eq!(c.next(port, &key, 0), Ok(Next::Empty));
        // The mod offers its queue's front until /v1/result: the two skips go first, then the upload.
        fm.queue.lock().unwrap().push(serde_json::json!({ "id": "2-56", "site": "tmuf", "trackId": 56, "mapName": "B", "fileName": "B.Replay.Gbx", "timeMs": 1, "verified": true }));
        fm.queue.lock().unwrap().push(serde_json::json!({ "id": "3-57", "site": "tmnf", "trackId": 57, "mapName": "C", "fileName": "C.Replay.Gbx", "timeMs": 1, "verified": false }));
        fm.queue.lock().unwrap().push(serde_json::json!({ "id": "1-55", "site": "tmnf", "trackId": 55, "mapName": "A01-Race", "fileName": "A01.Replay.Gbx", "timeMs": 25120, "verified": true }));

        let (_t, s) = svc();
        set_enabled(&s, "tmnf", true, true).unwrap();
        s.inner.lock().unwrap().cfg.mod_key = key.clone();
        let ex = fake_exchange(0);
        let up = HttpUploader { port: ex.port, signed_in: AtomicBool::new(true) };
        // Pull everything the mod offers, like mod_loop does.
        for _ in 0..3 {
            let Next::Job(j) = c.next(port, &key, 0).unwrap() else { panic!("job expected") };
            let bytes = c.file(port, &key, &j.id);
            if let Some((p, id, ok, d)) = take_mod_job(&s, port, j, bytes) {
                c.result(p, &key, &id, ok, &d).unwrap();
            }
        }
        // The same job offered again (still in the mod's queue) is not taken twice.
        let Next::Job(again) = c.next(port, &key, 0).unwrap() else { panic!() };
        assert_eq!(again.id, "1-55");
        assert!(take_mod_job(&s, port, again, Ok(vec![])).is_none());
        assert_eq!(s.status().queue.len(), 1);
        for (p, id, ok, d) in run_until_idle(&s, &up) {
            c.result(p, &key, &id, ok, &d).unwrap();
        }
        let res = fm.results.lock().unwrap().clone();
        let by = |id: &str| res.iter().find(|r| r["id"] == id).cloned().unwrap();
        assert_eq!(by("1-55")["ok"], true);
        assert_eq!(by("2-56")["ok"], false, "TMUF auto-upload is off");
        assert!(by("2-56")["detail"].as_str().unwrap().contains("off in TM Horizon"));
        assert!(by("3-57")["detail"].as_str().unwrap().contains("could not be matched"));
        assert!(fm.queue.lock().unwrap().is_empty(), "every job got its result");
        let h = s.status().history;
        assert_eq!(h.iter().filter(|h| h.result == "ok").count(), 1);
        assert_eq!(h.iter().find(|h| h.result == "ok").unwrap().map, "A01-Race");
    }

    #[test]
    fn handover_endpoint() {
        let last = HistoryEntry { at: 5, game: "tmnf".into(), site: "tmnf.exchange".into(), map: "A01".into(), time_ms: Some(1), source: "mod".into(), result: "ok".into(), detail: "Uploaded".into(), link: Some("https://tmnf.exchange/trackshow/1".into()) };
        let body = handover_json("0.3.0", true, &["tmnf.exchange".into()], Some(&last));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["app"], "tm-horizon");
        assert_eq!(v["uploading"], true);
        assert_eq!(v["last"]["ok"], true);
        assert_eq!(v["last"]["link"], "https://tmnf.exchange/trackshow/1");
        // Rebound host names are refused; only GET /v1/uploader exists.
        let f = || "{}".to_string();
        assert!(handover_answer("GET /v1/uploader HTTP/1.1\r\nHost: evil.example:27321\r\n\r\n", &f).starts_with("HTTP/1.1 403"));
        assert!(handover_answer("GET /v1/other HTTP/1.1\r\nHost: 127.0.0.1:27321\r\n\r\n", &f).starts_with("HTTP/1.1 404"));
        assert!(handover_answer("GET /v1/uploader HTTP/1.1\r\nhost: localhost:27321\r\n\r\n", &f).starts_with("HTTP/1.1 200"));
        // A real listener on a free port; dropping it stops answering.
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let free = probe.local_addr().unwrap().port();
        drop(probe);
        let h = Handover::start(&[free], Arc::new(move || body.clone())).unwrap();
        let r: serde_json::Value = ureq::get(&format!("http://127.0.0.1:{}/v1/uploader", h.port)).call().unwrap().into_json().unwrap();
        assert_eq!(r["sites"][0], "tmnf.exchange");
        drop(h);
        std::thread::sleep(Duration::from_millis(400));
        assert!(ureq::get(&format!("http://127.0.0.1:{free}/v1/uploader")).timeout(Duration::from_millis(500)).call().is_err());
    }

    #[test]
    fn folder_scan_and_host_log() {
        let t = tempfile::tempdir().unwrap();
        let dirs = watch_dirs(t.path());
        std::fs::create_dir_all(&dirs[0]).unwrap();
        let old = dirs[1].join("old.Replay.Gbx");
        std::fs::write(&old, "x").unwrap();
        let since = now_ms() + 1;
        std::thread::sleep(Duration::from_millis(30));
        let new = dirs[0].join("A01(00'25''12).Replay.Gbx");
        std::fs::write(&new, "x").unwrap();
        std::fs::write(dirs[0].join("note.txt"), "x").unwrap();
        let mut seen = HashSet::new();
        assert!(scan_new(&dirs, since, now_ms(), &mut seen).is_empty(), "still being written (< 2 s)");
        let later = now_ms() + 3000;
        assert_eq!(scan_new(&dirs, since, later, &mut seen), vec![new.clone()]);
        assert!(scan_new(&dirs, since, later, &mut seen).is_empty(), "only once");
        let log = "12:00:01.123 [info] host: event: map loaded\n12:00:31.500 [info] host: event: replay saved by eswc-autosave: C:\\Games\\TMNESWC\\GameData\\Tracks\\Replays\\A01 TMX.Replay.Gbx\r\nevent: replay saved by game: D:\\r.Replay.Gbx\n";
        assert_eq!(parse_host_events(log), vec![("eswc-autosave".to_string(), "C:\\Games\\TMNESWC\\GameData\\Tracks\\Replays\\A01 TMX.Replay.Gbx".to_string()), ("game".to_string(), "D:\\r.Replay.Gbx".to_string())]);
    }

    #[test]
    fn script_reports_only_codes() {
        let s = upload_script("n1", "A\"01.Replay.Gbx", Some("AAAA"));
        assert!(s.contains("tmhub-upload:") && s.contains("/api/replays/upload") && s.contains("__RequestVerificationToken"));
        assert!(s.contains(r#"NAME = "A\"01.Replay.Gbx""#), "file name is JSON-escaped");
        assert!(!s.contains("document.cookie"));
        assert!(upload_script("n1", "", None).contains("B64 = null"));
        let raw = |status: u16, no_token: bool| Raw { stage: "token".into(), status: Some(status), no_token, ..Default::default() };
        assert_eq!(check_verdict(&raw(401, false)), "signin", "TMX: 401 with a token on the page");
        assert_eq!(check_verdict(&raw(200, true)), "signin");
        assert_eq!(check_verdict(&raw(200, false)), "ok");
        assert_eq!(check_verdict(&raw(502, false)), "TMX answered 502");
    }
    // ------------------------------------------------------------ Forever replay folder + saved queue

    use crate::gbx::tests::replay_sample_run;

    /// Documents folder with the Forever replay folders; TMNF switched on since 0.
    fn forever_docs(svc: &Service, tmuf: bool) -> (tempfile::TempDir, Vec<PathBuf>) {
        let d = tempfile::tempdir().unwrap();
        let dirs = crate::tmxfolder::forever_dirs(d.path());
        std::fs::create_dir_all(&dirs[0]).unwrap();
        std::fs::create_dir_all(dirs[1].join("Downloaded")).unwrap();
        set_enabled(svc, "tmnf", true, true).unwrap();
        if tmuf {
            set_enabled(svc, "tmuf", true, true).unwrap();
        }
        let mut i = svc.inner.lock().unwrap();
        for g in i.cfg.games.values_mut() {
            g.since = 0;
        }
        drop(i);
        (d, dirs)
    }

    #[test]
    fn forever_folder_only_takes_own_replays() {
        let (_t, s) = svc();
        let (docs, dirs) = forever_docs(&s, false);
        let run = |login: &str, uid: &str, time: u32| replay_sample_run(login, login, "Stadium", uid, time);
        std::fs::write(dirs[0].join("Kunde_A01.Replay.gbx"), run("me", "UIDA", 25000)).unwrap();
        std::fs::write(dirs[1].join("A01(00'25''00).Replay.Gbx"), run("me", "UIDA", 24000)).unwrap();
        std::fs::write(dirs[1].join("B02(00'30''00)_other.Replay.Gbx"), run("them", "UIDB", 30000)).unwrap();
        std::fs::write(dirs[1].join("Downloaded").join("C03.Replay.Gbx"), run("me", "UIDC", 1000)).unwrap();
        let now = now_ms() + 10_000;
        // Order inside the folder is not guaranteed: the autosave teaches the login first on the
        // first pass, the root files need it. A second pass picks up what was skipped for lack of it.
        let n = s.scan_forever(docs.path(), now);
        assert!(n >= 1);
        let i = s.inner.lock().unwrap();
        assert_eq!(i.cfg.logins, vec!["me".to_string()]);
        let maps: Vec<_> = i.queue.jobs.iter().map(|j| j.map.as_str()).collect();
        assert!(maps.iter().all(|m| !m.starts_with("C03") && !m.starts_with("B02")), "{maps:?}");
        assert!(i.queue.jobs.iter().all(|j| j.game == "tmnf" && j.source == "folder" && j.site == "tmnf.exchange"));
        assert!(i.cfg.history.iter().any(|h| h.result == "skipped" && h.detail.contains("Not your replay") && h.map.starts_with("B02")));
        assert!(i.queue.jobs.iter().any(|j| j.map.starts_with("A01(00'25''00)") || j.file_name.starts_with("Kunde_A01")));
        drop(i);
        // Nothing twice.
        assert_eq!(s.scan_forever(docs.path(), now), 0);
    }

    #[test]
    fn forever_folder_game_follows_the_switches() {
        let (_t, s) = svc();
        let (docs, dirs) = forever_docs(&s, true);
        std::fs::write(dirs[0].join("Kunde_Snow.Replay.gbx"), replay_sample_run("me", "me", "Snow", "UIDS", 40000)).unwrap();
        std::fs::write(dirs[0].join("Kunde_Stad.Replay.gbx"), replay_sample_run("me", "me", "Stadium", "UIDT", 41000)).unwrap();
        assert_eq!(s.scan_forever(docs.path(), now_ms() + 10_000), 2);
        let i = s.inner.lock().unwrap();
        let by = |m: &str| i.queue.jobs.iter().find(|j| j.file_name.contains(m)).unwrap().game.clone();
        assert_eq!((by("Snow"), by("Stad")), ("tmuf".to_string(), "tmnf".to_string()));
    }

    #[test]
    fn folder_and_mod_copy_of_one_run_upload_once() {
        let (_t, s) = svc();
        let (docs, dirs) = forever_docs(&s, false);
        let bytes = replay_sample_run("me", "me", "Stadium", "UIDX", 22222);
        std::fs::write(dirs[0].join("Kunde_X.Replay.gbx"), &bytes).unwrap();
        assert_eq!(s.scan_forever(docs.path(), now_ms() + 10_000), 1);
        // The mod offers the same file ...
        let job = ModJob { id: "m1".into(), site: "tmnf".into(), map_name: "X".into(), file_name: "X.Replay.Gbx".into(), time_ms: 22222, verified: true, ..Default::default() };
        let tell = take_mod_job(&s, 27311, job.clone(), Ok(bytes.clone())).unwrap();
        assert!(!tell.2 && tell.3.contains("already"));
        // ... or the same run as another byte stream (the mod re-writes the file).
        let mut other = bytes.clone();
        other.extend_from_slice(b"tail");
        let job2 = ModJob { id: "m2".into(), ..job.clone() };
        assert!(take_mod_job(&s, 27311, job2, Ok(other)).is_some());
        assert_eq!(s.inner.lock().unwrap().queue.jobs.len(), 1);
        // Once uploaded, the run is handled for good, in either order.
        let up = HttpUploader { port: fake_exchange(0).port, signed_in: AtomicBool::new(true) };
        run_until_idle(&s, &up);
        let mut i = s.inner.lock().unwrap();
        assert!(i.queue.jobs.is_empty());
        let again = make_job("tmnf", "tmnf.exchange", "Z.Replay.Gbx", "Z".into(), None, "mod", bytes, ModRef::None);
        assert_eq!(admit(&mut i, again, false, 0), Ok(None));
    }

    #[test]
    fn pending_uploads_survive_a_restart() {
        let cfg = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let bytes = replay_sample_run("me", "me", "Stadium", "UIDQ", 33333);
        {
            let s = Service::with_dirs(cfg.path(), data.path());
            set_enabled(&s, "tmnf", true, true).unwrap();
            // A replay the mod handed over (only in memory), one from a file.
            let job = ModJob { id: "m9".into(), site: "tmnf".into(), map_name: "Q".into(), file_name: "Q.Replay.Gbx".into(), time_ms: 33333, verified: true, ..Default::default() };
            assert!(take_mod_job(&s, 27311, job, Ok(bytes.clone())).is_none());
            let mut i = s.inner.lock().unwrap();
            i.queue.jobs[0].state = "retry".into();
            i.queue.jobs[0].attempts = 1;
            s.save(&i);
        }
        // New process: same folders.
        let s = Service::with_dirs(cfg.path(), data.path());
        let i = s.inner.lock().unwrap();
        assert_eq!(i.queue.jobs.len(), 1);
        let j = &i.queue.jobs[0];
        assert_eq!((j.map.as_str(), j.state.as_str(), j.attempts, j.source.as_str()), ("Q", "retry", 1, "mod"));
        assert_eq!(&**j.bytes, &bytes[..]);
        assert!(i.pulled.contains("m9"), "the mod's re-offer is not taken a second time");
        assert!(i.cfg.enabled("tmnf"));
        drop(i);
        // It goes up after the restart, with no mod around.
        let up = HttpUploader { port: fake_exchange(0).port, signed_in: AtomicBool::new(true) };
        s.inner.lock().unwrap().queue.jobs[0].due_ms = 0;
        let tells = run_until_idle(&s, &up);
        assert_eq!(tells.len(), 1, "the mod hears the result once it is back");
        assert!(s.inner.lock().unwrap().queue.jobs.is_empty());
        // Finished jobs leave the saved queue and the cache.
        let s2 = Service::with_dirs(cfg.path(), data.path());
        assert!(s2.inner.lock().unwrap().queue.jobs.is_empty());
        assert_eq!(std::fs::read_dir(data.path().join("cache")).unwrap().count(), 0);
    }
}
