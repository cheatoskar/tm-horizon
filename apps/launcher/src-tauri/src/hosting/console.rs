//! "Konsole": admin of a running server from the launcher. The plain dedicated server has no
//! in-game admin commands; its XML-RPC port (127.0.0.1 only, SuperAdmin password from the
//! credential store) is the admin interface. Players (kick, ban, guest, force spectator/player),
//! chat (read the last lines, send as the server), maps (next, restart, jump), time limit, pause.
//!
//! Two method families: TMF and the older servers ("Challenge" names) and ManiaPlanet/TM2020
//! ("Map" names, mode settings through the mode script).

use super::xmlrpc::{Client, RpcError, Value};
use super::LiveStatus;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MapRow {
    pub name: String,
    pub file: String,
    pub author: String,
    pub environment: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleState {
    pub live: LiveStatus,
    /// Last chat lines as the server keeps them ("[nick] text", format codes kept), oldest first.
    pub chat: Vec<String>,
    pub maps: Vec<MapRow>,
    pub current: Option<usize>,
    pub next: Option<usize>,
    /// Time attack limit in seconds: now and from the next map on.
    pub time_limit_s: Option<u32>,
    pub next_time_limit_s: Option<u32>,
    /// Script modes (TM2, TM2020) can pause; the old servers cannot.
    pub can_pause: bool,
    pub script: bool,
}

fn idx(v: Result<Value, RpcError>) -> Option<usize> {
    v.ok().and_then(|v| v.as_i64()).filter(|i| *i >= 0).map(|i| i as usize)
}

pub fn read(c: &mut Client, script: bool) -> Result<ConsoleState, String> {
    let live = super::read_status(c)?;
    let mut st = ConsoleState { live, script, can_pause: script, ..Default::default() };
    if let Ok(v) = c.call("GetChatLines", &[]) {
        st.chat = v.as_array().iter().filter_map(|x| x.as_str().map(String::from)).collect();
    }
    let list = if script { c.call("GetMapList", &[Value::Int(500), Value::Int(0)]) } else { c.call("GetChallengeList", &[Value::Int(500), Value::Int(0)]) };
    if let Ok(v) = list {
        // TMF spells the key the French way ("Environnement"), ManiaPlanet the English way.
        let env = |m: &Value| Some(m.s("Environnement")).filter(|s| !s.is_empty()).unwrap_or_else(|| m.s("Environment"));
        st.maps = v.as_array().iter().map(|m| MapRow { name: m.s("Name"), file: m.s("FileName"), author: m.s("Author"), environment: env(m) }).collect();
    }
    if script {
        st.current = idx(c.call("GetCurrentMapIndex", &[]));
        st.next = idx(c.call("GetNextMapIndex", &[]));
        if let Ok(v) = c.call("GetModeScriptSettings", &[]) {
            st.time_limit_s = v.get("S_TimeLimit").and_then(Value::as_i64).filter(|x| *x >= 0).map(|x| x as u32);
            st.next_time_limit_s = st.time_limit_s;
        }
    } else {
        st.current = idx(c.call("GetCurrentChallengeIndex", &[]));
        st.next = idx(c.call("GetNextChallengeIndex", &[]));
        if let Ok(v) = c.call("GetTimeAttackLimit", &[]) {
            let s = |k: &str| v.get(k).and_then(Value::as_i64).filter(|x| *x >= 0).map(|x| (x / 1000) as u32);
            st.time_limit_s = s("CurrentValue");
            st.next_time_limit_s = s("NextValue");
        }
    }
    Ok(st)
}

/// Chat text as the server sends it: one line, no control characters, at most 200 characters.
pub fn clean_chat(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(200).collect::<String>().trim().to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Player { action: String, login: String },
    /// Force to spectator (true) or back to player (false).
    Spectator { login: String, spec: bool },
    Chat(String),
    Next,
    Restart,
    Jump(usize),
    TimeLimit(u32),
    Pause(bool),
}

pub fn run(c: &mut Client, script: bool, a: &Action) -> Result<(), String> {
    let e = |e: RpcError| e.to_string();
    match a {
        Action::Player { action, login } => super::player_action(c, action, login),
        Action::Spectator { login, spec } => {
            if !super::model::valid_login(login) {
                return Err("host.err.login".into());
            }
            if *spec {
                c.call("ForceSpectator", &[login.as_str().into(), Value::Int(1)]).map_err(e)?;
            } else {
                // 2 = force player, then 0 = let the player choose again
                c.call("ForceSpectator", &[login.as_str().into(), Value::Int(2)]).map_err(e)?;
                let _ = c.call("ForceSpectator", &[login.as_str().into(), Value::Int(0)]);
            }
            Ok(())
        }
        Action::Chat(text) => {
            let t = clean_chat(text);
            if t.is_empty() {
                return Err("host.err.chatEmpty".into());
            }
            c.call("ChatSendServerMessage", &[t.as_str().into()]).or_else(|_| c.call("ChatSend", &[t.as_str().into()])).map(|_| ()).map_err(e)
        }
        Action::Next => c.call(if script { "NextMap" } else { "NextChallenge" }, &[]).map(|_| ()).map_err(e),
        Action::Restart => c.call(if script { "RestartMap" } else { "ChallengeRestart" }, &[]).map(|_| ()).map_err(e),
        Action::Jump(i) => {
            if script {
                c.call("JumpToMapIndex", &[Value::Int(*i as i64)]).map(|_| ()).map_err(e)
            } else {
                c.call("SetNextChallengeIndex", &[Value::Int(*i as i64)]).map_err(e)?;
                c.call("NextChallenge", &[]).map(|_| ()).map_err(e)
            }
        }
        Action::TimeLimit(s) => {
            if *s > 7200 {
                return Err("host.err.timeLimit".into());
            }
            if script {
                c.call("SetModeScriptSettings", &[Value::Struct(vec![("S_TimeLimit".into(), Value::Int(*s as i64))])]).map(|_| ()).map_err(e)
            } else {
                c.call("SetTimeAttackLimit", &[Value::Int(*s as i64 * 1000)]).map(|_| ()).map_err(e)
            }
        }
        Action::Pause(on) => {
            if !script {
                return Err("host.err.noPause".into());
            }
            c.call("TriggerModeScriptEventArray", &["Maniaplanet.Pause.SetActive".into(), Value::Array(vec![on.to_string().into()])]).map(|_| ()).map_err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::xmlrpc::fake;
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// A fake TMF server with three maps and a chat that remembers what the server said.
    pub fn fake_tmf() -> fake::FakeServer {
        let chat = Arc::new(Mutex::new(vec!["[$f00Alice] gg".to_string()]));
        fake::start(2, Arc::new(move |name: &str, p: &[Value]| {
            let s = |l: &str| Value::Str(l.into());
            Ok(match name {
                "Authenticate" => Value::Bool(true),
                "GetStatus" => Value::Struct(vec![("Code".into(), Value::Int(4)), ("Name".into(), s("Running - Play"))]),
                "GetPlayerList" => Value::Array(vec![Value::Struct(vec![("Login".into(), s("alice")), ("NickName".into(), s("$f00Alice")), ("SpectatorStatus".into(), Value::Int(0))])]),
                "GetChatLines" => Value::Array(chat.lock().unwrap().iter().map(|l| s(l)).collect()),
                "ChatSendServerMessage" => {
                    chat.lock().unwrap().push(format!("$fff{}", p[0].as_str().unwrap()));
                    Value::Bool(true)
                }
                "GetChallengeList" => Value::Array(["A01", "A02", "A03"].iter().map(|n| Value::Struct(vec![("Name".into(), s(n)), ("FileName".into(), s(&format!("Challenges/Horizon/{n}.Challenge.Gbx"))), ("Author".into(), s("nadeo")), ("Environnement".into(), s("Stadium"))])).collect()),
                "GetCurrentChallengeIndex" => Value::Int(1),
                "GetNextChallengeIndex" => Value::Int(2),
                "GetTimeAttackLimit" => Value::Struct(vec![("CurrentValue".into(), Value::Int(300_000)), ("NextValue".into(), Value::Int(240_000))]),
                "GetMaxPlayers" => Value::Struct(vec![("CurrentValue".into(), Value::Int(16))]),
                "GetGameMode" => Value::Int(1),
                _ => Value::Bool(true),
            })
        }))
    }

    #[test]
    fn read_and_act_tmf() {
        let srv = fake_tmf();
        let mut c = Client::connect(srv.port, Duration::from_secs(3)).unwrap();
        c.authenticate("SuperAdmin", "x").unwrap();
        let st = read(&mut c, false).unwrap();
        assert_eq!(st.maps.len(), 3);
        assert_eq!((st.maps[0].environment.as_str(), st.current, st.next), ("Stadium", Some(1), Some(2)));
        assert_eq!((st.time_limit_s, st.next_time_limit_s, st.can_pause), (Some(300), Some(240), false));
        assert_eq!(st.chat, vec!["[$f00Alice] gg"]);
        run(&mut c, false, &Action::Chat("hello\nall".into())).unwrap();
        assert_eq!(read(&mut c, false).unwrap().chat.last().unwrap(), "$fffhelloall");
        run(&mut c, false, &Action::Jump(2)).unwrap();
        run(&mut c, false, &Action::Next).unwrap();
        run(&mut c, false, &Action::Restart).unwrap();
        run(&mut c, false, &Action::TimeLimit(240)).unwrap();
        run(&mut c, false, &Action::Spectator { login: "alice".into(), spec: false }).unwrap();
        run(&mut c, false, &Action::Spectator { login: "alice".into(), spec: true }).unwrap();
        assert_eq!(run(&mut c, false, &Action::Pause(true)), Err("host.err.noPause".into()));
        assert_eq!(run(&mut c, false, &Action::Chat(" \n".into())), Err("host.err.chatEmpty".into()));
        assert_eq!(run(&mut c, false, &Action::TimeLimit(9999)), Err("host.err.timeLimit".into()));
        assert!(run(&mut c, false, &Action::Spectator { login: "no way".into(), spec: true }).is_err());
        let calls = srv.calls.lock().unwrap().clone();
        let has = |n: &str, p: Vec<Value>| calls.iter().any(|(a, b)| a == n && *b == p);
        assert!(has("SetNextChallengeIndex", vec![Value::Int(2)]));
        assert!(has("NextChallenge", vec![]) && has("ChallengeRestart", vec![]));
        assert!(has("SetTimeAttackLimit", vec![Value::Int(240_000)]));
        assert!(has("ForceSpectator", vec!["alice".into(), Value::Int(2)]) && has("ForceSpectator", vec!["alice".into(), Value::Int(0)]) && has("ForceSpectator", vec!["alice".into(), Value::Int(1)]));
    }

    #[test]
    fn script_family_names() {
        let srv = fake::start(2, Arc::new(|_: &str, _: &[Value]| Ok(Value::Bool(true))));
        let mut c = Client::connect(srv.port, Duration::from_secs(3)).unwrap();
        for a in [Action::Next, Action::Restart, Action::Jump(4), Action::TimeLimit(600), Action::Pause(true)] {
            run(&mut c, true, &a).unwrap();
        }
        let names = srv.names();
        assert_eq!(names, vec!["NextMap", "RestartMap", "JumpToMapIndex", "SetModeScriptSettings", "TriggerModeScriptEventArray"]);
        let calls = srv.calls.lock().unwrap().clone();
        assert_eq!(calls[4].1, vec![Value::from("Maniaplanet.Pause.SetActive"), Value::Array(vec![Value::from("true")])]);
        assert_eq!(clean_chat(&"x".repeat(300)).len(), 200);
    }
}
