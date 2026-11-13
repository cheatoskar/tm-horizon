//! Login-free live status of TrackMania game servers, from the game's own server query:
//! one TCP connection to the game port (default 2350), two small ConnectionAdmin messages
//! (subtype 8 = query mode, subtype 7 = info request), the server answers with its server info
//! (name, players, mode, maps, ...). No account, no master server. Works for TMNF/TMUF
//! ("TmForever") and the older Original, Sunrise and Nations ESWC.
//!
//! Protocol: implemented from the community protocol notes (summary and sources in
//! docs/design/server-query.md). Test vectors (real captures) are from those notes and from
//! opengsq-python (MIT, (c) 2021 OpenGSQ). This file also holds the list of known servers
//! (registry) and the scheduler that keeps the load on the servers low: at most 4 connections at
//! once, never more than one query per server per 30 s, servers that keep failing are skipped
//! for 10 minutes.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::lzo1x;
use crate::state::AppState;

// ------------------------------------------------------------------ MD5 and HMAC-MD5

fn md5(data: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16,
        23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let k: Vec<u32> = (0..64).map(|i| ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32).collect();
    let (mut a0, mut b0, mut c0, mut d0) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64).wrapping_mul(8)).to_le_bytes());
    for chunk in msg.chunks(64) {
        let m: Vec<u32> = chunk.chunks(4).map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]])).collect();
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (mut f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            f = f.wrapping_add(a).wrapping_add(k[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(S[i]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = [0u8; 16];
    for (i, v) in [a0, b0, c0, d0].iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    out
}

fn hmac_md5(key: &[u8], msg: &[u8]) -> [u8; 16] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..16].copy_from_slice(&md5(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    inner.extend_from_slice(msg);
    let ih = md5(&inner);
    let mut outer: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    outer.extend_from_slice(&ih);
    md5(&outer)
}

// ------------------------------------------------------------------ variants

/// Protocol family of a game. Original and Sunrise speak the same protocol (they only differ in
/// how map decorations are named), so the registry has to say which one a server is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Forever,
    Original,
    Sunrise,
    Eswc,
}

const KEY_FOREVER: [u8; 16] = {
    // 0x80D79DB8, 0xBA216B72, 0x15439598, 0xE1EC1CFA as little-endian words
    let w: [u32; 4] = [0x80D79DB8, 0xBA216B72, 0x15439598, 0xE1EC1CFA];
    let mut k = [0u8; 16];
    let mut i = 0;
    while i < 4 {
        let b = w[i].to_le_bytes();
        k[i * 4] = b[0];
        k[i * 4 + 1] = b[1];
        k[i * 4 + 2] = b[2];
        k[i * 4 + 3] = b[3];
        i += 1;
    }
    k
};
const KEY_LEGACY: [u8; 16] = [0x08, 0xc4, 0x81, 0x30, 0x3a, 0x12, 0x26, 0xab, 0xaf, 0x1d, 0x6a, 0xe4, 0xfb, 0x65, 0xfb, 0xc9];

impl Variant {
    /// Registry game id ("tmnf", "tmuf", "tmo", "tms", "eswc") onto the protocol variant.
    pub fn of_game(game: &str) -> Option<Variant> {
        match game {
            "tmnf" | "tmuf" => Some(Variant::Forever),
            "tmo" => Some(Variant::Original),
            "tms" => Some(Variant::Sunrise),
            "eswc" => Some(Variant::Eswc),
            _ => None,
        }
    }
    fn version(self) -> u32 {
        match self {
            Variant::Forever => 7,
            Variant::Original | Variant::Sunrise => 4,
            Variant::Eswc => 5,
        }
    }
    fn forever(self) -> bool {
        self == Variant::Forever
    }
    fn checksum(self, msg: &[u8], pos: usize) -> u32 {
        let mut data = msg.to_vec();
        data[pos..pos + 4].fill(0);
        let key = if self.forever() { &KEY_FOREVER } else { &KEY_LEGACY };
        let d = hmac_md5(key, &data);
        let w = |i: usize| u32::from_le_bytes([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]);
        if self.forever() {
            w(0).wrapping_add(w(1)).wrapping_add(w(2)).wrapping_add(w(3))
        } else {
            w(0).wrapping_add(w(1)).wrapping_add(w(2)).wrapping_add(u32::from_le_bytes([key[0], key[1], key[2], key[3]]))
        }
    }
    /// Environments and decorations for the decoration index of Original, Sunrise and ESWC maps.
    fn decorations(self) -> Option<(&'static [&'static str], &'static [&'static str])> {
        match self {
            Variant::Forever => None,
            Variant::Sunrise => Some((&["Bay", "Coast", "Island"], &["Sunrise", "Day", "Sunset", "Night"])),
            Variant::Original => Some((
                &["Alpine", "Speed", "Rally"],
                &["32x32Sunset", "32x32Sunrise", "Simple", "30x30Sunrise", "30x30", "30x30Sunset", "20x60Sunrise", "20x60", "20x60Sunset", "10x150Sunrise", "10x150", "10x150Sunset"],
            )),
            Variant::Eswc => Some((&["Stadium"], &["Day"])),
        }
    }
}

/// Decoration index of a legacy map onto (environment, mood); mood is empty for the entry without one.
pub fn decoration(v: Variant, index: u32) -> Option<(String, String)> {
    let (envs, decs) = v.decorations()?;
    let mut table: Vec<(&str, &str)> = Vec::new();
    for e in envs {
        for d in decs.iter().copied().chain(std::iter::once("")) {
            table.push((e, d));
        }
    }
    table.sort_by_key(|(e, d)| (e.to_lowercase(), if d.is_empty() { "unassigned".to_string() } else { d.to_lowercase() }));
    let i = index.checked_sub(2)? as usize;
    table.get(i).map(|(e, d)| (e.to_string(), d.to_string()))
}

// ------------------------------------------------------------------ errors

#[derive(Debug, Clone, PartialEq)]
pub enum QueryError {
    Dns(String),
    Timeout,
    Refused,
    Io(String),
    Protocol(String),
    /// The server is up but has no game info yet (map loading).
    NoInfo,
    /// The server refused our protocol version and told its own.
    Rejected(u32),
}

impl QueryError {
    /// Short code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            QueryError::Dns(_) => "dns",
            QueryError::Timeout => "timeout",
            QueryError::Refused => "refused",
            QueryError::Io(_) => "io",
            QueryError::Protocol(_) | QueryError::Rejected(_) => "protocol",
            QueryError::NoInfo => "noinfo",
        }
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QueryError::Dns(e) => write!(f, "address not found: {e}"),
            QueryError::Timeout => write!(f, "no answer in time"),
            QueryError::Refused => write!(f, "connection refused"),
            QueryError::Io(e) => write!(f, "network error: {e}"),
            QueryError::Protocol(e) => write!(f, "not a TrackMania server answer: {e}"),
            QueryError::NoInfo => write!(f, "server has no game info yet"),
            QueryError::Rejected(v) => write!(f, "server wants protocol version {v}"),
        }
    }
}

fn proto<T>(msg: &str) -> Result<T, QueryError> {
    Err(QueryError::Protocol(msg.to_string()))
}

fn io_err(e: std::io::Error) -> QueryError {
    use std::io::ErrorKind::*;
    match e.kind() {
        TimedOut | WouldBlock => QueryError::Timeout,
        ConnectionRefused => QueryError::Refused,
        UnexpectedEof | ConnectionReset | ConnectionAborted => QueryError::Protocol("connection closed".into()),
        _ => QueryError::Io(e.to_string()),
    }
}

// ------------------------------------------------------------------ framing

const MAX_FRAME: usize = 1 << 20;

/// One message (without the TCP length prefix): flags 0x82 (checksum), type, checksum, payload.
fn build_message(v: Variant, msg_type: u8, payload: &[u8]) -> Vec<u8> {
    let mut m = vec![0x82, msg_type, 0, 0, 0, 0];
    m.extend_from_slice(payload);
    let c = v.checksum(&m, 2);
    m[2..6].copy_from_slice(&c.to_le_bytes());
    m
}

fn frame(msg: &[u8]) -> Vec<u8> {
    let mut f = (msg.len() as u32).to_le_bytes().to_vec();
    f.extend_from_slice(msg);
    f
}

/// ConnectionAdmin (type 3) request with the TCP length prefix.
pub fn connection_admin(v: Variant, version: u32, subtype: u32, args: &[u32]) -> Vec<u8> {
    let mut p = version.to_le_bytes().to_vec();
    p.extend_from_slice(&subtype.to_le_bytes());
    for a in args {
        p.extend_from_slice(&a.to_le_bytes());
    }
    frame(&build_message(v, 3, &p))
}

/// Checks flags and checksum, decompresses. Returns (message type, payload).
fn decode_message(v: Variant, msg: &[u8]) -> Result<(u8, Vec<u8>), QueryError> {
    if msg.len() < 2 {
        return proto("message too short");
    }
    let (flags, ty) = (msg[0], msg[1]);
    if flags & 0xF0 != 0x80 {
        return proto("bad flags");
    }
    let mut pos = 2;
    if flags & 0x0C != 0 {
        pos += 2;
    }
    // Real servers always send the checksum; it is the strongest sign that this is a TrackMania server.
    if flags & 0x02 == 0 {
        return proto("no checksum");
    }
    if msg.len() < pos + 4 {
        return proto("message too short");
    }
    let got = u32::from_le_bytes([msg[pos], msg[pos + 1], msg[pos + 2], msg[pos + 3]]);
    if got != v.checksum(msg, pos) {
        return proto("bad checksum");
    }
    pos += 4;
    if flags & 0x01 != 0 {
        if msg.len() < pos + 4 {
            return proto("message too short");
        }
        let size = u32::from_le_bytes([msg[pos], msg[pos + 1], msg[pos + 2], msg[pos + 3]]) as usize;
        let out = lzo1x::decompress(&msg[pos + 4..], size).map_err(|e| QueryError::Protocol(e))?;
        Ok((ty, out))
    } else {
        Ok((ty, msg[pos..].to_vec()))
    }
}

// ------------------------------------------------------------------ reader and parsing

struct Rd<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Rd<'a> {
    fn new(d: &'a [u8]) -> Self {
        Rd { d, p: 0 }
    }
    fn left(&self) -> usize {
        self.d.len() - self.p
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], QueryError> {
        if n > self.left() {
            return proto("truncated");
        }
        self.p += n;
        Ok(&self.d[self.p - n..self.p])
    }
    fn u8(&mut self) -> Result<u8, QueryError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, QueryError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, QueryError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn i32(&mut self) -> Result<i32, QueryError> {
        Ok(self.u32()? as i32)
    }
    /// `str` and `wstr`: u32 length + UTF-8, with a BOM when the text is not plain ASCII.
    fn text(&mut self) -> Result<String, QueryError> {
        let n = self.u32()? as usize;
        let b = self.take(n)?;
        let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(b);
        Ok(String::from_utf8_lossy(b).into_owned())
    }
    /// A count that must fit the bytes still there (each item takes at least `min` bytes).
    fn count(&mut self, min: usize) -> Result<usize, QueryError> {
        let n = self.u32()? as usize;
        if n.checked_mul(min).map_or(true, |t| t > self.left()) {
            return proto("implausible count");
        }
        Ok(n)
    }
}

/// Removes TrackMania format codes: `$$` becomes `$`, `$fff`/`$o`/`$l[url]` and so on vanish.
pub fn strip_format(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] != '$' {
            out.push(c[i]);
            i += 1;
            continue;
        }
        let Some(&n) = c.get(i + 1) else {
            out.push('$');
            break;
        };
        if n == '$' {
            out.push('$');
            i += 2;
        } else if n.is_ascii_hexdigit() {
            let mut j = i + 1;
            while j < c.len() && j < i + 4 && c[j].is_ascii_hexdigit() {
                j += 1;
            }
            i = j;
        } else if "lLhHpP".contains(n) && c.get(i + 2) == Some(&'[') {
            match c[i + 3..].iter().position(|x| *x == ']') {
                Some(e) => i = i + 3 + e + 1,
                None => i += 2,
            }
        } else if n == '\n' {
            out.push('$');
            i += 1;
        } else {
            i += 2;
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapEntry {
    pub name_raw: String,
    pub name: String,
    pub gold_ms: u32,
    pub copper: u32,
    /// Forever: environment ("Stadium"); legacy: environment from the decoration index ("" when unknown).
    pub environment: String,
    /// Legacy only: mood ("Day", "Night", ...).
    pub mood: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerEntry {
    pub name_raw: String,
    pub name: String,
    pub ladder_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub game_tag: u8,
    /// Address the server reports for itself (can be a LAN address behind NAT).
    pub reported_address: String,
    /// Login of the host. This is what tmtp://#join= takes for dedicated servers.
    pub host_login: String,
    pub password: bool,
    pub spectator_password: bool,
    pub players: u8,
    pub max_players: u8,
    pub spectators: u8,
    pub max_spectators: u8,
    pub ladder_mode: u8,
    pub name_raw: String,
    pub name: String,
    pub comment_raw: String,
    pub comment: String,
    pub pack_mask: Option<String>,
    pub player_list: Vec<PlayerEntry>,
    pub mode_id: Option<u8>,
    pub mode: Option<String>,
    pub limit: Option<u32>,
    /// "ms" (time limit), "laps" or "points".
    pub limit_kind: Option<String>,
    /// Maps in the playlist (the server lists at most 20 in the answer).
    pub nb_maps: u8,
    /// First entry is the current map, then the next ones in rotation order.
    pub maps: Vec<MapEntry>,
}

fn mode_name(id: u8) -> (String, Option<&'static str>) {
    match id {
        1 => ("TimeAttack".into(), Some("ms")),
        3 => ("Rounds".into(), Some("points")),
        6 => ("Team".into(), Some("points")),
        7 => ("Laps".into(), Some("laps")),
        8 => ("Stunts".into(), Some("ms")),
        9 => ("Cup".into(), Some("points")),
        n => (format!("Unknown ({n})"), None),
    }
}

/// Parses the server info bytes of a subtype 6 answer.
pub fn parse_server_info(data: &[u8], v: Variant) -> Result<ServerInfo, QueryError> {
    let mut r = Rd::new(data);
    let tag = r.u8()?;
    let ok = if v.forever() { tag & 0xE0 == 0x20 && tag & 0x1F == 0x0D } else { tag & 0xE0 == 0 && matches!(tag & 0x1F, 0x07 | 0x09) };
    if !ok {
        return proto("game tag does not match");
    }
    let ip = r.take(4)?;
    let port = r.u16()?;
    let reported_address = format!("{}.{}.{}.{}:{port}", ip[3], ip[2], ip[1], ip[0]);
    let host_login = r.text()?;
    let login = r.text()?;
    if !login.starts_with("#SRV#") {
        return Err(QueryError::NoInfo);
    }
    let flag = login.as_bytes().get(5).copied();
    let password = matches!(flag, Some(b'p') | Some(b'f'));
    let spectator_password = matches!(flag, Some(b's') | Some(b'f'));
    r.text()?; // unused, always empty
    let players = r.u8()?;
    let max_players = r.u8()?;
    let spectators = r.u8()?;
    let max_spectators = r.u8()?;
    let ladder_mode = r.u8()?;
    let name_raw = r.text()?;
    let pack_mask = if v.forever() { Some(r.text()?) } else { None };
    let n = r.count(8)?;
    let mut names = Vec::with_capacity(n.min(256));
    for _ in 0..n {
        names.push(r.text()?);
    }
    let mut player_list = Vec::new();
    for nm in names {
        let rank = r.i32()?;
        player_list.push(PlayerEntry { name: strip_format(&nm), name_raw: nm, ladder_rank: rank });
    }
    let comment_raw = r.text()?;
    let mut info = ServerInfo {
        game_tag: tag,
        reported_address,
        host_login,
        password,
        spectator_password,
        players,
        max_players,
        spectators,
        max_spectators,
        ladder_mode,
        name: strip_format(&name_raw),
        name_raw,
        comment: strip_format(&comment_raw),
        comment_raw,
        pack_mask,
        player_list,
        mode_id: None,
        mode: None,
        limit: None,
        limit_kind: None,
        nb_maps: 0,
        maps: Vec::new(),
    };
    if r.left() == 0 {
        return Ok(info);
    }
    let mode = r.u8()?;
    let (mname, kind) = mode_name(mode);
    info.mode_id = Some(mode);
    info.mode = Some(mname);
    info.limit_kind = kind.map(|k| k.to_string());
    info.limit = Some(r.u32()?);
    info.nb_maps = r.u8()?;
    let m = r.count(11)?;
    // Forever: (name, gold, copper u16, env index u8); legacy: (name, decoration, gold, copper u32).
    struct Raw(String, u32, u32, u32);
    let mut raw = Vec::with_capacity(m.min(64));
    for _ in 0..m {
        let name = r.text()?;
        if v.forever() {
            let gold = r.u32()?;
            let copper = r.u16()? as u32;
            let env = r.u8()? as u32;
            raw.push(Raw(name, gold, copper, env));
        } else {
            let deco = r.u32()?;
            let gold = r.u32()?;
            let copper = r.u32()?;
            raw.push(Raw(name, gold, copper, deco));
        }
    }
    let mut envs: Vec<String> = Vec::new();
    if v.forever() {
        let k = r.count(4)?;
        let mut table: Vec<String> = Vec::new();
        let mut version: Option<u32> = None;
        for _ in 0..k {
            if version.is_none() {
                version = Some(r.u32()?);
            }
            let val = r.u32()?;
            if val == 0xFFFF_FFFF {
                envs.push(String::new());
            } else if matches!(val & 0xC000_0000, 0x4000_0000 | 0x8000_0000) {
                if version == Some(2) || val & 0x0FFF_FFFF == 0 {
                    let s = r.text()?;
                    table.push(s.clone());
                    envs.push(s);
                } else {
                    let idx = (val & 0x0FFF_FFFF) as usize;
                    envs.push(table.get(idx - 1).cloned().ok_or_else(|| QueryError::Protocol("bad id reference".into()))?);
                }
            } else {
                envs.push(val.to_string());
            }
        }
    }
    for Raw(name, gold, copper, x) in raw {
        let (environment, mood) = if v.forever() {
            (envs.get(x as usize).cloned().unwrap_or_default(), String::new())
        } else {
            decoration(v, x).unwrap_or_default()
        };
        info.maps.push(MapEntry { name: strip_format(&name), name_raw: name, gold_ms: gold, copper, environment, mood });
    }
    Ok(info)
}

// ------------------------------------------------------------------ network

#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub connect: Duration,
    /// After the connection stands: time for the whole answer.
    pub answer: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts { connect: Duration::from_secs(3), answer: Duration::from_secs(4) }
    }
}

impl Timeouts {
    /// For the server list: a live server connects in well under 0.3 s (measured 2026-11-13 over the
    /// 94 known servers: median 0.06 s, slowest 0.2 s); a dead one should not hold a row for 7 s.
    pub fn list() -> Self {
        Timeouts { connect: Duration::from_millis(1500), answer: Duration::from_millis(2500) }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Queried {
    pub info: ServerInfo,
    /// Time the TCP connect took.
    pub ping_ms: u32,
    /// Protocol version that worked (4 or 5 for the legacy games).
    pub version: u32,
}

fn connect(addr: &str, timeout: Duration) -> Result<(TcpStream, u32), QueryError> {
    let mut addrs: Vec<SocketAddr> = addr.to_socket_addrs().map_err(|e| QueryError::Dns(e.to_string()))?.collect();
    if addrs.is_empty() {
        return Err(QueryError::Dns("no address".into()));
    }
    addrs.sort_by_key(|a| a.is_ipv6());
    let started = Instant::now();
    let mut last = QueryError::Timeout;
    for a in addrs.into_iter().take(2) {
        let left = timeout.saturating_sub(started.elapsed());
        if left.is_zero() {
            break;
        }
        let t0 = Instant::now();
        match TcpStream::connect_timeout(&a, left) {
            Ok(s) => return Ok((s, t0.elapsed().as_millis().min(u32::MAX as u128) as u32)),
            Err(e) => last = io_err(e),
        }
    }
    Err(last)
}

fn read_frame(s: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>, QueryError> {
    let mut read = |buf: &mut [u8]| -> Result<(), QueryError> {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(QueryError::Timeout);
        }
        s.set_read_timeout(Some(left)).map_err(io_err)?;
        s.read_exact(buf).map_err(io_err)
    };
    let mut len = [0u8; 4];
    read(&mut len)?;
    let n = u32::from_le_bytes(len) as usize;
    if !(2..=MAX_FRAME).contains(&n) {
        return proto("bad frame length");
    }
    let mut buf = vec![0u8; n];
    read(&mut buf)?;
    Ok(buf)
}

/// Queries one server. `request_id` is echoed by the server (any value but 0xFFFFFFFF).
pub fn query_with_id(addr: &str, v: Variant, version: u32, request_id: u32, t: Timeouts) -> Result<Queried, QueryError> {
    let (mut s, ping_ms) = connect(addr, t.connect)?;
    let _ = s.set_nodelay(true);
    let deadline = Instant::now() + t.answer;
    let mut req = connection_admin(v, version, 8, &[]);
    req.extend(connection_admin(v, version, 7, &[request_id]));
    s.set_write_timeout(Some(t.answer)).map_err(io_err)?;
    s.write_all(&req).map_err(io_err)?;
    for _ in 0..16 {
        let msg = read_frame(&mut s, deadline)?;
        let (ty, payload) = decode_message(v, &msg)?;
        if ty != 3 {
            continue;
        }
        let mut r = Rd::new(&payload);
        let (server_version, subtype) = (r.u32()?, r.u32()?);
        if subtype == 1 {
            return Err(if v.forever() { QueryError::Protocol("query refused".into()) } else { QueryError::Rejected(server_version) });
        }
        if subtype != 6 {
            continue;
        }
        let id = r.u32()?;
        let n = r.u32()? as usize;
        let data = r.take(n)?;
        if id == 0xFFFF_FFFF {
            return Err(QueryError::NoInfo);
        }
        if id != request_id {
            continue;
        }
        return Ok(Queried { info: parse_server_info(data, v)?, ping_ms, version });
    }
    proto("no matching answer")
}

fn random_id() -> u32 {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(1) as u64;
    let x = (n ^ (n >> 17)).wrapping_mul(0x9E3779B97F4A7C15) >> 33;
    (x as u32 & 0x7FFF_FFFF).max(1)
}

/// Queries one server of a game ("tmnf", "tmuf", "tmo", "tms", "eswc") at "host:port".
/// A legacy server that wants the other protocol version (4 or 5) is asked again once.
pub fn query(addr: &str, game: &str, t: Timeouts) -> Result<Queried, QueryError> {
    let v = Variant::of_game(game).ok_or_else(|| QueryError::Protocol(format!("unknown game {game}")))?;
    match query_with_id(addr, v, v.version(), random_id(), t) {
        Err(QueryError::Rejected(sv)) if sv != v.version() && matches!(sv, 4 | 5) && !v.forever() => query_with_id(addr, v, sv, random_id(), t),
        other => other,
    }
}

// ------------------------------------------------------------------ addresses

pub const DEFAULT_PORT: u16 = 2350;

/// "host:port" from what a player pastes: `1.2.3.4`, `1.2.3.4:2350`, `host.example:2352`,
/// `tmtp://#join=1.2.3.4:2350`. A bare server login (as in `tmtp://#join=login`) is not enough:
/// the query needs the address. Errors are codes for the UI: "needs-address", "bad-address".
pub fn parse_address(input: &str) -> Result<String, String> {
    let t = input.trim().trim_matches(|c| matches!(c, '<' | '>' | '"' | '\''));
    let lower = t.to_ascii_lowercase();
    let rest = if let Some(i) = lower.find("#join=") {
        &t[i + 6..]
    } else if lower.starts_with("tmtp://") {
        &t[7..]
    } else {
        t
    };
    let token = rest.split_whitespace().next().unwrap_or("");
    if token.contains('/') {
        return Err("bad-address".into());
    }
    // login:password is possible in a join link, so a number after the colon decides.
    let (host, port) = match token.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h, Some(p)),
        _ => (token, None),
    };
    let hostc = host.to_ascii_lowercase();
    if hostc.is_empty() || !hostc.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err("bad-address".into());
    }
    if !hostc.contains('.') && hostc != "localhost" {
        // No dot: a server login, not an address.
        return Err("needs-address".into());
    }
    if hostc.starts_with(['.', '-']) || hostc.ends_with(['.', '-']) || hostc.contains('_') || hostc.contains("..") {
        return Err("bad-address".into());
    }
    let port = match port {
        None | Some("") => DEFAULT_PORT,
        Some(p) => match p.parse::<u32>() {
            Ok(n) if (1..=65535).contains(&n) => n as u16,
            _ => return Err("bad-address".into()),
        },
    };
    // Names made of digits and dots must be a real IPv4 address.
    let parts: Vec<&str> = hostc.split('.').collect();
    if parts.iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())) && (parts.len() != 4 || parts.iter().any(|p| p.parse::<u16>().map_or(true, |n| n > 255))) {
        return Err("bad-address".into());
    }
    Ok(format!("{hostc}:{port}"))
}

// ------------------------------------------------------------------ registry

pub const GAMES: [&str; 5] = ["tmnf", "tmuf", "tmo", "tms", "eswc"];
const MAX_SERVERS: usize = 500;
const REG_FILE: &str = "server-registry.json";

/// Bundled servers (game, address, name). The 100% TMX project's randomizer servers (public game ports
/// from its deploy docs: TMNF 2350, TMUF 2351, ESWC 2352 on game.100tmx.com), then public TMNF servers
/// seen in a server list on 2026-11-11 (ports as listed, names not known).
pub const SEEDS: &[(&str, &str, Option<&str>)] = &[
    ("tmnf", "game.100tmx.com:2350", Some("100% TMX (Nations Forever)")),
    ("tmuf", "game.100tmx.com:2351", Some("100% TMX (United Forever)")),
    ("eswc", "game.100tmx.com:2352", Some("100% TMX (Nations ESWC)")),
    ("tmnf", "5.175.222.165:7012", None),
    ("tmnf", "57.131.192.66:2678", None),
    ("tmnf", "31.14.17.75:23060", None),
    ("tmnf", "87.237.52.153:2352", None),
    ("tmnf", "91.122.55.213:2312", None),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegEntry {
    pub game: String,
    pub address: String,
    #[serde(default)]
    pub name: Option<String>,
    /// "seed" (bundled, may be outdated) or "user".
    #[serde(default = "user_src")]
    pub source: String,
    /// Community entries only: listed by a community member, the operator has not claimed it (hub index `suggested`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub suggested: bool,
}
fn user_src() -> String {
    "user".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Registry {
    pub v: u32,
    /// Live status on/off (Settings > Servers).
    pub enabled: bool,
    pub servers: Vec<RegEntry>,
    /// Seeds the player removed ("game|address"), so they do not come back.
    pub seeds_removed: Vec<String>,
    /// Servers the hub lists (approved by an admin, from the signed hub index). Replaced on every
    /// index refresh; not part of exports and not removable one by one.
    pub community: Vec<RegEntry>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry { v: 1, enabled: true, servers: Vec::new(), seeds_removed: Vec::new(), community: Vec::new() }
    }
}

fn clean_name(n: Option<String>) -> Option<String> {
    let n = n?;
    let n: String = n.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(80).collect();
    if n.is_empty() {
        None
    } else {
        Some(n)
    }
}

impl Registry {
    pub fn load(dir: &Path) -> Registry {
        let mut r: Registry = std::fs::read(dir.join(REG_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        r.servers.retain(|s| GAMES.contains(&s.game.as_str()) && parse_address(&s.address).is_ok());
        r.servers.truncate(MAX_SERVERS);
        r.add_seeds();
        r
    }
    fn add_seeds(&mut self) {
        for (g, a, n) in SEEDS {
            let key = format!("{g}|{a}");
            if !self.seeds_removed.contains(&key) && !self.has(g, a) {
                self.servers.push(RegEntry { game: g.to_string(), address: a.to_string(), name: n.map(String::from), source: "seed".into(), suggested: false });
            }
        }
    }
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!("{REG_FILE}.tmp"));
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, dir.join(REG_FILE)).map_err(|e| e.to_string())
    }
    /// What the UI and the poll see: own and seed entries, then the hub's (not twice).
    pub fn merged(&self) -> Registry {
        let mut r = self.clone();
        for c in &self.community {
            if !r.has(&c.game, &c.address) {
                r.servers.push(c.clone());
            }
        }
        r
    }
    /// Replaces the hub's servers (game, address, name, suggested). Bad entries are dropped.
    pub fn set_community(&mut self, list: Vec<(String, String, Option<String>, bool)>) -> usize {
        self.community = list
            .into_iter()
            .filter(|(g, _, _, _)| GAMES.contains(&g.as_str()))
            .filter_map(|(g, a, n, s)| Some(RegEntry { game: g, address: parse_address(&a).ok()?, name: clean_name(n), source: "community".into(), suggested: s }))
            .take(MAX_SERVERS)
            .collect();
        self.community.len()
    }
    fn has(&self, game: &str, address: &str) -> bool {
        self.servers.iter().any(|s| s.game == game && s.address == address)
    }
    /// Adds a server from pasted text. Errors are codes: needs-address, bad-address, bad-game, exists, full.
    pub fn add(&mut self, game: &str, input: &str, name: Option<String>) -> Result<RegEntry, String> {
        if !GAMES.contains(&game) {
            return Err("bad-game".into());
        }
        let address = parse_address(input)?;
        if self.has(game, &address) {
            return Err("exists".into());
        }
        if self.servers.len() >= MAX_SERVERS {
            return Err("full".into());
        }
        self.seeds_removed.retain(|k| k != &format!("{game}|{address}"));
        let e = RegEntry { game: game.into(), address, name: clean_name(name), source: "user".into(), suggested: false };
        self.servers.push(e.clone());
        Ok(e)
    }
    pub fn remove(&mut self, game: &str, address: &str) -> bool {
        let Some(i) = self.servers.iter().position(|s| s.game == game && s.address == address) else { return false };
        if self.servers[i].source == "seed" {
            self.seeds_removed.push(format!("{game}|{address}"));
        }
        self.servers.remove(i);
        true
    }
    pub fn reset_seeds(&mut self) {
        self.seeds_removed.clear();
        self.add_seeds();
    }
    pub fn export(&self) -> String {
        #[derive(Serialize)]
        struct Out<'a> {
            format: &'a str,
            v: u32,
            servers: Vec<Item<'a>>,
        }
        #[derive(Serialize)]
        struct Item<'a> {
            game: &'a str,
            address: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            name: Option<&'a str>,
        }
        let servers = self.servers.iter().map(|s| Item { game: &s.game, address: &s.address, name: s.name.as_deref() }).collect();
        serde_json::to_string_pretty(&Out { format: "tm-horizon-servers", v: 1, servers }).unwrap_or_default()
    }
    /// Adds the servers of an export (or a plain JSON array of {game,address,name}). Returns (added, skipped).
    pub fn import(&mut self, json: &str) -> Result<(usize, usize), String> {
        #[derive(Deserialize)]
        struct Item {
            game: String,
            address: String,
            #[serde(default)]
            name: Option<String>,
        }
        #[derive(Deserialize)]
        struct Doc {
            servers: Vec<Item>,
        }
        if json.len() > 1 << 20 {
            return Err("too-big".into());
        }
        let items: Vec<Item> = match serde_json::from_str::<Doc>(json) {
            Ok(d) => d.servers,
            Err(_) => serde_json::from_str::<Vec<Item>>(json).map_err(|_| "bad-file".to_string())?,
        };
        let (mut added, mut skipped) = (0, 0);
        for it in items {
            match self.add(&it.game, &it.address, it.name) {
                Ok(_) => added += 1,
                Err(_) => skipped += 1,
            }
        }
        Ok((added, skipped))
    }
}

// ------------------------------------------------------------------ scheduler

/// Never more than one query per server in this time.
pub const MIN_GAP: Duration = Duration::from_secs(30);
/// A server that failed twice in a row is left alone for this long.
pub const OFFLINE_SKIP: Duration = Duration::from_secs(600);
/// Connections at once: one per server, to different hosts, so many are fine (was 4: 94 servers with a
/// third of them dead took about 30 s).
pub const MAX_PARALLEL: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusRow {
    pub game: String,
    pub address: String,
    /// "ok" or "offline".
    pub state: String,
    /// Fresh info, or the last good info of a server that is offline now (then `state` is "offline").
    pub info: Option<ServerInfo>,
    pub ping_ms: Option<u32>,
    /// Unix ms of the last real query.
    pub checked_at: u64,
    /// Short error code of the last failure: dns, timeout, refused, io, protocol, noinfo.
    pub error: Option<String>,
    pub error_text: Option<String>,
    /// This answer comes from memory (rate limit or offline skip), no new connection was made.
    pub cached: bool,
    /// Unix ms until which the server is not asked again (0 = no pause).
    pub paused_until: u64,
}

struct Entry {
    last_query: Option<Instant>,
    row: Option<StatusRow>,
    fails: u32,
    skip_until: Option<Instant>,
    last_good: Option<(ServerInfo, u32)>,
}

fn table() -> &'static Mutex<HashMap<String, Entry>> {
    static T: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Core of the scheduler, with the query function injected (tests use a fake).
pub fn status_with<F>(wanted: &[(String, String)], force: bool, parallel: usize, ask: F) -> Vec<StatusRow>
where
    F: Fn(&str, &str) -> Result<Queried, QueryError> + Sync,
{
    status_stream(wanted, force, parallel, ask, &|_| {})
}

/// The row of a finished query; updates the server's entry (failure count, pause, last good info).
fn finish_row(e: &mut Entry, g: &str, a: &str, res: Result<Queried, QueryError>) -> StatusRow {
    let checked_at = now_ms();
    let row = match res {
        Ok(q) => {
            e.fails = 0;
            e.skip_until = None;
            e.last_good = Some((q.info.clone(), q.ping_ms));
            StatusRow { game: g.into(), address: a.into(), state: "ok".into(), info: Some(q.info), ping_ms: Some(q.ping_ms), checked_at, error: None, error_text: None, cached: false, paused_until: 0 }
        }
        Err(err) => {
            e.fails += 1;
            // First failure: ask again next round. Second in a row: pause for 10 minutes.
            if e.fails >= 2 {
                e.skip_until = Some(Instant::now() + OFFLINE_SKIP);
            }
            let paused_until = e.skip_until.map_or(0, |u| now_ms() + u.saturating_duration_since(Instant::now()).as_millis() as u64);
            let last = e.last_good.clone();
            StatusRow { game: g.into(), address: a.into(), state: "offline".into(), info: last.as_ref().map(|l| l.0.clone()), ping_ms: None, checked_at, error: Some(err.code().into()), error_text: Some(err.to_string()), cached: false, paused_until }
        }
    };
    e.row = Some(row.clone());
    row
}

/// Like `status_with`, and `on_row` gets every fresh row the moment its query finishes (the page shows
/// servers as they answer instead of waiting for the slowest one).
pub fn status_stream<F>(wanted: &[(String, String)], force: bool, parallel: usize, ask: F, on_row: &(dyn Fn(&StatusRow) + Sync)) -> Vec<StatusRow>
where
    F: Fn(&str, &str) -> Result<Queried, QueryError> + Sync,
{
    // Decide who really needs a connection; mark them as asked right away so a second call at the
    // same time does not double the load.
    let mut todo: Vec<usize> = Vec::new();
    {
        let mut t = table().lock().unwrap();
        for (i, (g, a)) in wanted.iter().enumerate() {
            let e = t.entry(format!("{g}|{a}")).or_insert(Entry { last_query: None, row: None, fails: 0, skip_until: None, last_good: None });
            let recent = e.last_query.map_or(false, |q| q.elapsed() < MIN_GAP);
            let paused = !force && e.skip_until.map_or(false, |u| Instant::now() < u);
            if !recent && !paused {
                e.last_query = Some(Instant::now());
                todo.push(i);
            }
        }
    }
    let next = AtomicUsize::new(0);
    let fresh: Mutex<HashMap<usize, StatusRow>> = Mutex::new(HashMap::new());
    let workers = parallel.clamp(1, MAX_PARALLEL).min(todo.len().max(1));
    std::thread::scope(|sc| {
        for _ in 0..workers {
            sc.spawn(|| loop {
                let k = next.fetch_add(1, Ordering::SeqCst);
                let Some(&i) = todo.get(k) else { break };
                let (g, a) = &wanted[i];
                let res = ask(g, a);
                let row = {
                    let mut t = table().lock().unwrap();
                    let e = t.get_mut(&format!("{g}|{a}")).expect("entry exists");
                    finish_row(e, g, a, res)
                };
                on_row(&row);
                fresh.lock().unwrap().insert(i, row);
            });
        }
    });
    let mut done = fresh.into_inner().unwrap();
    let t = table().lock().unwrap();
    wanted
        .iter()
        .enumerate()
        .map(|(i, (g, a))| {
            if let Some(row) = done.remove(&i) {
                return row;
            }
            let e = t.get(&format!("{g}|{a}")).expect("entry exists");
            if let Some(mut row) = e.row.clone() {
                row.cached = true;
                row.paused_until = e.skip_until.map_or(0, |u| now_ms() + u.saturating_duration_since(Instant::now()).as_millis() as u64);
                row
            } else {
                // Asked by another call that has not finished yet.
                StatusRow { game: g.clone(), address: a.clone(), state: "pending".into(), info: None, ping_ms: None, checked_at: 0, error: None, error_text: None, cached: true, paused_until: 0 }
            }
        })
        .collect()
}

// ------------------------------------------------------------------ last results on disk

/// The last good answer of every server, kept between launcher runs so the list is filled at once.
fn status_cache_file(data: &Path) -> PathBuf {
    data.join("server-status-cache.json")
}

/// Rows from the last runs (state "ok", marked `cached`) of the given games; empty without a file.
pub fn load_status_cache(data: &Path, games: &[String]) -> Vec<StatusRow> {
    let rows: Vec<StatusRow> = std::fs::read(status_cache_file(data)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    rows.into_iter()
        .filter(|r| games.iter().any(|g| g == &r.game) && r.info.is_some())
        .map(|mut r| {
            r.cached = true;
            r.paused_until = 0;
            r
        })
        .collect()
}

/// Merges fresh good rows into the file (servers that did not answer keep their last good row).
pub fn save_status_cache(data: &Path, rows: &[StatusRow]) {
    if !rows.iter().any(|r| r.state == "ok" && !r.cached) {
        return;
    }
    let mut all: Vec<StatusRow> = std::fs::read(status_cache_file(data)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    for r in rows.iter().filter(|r| r.state == "ok" && !r.cached && r.info.is_some()) {
        all.retain(|x| !(x.game == r.game && x.address == r.address));
        all.push(r.clone());
    }
    let skip = all.len().saturating_sub(2000);
    let _ = crate::fsx::write(&status_cache_file(data), &serde_json::to_vec(&all[skip..]).unwrap_or_default());
}

// ------------------------------------------------------------------ commands

fn reg_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn with_registry<T>(dir: &PathBuf, f: impl FnOnce(&mut Registry) -> Result<T, String>) -> Result<T, String> {
    let _g = reg_lock().lock().map_err(|_| "locked".to_string())?;
    let mut r = Registry::load(dir);
    let before = r.clone();
    let out = f(&mut r)?;
    if r != before || !dir.join(REG_FILE).exists() {
        r.save(dir)?;
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn server_registry(st: State<AppState>) -> Result<Registry, String> {
    with_registry(&st.data_dir, |r| Ok(r.merged()))
}

#[derive(Deserialize)]
pub struct CommunityIn {
    pub game: String,
    pub address: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub suggested: bool,
}

/// The hub's approved servers (from the verified hub index), shown as "Community".
#[tauri::command(async)]
pub fn server_registry_set_community(st: State<AppState>, servers: Vec<CommunityIn>) -> Result<usize, String> {
    with_registry(&st.data_dir, |r| Ok(r.set_community(servers.into_iter().map(|s| (s.game, s.address, s.name, s.suggested)).collect())))
}

#[tauri::command(async)]
pub fn server_registry_add(st: State<AppState>, game: String, input: String, name: Option<String>) -> Result<RegEntry, String> {
    with_registry(&st.data_dir, |r| r.add(&game, &input, name))
}

#[tauri::command(async)]
pub fn server_registry_remove(st: State<AppState>, game: String, address: String) -> Result<bool, String> {
    with_registry(&st.data_dir, |r| Ok(r.remove(&game, &address)))
}

#[tauri::command]
pub async fn server_registry_export(app: tauri::AppHandle) -> Result<String, String> {
    crate::bg::run(move || -> Result<String, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        with_registry(&st.data_dir, |r| Ok(r.export()))
    })
    .await
}

#[derive(Serialize)]
pub struct ImportResult {
    pub added: usize,
    pub skipped: usize,
}

#[tauri::command]
pub async fn server_registry_import(app: tauri::AppHandle, json: String) -> Result<ImportResult, String> {
    crate::bg::run(move || -> Result<ImportResult, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        with_registry(&st.data_dir, |r| r.import(&json).map(|(added, skipped)| ImportResult { added, skipped }))
    })
    .await
}

#[tauri::command(async)]
pub fn server_registry_reset_seeds(st: State<AppState>) -> Result<Registry, String> {
    with_registry(&st.data_dir, |r| {
        r.reset_seeds();
        Ok(r.merged())
    })
}

#[tauri::command(async)]
pub fn server_query_enable(st: State<AppState>, enabled: bool) -> Result<(), String> {
    with_registry(&st.data_dir, |r| {
        r.enabled = enabled;
        Ok(())
    })
}

/// Live status of the known servers of one game (all of them when `address` is empty).
/// `force` skips the 10 minute pause of failing servers (the 30 s gap per server always applies).
#[tauri::command]
pub async fn server_status(app: tauri::AppHandle, game: String, force: bool) -> Result<Vec<StatusRow>, String> {
    crate::bg::run(move || -> Result<Vec<StatusRow>, String> {
        let st = tauri::Manager::state::<AppState>(&app);
        let reg = with_registry(&st.data_dir, |r| Ok(r.merged()))?;
        if !reg.enabled {
            return Ok(Vec::new());
        }
        let wanted: Vec<(String, String)> = reg.servers.iter().filter(|s| s.game == game).map(|s| (s.game.clone(), s.address.clone())).collect();
        let rows = status_with(&wanted, force, MAX_PARALLEL, |g, a| query(a, g, Timeouts::list()));
        save_status_cache(&st.data_dir, &rows);
        Ok(rows)
    })
    .await
}

/// Live status of the known servers of several games in one go: all queries run at once (up to
/// MAX_PARALLEL), every finished one is sent right away as the event `server-status-row`, the full list
/// is the answer. Good answers are kept on disk for the next start (`server_status_cached`).
#[tauri::command]
pub async fn server_status_all(app: tauri::AppHandle, games: Vec<String>, force: bool) -> Result<Vec<StatusRow>, String> {
    crate::bg::run(move || -> Result<Vec<StatusRow>, String> {
        use tauri::Emitter;
        let st = tauri::Manager::state::<AppState>(&app);
        let reg = with_registry(&st.data_dir, |r| Ok(r.merged()))?;
        if !reg.enabled {
            return Ok(Vec::new());
        }
        let wanted: Vec<(String, String)> = reg.servers.iter().filter(|s| games.contains(&s.game)).map(|s| (s.game.clone(), s.address.clone())).collect();
        let t0 = Instant::now();
        let first = Mutex::new(None::<u128>);
        let emit = |row: &StatusRow| {
            first.lock().unwrap().get_or_insert(t0.elapsed().as_millis());
            let _ = app.emit("server-status-row", row);
        };
        let rows = status_stream(&wanted, force, MAX_PARALLEL, |g, a| query(a, g, Timeouts::list()), &emit);
        save_status_cache(&st.data_dir, &rows);
        let fresh = rows.iter().filter(|r| !r.cached).count();
        let first = first.into_inner().unwrap().unwrap_or(0);
        crate::perf::log(&st, &format!("servers: {} servers ({fresh} asked), first answer after {first} ms", rows.len()), t0.elapsed().as_millis());
        Ok(rows)
    })
    .await
}

/// The last good answers from the previous runs, for an instant list before the live query.
#[tauri::command(async)]
pub fn server_status_cached(st: State<AppState>, games: Vec<String>) -> Vec<StatusRow> {
    load_status_cache(&st.data_dir, &games)
}

#[cfg(test)]
#[path = "serverquery_vectors.rs"]
mod vectors;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serverquery::vectors::*;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicU32;

    fn hex(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    #[test]
    fn md5_and_hmac_known_answers() {
        assert_eq!(hex::encode(md5(b"")), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hex::encode(md5(b"abc")), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(hex::encode(md5(&[b'a'; 1000])), "cabe45dcc9ae5b66ba86600cca6b8ba8");
        // RFC 2202 test case 2
        assert_eq!(hex::encode(hmac_md5(b"Jefe", b"what do ya want for nothing?")), "750c783e6ab0b503eaa86e310a5db738");
        // RFC 2202 test case 1
        assert_eq!(hex::encode(hmac_md5(&[0x0b; 16], b"Hi There")), "9294727a3638bb1c13f48ef8158bfc9d");
    }

    #[test]
    fn requests_match_game_clients() {
        assert_eq!(connection_admin(Variant::Forever, 7, 8, &[]), hex(FOREVER_CLIENT_QUERY_MODE));
        assert_eq!(connection_admin(Variant::Forever, 7, 7, &[0x0041_3DD5]), hex(FOREVER_CLIENT_INFO_REQUEST));
        assert_eq!(connection_admin(Variant::Sunrise, 4, 8, &[]), hex(SUNRISE_CLIENT_QUERY_MODE));
        assert_eq!(connection_admin(Variant::Sunrise, 4, 7, &[0x1234]), hex(SUNRISE_CLIENT_INFO_REQUEST));
    }

    fn reply_payload(v: Variant, reply: &str) -> Vec<u8> {
        let f = hex(reply);
        let (ty, p) = decode_message(v, &f[4..]).unwrap();
        assert_eq!(ty, 3);
        p
    }

    #[test]
    fn forever_capture_parses() {
        let p = reply_payload(Variant::Forever, FOREVER_SERVER_INFO_REPLY);
        assert_eq!(p.len(), 155);
        let info = parse_server_info(&p[16..], Variant::Forever).unwrap();
        assert_eq!(info.name, "Kawabonga");
        assert_eq!((info.players, info.max_players, info.spectators, info.max_spectators), (1, 6, 0, 6));
        assert_eq!(info.mode.as_deref(), Some("TimeAttack"));
        assert_eq!((info.limit, info.limit_kind.as_deref()), (Some(300000), Some("ms")));
        assert_eq!(info.host_login, "PC-ce9b0c");
        assert_eq!(info.reported_address, "172.29.100.29:2350");
        assert_eq!(info.pack_mask.as_deref(), Some("Stadium"));
        assert!(!info.password && !info.spectator_password);
        assert_eq!(info.player_list.len(), 1);
        assert_eq!(info.player_list[0].ladder_rank, -1);
        assert_eq!(info.nb_maps, 1);
        assert_eq!(info.maps.len(), 1);
        let m = &info.maps[0];
        assert_eq!((m.name.as_str(), m.gold_ms, m.copper, m.environment.as_str()), ("B02-Race", 29050, 697, "Stadium"));
    }

    #[test]
    fn forever_dedicated_info_parses() {
        let info = parse_server_info(&hex(FOREVER_DEDICATED_SERVER_INFO), Variant::Forever).unwrap();
        assert_eq!(info.name_raw, "$o$f00DGN $fffLive-Test");
        assert_eq!(info.name, "DGN Live-Test");
        assert_eq!(info.comment, "Live-Test Kommentar äöü");
        assert_eq!((info.players, info.max_players, info.spectators, info.max_spectators), (0, 6, 0, 4));
        assert_eq!((info.mode.as_deref(), info.mode_id, info.limit), (Some("Rounds"), Some(3), Some(30)));
        assert_eq!(info.limit_kind.as_deref(), Some("points"));
        assert_eq!(info.nb_maps, 15);
        assert_eq!(info.maps.len(), 15);
        assert_eq!(info.maps[7].name, "B08-Endurance");
        assert_eq!(info.maps[7].gold_ms, 107960);
        assert!(info.maps.iter().all(|m| m.environment == "Stadium"));
    }

    #[test]
    fn password_flags() {
        let base = parse_server_info(&reply_payload(Variant::Forever, FOREVER_SERVER_INFO_REPLY)[16..], Variant::Forever).unwrap();
        assert!(!base.password);
        let mut data = reply_payload(Variant::Forever, FOREVER_SERVER_INFO_REPLY)[16..].to_vec();
        let at = data.windows(5).position(|w| w == b"#SRV#").unwrap();
        for (flag, p, s) in [(b'p', true, false), (b's', false, true), (b'f', true, true)] {
            let mut d = data.clone();
            d.splice(at - 4..at + 5, [6, 0, 0, 0].into_iter().chain(*b"#SRV#").chain([flag]));
            let i = parse_server_info(&d, Variant::Forever).unwrap();
            assert_eq!((i.password, i.spectator_password), (p, s));
            assert_eq!(i.name, "Kawabonga");
        }
        data[0] = 0x2E;
        assert!(parse_server_info(&data, Variant::Forever).is_err());
    }

    #[test]
    fn corrupted_and_truncated_input_is_rejected() {
        let mut f = hex(FOREVER_SERVER_INFO_REPLY);
        *f.last_mut().unwrap() ^= 0xFF;
        assert!(decode_message(Variant::Forever, &f[4..]).is_err());
        let p = reply_payload(Variant::Forever, FOREVER_SERVER_INFO_REPLY);
        for cut in [20, 40, 60, 100, 150] {
            assert!(parse_server_info(&p[16..cut], Variant::Forever).is_err(), "cut {cut}");
        }
        // a Forever answer is not accepted with the legacy key and the other way round
        assert!(decode_message(Variant::Sunrise, &hex(SUNRISE_TMNF_INFO_REPLY)[4..]).is_err());
        assert!(decode_message(Variant::Forever, &hex(SUNRISE_SERVER_INFO_REPLY)[4..]).is_err());
        assert!(decode_message(Variant::Sunrise, &[0x80, 0x03, 4, 0, 0, 0, 8, 0, 0, 0]).is_err());
    }

    #[test]
    fn sunrise_capture_parses() {
        let p = reply_payload(Variant::Sunrise, SUNRISE_SERVER_INFO_REPLY);
        assert_eq!(p.len(), 631);
        let info = parse_server_info(&p[16..], Variant::Sunrise).unwrap();
        assert_eq!(info.name, "Sunrise LAN Server");
        assert_eq!(info.comment, "TrackMania Sunrise Extreme LAN");
        assert_eq!(info.host_login, "DESKTOP-JBKL5J0");
        assert_eq!(info.reported_address, "10.10.101.4:2350");
        assert_eq!((info.players, info.max_players, info.spectators, info.max_spectators), (0, 32, 0, 32));
        assert_eq!((info.mode.as_deref(), info.limit), (Some("TimeAttack"), Some(300000)));
        assert_eq!(info.nb_maps, 54);
        assert_eq!(info.maps.len(), 20);
        assert_eq!(info.maps[0].name, "NightFlight");
        assert_eq!((info.maps[0].gold_ms, info.maps[0].copper), (39150, 1451));
        assert_eq!((info.maps[0].environment.as_str(), info.maps[0].mood.as_str()), ("Island", "Night"));
        assert_eq!(info.maps[15].name, "HappyBay");
        assert_eq!(info.maps[19].name, "XRace05");
        let by = |n: &str| info.maps.iter().find(|m| m.name == n).unwrap();
        assert_eq!((by("HappyBay").environment.as_str(), by("HappyBay").mood.as_str()), ("Bay", "Day"));
        assert_eq!((by("Downtown").environment.as_str(), by("Downtown").mood.as_str()), ("Bay", "Night"));
        assert_eq!((by("ParadiseIsland").environment.as_str(), by("ParadiseIsland").mood.as_str()), ("Island", "Sunset"));
        // the Forever reply does not pass the legacy parser's tag check either
        assert!(parse_server_info(&reply_payload(Variant::Forever, FOREVER_SERVER_INFO_REPLY)[16..], Variant::Sunrise).is_err());
    }

    #[test]
    fn decoration_table() {
        let s = |v, i| decoration(v, i).map(|(a, b)| (a, b));
        let p = |a: &str, b: &str| Some((a.to_string(), b.to_string()));
        assert_eq!(s(Variant::Sunrise, 2), p("Bay", "Day"));
        assert_eq!(s(Variant::Sunrise, 5), p("Bay", "Sunset"));
        assert_eq!(s(Variant::Sunrise, 6), p("Bay", ""));
        assert_eq!(s(Variant::Sunrise, 7), p("Coast", "Day"));
        assert_eq!(s(Variant::Sunrise, 13), p("Island", "Night"));
        assert_eq!(s(Variant::Sunrise, 16), p("Island", ""));
        assert_eq!(s(Variant::Sunrise, 17), None);
        assert_eq!(s(Variant::Sunrise, 0), None);
        assert_eq!(s(Variant::Original, 2), p("Alpine", "10x150"));
        assert_eq!(s(Variant::Original, 3), p("Alpine", "10x150Sunrise"));
        assert_eq!(s(Variant::Original, 13), p("Alpine", "Simple"));
        assert_eq!(s(Variant::Original, 14), p("Alpine", ""));
        assert_eq!(s(Variant::Original, 15), p("Rally", "10x150"));
        assert_eq!(s(Variant::Original, 40), p("Speed", ""));
        assert_eq!(s(Variant::Original, 41), None);
        assert_eq!(s(Variant::Eswc, 2), p("Stadium", "Day"));
        assert_eq!(s(Variant::Eswc, 3), p("Stadium", ""));
        assert_eq!(s(Variant::Forever, 2), None);
    }

    /// Server info as a legacy server serialises it (after the opengsq test helper).
    fn legacy_info(tag: u8, name: &str, login: &str, players: &[&str]) -> Vec<u8> {
        fn w(text: &str) -> Vec<u8> {
            let mut d = text.as_bytes().to_vec();
            if !text.is_ascii() {
                d.splice(0..0, [0xEF, 0xBB, 0xBF]);
            }
            let mut o = (d.len() as u32).to_le_bytes().to_vec();
            o.extend(d);
            o
        }
        let mut d = vec![tag, 4, 101, 10, 10, 0x2E, 0x09];
        d.extend(w("HOST"));
        d.extend(w(login));
        d.extend(w(""));
        d.extend([players.len() as u8, 16, 0, 8, 0]);
        d.extend(w(name));
        d.extend((players.len() as u32).to_le_bytes());
        for p in players {
            d.extend(w(p));
        }
        for _ in players {
            d.extend((-1i32).to_le_bytes());
        }
        d.extend(w("Kommentar"));
        d.push(3);
        d.extend(30u32.to_le_bytes());
        d.push(1);
        d.extend(1u32.to_le_bytes());
        d.extend(w("A01-Race"));
        for x in [2u32, 25000, 600] {
            d.extend(x.to_le_bytes());
        }
        d
    }

    #[test]
    fn built_legacy_info() {
        let i = parse_server_info(&legacy_info(0x07, "$o$f00Grüne $fffWelle", "#SRV#", &["$f00Gamie", "Spieler 2"]), Variant::Original).unwrap();
        assert_eq!(i.name, "Grüne Welle");
        assert_eq!(i.name_raw, "$o$f00Grüne $fffWelle");
        assert_eq!((i.players, i.max_players, i.spectators, i.max_spectators), (2, 16, 0, 8));
        assert_eq!(i.player_list.iter().map(|p| p.name_raw.as_str()).collect::<Vec<_>>(), ["$f00Gamie", "Spieler 2"]);
        assert_eq!((i.mode.as_deref(), i.limit, i.limit_kind.as_deref()), (Some("Rounds"), Some(30), Some("points")));
        assert_eq!(i.maps[0].name, "A01-Race");
        assert_eq!(i.maps[0].environment, "Alpine");
        for (login, p, s) in [("#SRV#", false, false), ("#SRV#p", true, false), ("#SRV#s", false, true), ("#SRV#f", true, true)] {
            let i = parse_server_info(&legacy_info(0x07, "x", login, &[]), Variant::Sunrise).unwrap();
            assert_eq!((i.password, i.spectator_password), (p, s));
        }
        let e = parse_server_info(&legacy_info(0x09, "x", "#SRV#", &[]), Variant::Eswc).unwrap();
        assert_eq!((e.maps[0].environment.as_str(), e.maps[0].mood.as_str()), ("Stadium", "Day"));
        for tag in [0x2D, 0x0D, 0x27, 0x08] {
            assert!(parse_server_info(&legacy_info(tag, "x", "#SRV#", &[]), Variant::Sunrise).is_err());
        }
        // not a game server: login without #SRV#
        assert_eq!(parse_server_info(&legacy_info(0x07, "x", "plain", &[]), Variant::Sunrise), Err(QueryError::NoInfo));
    }

    #[test]
    fn format_codes() {
        assert_eq!(strip_format("$o$f00Kawa$fffbonga $$5"), "Kawabonga $5");
        assert_eq!(strip_format("$l[http://example.com]Link$l"), "Link");
        assert_eq!(strip_format("$s$i$wText$z"), "Text");
        assert_eq!(strip_format("Preis 5$"), "Preis 5$");
        assert_eq!(strip_format(""), "");
    }

    #[test]
    fn address_input() {
        assert_eq!(parse_address("5.175.222.165:7012").unwrap(), "5.175.222.165:7012");
        assert_eq!(parse_address(" 5.175.222.165 ").unwrap(), "5.175.222.165:2350");
        assert_eq!(parse_address("tmtp://#join=1.2.3.4:2352").unwrap(), "1.2.3.4:2352");
        assert_eq!(parse_address("tmtp://#join=Play.Example.com").unwrap(), "play.example.com:2350");
        assert_eq!(parse_address("tmtp://#join=my_login"), Err("needs-address".into()));
        assert_eq!(parse_address("tmtp://#join=mylogin"), Err("needs-address".into()));
        assert_eq!(parse_address("tmtp://#join=mylogin:secret"), Err("needs-address".into()));
        assert_eq!(parse_address("mylogin"), Err("needs-address".into()));
        assert_eq!(parse_address("1.2.3.4:0"), Err("bad-address".into()));
        assert_eq!(parse_address("1.2.3.4:99999"), Err("bad-address".into()));
        assert_eq!(parse_address("999.2.3.4"), Err("bad-address".into()));
        assert_eq!(parse_address("1.2.3"), Err("bad-address".into()));
        assert_eq!(parse_address(""), Err("bad-address".into()));
        assert_eq!(parse_address("a b.c"), Err("needs-address".into()));
        assert_eq!(parse_address("http://x.y/"), Err("bad-address".into()));
    }

    #[test]
    fn registry_seeds_add_remove_import_export() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path());
        assert_eq!(r.servers.len(), SEEDS.len());
        assert!(r.servers.iter().all(|s| s.source == "seed"));
        // every game with a server query but no public list of its own has a seed (ESWC: the 100% TMX server)
        for g in ["tmnf", "tmuf", "eswc"] {
            assert!(r.servers.iter().any(|s| s.game == g), "{g} has a seed");
        }
        assert!(r.servers.iter().all(|s| parse_address(&s.address).is_ok()), "seed addresses parse");
        assert_eq!(r.add("tmnf", "5.175.222.165:7012", None), Err("exists".into()));
        assert_eq!(r.add("tm2", "1.2.3.4", None), Err("bad-game".into()));
        assert_eq!(r.add("tmuf", "tmtp://#join=login", None), Err("needs-address".into()));
        let e = r.add("tms", "9.9.9.9:2351", Some("  My\nserver ".into())).unwrap();
        assert_eq!(e.name.as_deref(), Some("Myserver"));
        assert!(r.remove("tmnf", "5.175.222.165:7012"));
        assert!(!r.remove("tmnf", "5.175.222.165:7012"));
        r.save(dir.path()).unwrap();
        let again = Registry::load(dir.path());
        assert_eq!(again.servers.len(), SEEDS.len(), "removed seed stays removed");
        assert!(!again.servers.iter().any(|s| s.address == "5.175.222.165:7012"));
        let json = again.export();
        let mut other = Registry { servers: vec![], seeds_removed: SEEDS.iter().map(|(g, a, _)| format!("{g}|{a}")).collect(), ..Registry::default() };
        let (added, skipped) = other.import(&json).unwrap();
        assert_eq!((added, skipped), (SEEDS.len(), 0));
        assert_eq!(other.import(&json).unwrap(), (0, SEEDS.len()));
        assert!(other.import("not json").is_err());
        assert_eq!(other.import(r#"[{"game":"eswc","address":"2.2.2.2"},{"game":"x","address":"2.2.2.2"}]"#).unwrap(), (1, 1));
        let mut again = again;
        again.reset_seeds();
        assert_eq!(again.servers.len(), SEEDS.len() + 1);
        // hub servers: merged after the player's own, never twice, bad ones dropped, not exported
        let mut c = Registry::load(dir.path());
        let n = c.set_community(vec![
            ("tmnf".into(), "57.131.192.66:2678".into(), Some("same as a seed".into()), false),
            ("tmnf".into(), "7.7.7.7:2350".into(), Some("Hub server".into()), true),
            ("tm2".into(), "8.8.8.8".into(), None, false),
            ("tmuf".into(), "login-only".into(), None, false),
        ]);
        assert_eq!(n, 1 + 1);
        let m = c.merged();
        assert_eq!(m.servers.len(), c.servers.len() + 1);
        assert_eq!(m.servers.last().unwrap().source, "community");
        assert!(m.servers.last().unwrap().suggested);
        assert!(!c.export().contains("7.7.7.7"));
        assert!(!c.remove("tmnf", "7.7.7.7:2350"));
        // a damaged file falls back to the defaults
        std::fs::write(dir.path().join(REG_FILE), b"{oops").unwrap();
        assert_eq!(Registry::load(dir.path()).servers.len(), SEEDS.len());
    }

    // ---- fake servers

    /// Serves `reply_frames` after reading the two requests; returns the port and what was received.
    fn fake_server(reply_frames: Vec<Vec<u8>>) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut got = Vec::new();
            for _ in 0..2 {
                let mut len = [0u8; 4];
                s.read_exact(&mut len).unwrap();
                let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
                s.read_exact(&mut body).unwrap();
                got.extend(len);
                got.extend(body);
            }
            for f in reply_frames {
                s.write_all(&f).unwrap();
            }
            got
        });
        (port, h)
    }

    #[test]
    fn query_against_fake_forever_server() {
        let good = hex(FOREVER_SERVER_INFO_REPLY);
        // an unrelated type-5 message first, then the real answer
        let other = frame(&build_message(Variant::Forever, 5, &[0u8; 8]));
        let (port, h) = fake_server(vec![other, good]);
        let q = query_with_id(&format!("127.0.0.1:{port}"), Variant::Forever, 7, 0x0041_3DD5, Timeouts::default()).unwrap();
        assert_eq!(q.info.name, "Kawabonga");
        assert_eq!(q.info.maps[0].name, "B02-Race");
        let got = h.join().unwrap();
        let mut want = hex(FOREVER_CLIENT_QUERY_MODE);
        want.extend(hex(FOREVER_CLIENT_INFO_REQUEST));
        assert_eq!(got, want, "requests are byte-identical to the game client's");
    }

    #[test]
    fn query_skips_stale_answers_and_reports_noinfo() {
        // answer for another request id is skipped; then the real one
        let stale = hex(FOREVER_SERVER_INFO_REPLY); // id 0x00413DD5
        let info = reply_payload(Variant::Forever, FOREVER_SERVER_INFO_REPLY)[16..].to_vec();
        let mut pl = [7u32, 6, 0x55].iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
        pl.extend((info.len() as u32).to_le_bytes());
        pl.extend(&info);
        let right = frame(&build_message(Variant::Forever, 3, &pl));
        let (port, h) = fake_server(vec![stale, right]);
        let q = query_with_id(&format!("127.0.0.1:{port}"), Variant::Forever, 7, 0x55, Timeouts::default()).unwrap();
        assert_eq!(q.info.name, "Kawabonga");
        h.join().unwrap();

        let empty = [7u32, 6, 0xFFFF_FFFF, 0].iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
        let (port, h) = fake_server(vec![frame(&build_message(Variant::Forever, 3, &empty))]);
        let e = query_with_id(&format!("127.0.0.1:{port}"), Variant::Forever, 7, 0x55, Timeouts::default()).unwrap_err();
        assert_eq!(e, QueryError::NoInfo);
        h.join().unwrap();
    }

    #[test]
    fn legacy_switches_protocol_version() {
        // An ESWC server (wants 5) is asked as "Original" (4): it refuses and names its version, we ask again with 5.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..2 {
                let (mut s, _) = l.accept().unwrap();
                let mut last = (0u32, 0u32);
                for _ in 0..2 {
                    let mut len = [0u8; 4];
                    s.read_exact(&mut len).unwrap();
                    let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
                    s.read_exact(&mut body).unwrap();
                    let (_, p) = decode_message(Variant::Eswc, &body).unwrap();
                    if p.len() >= 12 {
                        last = (u32::from_le_bytes(p[0..4].try_into().unwrap()), u32::from_le_bytes(p[8..12].try_into().unwrap()));
                    }
                }
                seen.push(last.0);
                let reply = if last.0 == 5 {
                    let info = legacy_info(0x09, "ESWC test", "#SRV#", &[]);
                    let mut pl = [5u32, 6, last.1, info.len() as u32].iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
                    pl.extend(info);
                    pl
                } else {
                    [5u32, 1, 0].iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>()
                };
                s.write_all(&frame(&build_message(Variant::Eswc, 3, &reply))).unwrap();
            }
            seen
        });
        let q = query(&format!("127.0.0.1:{port}"), "tmo", Timeouts::default()).unwrap();
        assert_eq!((q.info.name.as_str(), q.version), ("ESWC test", 5));
        assert_eq!(h.join().unwrap(), vec![4, 5]);
    }

    #[test]
    fn dead_ports_and_silent_servers_fail_fast() {
        // refused: a port nobody listens on
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let t = Timeouts { connect: Duration::from_millis(500), answer: Duration::from_millis(300) };
        let e = query_with_id(&format!("127.0.0.1:{port}"), Variant::Forever, 7, 1, t).unwrap_err();
        assert!(matches!(e, QueryError::Refused | QueryError::Timeout | QueryError::Io(_)), "{e:?}");
        // silent: accepts, never answers
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            std::thread::sleep(Duration::from_millis(600));
            drop(s);
        });
        let t0 = Instant::now();
        let e = query_with_id(&format!("127.0.0.1:{port}"), Variant::Forever, 7, 1, t).unwrap_err();
        assert!(t0.elapsed() < Duration::from_secs(2));
        assert!(matches!(e, QueryError::Timeout | QueryError::Protocol(_)), "{e:?}");
        h.join().unwrap();
        // garbage instead of a TrackMania answer
        let (port, h) = fake_server(vec![frame(&[0x82, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])]);
        let e = query_with_id(&format!("127.0.0.1:{port}"), Variant::Forever, 7, 1, Timeouts::default()).unwrap_err();
        assert!(matches!(e, QueryError::Protocol(_)), "{e:?}");
        h.join().unwrap();
        // unknown host name
        assert!(matches!(query("no-such-host.invalid:2350", "tmnf", t), Err(QueryError::Dns(_)) | Err(QueryError::Timeout) | Err(QueryError::Io(_))));
    }

    #[test]
    fn scheduler_limits_parallelism_gap_and_backoff() {
        let wanted: Vec<(String, String)> = (0..9).map(|i| ("tmnf".to_string(), format!("10.99.0.{i}:2350"))).collect();
        let running = AtomicU32::new(0);
        let peak = AtomicU32::new(0);
        let calls = AtomicU32::new(0);
        let ask = |_: &str, a: &str| {
            calls.fetch_add(1, Ordering::SeqCst);
            let n = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(40));
            running.fetch_sub(1, Ordering::SeqCst);
            if a.ends_with(".3:2350") {
                return Err(QueryError::Timeout);
            }
            let p = reply_payload(Variant::Forever, FOREVER_SERVER_INFO_REPLY);
            Ok(Queried { info: parse_server_info(&p[16..], Variant::Forever).unwrap(), ping_ms: 12, version: 7 })
        };
        let rows = status_with(&wanted, false, 99, &ask);
        assert_eq!(rows.len(), 9);
        assert!(peak.load(Ordering::SeqCst) <= MAX_PARALLEL as u32, "peak {}", peak.load(Ordering::SeqCst));
        assert_eq!(calls.load(Ordering::SeqCst), 9);
        assert_eq!(rows.iter().filter(|r| r.state == "ok").count(), 8);
        let bad = rows.iter().find(|r| r.address.ends_with(".3:2350")).unwrap();
        assert_eq!((bad.state.as_str(), bad.error.as_deref(), bad.paused_until), ("offline", Some("timeout"), 0));
        // second call right away: nothing is asked again (30 s gap), answers come from memory
        let rows2 = status_with(&wanted, false, 99, &ask);
        assert_eq!(calls.load(Ordering::SeqCst), 9);
        assert!(rows2.iter().all(|r| r.cached));
        assert_eq!(rows2.iter().filter(|r| r.state == "ok").count(), 8);
        // second failure in a row (gap forced to pass) pauses the server for 10 minutes
        table().lock().unwrap().get_mut("tmnf|10.99.0.3:2350").unwrap().last_query = Some(Instant::now() - MIN_GAP - Duration::from_secs(1));
        let rows3 = status_with(&wanted[3..4], false, 4, &ask);
        assert_eq!(calls.load(Ordering::SeqCst), 10);
        assert!(rows3[0].paused_until > now_ms() + 500_000);
        // ... and while paused it is not asked, even after the gap, unless forced
        table().lock().unwrap().get_mut("tmnf|10.99.0.3:2350").unwrap().last_query = Some(Instant::now() - MIN_GAP - Duration::from_secs(1));
        let rows4 = status_with(&wanted[3..4], false, 4, &ask);
        assert_eq!(calls.load(Ordering::SeqCst), 10);
        assert!(rows4[0].cached);
        table().lock().unwrap().get_mut("tmnf|10.99.0.3:2350").unwrap().last_query = Some(Instant::now() - MIN_GAP - Duration::from_secs(1));
        status_with(&wanted[3..4], true, 4, &ask);
        assert_eq!(calls.load(Ordering::SeqCst), 11);
    }

    /// Live check of the seed servers (real network, one query each). Not part of CI:
    /// `cargo test --lib live_seed_servers -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_seed_servers() {
        for (g, a, _) in SEEDS {
            let t0 = Instant::now();
            match query(a, g, Timeouts::default()) {
                Ok(q) => println!("OK   {a}: {:?} {}/{} players, {}/{} spectators, mode {:?} limit {:?} map {:?} ({} maps), pw {}, ladder {}, login {:?}, reported {}, ping {} ms, {} ms total",
                    q.info.name, q.info.players, q.info.max_players, q.info.spectators, q.info.max_spectators, q.info.mode, q.info.limit, q.info.maps.first().map(|m| m.name.clone()), q.info.nb_maps,
                    q.info.password, q.info.ladder_mode, q.info.host_login, q.info.reported_address, q.ping_ms, t0.elapsed().as_millis()),
                Err(e) => println!("FAIL {a}: {} ({} ms)", e, t0.elapsed().as_millis()),
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// Before/after timing of the whole list over a real registry file (real network, read only):
    /// `TMH_REGISTRY=<data>\server-registry.json cargo test --lib list_timing -- --ignored --nocapture`.
    /// Old: 4 at a time, 3 s connect + 4 s answer, and the page saw nothing until the last game finished.
    #[test]
    #[ignore]
    fn list_timing() {
        let b = std::fs::read(std::env::var("TMH_REGISTRY").expect("TMH_REGISTRY")).unwrap();
        let reg: Registry = serde_json::from_slice(&b).unwrap();
        let reg = reg.merged();
        let wanted: Vec<(String, String)> = reg.servers.iter().map(|s| (s.game.clone(), s.address.clone())).collect();
        for (label, workers, t) in [("old: 4 at a time, 3 s + 4 s", 4usize, Timeouts::default()), ("new: 32 at a time, 1.5 s + 2.5 s", MAX_PARALLEL, Timeouts::list())] {
            let t0 = Instant::now();
            let first = Mutex::new(None::<u128>);
            let next = AtomicUsize::new(0);
            let ok = AtomicUsize::new(0);
            std::thread::scope(|sc| {
                for _ in 0..workers {
                    sc.spawn(|| loop {
                        let k = next.fetch_add(1, Ordering::SeqCst);
                        let Some((g, a)) = wanted.get(k) else { break };
                        if query(a, g, t).is_ok() {
                            ok.fetch_add(1, Ordering::SeqCst);
                        }
                        first.lock().unwrap().get_or_insert(t0.elapsed().as_millis());
                    });
                }
            });
            println!("{label}: {} servers, {} answered, first row after {} ms, all after {} ms", wanted.len(), ok.load(Ordering::SeqCst), first.lock().unwrap().unwrap_or(0), t0.elapsed().as_millis());
        }
    }
}
