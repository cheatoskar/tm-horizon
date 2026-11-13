//! GBXRemote: XML-RPC over TCP as the TrackMania dedicated servers speak it (protocol 1 for the
//! 2006 server, 2 for TMF and newer). Handshake: the server sends `u32 len` + "GBXRemote N". Each
//! request is `u32 len` (+ `u32 handle` in protocol 2) + the XML. Answers carry the handle with the
//! high bit set; messages without it are callbacks and are skipped. Local connections only.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Int(i64),
    Bool(bool),
    Str(String),
    Double(f64),
    Array(Vec<Value>),
    Struct(Vec<(String, Value)>),
    Base64(Vec<u8>),
    Nil,
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Struct(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(i) => Some(*i),
            Value::Bool(b) => Some(*b as i64),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            Value::Int(i) => Some(*i != 0),
            _ => None,
        }
    }
    pub fn as_array(&self) -> &[Value] {
        match self {
            Value::Array(a) => a,
            _ => &[],
        }
    }
    pub fn s(&self, key: &str) -> String {
        self.get(key).and_then(Value::as_str).unwrap_or("").to_string()
    }
    pub fn i(&self, key: &str) -> i64 {
        self.get(key).and_then(Value::as_i64).unwrap_or(0)
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Str(s)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}
impl From<i64> for Value {
    fn from(i: i64) -> Self {
        Value::Int(i)
    }
}

pub fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut o = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        o.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail.find(';').filter(|&e| e <= 10) else {
            o.push('&');
            rest = &tail[1..];
            continue;
        };
        let ent = &tail[1..end];
        let c = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
            _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match c {
            Some(c) => {
                o.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                o.push('&');
                rest = &tail[1..];
            }
        }
    }
    o.push_str(rest);
    o
}

fn esc(s: &str) -> String {
    super::config::xml_escape(s)
}

pub fn write_value(v: &Value, o: &mut String) {
    o.push_str("<value>");
    match v {
        Value::Int(i) => o.push_str(&format!("<int>{i}</int>")),
        Value::Bool(b) => o.push_str(&format!("<boolean>{}</boolean>", u8::from(*b))),
        Value::Str(s) => o.push_str(&format!("<string>{}</string>", esc(s))),
        Value::Double(d) => o.push_str(&format!("<double>{d}</double>")),
        Value::Base64(b) => {
            use base64::Engine;
            o.push_str(&format!("<base64>{}</base64>", base64::engine::general_purpose::STANDARD.encode(b)))
        }
        Value::Array(a) => {
            o.push_str("<array><data>");
            for x in a {
                write_value(x, o);
            }
            o.push_str("</data></array>");
        }
        Value::Struct(m) => {
            o.push_str("<struct>");
            for (k, x) in m {
                o.push_str(&format!("<member><name>{}</name>", esc(k)));
                write_value(x, o);
                o.push_str("</member>");
            }
            o.push_str("</struct>");
        }
        Value::Nil => o.push_str("<nil/>"),
    }
    o.push_str("</value>");
}

pub fn method_call(name: &str, params: &[Value]) -> String {
    let mut o = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><methodCall><methodName>{}</methodName><params>", esc(name));
    for p in params {
        o.push_str("<param>");
        write_value(p, &mut o);
        o.push_str("</param>");
    }
    o.push_str("</params></methodCall>");
    o
}

pub fn method_response(v: Result<&Value, (i64, &str)>) -> String {
    let mut o = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><methodResponse>");
    match v {
        Ok(v) => {
            o.push_str("<params><param>");
            write_value(v, &mut o);
            o.push_str("</param></params>");
        }
        Err((code, msg)) => {
            o.push_str("<fault>");
            write_value(&Value::Struct(vec![("faultCode".into(), Value::Int(code)), ("faultString".into(), Value::Str(msg.into()))]), &mut o);
            o.push_str("</fault>");
        }
    }
    o.push_str("</methodResponse>");
    o
}

// ------------------------------------------------------------------ parser (just enough XML)

#[derive(Debug, PartialEq)]
enum Tok<'a> {
    Open(&'a str),
    Close(&'a str),
    Empty(&'a str),
    Text(&'a str),
}

struct Lexer<'a> {
    s: &'a str,
    i: usize,
}

impl<'a> Lexer<'a> {
    fn next(&mut self) -> Option<Tok<'a>> {
        loop {
            if self.i >= self.s.len() {
                return None;
            }
            let rest = &self.s[self.i..];
            if let Some(r) = rest.strip_prefix('<') {
                if r.starts_with('?') || r.starts_with('!') {
                    let end = rest.find('>')?;
                    self.i += end + 1;
                    continue;
                }
                let end = rest.find('>')?;
                let inner = &rest[1..end];
                self.i += end + 1;
                let name_of = |t: &'a str| t.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
                return Some(if let Some(n) = inner.strip_prefix('/') {
                    Tok::Close(n.trim())
                } else if inner.ends_with('/') {
                    Tok::Empty(name_of(inner))
                } else {
                    Tok::Open(name_of(inner))
                });
            }
            let end = rest.find('<').unwrap_or(rest.len());
            self.i += end;
            return Some(Tok::Text(&rest[..end]));
        }
    }
    /// Next token that is not whitespace-only text.
    fn sig(&mut self) -> Option<Tok<'a>> {
        loop {
            match self.next()? {
                Tok::Text(t) if t.trim().is_empty() => continue,
                t => return Some(t),
            }
        }
    }
    fn text_until(&mut self, close: &str) -> Result<String, String> {
        let mut o = String::new();
        loop {
            match self.next().ok_or("unexpected end")? {
                Tok::Text(t) => o.push_str(t),
                Tok::Close(c) if c == close => return Ok(unescape(&o)),
                t => return Err(format!("unexpected {t:?} in <{close}>")),
            }
        }
    }
    fn expect_close(&mut self, name: &str) -> Result<(), String> {
        match self.sig() {
            Some(Tok::Close(c)) if c == name => Ok(()),
            t => Err(format!("expected </{name}>, got {t:?}")),
        }
    }
}

/// Parses the contents after `<value>` up to and including `</value>`.
fn parse_value_body(lx: &mut Lexer) -> Result<Value, String> {
    // A value without a type tag is a string (whitespace kept).
    let save = lx.i;
    let first = lx.next().ok_or("unexpected end")?;
    let tok = match first {
        Tok::Text(t) if t.trim().is_empty() => {
            match lx.sig().ok_or("unexpected end")? {
                Tok::Close("value") => return Ok(Value::Str(unescape(t))),
                t => t,
            }
        }
        Tok::Text(_) => {
            lx.i = save;
            return Ok(Value::Str(lx.text_until("value")?));
        }
        Tok::Close("value") => return Ok(Value::Str(String::new())),
        t => t,
    };
    let v = match tok {
        Tok::Empty("nil") => Value::Nil,
        Tok::Empty("string") => Value::Str(String::new()),
        Tok::Open(t @ ("int" | "i4" | "i8")) => {
            let s = lx.text_until(t)?;
            Value::Int(s.trim().parse().map_err(|_| format!("bad int {s}"))?)
        }
        Tok::Open("boolean") => Value::Bool(lx.text_until("boolean")?.trim() == "1"),
        Tok::Open("string") => Value::Str(lx.text_until("string")?),
        Tok::Open("double") => {
            let s = lx.text_until("double")?;
            Value::Double(s.trim().parse().map_err(|_| format!("bad double {s}"))?)
        }
        Tok::Open("base64") => {
            use base64::Engine;
            let s = lx.text_until("base64")?;
            let clean: String = s.chars().filter(|c| !c.is_whitespace()).collect();
            Value::Base64(base64::engine::general_purpose::STANDARD.decode(clean).map_err(|e| e.to_string())?)
        }
        Tok::Open("array") => {
            let mut out = vec![];
            match lx.sig() {
                Some(Tok::Open("data")) => loop {
                    match lx.sig().ok_or("unexpected end")? {
                        Tok::Open("value") => out.push(parse_value_body(lx)?),
                        Tok::Close("data") => break,
                        t => return Err(format!("unexpected {t:?} in array")),
                    }
                },
                Some(Tok::Empty("data")) => {}
                t => return Err(format!("expected <data>, got {t:?}")),
            }
            lx.expect_close("array")?;
            Value::Array(out)
        }
        Tok::Open("struct") => {
            let mut out = vec![];
            loop {
                match lx.sig().ok_or("unexpected end")? {
                    Tok::Open("member") => {
                        let (mut name, mut val) = (String::new(), Value::Nil);
                        loop {
                            match lx.sig().ok_or("unexpected end")? {
                                Tok::Open("name") => name = lx.text_until("name")?,
                                Tok::Open("value") => val = parse_value_body(lx)?,
                                Tok::Close("member") => break,
                                t => return Err(format!("unexpected {t:?} in member")),
                            }
                        }
                        out.push((name, val));
                    }
                    Tok::Close("struct") => break,
                    t => return Err(format!("unexpected {t:?} in struct")),
                }
            }
            Value::Struct(out)
        }
        t => return Err(format!("unknown value {t:?}")),
    };
    lx.expect_close("value")?;
    Ok(v)
}

/// methodResponse -> Ok(value) or Err((faultCode, faultString)).
pub fn parse_response(xml: &str) -> Result<Result<Value, (i64, String)>, String> {
    let mut lx = Lexer { s: xml, i: 0 };
    let mut fault = false;
    loop {
        match lx.sig().ok_or("no value in the answer")? {
            Tok::Open("fault") => fault = true,
            Tok::Open("value") => {
                let v = parse_value_body(&mut lx)?;
                return Ok(if fault { Err((v.i("faultCode"), v.s("faultString"))) } else { Ok(v) });
            }
            Tok::Close("params") => return Ok(Ok(Value::Nil)),
            _ => {}
        }
    }
}

/// methodCall -> (name, params). Used by the fake server in tests and to read callbacks.
pub fn parse_call(xml: &str) -> Result<(String, Vec<Value>), String> {
    let mut lx = Lexer { s: xml, i: 0 };
    let mut name = String::new();
    let mut params = vec![];
    while let Some(t) = lx.sig() {
        match t {
            Tok::Open("methodName") => name = lx.text_until("methodName")?,
            Tok::Open("value") => params.push(parse_value_body(&mut lx)?),
            _ => {}
        }
    }
    if name.is_empty() {
        return Err("no methodName".into());
    }
    Ok((name, params))
}

// ------------------------------------------------------------------ client

#[derive(Debug)]
pub enum RpcError {
    Io(String),
    Protocol(String),
    Fault(i64, String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Io(e) => write!(f, "connection: {e}"),
            RpcError::Protocol(e) => write!(f, "protocol: {e}"),
            RpcError::Fault(c, s) => write!(f, "server said {c}: {s}"),
        }
    }
}

pub struct Client {
    s: TcpStream,
    proto: u8,
    handle: u32,
}

const MAX_MSG: usize = 4 << 20;

impl Client {
    /// Connects to 127.0.0.1:`port` only.
    pub fn connect(port: u16, timeout: Duration) -> Result<Client, RpcError> {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| RpcError::Io(e.to_string()))?;
        s.set_read_timeout(Some(timeout)).ok();
        s.set_write_timeout(Some(timeout)).ok();
        let mut len = [0u8; 4];
        s.read_exact(&mut len).map_err(|e| RpcError::Io(e.to_string()))?;
        let n = u32::from_le_bytes(len) as usize;
        if n > 64 {
            return Err(RpcError::Protocol("bad handshake".into()));
        }
        let mut hs = vec![0u8; n];
        s.read_exact(&mut hs).map_err(|e| RpcError::Io(e.to_string()))?;
        let proto = match hs.as_slice() {
            b"GBXRemote 1" => 1,
            b"GBXRemote 2" => 2,
            _ => return Err(RpcError::Protocol("not a TrackMania server".into())),
        };
        Ok(Client { s, proto, handle: 0x8000_0000 })
    }

    pub fn protocol(&self) -> u8 {
        self.proto
    }

    pub fn call(&mut self, method: &str, params: &[Value]) -> Result<Value, RpcError> {
        let xml = method_call(method, params);
        self.handle = self.handle.wrapping_add(1) | 0x8000_0000;
        let mut msg = (xml.len() as u32).to_le_bytes().to_vec();
        if self.proto == 2 {
            msg.extend(self.handle.to_le_bytes());
        }
        msg.extend(xml.as_bytes());
        self.s.write_all(&msg).map_err(|e| RpcError::Io(e.to_string()))?;
        for _ in 0..256 {
            let mut head = [0u8; 8];
            let hl = if self.proto == 2 { 8 } else { 4 };
            self.s.read_exact(&mut head[..hl]).map_err(|e| RpcError::Io(e.to_string()))?;
            let n = u32::from_le_bytes(head[..4].try_into().unwrap()) as usize;
            if n > MAX_MSG {
                return Err(RpcError::Protocol("answer too large".into()));
            }
            let mut body = vec![0u8; n];
            self.s.read_exact(&mut body).map_err(|e| RpcError::Io(e.to_string()))?;
            if self.proto == 2 {
                let h = u32::from_le_bytes(head[4..8].try_into().unwrap());
                if h & 0x8000_0000 == 0 || h != self.handle {
                    continue; // callback or a stale answer
                }
            }
            let text = String::from_utf8_lossy(&body);
            return match parse_response(&text).map_err(RpcError::Protocol)? {
                Ok(v) => Ok(v),
                Err((c, s)) => Err(RpcError::Fault(c, s)),
            };
        }
        Err(RpcError::Protocol("no answer".into()))
    }

    pub fn authenticate(&mut self, level: &str, password: &str) -> Result<(), RpcError> {
        match self.call("Authenticate", &[level.into(), password.into()])? {
            Value::Bool(true) => Ok(()),
            _ => Err(RpcError::Fault(-1, "authentication refused".into())),
        }
    }
}

// ------------------------------------------------------------------ fake server (tests)

/// A fake dedicated server for tests (and the debug-only demo mode, demo.rs): answers GBXRemote
/// calls through `handler`, records every call. Runs until the process ends.
#[cfg(any(test, debug_assertions))]
#[allow(dead_code)]
pub mod fake {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    pub type Handler = dyn Fn(&str, &[Value]) -> Result<Value, (i64, String)> + Send + Sync;

    pub struct FakeServer {
        pub port: u16,
        pub calls: Arc<Mutex<Vec<(String, Vec<Value>)>>>,
    }

    pub fn start(proto: u8, handler: Arc<Handler>) -> FakeServer {
        start_on(0, proto, handler).unwrap()
    }

    /// Same on a given port of 127.0.0.1 (0 = any free one).
    pub fn start_on(port: u16, proto: u8, handler: Arc<Handler>) -> std::io::Result<FakeServer> {
        let l = TcpListener::bind(("127.0.0.1", port))?;
        let port = l.local_addr()?.port();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let c2 = calls.clone();
        std::thread::spawn(move || {
            for conn in l.incoming() {
                let Ok(mut s) = conn else { break };
                let h = handler.clone();
                let calls = c2.clone();
                std::thread::spawn(move || {
                    let hs = format!("GBXRemote {proto}");
                    let mut m = (hs.len() as u32).to_le_bytes().to_vec();
                    m.extend(hs.as_bytes());
                    if s.write_all(&m).is_err() {
                        return;
                    }
                    let mut callback_sent = false;
                    loop {
                        let hl = if proto == 2 { 8 } else { 4 };
                        let mut head = [0u8; 8];
                        if s.read_exact(&mut head[..hl]).is_err() {
                            return;
                        }
                        let n = u32::from_le_bytes(head[..4].try_into().unwrap()) as usize;
                        let mut body = vec![0u8; n];
                        if s.read_exact(&mut body).is_err() {
                            return;
                        }
                        let (name, params) = parse_call(&String::from_utf8_lossy(&body)).unwrap();
                        calls.lock().unwrap().push((name.clone(), params.clone()));
                        let r = h(&name, &params);
                        let xml = method_response(r.as_ref().map_err(|(c, m)| (*c, m.as_str())));
                        // Protocol 2: a callback before the first answer, as real servers do.
                        if proto == 2 && !callback_sent {
                            callback_sent = true;
                            let cb = method_call("TrackMania.PlayerChat", &[Value::Int(0), "srv".into(), "hi".into()]);
                            let mut m = (cb.len() as u32).to_le_bytes().to_vec();
                            m.extend(7u32.to_le_bytes());
                            m.extend(cb.as_bytes());
                            let _ = s.write_all(&m);
                        }
                        let mut m = (xml.len() as u32).to_le_bytes().to_vec();
                        if proto == 2 {
                            m.extend_from_slice(&head[4..8]);
                        }
                        m.extend(xml.as_bytes());
                        if s.write_all(&m).is_err() {
                            return;
                        }
                        if name == "QuitGame" {
                            return;
                        }
                    }
                });
            }
        });
        Ok(FakeServer { port, calls })
    }

    impl FakeServer {
        pub fn names(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|(n, _)| n.clone()).collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn encode_decode_roundtrip() {
        let v = Value::Struct(vec![
            ("Login".into(), "a<b&c".into()),
            ("N".into(), Value::Int(-3)),
            ("Ok".into(), Value::Bool(true)),
            ("L".into(), Value::Array(vec![Value::Double(1.5), Value::Nil, Value::Base64(vec![1, 2, 3])])),
        ]);
        let xml = method_response(Ok(&v));
        assert_eq!(parse_response(&xml).unwrap().unwrap(), v);
        let call = method_call("Kick", &["x".into(), "bye".into()]);
        assert_eq!(parse_call(&call).unwrap(), ("Kick".to_string(), vec![Value::from("x"), Value::from("bye")]));
    }

    #[test]
    fn parse_real_shapes() {
        // untyped string, i4, whitespace, empty array, fault
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<methodResponse>\n<params>\n<param><value><struct>\n<member><name>Name</name><value>$f00Srv &amp; co</value></member>\n<member><name>Code</name><value><i4>4</i4></value></member>\n<member><name>Empty</name><value><array><data></data></array></value></member>\n<member><name>E2</name><value><string></string></value></member>\n</struct></value></param>\n</params>\n</methodResponse>";
        let v = parse_response(xml).unwrap().unwrap();
        assert_eq!(v.s("Name"), "$f00Srv & co");
        assert_eq!(v.i("Code"), 4);
        assert!(v.get("Empty").unwrap().as_array().is_empty());
        assert_eq!(v.s("E2"), "");
        let f = "<methodResponse><fault><value><struct><member><name>faultCode</name><value><int>-1000</int></value></member><member><name>faultString</name><value><string>Login unknown.</string></value></member></struct></value></fault></methodResponse>";
        assert_eq!(parse_response(f).unwrap(), Err((-1000, "Login unknown.".to_string())));
        assert_eq!(unescape("&#36;f00 &#x41; &bogus; &"), "$f00 A &bogus; &");
    }

    #[test]
    fn client_against_fake_both_protocols() {
        for proto in [1u8, 2] {
            let srv = fake::start(
                proto,
                Arc::new(|name: &str, p: &[Value]| match name {
                    "Authenticate" => Ok(Value::Bool(p.get(1).and_then(Value::as_str) == Some("pw"))),
                    "GetVersion" => Ok(Value::Struct(vec![("Name".into(), "TmForever".into())])),
                    _ => Err((-1000, format!("unknown {name}"))),
                }),
            );
            let mut c = Client::connect(srv.port, Duration::from_secs(3)).unwrap();
            assert_eq!(c.protocol(), proto);
            assert!(c.authenticate("SuperAdmin", "wrong").is_err());
            c.authenticate("SuperAdmin", "pw").unwrap();
            assert_eq!(c.call("GetVersion", &[]).unwrap().s("Name"), "TmForever");
            match c.call("Nope", &[]) {
                Err(RpcError::Fault(-1000, m)) => assert!(m.contains("Nope")),
                other => panic!("{other:?}"),
            }
            assert_eq!(srv.names(), vec!["Authenticate", "Authenticate", "GetVersion", "Nope"]);
        }
    }

    #[test]
    fn refuses_non_tm_server() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let _ = s.write_all(&[5, 0, 0, 0, b'H', b'T', b'T', b'P', b'/']);
            }
        });
        assert!(matches!(Client::connect(port, Duration::from_secs(2)), Err(RpcError::Protocol(_))));
    }
}
