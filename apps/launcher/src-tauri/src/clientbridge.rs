//! Client bridge: a small local endpoint for the Horizon Host inside the old TrackMania games.
//!
//! The game process never goes online itself. Its plugins (TMX Browser, WR Hunter) ask TM Horizon on
//! the same PC, and TM Horizon asks TMX with its own HTTP client (`net.rs`, user agent `TM-Horizon/<ver> (+https://tm-horizon.com)`).
//! The same connection carries notifications to the game (upload finished, mod updates, server events),
//! which the host shows as toasts. Protocol: horizon-host `docs/client-bridge.md`.
//!
//! - HTTP/1.1 on 127.0.0.1, first free port of 27331-27335, `Connection: close`, no CORS headers.
//! - `Host` must be 127.0.0.1/localhost (DNS rebinding); every path but ping/pair needs `X-Horizon-Key`.
//! - Pairing like the 100% TMX mod bridge, roles swapped: the game asks, the player presses Allow here.
//! - Limits: per key a token bucket (8/s, burst 24) -> 429; TMX calls serialised, at least one second
//!   apart, searches cached for two minutes, thumbnails and record lookups cached.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const PORTS: [u16; 5] = [27331, 27332, 27333, 27334, 27335];
pub const API: u32 = 1;
const PAIR_STANDS_MS: u64 = 180_000;
const DENIED_MS: u64 = 60_000;
const EVENTS_KEEP_MS: u64 = 600_000;
const EVENTS_MAX: usize = 50;
const MAX_BODY: usize = 64 * 1024;
const MAX_MAP: u64 = 8 << 20;
const MAX_THUMB: u64 = 2 << 20;
const PAGE: usize = 20;
const TMX_GAP: Duration = Duration::from_millis(1000);

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Exchange host of a site code.
pub fn site_host(code: &str) -> Option<&'static str> {
    Some(match code {
        "tmn" => "nations.tm-exchange.com",
        "tms" => "sunrise.tm-exchange.com",
        "tmo" => "original.tm-exchange.com",
        "tmnf" => "tmnf.exchange",
        "tmuf" => "tmuf.exchange",
        _ => return None,
    })
}

pub const TAGS: [&str; 19] = [
    "Race", "Stunt", "Maze", "Offroad", "Multilap", "FullSpeed", "LOL", "Tech", "SpeedTech", "RPG", "PressForward", "Trial", "Grass", "Story", "Nascar",
    "Speedfun", "Endurance", "Altered Nadeo", "Transitional",
];
const DIFFICULTY: [&str; 4] = ["Beginner", "Intermediate", "Expert", "Lunatic"];
const ENVIRONMENTS: [&str; 8] = ["", "Snow", "Desert", "Rally", "Island", "Coast", "Bay", "Stadium"];

// ------------------------------------------------------------------ requests and answers

#[derive(Debug, Default, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub host: String,
    pub key: String,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
}

impl Answer {
    pub fn json(status: u16, v: Value) -> Answer {
        Answer { status, content_type: "application/json".into(), body: v.to_string().into_bytes(), headers: vec![] }
    }
    fn err(status: u16, msg: &str) -> Answer {
        Answer::json(status, json!({ "ok": false, "error": msg }))
    }
    fn bytes(content_type: &str, body: Vec<u8>) -> Answer {
        Answer { status: 200, content_type: content_type.into(), body, headers: vec![] }
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Parses the head and body of one request. None when it is not complete or too large.
pub fn parse_request(raw: &[u8]) -> Option<Request> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..end]);
    let mut lines = head.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut r = Request { method, ..Default::default() };
    let (path, q) = target.split_once('?').unwrap_or((&target, ""));
    r.path = path.to_string();
    for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
        r.query.insert(k.into_owned(), v.into_owned());
    }
    let mut length = 0usize;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        match k.as_str() {
            "host" => r.host = v.to_ascii_lowercase(),
            "x-horizon-key" => r.key = v.to_string(),
            "content-length" => length = v.parse().ok()?,
            _ => {}
        }
    }
    if length > MAX_BODY || raw.len() < end + 4 + length {
        return None;
    }
    r.body = raw[end + 4..end + 4 + length].to_vec();
    Some(r)
}

pub fn http_bytes(a: &Answer) -> Vec<u8> {
    let reason = match a.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let mut head = format!("HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n", a.status, a.content_type, a.body.len());
    for (k, v) in &a.headers {
        head += &format!("{k}: {v}\r\n");
    }
    head += "\r\n";
    let mut out = head.into_bytes();
    out.extend_from_slice(&a.body);
    out
}

// ------------------------------------------------------------------ TMX access (mocked in tests)

pub trait Tmx: Send + Sync {
    fn get_json(&self, url: &str) -> Result<Value, String>;
    fn get_bytes(&self, url: &str, max: u64) -> Result<Vec<u8>, String>;
}

/// The launcher's own HTTP client (net.rs, its user agent), one request at a time, a second apart.
pub struct NetTmx {
    last: Mutex<Option<Instant>>,
}

impl Default for NetTmx {
    fn default() -> Self {
        NetTmx { last: Mutex::new(None) }
    }
}

impl NetTmx {
    fn wait(&self) -> std::sync::MutexGuard<'_, Option<Instant>> {
        let mut g = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = *g {
            let since = t.elapsed();
            if since < TMX_GAP {
                std::thread::sleep(TMX_GAP - since);
            }
        }
        *g = Some(Instant::now());
        g
    }
}

impl Tmx for NetTmx {
    fn get_json(&self, url: &str) -> Result<Value, String> {
        let _g = self.wait();
        crate::net::get_json(url)
    }
    fn get_bytes(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
        let _g = self.wait();
        crate::net::get_bytes(url, max)
    }
}

/// The one TMX gate of the launcher: the bridge (in-game TMX browser) and Statistics' map lookups
/// share it, so TMX never gets more than one request per second from this PC.
pub fn shared_tmx() -> &'static NetTmx {
    static T: std::sync::OnceLock<NetTmx> = std::sync::OnceLock::new();
    T.get_or_init(NetTmx::default)
}

/// `Tmx` over the shared gate.
pub struct SharedTmx;

impl Tmx for SharedTmx {
    fn get_json(&self, url: &str) -> Result<Value, String> {
        shared_tmx().get_json(url)
    }
    fn get_bytes(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
        shared_tmx().get_bytes(url, max)
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Filters {
    pub name: String,
    pub author: String,
    pub tags: Vec<u32>,
    pub difficulty: Option<u32>,
    pub length_min: Option<u32>,
    pub length_max: Option<u32>,
    pub awards: u32,
}

impl Filters {
    pub fn from_query(q: &HashMap<String, String>) -> Filters {
        let num = |k: &str| q.get(k).and_then(|v| v.trim().parse::<u32>().ok());
        Filters {
            name: q.get("name").map(|s| s.trim().chars().take(80).collect()).unwrap_or_default(),
            author: q.get("author").map(|s| s.trim().chars().take(40).collect()).unwrap_or_default(),
            tags: q.get("tags").map(|s| s.split(',').filter_map(|t| t.trim().parse().ok()).filter(|t: &u32| (*t as usize) < TAGS.len()).take(8).collect()).unwrap_or_default(),
            difficulty: num("difficulty").filter(|d| *d < 4),
            length_min: num("lengthmin"),
            length_max: num("lengthmax"),
            awards: num("awards").unwrap_or(0),
        }
    }
}

const FIELDS: &str = "TrackId,TrackName,Uploader.Name,Authors,Awards,Tags,Difficulty,AuthorTime,Environment,HasThumbnail,UId,UploadedAt";

/// TMX API v2 search URL (track sites). `after`: the last track id of the page before.
pub fn search_url(host: &str, f: &Filters, count: usize, after: Option<i64>) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("fields", FIELDS);
    q.append_pair("count", &count.to_string());
    q.append_pair("inunlimiter", "0");
    if !f.name.is_empty() {
        q.append_pair("name", &f.name);
    }
    if !f.author.is_empty() {
        q.append_pair("author", &f.author);
    }
    if !f.tags.is_empty() {
        q.append_pair("tag", &f.tags.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(","));
    }
    if let Some(d) = f.difficulty {
        q.append_pair("difficulty", &d.to_string());
    }
    if let Some(m) = f.length_min {
        q.append_pair("authortimemin", &m.to_string());
    }
    if let Some(m) = f.length_max {
        q.append_pair("authortimemax", &m.to_string());
    }
    if let Some(a) = after {
        q.append_pair("after", &a.to_string());
    }
    format!("https://{host}/api/tracks?{}", q.finish())
}

/// One TMX track as the bridge hands it out.
pub fn track_of(v: &Value) -> Option<Value> {
    let id = v.get("TrackId")?.as_i64()?;
    let name = v.get("TrackName").and_then(|n| n.as_str()).unwrap_or("");
    let author = v
        .get("Authors")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|a| a.pointer("/User/Name"))
        .and_then(|n| n.as_str())
        .or_else(|| v.pointer("/Uploader/Name").and_then(|n| n.as_str()))
        .unwrap_or("");
    let tags: Vec<&str> = v.get("Tags").and_then(|t| t.as_array()).map(|t| t.iter().filter_map(|x| x.as_u64()).filter_map(|i| TAGS.get(i as usize).copied()).collect()).unwrap_or_default();
    let difficulty = v.get("Difficulty").and_then(|d| d.as_u64()).and_then(|d| DIFFICULTY.get(d as usize).copied()).unwrap_or("");
    let env = v.get("Environment").and_then(|e| e.as_u64()).and_then(|e| ENVIRONMENTS.get(e as usize).copied()).unwrap_or("");
    let uploaded = v.get("UploadedAt").and_then(|u| u.as_str()).map(|u| if u.ends_with('Z') || u.contains('+') { u.to_string() } else { format!("{u}Z") });
    Some(json!({
        "id": id,
        "name": strip_codes(name),
        "author": author,
        "awards": v.get("Awards").and_then(|a| a.as_i64()).unwrap_or(0),
        "tags": tags,
        "difficulty": difficulty,
        "authorTime": v.get("AuthorTime").and_then(|a| a.as_i64()).unwrap_or(-1),
        "environment": env,
        "uploaded": uploaded,
        "thumbnail": v.get("HasThumbnail").and_then(|h| h.as_bool()).unwrap_or(true),
        "uid": v.get("UId").and_then(|u| u.as_str()).unwrap_or(""),
    }))
}

/// Nadeo formatting codes removed ("$o$fffName" -> "Name").
/// The path rules of the host (bridge::mapRelPath in Horizon Host): relative, no "..", no drive or
/// device names, a .Challenge.Gbx file.
pub fn play_map_path_ok(rel: &str) -> bool {
    let p = rel.replace('\\', "/");
    if p.is_empty() || p.len() > 400 || p.starts_with('/') || p.contains(':') || !p.to_ascii_lowercase().ends_with(".challenge.gbx") {
        return false;
    }
    let dev = |s: &str| {
        let b = s.split('.').next().unwrap_or("").to_ascii_uppercase();
        ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&b.as_str()) || ((b.starts_with("COM") || b.starts_with("LPT")) && b.len() == 4 && b.as_bytes()[3].is_ascii_digit())
    };
    let name_len = p.rsplit('/').next().map(|f| f.len()).unwrap_or(0);
    name_len > ".challenge.gbx".len()
        && p.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.ends_with('.') && !seg.ends_with(' ') && !dev(seg) && !seg.chars().any(|c| c.is_control() || "*?\"<>|".contains(c)))
}

pub fn strip_codes(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut o = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] != '$' {
            o.push(c[i]);
            i += 1;
            continue;
        }
        match c.get(i + 1) {
            None => break,
            Some('$') => {
                o.push('$');
                i += 2;
            }
            Some(x) if x.is_ascii_hexdigit() => i += 4.min(c.len() - i),
            Some(_) => i += 2,
        }
    }
    o
}

// ------------------------------------------------------------------ state

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub key: String,
    pub game: String,
    pub game_name: String,
    pub instance: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub instance: String,
    pub game: String,
    pub game_name: String,
    pub client: String,
    pub version: String,
    pub first: u64,
    pub last: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Event {
    pub id: u64,
    pub kind: String,
    pub level: String,
    pub title: String,
    pub text: String,
    pub at: u64,
    /// play_map: the bridge site code of the game that should open the map ("tmn", "tms").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game: Option<String>,
    /// play_map: the map file, relative to that game's Tracks folder (forward slashes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// A paired game that is polling right now, with what it can do.
#[derive(Debug, Clone, PartialEq)]
pub struct Live {
    pub game: String,
    pub seen: u64,
    /// Sent `caps=play_map` (Horizon Host 0.2 with the play_map event: ESWC and Sunrise).
    pub play_map: bool,
}

/// A game counts as connected while its long poll (20 s) came back within this time.
pub const LIVE_MS: u64 = 45_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub port: Option<u16>,
    pub asks: Vec<Ask>,
    pub paired: Vec<Paired>,
}

#[derive(Default)]
struct Bucket {
    tokens: f64,
    at: u64,
}

#[derive(Default)]
pub struct Inner {
    pub paired: Vec<Paired>,
    pub asks: Vec<Ask>,
    granted: HashMap<String, String>, // instance -> key, picked up by the next /pair
    denied: HashMap<String, u64>,     // instance -> until (ms)
    events: VecDeque<Event>,
    next_event: u64,
    buckets: HashMap<String, Bucket>,
    search_cache: HashMap<String, (u64, Value)>,
    cursors: HashMap<String, i64>, // "<query>|<page>" -> after id
    thumbs: VecDeque<(String, Vec<u8>, String)>,
    records: HashMap<String, (u64, Value)>,
    live: HashMap<String, Live>, // key -> the game polling with it
    pub port: Option<u16>,
}

pub struct Bridge {
    pub inner: Mutex<Inner>,
    pub changed: Condvar,
    path: Option<PathBuf>,
    pub tmx: Box<dyn Tmx>,
    pub version: String,
    /// Called when asks or pairings change (the UI listens).
    pub on_change: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    paired: Vec<Paired>,
}

/// System random bytes (BCryptGenRandom on Windows, /dev/urandom elsewhere). False if none.
fn os_random(buf: &mut [u8]) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
        // SAFETY: the buffer is valid for its length; no algorithm handle with the system-preferred flag.
        unsafe { BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 }
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)).is_ok()
    }
}

/// A pairing key: n hex digits from the system's random source (hashed with time and process id as a
/// fallback that should never be needed).
fn random_hex(n: usize) -> String {
    use sha2::{Digest, Sha256};
    let mut out = String::new();
    while out.len() < n {
        let mut seed = [0u8; 32];
        let strong = os_random(&mut seed);
        let mut h = Sha256::new();
        h.update(seed);
        if !strong {
            h.update(now_ms().to_le_bytes());
            h.update(std::process::id().to_le_bytes());
            h.update(format!("{:?}", Instant::now()).as_bytes());
        }
        out += &hex::encode(h.finalize());
    }
    out.truncate(n);
    out
}

impl Bridge {
    pub fn new(path: Option<PathBuf>, tmx: Box<dyn Tmx>, version: &str) -> Bridge {
        let mut inner = Inner::default();
        if let Some(p) = &path {
            if let Ok(t) = std::fs::read_to_string(p) {
                if let Ok(s) = serde_json::from_str::<Saved>(&t) {
                    inner.paired = s.paired;
                }
            }
        }
        Bridge { inner: Mutex::new(inner), changed: Condvar::new(), path, tmx, version: version.into(), on_change: Mutex::new(None) }
    }

    fn save(&self, i: &Inner) {
        if let Some(p) = &self.path {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(p, serde_json::to_string_pretty(&Saved { paired: i.paired.clone() }).unwrap_or_default());
        }
    }

    fn notify_ui(&self) {
        if let Some(f) = self.on_change.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            f();
        }
    }

    pub fn status(&self) -> Status {
        let mut i = self.inner.lock().unwrap();
        let now = now_ms();
        i.asks.retain(|a| a.last + PAIR_STANDS_MS > now);
        Status { port: i.port, asks: i.asks.clone(), paired: i.paired.clone() }
    }

    /// The player answered an ask in the UI.
    pub fn answer_ask(&self, instance: &str, allow: bool) -> bool {
        let found = {
            let mut i = self.inner.lock().unwrap();
            let Some(pos) = i.asks.iter().position(|a| a.instance == instance) else { return false };
            let a = i.asks.remove(pos);
            if allow {
                let key = random_hex(64);
                i.paired.retain(|p| p.instance != a.instance);
                i.paired.push(Paired { key: key.clone(), game: a.game.clone(), game_name: a.game_name.clone(), instance: a.instance.clone(), at: now_ms() });
                i.granted.insert(a.instance.clone(), key);
                self.save(&i);
            } else {
                i.denied.insert(a.instance.clone(), now_ms() + DENIED_MS);
            }
            true
        };
        self.notify_ui();
        found
    }

    /// Forgets one pairing (instance) or all (None).
    pub fn forget(&self, instance: Option<&str>) {
        {
            let mut i = self.inner.lock().unwrap();
            match instance {
                Some(x) => i.paired.retain(|p| p.instance != x),
                None => i.paired.clear(),
            }
            i.granted.clear();
            self.save(&i);
        }
        self.notify_ui();
    }

    /// A notification for every paired game (upload finished, mod update, server event).
    pub fn push(&self, kind: &str, level: &str, title: &str, text: &str) {
        let mut i = self.inner.lock().unwrap();
        i.next_event += 1;
        let ev = Event { id: i.next_event, kind: kind.into(), level: level.into(), title: title.chars().take(120).collect(), text: text.chars().take(240).collect(), at: now_ms(), game: None, path: None };
        i.events.push_back(ev);
        let now = now_ms();
        while i.events.len() > EVENTS_MAX || i.events.front().is_some_and(|e| e.at + EVENTS_KEEP_MS < now) {
            i.events.pop_front();
        }
        drop(i);
        self.changed.notify_all();
    }

    /// A running game (site code "tmn" ESWC, "tms" Sunrise) that can open maps on request.
    pub fn can_play_map(&self, game: &str) -> bool {
        let now = now_ms();
        self.inner.lock().unwrap().live.values().any(|l| l.game == game && l.play_map && l.seen + LIVE_MS > now)
    }

    /// Asks the running game to open a map (`rel`: path inside its Tracks folder). The game shows the
    /// result as a toast; it only opens maps from its main menu.
    pub fn push_play_map(&self, game: &str, rel: &str, title: &str) -> Result<(), String> {
        if !play_map_path_ok(rel) {
            return Err("bad map path".into());
        }
        let mut i = self.inner.lock().unwrap();
        i.next_event += 1;
        let ev = Event {
            id: i.next_event,
            kind: "play_map".into(),
            level: "info".into(),
            title: strip_codes(title).chars().take(120).collect(),
            text: String::new(),
            at: now_ms(),
            game: Some(game.into()),
            path: Some(rel.replace('\\', "/")),
        };
        i.events.push_back(ev);
        while i.events.len() > EVENTS_MAX {
            i.events.pop_front();
        }
        drop(i);
        self.changed.notify_all();
        Ok(())
    }

    fn take_token(&self, key: &str, now: u64) -> bool {
        let mut i = self.inner.lock().unwrap();
        let b = i.buckets.entry(key.to_string()).or_insert(Bucket { tokens: 24.0, at: now });
        b.tokens = (b.tokens + (now.saturating_sub(b.at)) as f64 / 1000.0 * 8.0).min(24.0);
        b.at = now;
        if b.tokens < 1.0 {
            return false;
        }
        b.tokens -= 1.0;
        true
    }

    fn pair(&self, r: &Request) -> Answer {
        let v: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
        let s = |k: &str, max: usize| v.get(k).and_then(|x| x.as_str()).unwrap_or("").chars().filter(|c| !c.is_control()).take(max).collect::<String>();
        let instance = s("instance", 32);
        if instance.len() < 8 || !instance.chars().all(|c| c.is_ascii_hexdigit()) {
            return Answer::err(400, "instance missing");
        }
        let now = now_ms();
        let mut changed = false;
        let a = {
            let mut i = self.inner.lock().unwrap();
            if let Some(key) = i.granted.remove(&instance) {
                return Answer::json(200, json!({ "ok": true, "key": key }));
            }
            // Allowed once = allowed for this install: an instance that is already paired gets its key again
            // without asking (the game side lost or never stored bridge.key, e.g. a copied or reset settings
            // folder). Remove in Settings ends that.
            if let Some(p) = i.paired.iter().find(|p| p.instance == instance) {
                return Answer::json(200, json!({ "ok": true, "key": p.key.clone() }));
            }
            if i.denied.get(&instance).is_some_and(|u| *u > now) {
                return Answer::json(200, json!({ "ok": false, "status": "denied" }));
            }
            i.asks.retain(|a| a.last + PAIR_STANDS_MS > now);
            match i.asks.iter_mut().find(|a| a.instance == instance) {
                Some(a) => a.last = now,
                None => {
                    if i.asks.len() >= 8 {
                        return Answer::json(200, json!({ "ok": false, "status": "denied" }));
                    }
                    i.asks.push(Ask { instance, game: s("game", 8), game_name: s("gameName", 60), client: s("client", 40), version: s("version", 20), first: now, last: now });
                    changed = true;
                }
            }
            Answer::json(200, json!({ "ok": false, "status": "pending" }))
        };
        if changed {
            self.notify_ui();
        }
        a
    }

    fn events(&self, r: &Request) -> Answer {
        {
            let mut i = self.inner.lock().unwrap();
            let game = i.paired.iter().find(|p| p.key == r.key).map(|p| p.game.clone()).unwrap_or_default();
            let play_map = r.query.get("caps").is_some_and(|c| c.split(',').any(|x| x == "play_map"));
            i.live.insert(r.key.clone(), Live { game, seen: now_ms(), play_map });
        }
        let Some(since) = r.query.get("since").and_then(|s| s.parse::<u64>().ok()) else {
            let last = self.inner.lock().unwrap().next_event;
            return Answer::json(200, json!({ "ok": true, "last": last, "events": [] }));
        };
        let wait = r.query.get("wait").and_then(|w| w.parse::<u64>().ok()).unwrap_or(0).min(25);
        let deadline = Instant::now() + Duration::from_secs(wait);
        let mut i = self.inner.lock().unwrap();
        loop {
            let evs: Vec<&Event> = i.events.iter().filter(|e| e.id > since).collect();
            if !evs.is_empty() || Instant::now() >= deadline {
                let last = i.next_event.max(since);
                return Answer::json(200, json!({ "ok": true, "last": last, "events": evs }));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            i = self.changed.wait_timeout(i, left).unwrap().0;
        }
    }

    fn search(&self, host: &str, game: &str, q: &HashMap<String, String>) -> Answer {
        let f = Filters::from_query(q);
        let page = q.get("page").and_then(|p| p.parse::<usize>().ok()).unwrap_or(1).clamp(1, 50);
        let base = format!("{game}|{f:?}");
        let after = if page > 1 {
            match self.inner.lock().unwrap().cursors.get(&format!("{base}|{page}")) {
                Some(a) => Some(*a),
                None => return Answer::err(400, "load the pages before this one first"),
            }
        } else {
            None
        };
        let cache_key = format!("{base}|{page}");
        let now = now_ms();
        if let Some((at, v)) = self.inner.lock().unwrap().search_cache.get(&cache_key) {
            if *at + 120_000 > now {
                return Answer::json(200, v.clone());
            }
        }
        let raw = match self.tmx.get_json(&search_url(host, &f, PAGE, after)) {
            Ok(v) => v,
            Err(e) => return Answer::err(502, &format!("TMX: {e}")),
        };
        let results = raw.get("Results").and_then(|r| r.as_array()).cloned().unwrap_or_default();
        let last_id = results.last().and_then(|r| r.get("TrackId")).and_then(|i| i.as_i64());
        let more = raw.get("More").and_then(|m| m.as_bool()).unwrap_or(false);
        let tracks: Vec<Value> = results.iter().filter_map(track_of).filter(|t| t["awards"].as_i64().unwrap_or(0) >= f.awards as i64).collect();
        let out = json!({ "ok": true, "site": host, "page": page, "more": more, "results": tracks });
        let mut i = self.inner.lock().unwrap();
        if let (true, Some(l)) = (more, last_id) {
            i.cursors.insert(format!("{base}|{}", page + 1), l);
        }
        if i.search_cache.len() > 64 {
            i.search_cache.clear();
        }
        i.search_cache.insert(cache_key, (now, out.clone()));
        Answer::json(200, out)
    }

    fn random(&self, host: &str, q: &HashMap<String, String>) -> Answer {
        let f = Filters::from_query(q);
        let raw = match self.tmx.get_json(&search_url(host, &f, 100, None)) {
            Ok(v) => v,
            Err(e) => return Answer::err(502, &format!("TMX: {e}")),
        };
        let tracks: Vec<Value> = raw
            .get("Results")
            .and_then(|r| r.as_array())
            .map(|r| r.iter().filter_map(track_of).filter(|t| t["awards"].as_i64().unwrap_or(0) >= f.awards as i64).collect())
            .unwrap_or_default();
        if tracks.is_empty() {
            return Answer::json(200, json!({ "ok": true, "result": null }));
        }
        let pick = (now_ms() as usize ^ (std::process::id() as usize).rotate_left(7)) % tracks.len();
        Answer::json(200, json!({ "ok": true, "result": tracks[pick] }))
    }

    fn thumb(&self, host: &str, id: i64) -> Answer {
        let key = format!("{host}/{id}");
        if let Some((_, b, t)) = self.inner.lock().unwrap().thumbs.iter().find(|(k, _, _)| *k == key) {
            return Answer::bytes(t, b.clone());
        }
        let b = match self.tmx.get_bytes(&format!("https://{host}/trackshow/{id}/image/1"), MAX_THUMB) {
            Ok(b) => b,
            Err(e) => return Answer::err(if e.contains("404") { 404 } else { 502 }, &e),
        };
        let t = if b.starts_with(&[0x89, b'P', b'N', b'G']) {
            "image/png"
        } else if b.starts_with(&[0xFF, 0xD8]) {
            "image/jpeg"
        } else if b.starts_with(b"GIF8") {
            "image/gif"
        } else if b.starts_with(b"BM") {
            "image/bmp"
        } else {
            return Answer::err(404, "no image");
        };
        let mut i = self.inner.lock().unwrap();
        i.thumbs.push_back((key, b.clone(), t.into()));
        while i.thumbs.len() > 96 {
            i.thumbs.pop_front();
        }
        Answer::bytes(t, b)
    }

    fn map(&self, host: &str, id: i64) -> Answer {
        match self.tmx.get_bytes(&format!("https://{host}/trackgbx/{id}"), MAX_MAP) {
            Ok(b) if b.starts_with(b"GBX") => {
                let mut a = Answer::bytes("application/octet-stream", b);
                a.headers.push(("X-File-Name".into(), format!("{id}.Challenge.Gbx")));
                a
            }
            Ok(_) => Answer::err(502, "TMX did not send a map file"),
            Err(e) => Answer::err(502, &e),
        }
    }

    fn record(&self, game: &str, uid: &str) -> Answer {
        if uid.is_empty() || uid.len() > 40 || !uid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Answer::err(400, "uid missing");
        }
        let now = now_ms();
        if let Some((at, v)) = self.inner.lock().unwrap().records.get(&format!("{game}|{uid}")) {
            if *at + 600_000 > now {
                return Answer::json(200, v.clone());
            }
        }
        // a Stadium map can be on either Forever site
        let sites: Vec<&str> = match game {
            "tmnf" => vec!["tmnf.exchange", "tmuf.exchange"],
            "tmuf" => vec!["tmuf.exchange", "tmnf.exchange"],
            g => site_host(g).into_iter().collect(),
        };
        let mut answered = false;
        let mut out = json!({ "ok": true, "found": false });
        for host in sites {
            let url = format!("https://{host}/api/tracks?uid={uid}&fields=TrackId,TrackName,WRReplay.ReplayId,WRReplay.ReplayTime,WRReplay.User.Name");
            let Ok(v) = self.tmx.get_json(&url) else { continue };
            answered = true;
            let Some(t) = v.get("Results").and_then(|r| r.as_array()).and_then(|r| r.first()) else { continue };
            let Some(rid) = t.pointer("/WRReplay/ReplayId").and_then(|x| x.as_i64()) else { continue };
            out = json!({
                "ok": true, "found": true, "site": host,
                "trackId": t.get("TrackId").and_then(|x| x.as_i64()).unwrap_or(0),
                "replayId": rid,
                "time": t.pointer("/WRReplay/ReplayTime").and_then(|x| x.as_i64()).unwrap_or(-1),
                "player": t.pointer("/WRReplay/User/Name").and_then(|x| x.as_str()).unwrap_or(""),
            });
            break;
        }
        if !answered {
            return Answer::err(502, "TMX did not answer");
        }
        self.inner.lock().unwrap().records.insert(format!("{game}|{uid}"), (now, out.clone()));
        Answer::json(200, out)
    }

    fn replay(&self, game: &str, id: i64) -> Answer {
        // the record replay comes from the site the record lookup found (cached), else the game's own
        let host = {
            let i = self.inner.lock().unwrap();
            i.records.values().find(|(_, v)| v.get("replayId").and_then(|r| r.as_i64()) == Some(id)).and_then(|(_, v)| v.get("site").and_then(|s| s.as_str()).map(String::from))
        }
        .or_else(|| site_host(game).map(String::from));
        let Some(host) = host else { return Answer::err(400, "unknown game") };
        match self.tmx.get_bytes(&format!("https://{host}/recordgbx/{id}"), MAX_MAP) {
            Ok(b) if b.starts_with(b"GBX") => Answer::bytes("application/octet-stream", b),
            Ok(_) => Answer::err(502, "TMX did not send a replay"),
            Err(e) => Answer::err(502, &e),
        }
    }

    /// Answers one request (the HTTP server calls it on a connection thread).
    pub fn answer(&self, r: &Request) -> Answer {
        let host_name = r.host.rsplit_once(':').map(|(h, _)| h).unwrap_or(&r.host);
        if host_name != "127.0.0.1" && host_name != "localhost" {
            return Answer::err(403, "forbidden");
        }
        match (r.method.as_str(), r.path.as_str()) {
            ("GET", "/v1/client/ping") => return Answer::json(200, json!({ "ok": true, "app": "tm-horizon", "version": self.version, "api": API })),
            ("POST", "/v1/client/pair") => return self.pair(r),
            _ => {}
        }
        if r.key.is_empty() || !self.inner.lock().unwrap().paired.iter().any(|p| p.key == r.key) {
            return Answer::err(401, "not paired");
        }
        let long_poll = r.path == "/v1/client/events";
        if !long_poll && !self.take_token(&r.key, now_ms()) {
            let mut a = Answer::err(429, "too many requests");
            a.headers.push(("Retry-After".into(), "1".into()));
            return a;
        }
        let game = r.query.get("game").map(String::as_str).unwrap_or("");
        let id = r.query.get("id").and_then(|i| i.parse::<i64>().ok()).filter(|i| *i > 0);
        let site = site_host(game);
        match (r.method.as_str(), r.path.as_str()) {
            ("GET", "/v1/client/hello") => Answer::json(200, json!({ "ok": true, "app": "tm-horizon", "version": self.version })),
            ("GET", "/v1/client/events") => self.events(r),
            ("GET", "/v1/tmx/search") => site.map(|h| self.search(h, game, &r.query)).unwrap_or_else(|| Answer::err(400, "unknown game")),
            ("GET", "/v1/tmx/random") => site.map(|h| self.random(h, &r.query)).unwrap_or_else(|| Answer::err(400, "unknown game")),
            ("GET", "/v1/tmx/thumb") => match (site, id) {
                (Some(h), Some(i)) => self.thumb(h, i),
                _ => Answer::err(400, "game and id needed"),
            },
            ("GET", "/v1/tmx/map") => match (site, id) {
                (Some(h), Some(i)) => self.map(h, i),
                _ => Answer::err(400, "game and id needed"),
            },
            ("GET", "/v1/tmx/record") => match site {
                Some(_) => self.record(game, r.query.get("uid").map(String::as_str).unwrap_or("")),
                None => Answer::err(400, "unknown game"),
            },
            ("GET", "/v1/tmx/replay") => match id {
                Some(i) => self.replay(game, i),
                None => Answer::err(400, "id needed"),
            },
            _ => Answer::err(404, "not found"),
        }
    }
}

// ------------------------------------------------------------------ the server

pub struct Server {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn serve_one(mut c: TcpStream, b: &Bridge) {
    let _ = c.set_nonblocking(false);
    let _ = c.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = c.set_write_timeout(Some(Duration::from_secs(30)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let req = loop {
        if let Some(r) = parse_request(&buf) {
            break Some(r);
        }
        if buf.len() > MAX_BODY + 16 * 1024 {
            break None;
        }
        match c.read(&mut chunk) {
            Ok(0) | Err(_) => break None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let a = match req {
        Some(r) => b.answer(&r),
        None => Answer::err(400, "bad request"),
    };
    let _ = c.write_all(&http_bytes(&a));
    let _ = c.shutdown(std::net::Shutdown::Both);
}

/// Listens on the first free port of PORTS (loopback only); one thread per connection (at most 16).
pub fn start(bridge: Arc<Bridge>, ports: &[u16]) -> Result<Server, String> {
    let (listener, port) = ports.iter().find_map(|&p| TcpListener::bind(("127.0.0.1", p)).ok().map(|l| (l, p))).ok_or("no free port for the client bridge")?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    bridge.inner.lock().unwrap().port = Some(port);
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let open = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::spawn(move || {
        while !s2.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((c, _)) => {
                    if open.load(Ordering::Relaxed) >= 16 {
                        drop(c);
                        continue;
                    }
                    open.fetch_add(1, Ordering::Relaxed);
                    let b = bridge.clone();
                    let o = open.clone();
                    std::thread::spawn(move || {
                        serve_one(c, &b);
                        o.fetch_sub(1, Ordering::Relaxed);
                    });
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    });
    Ok(Server { port, stop })
}

/// The file the pairings are kept in.
pub fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("client-bridge.json")
}

// ------------------------------------------------------------------ global access (notifications from anywhere)

static GLOBAL: Mutex<Option<Arc<Bridge>>> = Mutex::new(None);

pub fn set_global(b: Arc<Bridge>) {
    *GLOBAL.lock().unwrap_or_else(|e| e.into_inner()) = Some(b);
}

/// A running ESWC ("tmn") or Sunrise ("tms") with Horizon Client opens the map (`rel`: inside its
/// Tracks folder). False when no such game is connected (or the bridge is off).
pub fn play_map(game: &str, rel: &str, title: &str) -> bool {
    let g = GLOBAL.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match g {
        Some(b) if b.can_play_map(game) => b.push_play_map(game, rel, title).is_ok(),
        _ => false,
    }
}

/// Sends a notification to the paired games (no-op before the bridge started).
pub fn notify(kind: &str, level: &str, title: &str, text: &str) {
    if let Some(b) = GLOBAL.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        b.push(kind, level, title, text);
    }
}

/// Mod updates found by a check: one notification per new (mod, version), not again for the same one.
pub fn notify_updates(list: &[crate::updates::UpdateInfo]) {
    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let new: Vec<&crate::updates::UpdateInfo> = list
        .iter()
        .filter(|u| u.update && u.latest.is_some())
        .filter(|u| {
            let k = format!("{}|{}|{}", u.entry_id, u.game, u.latest.as_deref().unwrap_or(""));
            if seen.contains(&k) {
                false
            } else {
                seen.push(k);
                true
            }
        })
        .collect();
    match new.len() {
        0 => {}
        1 => notify("mod", "info", "Mod update available", &format!("{} {}", new[0].entry_id, new[0].latest.as_deref().unwrap_or(""))),
        n => notify("mod", "info", "Mod updates available", &format!("{n} mods have a new version")),
    }
}

/// An upload result (tmxupload history entry) as a notification.
pub fn notify_upload(h: &crate::tmxupload::HistoryEntry) {
    let map = if h.map.is_empty() { "Replay".to_string() } else { h.map.clone() };
    match h.result.as_str() {
        "ok" => notify("upload", "ok", "Replay uploaded to TMX", &map),
        "skipped" => {}
        _ => notify("upload", "error", "Upload failed", &format!("{map}: {}", h.detail)),
    }
}

pub mod app {
    use super::*;
    use tauri::{AppHandle, Emitter, Manager, Runtime, State};

    pub struct Handle {
        pub bridge: Arc<Bridge>,
        pub server: Mutex<Option<Server>>,
    }

    pub fn start<R: Runtime>(app: &AppHandle<R>, config_dir: &Path) -> Handle {
        let bridge = Arc::new(Bridge::new(Some(store_path(config_dir)), Box::new(SharedTmx), env!("CARGO_PKG_VERSION")));
        let a = app.clone();
        let b2 = bridge.clone();
        *bridge.on_change.lock().unwrap() = Some(Box::new(move || {
            let _ = a.emit("client-bridge", b2.status());
        }));
        set_global(bridge.clone());
        // Screenshot and test builds run next to a real TM Horizon: TMHUB_NO_BRIDGE=1 keeps them off the
        // bridge ports so no running game can pair with them.
        if std::env::var_os("TMHUB_NO_BRIDGE").is_some_and(|v| !v.is_empty() && v != "0") {
            return Handle { bridge, server: Mutex::new(None) };
        }
        let server = match super::start(bridge.clone(), &PORTS) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("client bridge: {e}");
                None
            }
        };
        Handle { bridge, server: Mutex::new(server) }
    }

    #[tauri::command(async)]
    pub fn client_bridge_status(h: State<Handle>) -> Status {
        h.bridge.status()
    }

    #[tauri::command(async)]
    pub fn client_bridge_answer(h: State<Handle>, instance: String, allow: bool) -> bool {
        h.bridge.answer_ask(&instance, allow)
    }

    #[tauri::command(async)]
    pub fn client_bridge_forget(h: State<Handle>, instance: Option<String>) -> Status {
        h.bridge.forget(instance.as_deref());
        h.bridge.status()
    }

    /// For the frontend: a notification to the games (e.g. a server event).
    #[tauri::command(async)]
    pub fn client_notify(h: State<Handle>, kind: String, level: String, title: String, text: Option<String>) {
        let kind = if ["upload", "mod", "server", "info"].contains(&kind.as_str()) { kind } else { "info".into() };
        let level = if ["info", "ok", "warn", "error"].contains(&level.as_str()) { level } else { "info".into() };
        h.bridge.push(&kind, &level, &title, text.as_deref().unwrap_or(""));
    }

    #[allow(dead_code)]
    pub fn handle<R: Runtime>(app: &AppHandle<R>) -> Arc<Bridge> {
        app.state::<Handle>().bridge.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn play_map_paths_follow_the_host_rules() {
        assert!(play_map_path_ok("Challenges/Downloaded/12345.Challenge.Gbx"));
        assert!(play_map_path_ok("Challenges\\Downloaded\\Schön.Challenge.gbx"));
        for bad in ["", "/abs/x.Challenge.Gbx", "C:/x.Challenge.Gbx", "a/../b.Challenge.Gbx", "a/x.Map.Gbx", "a/.Challenge.Gbx", "CON/x.Challenge.Gbx", "a/x?.Challenge.Gbx", "a//x.Challenge.Gbx", "a./x.Challenge.Gbx"] {
            assert!(!play_map_path_ok(bad), "{bad}");
        }
    }

    struct Fake {
        calls: Mutex<Vec<String>>,
    }
    impl Tmx for Fake {
        fn get_json(&self, url: &str) -> Result<Value, String> {
            self.calls.lock().unwrap().push(url.to_string());
            if url.contains("uid=") {
                if url.contains("tmnf.exchange") {
                    return Ok(json!({"More": false, "Results": []}));
                }
                return Ok(json!({"More": false, "Results": [{"TrackId": 5, "TrackName": "X", "WRReplay": {"ReplayId": 77, "ReplayTime": 24420, "User": {"Name": "Wr"}}}]}));
            }
            let after = url.contains("after=");
            Ok(json!({"More": !after, "Results": [
                {"TrackId": if after { 30 } else { 10 }, "TrackName": "$o$fffA01", "Authors": [{"User": {"UserId": 1, "Name": "nadeo"}, "Role": ""}], "Awards": 357, "Tags": [0, 7], "Difficulty": 0, "AuthorTime": 24540, "Environment": 7, "HasThumbnail": true, "UId": "abc", "UploadedAt": "2008-04-12T00:00:00"},
                {"TrackId": if after { 31 } else { 11 }, "TrackName": "B", "Uploader": {"Name": "up"}, "Awards": 2, "Tags": [99], "Difficulty": 3, "AuthorTime": 61000, "Environment": 1}
            ]}))
        }
        fn get_bytes(&self, url: &str, _max: u64) -> Result<Vec<u8>, String> {
            self.calls.lock().unwrap().push(url.to_string());
            if url.contains("/image/") {
                return Ok(vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2]);
            }
            if url.contains("missing") {
                return Err("HTTP 404".into());
            }
            Ok(b"GBX\x06\x00rest".to_vec())
        }
    }

    fn bridge() -> Bridge {
        Bridge::new(None, Box::new(Fake { calls: Mutex::new(vec![]) }), "0.3.0")
    }
    fn req(method: &str, target: &str, key: &str, body: &str) -> Request {
        let raw = format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:27331\r\nX-Horizon-Key: {key}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        parse_request(raw.as_bytes()).unwrap()
    }
    fn paired(b: &Bridge) -> String {
        let pair = r#"{"client":"horizon-host","version":"0.3.0","game":"tmnf","gameName":"TrackMania Nations Forever","instance":"0123456789abcdef"}"#;
        let a = b.answer(&req("POST", "/v1/client/pair", "", pair));
        assert_eq!(serde_json::from_slice::<Value>(&a.body).unwrap()["status"], "pending");
        assert!(b.answer_ask("0123456789abcdef", true));
        let a = b.answer(&req("POST", "/v1/client/pair", "", pair));
        let v: Value = serde_json::from_slice(&a.body).unwrap();
        v["key"].as_str().unwrap().to_string()
    }

    #[test]
    fn ping_without_key_and_host_check() {
        let b = bridge();
        let a = b.answer(&req("GET", "/v1/client/ping", "", ""));
        assert_eq!(a.status, 200);
        assert!(a.text().contains("\"tm-horizon\""));
        let mut r = req("GET", "/v1/client/ping", "", "");
        r.host = "evil.example".into();
        assert_eq!(b.answer(&r).status, 403);
        assert_eq!(b.answer(&req("GET", "/v1/client/hello", "nope", "")).status, 401);
    }

    #[test]
    fn pairing_allow_deny_forget() {
        let b = bridge();
        let key = paired(&b);
        assert_eq!(key.len(), 64);
        assert_eq!(b.answer(&req("GET", "/v1/client/hello", &key, "")).status, 200);
        assert_eq!(b.status().paired.len(), 1);
        // a second game, refused
        let other = r#"{"game":"tmn","gameName":"TrackMania Nations ESWC","instance":"fedcba9876543210"}"#;
        b.answer(&req("POST", "/v1/client/pair", "", other));
        assert_eq!(b.status().asks.len(), 1);
        assert!(b.answer_ask("fedcba9876543210", false));
        let a = b.answer(&req("POST", "/v1/client/pair", "", other));
        assert!(a.text().contains("denied"));
        assert!(b.answer(&req("POST", "/v1/client/pair", "", "{}")).status == 400);
        // Paired once: the same install asking again (lost its key) gets the key without a new Allow.
        let again = r#"{"game":"tmnf","gameName":"TrackMania Nations Forever","instance":"0123456789abcdef"}"#;
        let v: Value = serde_json::from_slice(&b.answer(&req("POST", "/v1/client/pair", "", again)).body).unwrap();
        assert_eq!(v["key"].as_str(), Some(key.as_str()));
        assert!(b.status().asks.is_empty());
        b.forget(None);
        assert_eq!(b.answer(&req("GET", "/v1/client/hello", &key, "")).status, 401);
    }

    #[test]
    fn events_cursor_and_long_poll() {
        let b = Arc::new(bridge());
        let key = paired(&b);
        let first: Value = serde_json::from_slice(&b.answer(&req("GET", "/v1/client/events", &key, "")).body).unwrap();
        let last = first["last"].as_u64().unwrap();
        b.push("upload", "ok", "Replay uploaded to TMX", "A01");
        let v: Value = serde_json::from_slice(&b.answer(&req("GET", &format!("/v1/client/events?since={last}&wait=0"), &key, "")).body).unwrap();
        assert_eq!(v["events"].as_array().unwrap().len(), 1);
        assert_eq!(v["events"][0]["title"], "Replay uploaded to TMX");
        let next = v["last"].as_u64().unwrap();
        // long poll wakes up on a push
        let b2 = b.clone();
        let k2 = key.clone();
        let t = std::thread::spawn(move || b2.answer(&req("GET", &format!("/v1/client/events?since={next}&wait=5"), &k2, "")));
        std::thread::sleep(Duration::from_millis(150));
        b.push("mod", "info", "Mod update available", "x 1.2");
        let v: Value = serde_json::from_slice(&t.join().unwrap().body).unwrap();
        assert_eq!(v["events"][0]["kind"], "mod");
    }

    #[test]
    fn search_paging_filters_and_cache() {
        let b = bridge();
        let key = paired(&b);
        let a = b.answer(&req("GET", "/v1/tmx/search?game=tmnf&name=a01&tags=7,99&difficulty=0&lengthmax=60000&awards=10", &key, ""));
        assert_eq!(a.status, 200);
        let v: Value = serde_json::from_slice(&a.body).unwrap();
        assert_eq!(v["results"].as_array().unwrap().len(), 1, "awards filter drops the 2-award track");
        assert_eq!(v["results"][0]["name"], "A01");
        assert_eq!(v["results"][0]["author"], "nadeo");
        assert_eq!(v["results"][0]["tags"], json!(["Race", "Tech"]));
        assert_eq!(v["results"][0]["environment"], "Stadium");
        assert_eq!(v["more"], true);
        // page 2 uses the cursor of page 1
        let a = b.answer(&req("GET", "/v1/tmx/search?game=tmnf&name=a01&tags=7,99&difficulty=0&lengthmax=60000&awards=0&page=2", &key, ""));
        assert_eq!(a.status, 400, "page 2 of another query needs its page 1");
        let a = b.answer(&req("GET", "/v1/tmx/search?game=tmnf&name=a01&tags=7,99&difficulty=0&lengthmax=60000&awards=10&page=2", &key, ""));
        assert_eq!(a.status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&a.body).unwrap()["results"][0]["id"], 30);
        assert_eq!(b.answer(&req("GET", "/v1/tmx/search?game=nope", &key, "")).status, 400);
    }

    #[test]
    fn search_url_has_the_filters() {
        let f = Filters { name: "a b".into(), author: "x".into(), tags: vec![7, 8], difficulty: Some(3), length_min: Some(1), length_max: Some(45000), awards: 0 };
        let u = search_url("tmnf.exchange", &f, 20, Some(99));
        for part in ["name=a+b", "author=x", "tag=7%2C8", "difficulty=3", "authortimemin=1", "authortimemax=45000", "after=99", "inunlimiter=0", "count=20"] {
            assert!(u.contains(part), "{part} in {u}");
        }
        assert!(u.starts_with("https://tmnf.exchange/api/tracks?"));
    }

    #[test]
    fn thumbs_maps_records_replays() {
        let b = bridge();
        let key = paired(&b);
        let a = b.answer(&req("GET", "/v1/tmx/thumb?game=tmnf&id=10", &key, ""));
        assert_eq!((a.status, a.content_type.as_str()), (200, "image/jpeg"));
        let a = b.answer(&req("GET", "/v1/tmx/map?game=tmuf&id=10", &key, ""));
        assert!(a.status == 200 && a.body.starts_with(b"GBX") && a.headers.iter().any(|(k, _)| k == "X-File-Name"));
        let a = b.answer(&req("GET", "/v1/tmx/record?game=tmnf&uid=abcDEF123", &key, ""));
        let v: Value = serde_json::from_slice(&a.body).unwrap();
        assert_eq!((v["found"].as_bool(), v["site"].as_str(), v["replayId"].as_i64()), (Some(true), Some("tmuf.exchange"), Some(77)), "falls back to tmuf.exchange");
        let a = b.answer(&req("GET", "/v1/tmx/replay?game=tmnf&id=77", &key, ""));
        assert_eq!(a.status, 200);
        assert_eq!(b.answer(&req("GET", "/v1/tmx/record?game=tmnf&uid=bad%20uid", &key, "")).status, 400);
        assert_eq!(b.answer(&req("GET", "/v1/tmx/thumb?game=tmnf", &key, "")).status, 400);
    }

    #[test]
    fn rate_limit_per_key() {
        let b = bridge();
        let key = paired(&b);
        let mut limited = 0;
        for _ in 0..40 {
            if b.answer(&req("GET", "/v1/client/hello", &key, "")).status == 429 {
                limited += 1;
            }
        }
        assert!(limited >= 10, "burst of 24 then 429 ({limited})");
    }

    #[test]
    fn request_parsing_limits() {
        assert!(parse_request(b"GET /v1/x HTTP/1.1\r\nHost: a\r\n").is_none(), "incomplete head");
        assert!(parse_request(b"POST /v1/x HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc").is_none(), "body not complete");
        let r = parse_request(b"GET /v1/tmx/search?game=tmnf&name=a%20b HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        assert_eq!(r.query.get("name").unwrap(), "a b");
        assert_eq!(strip_codes("$o$f00Red $$ $wWide"), "Red $ Wide");
    }

    #[test]
    fn server_on_loopback() {
        let b = Arc::new(bridge());
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let s = start(b.clone(), &[port]).unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
        c.write_all(b"GET /v1/client/ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 200") && out.contains("tm-horizon"), "{out}");
    }
}
