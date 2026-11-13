//! The saved description of one of the player's own servers (`<data>/servers/<id>/server.json`).
//! Secrets (XML-RPC passwords, the server account password, the hub token) are not in here; they
//! live in the OS credential store (`secrets.rs`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Ports {
    pub game: u16,
    pub p2p: u16,
    /// Local only: bound to 127.0.0.1 by the server config, never mapped, never in a firewall rule.
    pub xmlrpc: u16,
}

impl Default for Ports {
    fn default() -> Self {
        Ports { game: 2350, p2p: 3450, xmlrpc: 5000 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MapRef {
    /// A file from the player's own Tracks/Maps folder (copied into the server folder at start).
    File { path: String, name: String },
    /// A TMX map, downloaded at start (cached).
    Tmx { id: u64, name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Match {
    /// "ta" | "rounds" | "team" | "laps" | "cup" | "stunts"
    pub mode: String,
    /// Time attack / laps time limit in seconds (0 = none for laps).
    pub time_limit_s: u32,
    /// Points limit (rounds, team, cup).
    pub points_limit: u32,
    /// Rounds per map (cup / TM2020 rounds), laps (laps mode).
    pub rounds: u32,
    pub laps: u32,
    pub chat_time_s: u32,
    pub random_order: bool,
    /// Rounds/Team: new rules (TMF).
    pub new_rules: bool,
}

impl Default for Match {
    fn default() -> Self {
        Match { mode: "ta".into(), time_limit_s: 300, points_limit: 50, rounds: 5, laps: 5, chat_time_s: 10, random_order: false, new_rules: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Randomizer {
    /// Preset name of the 100% TMX server ("100tmx_tmnf", ...).
    pub preset: String,
    /// "AuthorMedal" | "GoldMedal" | "SilverMedal" | "BronzeMedal" | "Finished" | "None"
    pub auto_skip: String,
    /// Session time budget in minutes (0 = unlimited).
    pub time_limit_min: u32,
    /// Port of its status page / replay links (local by default; never mapped by us).
    pub web_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Listing {
    /// The player agreed that the public IP is shown in the hub list (ISO time).
    pub consent_at: Option<String>,
    /// Id the hub gave the submission.
    pub hub_id: Option<String>,
    /// Address that was submitted (public ip:port).
    pub address: Option<String>,
    /// A token was pasted (the token itself is in the credential store).
    pub has_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerDef {
    pub id: String,
    pub game: String,
    /// "plain" | "randomizer" | "xaseco"
    pub engine: String,
    /// With format codes ($f00, $o, ...).
    pub name: String,
    pub comment: String,
    pub password: String,
    pub spec_password: String,
    pub max_players: u32,
    pub max_spectators: u32,
    /// false = LAN only.
    pub internet: bool,
    pub ports: Ports,
    pub maps: Vec<MapRef>,
    #[serde(rename = "match")]
    pub matchs: Match,
    pub guests: Vec<String>,
    pub blacklist: Vec<String>,
    pub admins: Vec<String>,
    /// Server account login (internet; the password is in the credential store).
    pub server_login: String,
    /// TMUF only: validation key of the server account (not secret per se, kept with the login).
    pub validation_key: String,
    pub randomizer: Randomizer,
    pub upnp: bool,
    /// Set for one start only (never saved): TM Horizon's own UPnP mapping failed, so the server's own
    /// UPnP (`use_nat_upnp`) is switched on as a fallback.
    #[serde(skip)]
    pub nat_upnp_fallback: bool,
    pub autostart: bool,
    pub listing: Listing,
    pub created: String,
}

impl Default for ServerDef {
    fn default() -> Self {
        ServerDef {
            id: String::new(),
            game: "tmnf".into(),
            engine: "plain".into(),
            name: String::new(),
            comment: String::new(),
            password: String::new(),
            spec_password: String::new(),
            max_players: 16,
            max_spectators: 8,
            internet: false,
            ports: Ports::default(),
            maps: vec![],
            matchs: Match::default(),
            guests: vec![],
            blacklist: vec![],
            admins: vec![],
            server_login: String::new(),
            validation_key: String::new(),
            randomizer: Randomizer::default(),
            upnp: false,
            nat_upnp_fallback: false,
            autostart: false,
            listing: Listing::default(),
            created: String::new(),
        }
    }
}

/// Plain checks before anything is written. Error codes are i18n keys for the UI.
pub fn validate(d: &ServerDef) -> Result<(), String> {
    let k = super::kinds::kind(&d.game).ok_or("host.err.game")?;
    if !k.has_engine(&d.engine) {
        return Err("host.err.engine".into());
    }
    let plain = crate::serverquery::strip_format(&d.name);
    if plain.trim().is_empty() || d.name.chars().count() > 75 {
        return Err("host.err.name".into());
    }
    if d.comment.chars().count() > 250 {
        return Err("host.err.comment".into());
    }
    if d.max_players == 0 || d.max_players > 250 || d.max_spectators > 250 {
        return Err("host.err.slots".into());
    }
    for s in [&d.password, &d.spec_password] {
        if s.chars().any(|c| c.is_control() || c == ' ') || s.len() > 64 {
            return Err("host.err.password".into());
        }
    }
    let p = &d.ports;
    if p.game < 1024 || p.p2p < 1024 || p.xmlrpc < 1024 || p.game == p.p2p || p.game == p.xmlrpc || p.p2p == p.xmlrpc {
        return Err("host.err.ports".into());
    }
    for l in d.guests.iter().chain(&d.blacklist).chain(&d.admins) {
        if !valid_login(l) {
            return Err("host.err.login".into());
        }
    }
    if !d.server_login.is_empty() && !valid_login(&d.server_login) {
        return Err("host.err.serverLogin".into());
    }
    if d.engine != "randomizer" && d.maps.is_empty() {
        return Err("host.err.maps".into());
    }
    Ok(())
}

/// Player logins as the games use them: TMF/TM2 logins, TM2020 account ids (UUID) and logins.
pub fn valid_login(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> ServerDef {
        ServerDef { id: "a".into(), name: "$f00My $oServer".into(), maps: vec![MapRef::Tmx { id: 1, name: "x".into() }], ..Default::default() }
    }

    #[test]
    fn validation() {
        assert_eq!(validate(&ok()), Ok(()));
        let bad = |f: &dyn Fn(&mut ServerDef), code: &str| {
            let mut d = ok();
            f(&mut d);
            assert_eq!(validate(&d), Err(code.to_string()));
        };
        bad(&|d| d.name = "$f00$o".into(), "host.err.name");
        bad(&|d| d.game = "tm3".into(), "host.err.game");
        bad(&|d| d.max_players = 0, "host.err.slots");
        bad(&|d| d.password = "a b".into(), "host.err.password");
        bad(&|d| d.ports.p2p = d.ports.game, "host.err.ports");
        bad(&|d| d.guests.push("bad login!".into()), "host.err.login");
        bad(&|d| d.maps.clear(), "host.err.maps");
        bad(&|d| d.engine = "rocket".into(), "host.err.engine");
        // the randomizer brings its own maps; TM2020 has no randomizer
        let mut r = ok();
        r.engine = "randomizer".into();
        r.maps.clear();
        assert_eq!(validate(&r), Ok(()));
        r.game = "tm2020".into();
        assert_eq!(validate(&r), Err("host.err.engine".to_string()));
    }

    #[test]
    fn serde_roundtrip_and_defaults() {
        let d = ok();
        let j = serde_json::to_string(&d).unwrap();
        assert!(j.contains("\"match\":"));
        assert_eq!(serde_json::from_str::<ServerDef>(&j).unwrap(), d);
        // old/partial files load with defaults
        let p: ServerDef = serde_json::from_str(r#"{"id":"x","game":"tmuf"}"#).unwrap();
        assert_eq!(p.ports.game, 2350);
        assert_eq!(p.matchs.mode, "ta");
    }
}
