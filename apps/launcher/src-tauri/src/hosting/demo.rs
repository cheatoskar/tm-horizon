//! Demo mode for screenshots and UI work, debug builds only (`TMHUB_HOST_DEMO=1`): "Start" runs no
//! dedicated server; an in-process fake answers XML-RPC on the server's port (127.0.0.1) with a few
//! players, chat, a map list and a time limit, and reacts to the console's actions. Nothing is
//! downloaded, no process is started, no port is mapped.

use super::xmlrpc::{fake, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

pub fn enabled() -> bool {
    std::env::var("TMHUB_HOST_DEMO").is_ok_and(|v| v == "1")
}

#[derive(Default)]
struct World {
    players: Vec<(String, String, bool)>,
    chat: Vec<String>,
    maps: Vec<(String, String)>,
    current: usize,
    next: usize,
    limit_ms: i64,
    next_limit_ms: i64,
    guests: Vec<String>,
    black: Vec<String>,
}

fn running() -> &'static Mutex<HashMap<String, (u16, bool)>> {
    static R: OnceLock<Mutex<HashMap<String, (u16, bool)>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

pub fn is_running(id: &str) -> bool {
    running().lock().unwrap().get(id).is_some_and(|(_, on)| *on)
}

pub fn stopped(id: &str) {
    if let Some(r) = running().lock().unwrap().get_mut(id) {
        r.1 = false;
    }
}

fn world(names: &[String]) -> World {
    let maps: Vec<(String, String)> = if names.is_empty() {
        vec![("$fffA01-$f00Race".into(), "Nadeo".into()), ("$0bfSpeed$fff Run".into(), "speedy".into()), ("Tech Tour".into(), "tmfan".into())]
    } else {
        names.iter().map(|n| (n.clone(), "Horizon".into())).collect()
    };
    World {
        players: vec![
            ("speedy".into(), "$f80Speedy$fff Gonzales".into(), false),
            ("tmfan".into(), "$0f0TM$fffFan".into(), false),
            ("nightdriver".into(), "$00fNight$fffDriver".into(), false),
            ("watcher".into(), "Watcher".into(), true),
        ],
        chat: vec![
            "$z[$f80Speedy$fff Gonzales$z] gl hf".into(),
            "$z[$0f0TM$fffFan$z] that last cp is mean".into(),
            "$z[$00fNight$fffDriver$z] 52.93 :)".into(),
        ],
        next: 1 % maps.len().max(1),
        maps,
        current: 0,
        limit_ms: 300_000,
        next_limit_ms: 300_000,
        guests: vec!["tmfan".into()],
        black: vec![],
    }
}

/// Starts (or wakes) the fake for server `id` on `port`. Map names come from the server's list.
pub fn start(id: &str, port: u16, map_names: &[String]) -> Result<(), String> {
    let mut r = running().lock().unwrap();
    if let Some(e) = r.get_mut(id) {
        e.1 = true;
        return Ok(());
    }
    let w = Arc::new(Mutex::new(world(map_names)));
    let handler = move |name: &str, p: &[Value]| -> Result<Value, (i64, String)> {
        let mut w = w.lock().unwrap();
        let s = |x: &str| Value::Str(x.into());
        let login = p.first().and_then(Value::as_str).unwrap_or("").to_string();
        let logins = |v: &[String]| Value::Array(v.iter().map(|l| Value::Struct(vec![("Login".into(), s(l))])).collect());
        Ok(match name {
            "Authenticate" => Value::Bool(true),
            "GetStatus" => Value::Struct(vec![("Code".into(), Value::Int(4)), ("Name".into(), s("Running - Play"))]),
            "GetPlayerList" => Value::Array(
                w.players
                    .iter()
                    .map(|(l, n, spec)| Value::Struct(vec![("Login".into(), s(l)), ("NickName".into(), s(n)), ("SpectatorStatus".into(), Value::Int(i64::from(*spec))), ("LadderRanking".into(), Value::Int(1234))]))
                    .collect(),
            ),
            "GetMaxPlayers" => Value::Struct(vec![("CurrentValue".into(), Value::Int(16))]),
            "GetGameMode" => Value::Int(1),
            "GetCurrentChallengeInfo" => Value::Struct(vec![("Name".into(), s(&w.maps.get(w.current).map(|m| m.0.clone()).unwrap_or_default()))]),
            "GetChallengeList" => Value::Array(w.maps.iter().map(|(n, a)| Value::Struct(vec![("Name".into(), s(n)), ("FileName".into(), s(&format!("Challenges/Horizon/{n}.Challenge.Gbx"))), ("Author".into(), s(a)), ("Environnement".into(), s("Stadium"))])).collect()),
            "GetCurrentChallengeIndex" => Value::Int(w.current as i64),
            "GetNextChallengeIndex" => Value::Int(w.next as i64),
            "SetNextChallengeIndex" => {
                w.next = p.first().and_then(Value::as_i64).unwrap_or(0).clamp(0, w.maps.len().saturating_sub(1) as i64) as usize;
                Value::Bool(true)
            }
            "NextChallenge" => {
                let n = w.maps.len().max(1);
                w.current = w.next % n;
                w.next = (w.current + 1) % n;
                w.limit_ms = w.next_limit_ms;
                Value::Bool(true)
            }
            "GetTimeAttackLimit" => Value::Struct(vec![("CurrentValue".into(), Value::Int(w.limit_ms)), ("NextValue".into(), Value::Int(w.next_limit_ms))]),
            "SetTimeAttackLimit" => {
                w.next_limit_ms = p.first().and_then(Value::as_i64).unwrap_or(300_000);
                Value::Bool(true)
            }
            "GetChatLines" => Value::Array(w.chat.iter().map(|l| s(l)).collect()),
            "ChatSendServerMessage" | "ChatSend" => {
                w.chat.push(format!("$z{}", p.first().and_then(Value::as_str).unwrap_or("")));
                Value::Bool(true)
            }
            "Kick" => {
                w.players.retain(|x| x.0 != login);
                Value::Bool(true)
            }
            "BanAndBlackList" | "BlackList" => {
                w.players.retain(|x| x.0 != login);
                if !w.black.contains(&login) {
                    w.black.push(login);
                }
                Value::Bool(true)
            }
            "UnBlackList" => {
                w.black.retain(|x| *x != login);
                Value::Bool(true)
            }
            "AddGuest" => {
                if !w.guests.contains(&login) {
                    w.guests.push(login);
                }
                Value::Bool(true)
            }
            "RemoveGuest" => {
                w.guests.retain(|x| *x != login);
                Value::Bool(true)
            }
            "ForceSpectator" => {
                let mode = p.get(1).and_then(Value::as_i64).unwrap_or(0);
                if let Some(x) = w.players.iter_mut().find(|x| x.0 == login) {
                    match mode {
                        1 => x.2 = true,
                        2 => x.2 = false,
                        _ => {}
                    }
                }
                Value::Bool(true)
            }
            "GetGuestList" => logins(&w.guests),
            "GetBlackList" => logins(&w.black),
            "GetBanList" => Value::Array(vec![]),
            _ => Value::Bool(true),
        })
    };
    let srv = fake::start_on(port, 2, Arc::new(handler)).map_err(|e| format!("host.err.portBusy:{e}"))?;
    r.insert(id.to_string(), (srv.port, true));
    Ok(())
}
