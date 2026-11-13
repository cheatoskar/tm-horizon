//! Files the dedicated server reads: the server config (patched into the template that ships in the
//! server zip, so unknown tags of each game stay as Nadeo wrote them), the match settings, the guest
//! and black lists, and the start arguments. Pure functions, unit tested.

use super::kinds::{CfgStyle, GameServerKind, MatchStyle};
use super::model::{Match, ServerDef};

/// Secrets that go into the server config only (never into server.json, logs or the UI).
#[derive(Debug, Clone, Default)]
pub struct CfgSecrets {
    pub superadmin: String,
    pub admin: String,
    pub user: String,
    /// Server account password (internet), empty for LAN.
    pub account_password: String,
}

pub fn xml_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => o.push(c),
        }
    }
    o
}

/// Byte range of `<tag>...</tag>` (first one, case-insensitive) inside `s[from..to]`.
fn find_block(s: &str, tag: &str, from: usize, to: usize) -> Option<(usize, usize, usize, usize)> {
    let low = s[from..to].to_ascii_lowercase();
    let open = format!("<{}>", tag.to_ascii_lowercase());
    let close = format!("</{}>", tag.to_ascii_lowercase());
    let a = low.find(&open)?;
    let b = low[a..].find(&close)? + a;
    // (start of open tag, start of content, start of close tag, end of close tag), absolute
    Some((from + a, from + a + open.len(), from + b, from + b + close.len()))
}

/// Sets `<tag>` inside the block `<block>` to `value` (already escaped). Missing tag: inserted
/// before the block's closing tag. Missing block: appended before `</dedicated>`.
pub fn set_in_block(xml: &str, block: &str, tag: &str, value: &str) -> String {
    let Some((_, bc, bclose, _)) = find_block(xml, block, 0, xml.len()) else {
        let root = xml.to_ascii_lowercase().rfind("</dedicated>").unwrap_or(xml.len());
        return format!("{}\t<{block}>\n\t\t<{tag}>{value}</{tag}>\n\t</{block}>\n{}", &xml[..root], &xml[root..]);
    };
    if let Some((_, c, cl, _)) = find_block(xml, tag, bc, bclose) {
        return format!("{}{}{}", &xml[..c], value, &xml[cl..]);
    }
    format!("{}\t<{tag}>{value}</{tag}>\n\t{}", &xml[..bclose].trim_end_matches(['\t', ' ']), &xml[bclose..])
}

/// Sets the password of an authorization level (SuperAdmin/Admin/User).
pub fn set_level_password(xml: &str, level: &str, pw: &str) -> String {
    let Some((_, bc, bclose, _)) = find_block(xml, "authorization_levels", 0, xml.len()) else { return xml.to_string() };
    let mut at = bc;
    while let Some((_, lc, lclose, lend)) = find_block(xml, "level", at, bclose) {
        if let Some((_, nc, ncl, _)) = find_block(xml, "name", lc, lclose) {
            if xml[nc..ncl].trim().eq_ignore_ascii_case(level) {
                if let Some((_, pc, pcl, _)) = find_block(xml, "password", lc, lclose) {
                    return format!("{}{}{}", &xml[..pc], xml_escape(pw), &xml[pcl..]);
                }
            }
        }
        at = lend;
    }
    xml.to_string()
}

/// Reads `<tag>` inside `<block>` (tests and the "is the cfg ours" check).
pub fn get_in_block(xml: &str, block: &str, tag: &str) -> Option<String> {
    let (_, bc, bclose, _) = find_block(xml, block, 0, xml.len())?;
    let (_, c, cl, _) = find_block(xml, tag, bc, bclose)?;
    Some(xml[c..cl].to_string())
}

/// The server config: the shipped template with our values.
pub fn render_cfg(template: &str, k: &GameServerKind, d: &ServerDef, s: &CfgSecrets) -> String {
    let e = xml_escape;
    let mut x = template.trim_start_matches('\u{feff}').to_string();
    x = set_level_password(&x, "SuperAdmin", &s.superadmin);
    x = set_level_password(&x, "Admin", &s.admin);
    x = set_level_password(&x, "User", &s.user);
    let (login, pw) = if d.internet || k.login_for_lan { (d.server_login.as_str(), s.account_password.as_str()) } else { ("", "") };
    x = set_in_block(&x, "masterserver_account", "login", &e(login));
    x = set_in_block(&x, "masterserver_account", "password", &e(pw));
    if k.cfg_style == CfgStyle::Forever || k.cfg_style == CfgStyle::ManiaPlanet {
        x = set_in_block(&x, "masterserver_account", "validation_key", &e(if d.internet { &d.validation_key } else { "" }));
    }
    x = set_in_block(&x, "server_options", "name", &e(&d.name));
    x = set_in_block(&x, "server_options", "comment", &e(&d.comment));
    x = set_in_block(&x, "server_options", "max_players", &d.max_players.to_string());
    x = set_in_block(&x, "server_options", "password", &e(&d.password));
    x = set_in_block(&x, "server_options", "max_spectators", &d.max_spectators.to_string());
    x = set_in_block(&x, "server_options", "password_spectator", &e(&d.spec_password));
    x = set_in_block(&x, "system_config", "server_port", &d.ports.game.to_string());
    // TM2020 has no P2P port.
    if k.cfg_style != CfgStyle::Tm2020 {
        x = set_in_block(&x, "system_config", "server_p2p_port", &d.ports.p2p.to_string());
    }
    x = set_in_block(&x, "system_config", "xmlrpc_port", &d.ports.xmlrpc.to_string());
    // XML-RPC from this PC only: the launcher (and a local controller) talk to it, nobody else.
    x = set_in_block(&x, "system_config", "xmlrpc_allowremote", "False");
    match k.cfg_style {
        CfgStyle::Forever => {
            // We map ports ourselves (and only game + P2P); the server's own UPnP only when ours failed.
            x = set_in_block(&x, "system_config", "use_nat_upnp", if d.nat_upnp_fallback { "True" } else { "False" });
            x = set_in_block(&x, "system_config", "guestlist_filename", "guestlist.txt");
            x = set_in_block(&x, "system_config", "blacklist_filename", "blacklist.txt");
            if let Some(pm) = k.packmask {
                x = set_in_block(&x, "system_config", "packmask", pm);
            }
            x = set_in_block(&x, "server_options", "hide_server", "0");
        }
        CfgStyle::ManiaPlanet | CfgStyle::Tm2020 => {
            x = set_in_block(&x, "system_config", "use_nat_upnp", if d.nat_upnp_fallback { "True" } else { "False" });
            x = set_in_block(&x, "system_config", "guestlist_filename", "guestlist.txt");
            x = set_in_block(&x, "system_config", "blacklist_filename", "blacklist.txt");
            x = set_in_block(&x, "server_options", "hide_server", "0");
            if k.cfg_style == CfgStyle::ManiaPlanet {
                x = set_in_block(&x, "system_config", "title", "TMStadium@nadeo");
            }
        }
        CfgStyle::Legacy => {
            // The 2006 server only knows connection presets, and plays LAN with "LAN".
            if !d.internet {
                x = set_in_block(&x, "system_config", "connection_type", "LAN");
            }
        }
    }
    x
}

/// TMF game mode numbers.
pub fn legacy_mode(mode: &str) -> u32 {
    match mode {
        "rounds" => 0,
        "team" => 2,
        "laps" => 3,
        "stunts" => 4,
        "cup" => 5,
        _ => 1,
    }
}

/// ManiaScript mode file per game (TM2 title TMStadium, TM2020).
pub fn script_name(k: &GameServerKind, mode: &str) -> &'static str {
    let tm2020 = k.cfg_style == CfgStyle::Tm2020;
    match (mode, tm2020) {
        ("rounds", false) => "Rounds.Script.txt",
        ("team", false) => "Team.Script.txt",
        ("laps", false) => "Laps.Script.txt",
        ("cup", false) => "Cup.Script.txt",
        (_, false) => "TimeAttack.Script.txt",
        // Form of the example MatchSettings in the 2026-05-16 server zip (no ".Script.txt").
        ("rounds", true) => "Trackmania/TM_Rounds_Online",
        ("team", true) => "Trackmania/TM_Teams_Online",
        ("laps", true) => "Trackmania/TM_Laps_Online",
        ("cup", true) => "Trackmania/TM_Cup_Online",
        (_, true) => "Trackmania/TM_TimeAttack_Online",
    }
}

/// Match settings with the given map files (paths relative to the tracks folder).
pub fn render_match_settings(k: &GameServerKind, m: &Match, maps: &[String]) -> String {
    let mut o = String::from("<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n<playlist>\n");
    let tag = |o: &mut String, n: &str, v: String| o.push_str(&format!("\t\t<{n}>{v}</{n}>\n"));
    let ms = |s: u32| (s as u64 * 1000).to_string();
    match k.match_style {
        MatchStyle::Legacy => {
            o.push_str("\t<gameinfos>\n");
            tag(&mut o, "game_mode", legacy_mode(&m.mode).to_string());
            tag(&mut o, "chat_time", ms(m.chat_time_s));
            tag(&mut o, "finishtimeout", "1".into());
            tag(&mut o, "rounds_pointslimit", m.points_limit.to_string());
            tag(&mut o, "rounds_usenewrules", u8::from(m.new_rules).to_string());
            tag(&mut o, "rounds_forcedlaps", "0".into());
            tag(&mut o, "timeattack_limit", ms(m.time_limit_s));
            tag(&mut o, "timeattack_synchstartperiod", "0".into());
            tag(&mut o, "team_pointslimit", m.points_limit.to_string());
            tag(&mut o, "team_maxpoints", "6".into());
            tag(&mut o, "team_usenewrules", u8::from(m.new_rules).to_string());
            tag(&mut o, "laps_nblaps", m.laps.to_string());
            tag(&mut o, "laps_timelimit", ms(if m.mode == "laps" { m.time_limit_s } else { 0 }));
            tag(&mut o, "cup_pointslimit", m.points_limit.to_string());
            tag(&mut o, "cup_roundsperchallenge", m.rounds.to_string());
            tag(&mut o, "cup_nbwinners", "3".into());
            tag(&mut o, "cup_warmupduration", "2".into());
            o.push_str("\t</gameinfos>\n");
            o.push_str("\t<filter>\n");
            tag(&mut o, "random_map_order", u8::from(m.random_order).to_string());
            o.push_str("\t</filter>\n");
            for f in maps {
                o.push_str(&format!("\t<challenge>\n\t\t<file>{}</file>\n\t</challenge>\n", xml_escape(f)));
            }
        }
        MatchStyle::Script => {
            o.push_str("\t<gameinfos>\n");
            tag(&mut o, "game_mode", "0".into());
            tag(&mut o, "chat_time", ms(m.chat_time_s));
            tag(&mut o, "script_name", script_name(k, &m.mode).into());
            o.push_str("\t</gameinfos>\n");
            o.push_str("\t<filter>\n");
            tag(&mut o, "random_map_order", u8::from(m.random_order).to_string());
            o.push_str("\t</filter>\n");
            o.push_str("\t<mode_script_settings>\n");
            let set = |o: &mut String, n: &str, ty: &str, v: String| o.push_str(&format!("\t\t<setting name=\"{n}\" type=\"{ty}\" value=\"{v}\"/>\n"));
            match m.mode.as_str() {
                "rounds" | "team" => {
                    set(&mut o, "S_PointsLimit", "integer", m.points_limit.to_string());
                    set(&mut o, "S_RoundsPerMap", "integer", m.rounds.to_string());
                }
                "cup" => {
                    set(&mut o, "S_PointsLimit", "integer", m.points_limit.to_string());
                    set(&mut o, "S_RoundsPerMap", "integer", m.rounds.to_string());
                }
                "laps" => {
                    set(&mut o, "S_ForceLapsNb", "integer", m.laps.to_string());
                    set(&mut o, "S_TimeLimit", "integer", m.time_limit_s.to_string());
                }
                _ => set(&mut o, "S_TimeLimit", "integer", m.time_limit_s.to_string()),
            }
            o.push_str("\t</mode_script_settings>\n");
            o.push_str("\t<startindex>0</startindex>\n");
            for f in maps {
                o.push_str(&format!("\t<map>\n\t\t<file>{}</file>\n\t</map>\n", xml_escape(f)));
            }
        }
    }
    o.push_str("</playlist>\n");
    o
}

/// guestlist.txt / blacklist.txt (`root` = "guestlist" | "blacklist").
pub fn render_login_list(root: &str, logins: &[String]) -> String {
    let mut o = format!("<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n<{root}>\n");
    for l in logins {
        o.push_str(&format!("\t<player>\n\t\t<login>{}</login>\n\t</player>\n", xml_escape(l)));
    }
    o.push_str(&format!("</{root}>\n"));
    o
}

/// Logins from a guest/black list file (also one the server saved itself).
pub fn parse_login_list(xml: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let low = xml.to_ascii_lowercase();
    let mut at = 0;
    while let Some(a) = low[at..].find("<login>") {
        let s = at + a + 7;
        let Some(b) = low[s..].find("</login>") else { break };
        let v = super::xmlrpc::unescape(xml[s..s + b].trim());
        if !v.is_empty() && !out.iter().any(|x| x.eq_ignore_ascii_case(&v)) {
            out.push(v);
        }
        at = s + b + 8;
    }
    out
}

/// Start arguments. No secrets (they are in the config file); names with spaces are in the
/// config too, because the server splits its command line on spaces.
pub fn start_args(k: &GameServerKind, d: &ServerDef, match_file: &str) -> Vec<String> {
    let mut a = vec![format!("/dedicated_cfg={}", k.cfg_arg), format!("/game_settings={match_file}")];
    a.extend(k.extra_args.iter().map(|s| s.to_string()));
    match k.cfg_style {
        CfgStyle::Legacy => {
            if d.internet {
                a.push("/internet".into());
            }
        }
        _ => {
            if !d.internet {
                a.push("/lan".into());
            }
        }
    }
    if !cfg!(windows) {
        a.push("/nodaemon".into());
    }
    a
}

// ------------------------------------------------------------------ ports

/// Game ports 2350-2399 (the hub's self-test checks only these), P2P = game + 1100, XML-RPC from
/// 5000 up. `taken` are ports of the player's other servers; `free(port)` checks that nothing on
/// this PC uses it (TCP and UDP for the game ports). The launcher's own game client keeps 2350 if it
/// runs first, so a busy 2350 simply moves the server to the next pair.
pub fn pick_ports(taken: &[u16], free: &dyn Fn(u16, bool) -> bool) -> Option<super::model::Ports> {
    let game = (2350u16..2400).find(|&g| {
        let p = g + 1100;
        !taken.contains(&g) && !taken.contains(&p) && free(g, true) && free(p, true)
    })?;
    let xmlrpc = (5000u16..5100).find(|&x| !taken.contains(&x) && free(x, false))?;
    Some(super::model::Ports { game, p2p: game + 1100, xmlrpc })
}

/// At a start: Some(None) when the saved ports are free, Some(Some(new)) with the next free set when one of
/// them is busy (game and P2P move together, P2P only matters when `need_p2p`), None when nothing is free.
pub fn move_busy_ports(cur: &super::model::Ports, need_p2p: bool, taken: &[u16], free: &dyn Fn(u16, bool) -> bool) -> Option<Option<super::model::Ports>> {
    let ok = free(cur.game, true) && (!need_p2p || free(cur.p2p, true)) && free(cur.xmlrpc, false);
    if ok {
        return Some(None);
    }
    pick_ports(taken, free).map(Some)
}

/// Real check: can we bind the port on all interfaces right now (TCP, and UDP when `udp`)?
pub fn port_free(port: u16, udp: bool) -> bool {
    use std::net::{Ipv4Addr, TcpListener, UdpSocket};
    TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok() && (!udp || UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok())
}

/// Random password for the XML-RPC levels (24 chars, letters and digits; the server config is XML
/// and some old servers choke on symbols).
pub fn random_password() -> String {
    const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut buf = [0u8; 24];
    super::secrets::random_bytes(&mut buf);
    buf.iter().map(|b| A[*b as usize % A.len()] as char).collect()
}

#[cfg(test)]
mod tests {
    use super::super::kinds::kind;
    use super::super::model::{MapRef, Ports};
    use super::*;

    // Shape of the TMF template (shortened, same blocks and tags as the 2011 zip).
    const TMF_TEMPLATE: &str = "\u{feff}<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n<dedicated>\n\t<authorization_levels>\n\t\t<level>\n\t\t\t<name>SuperAdmin</name>\n\t\t\t<password>SuperAdmin</password>\n\t\t</level>\n\t\t<level>\n\t\t\t<name>Admin</name>\n\t\t\t<password>Admin</password>\n\t\t</level>\n\t\t<level>\n\t\t\t<name>User</name>\n\t\t\t<password>User</password>\n\t\t</level>\n\t</authorization_levels>\n\t<masterserver_account>\n\t\t<login></login>\n\t\t<password></password>\n\t\t<validation_key></validation_key>\n\t</masterserver_account>\n\t<server_options>\n\t\t<name></name>\n\t\t<comment></comment>\n\t\t<hide_server>0</hide_server>\n\t\t<max_players>32</max_players>\n\t\t<password></password>\n\t\t<max_spectators>32</max_spectators>\n\t\t<password_spectator></password_spectator>\n\t\t<ladder_mode>forced</ladder_mode>\n\t</server_options>\n\t<system_config>\n\t\t<connection_uploadrate>512</connection_uploadrate>\n\t\t<server_port>2350</server_port>\n\t\t<server_p2p_port>3450</server_p2p_port>\n\t\t<use_nat_upnp></use_nat_upnp>\n\t\t<xmlrpc_port>5000</xmlrpc_port>\n\t\t<xmlrpc_allowremote>False</xmlrpc_allowremote>\n\t\t<guestlist_filename></guestlist_filename>\n\t\t<blacklist_filename></blacklist_filename>\n\t\t<packmask>stadium</packmask>\n\t</system_config>\n</dedicated>\n";
    // The 2006 template (shortened): nation instead of validation_key, connection_type, no packmask.
    const LEGACY_TEMPLATE: &str = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n<dedicated>\n\t<authorization_levels>\n\t\t<level>\n\t\t\t<name>SuperAdmin</name>\n\t\t\t<password>SuperAdmin</password>\n\t\t</level>\n\t</authorization_levels>\n\t<masterserver_account>\n\t\t<login></login>\n\t\t<password></password>\n\t\t<nation></nation>\n\t</masterserver_account>\n\t<server_options>\n\t\t<name></name>\n\t\t<comment></comment>\n\t\t<max_players>32</max_players>\n\t\t<password></password>\n\t\t<ladder_mode>normal</ladder_mode> // comment the server tolerates\n\t</server_options>\n\t<system_config>\n\t\t<connection_type>DSL_16384_4096</connection_type>\n\t\t<server_port>2350</server_port>\n\t\t<xmlrpc_port>5000</xmlrpc_port>\n\t\t<xmlrpc_allowremote>True</xmlrpc_allowremote>\n\t</system_config>\n</dedicated>\n";

    #[test]
    fn busy_default_ports_move_to_the_next_set() {
        let cur = Ports { game: 2350, p2p: 3450, xmlrpc: 5000 };
        // The running game client holds 2350, 3450 and 5000.
        let busy = [2350u16, 3450, 5000];
        let free = |p: u16, _udp: bool| !busy.contains(&p);
        assert_eq!(move_busy_ports(&cur, true, &[], &free), Some(Some(Ports { game: 2351, p2p: 3451, xmlrpc: 5001 })));
        // Free ports stay as they are.
        assert_eq!(move_busy_ports(&cur, true, &[], &|_, _| true), Some(None));
        // Another saved server already uses 2351: the next pair.
        assert_eq!(move_busy_ports(&cur, true, &[2351, 3451], &free).unwrap().unwrap().game, 2352);
        // Nothing free in the range: an error for the caller.
        assert_eq!(move_busy_ports(&cur, true, &[], &|_, _| false), None);
    }

    fn def() -> ServerDef {
        ServerDef {
            id: "x".into(),
            name: "$f00Red & <Bold>".into(),
            comment: "Hi \"all\"".into(),
            password: "pw".into(),
            ports: Ports { game: 2351, p2p: 3451, xmlrpc: 5001 },
            maps: vec![MapRef::Tmx { id: 1, name: "a".into() }],
            server_login: "mysrv".into(),
            validation_key: "ABC".into(),
            ..Default::default()
        }
    }
    fn secrets() -> CfgSecrets {
        CfgSecrets { superadmin: "S3cret".into(), admin: "Adm1n".into(), user: "Us3r".into(), account_password: "acctpw".into() }
    }

    #[test]
    fn tmf_cfg_lan() {
        let k = kind("tmnf").unwrap();
        let x = render_cfg(TMF_TEMPLATE, k, &def(), &secrets());
        assert!(!x.starts_with('\u{feff}'));
        assert_eq!(get_in_block(&x, "server_options", "name").unwrap(), "$f00Red &amp; &lt;Bold&gt;");
        assert_eq!(get_in_block(&x, "server_options", "comment").unwrap(), "Hi &quot;all&quot;");
        assert_eq!(get_in_block(&x, "server_options", "password").unwrap(), "pw");
        assert_eq!(get_in_block(&x, "system_config", "server_port").unwrap(), "2351");
        assert_eq!(get_in_block(&x, "system_config", "server_p2p_port").unwrap(), "3451");
        assert_eq!(get_in_block(&x, "system_config", "xmlrpc_port").unwrap(), "5001");
        assert_eq!(get_in_block(&x, "system_config", "xmlrpc_allowremote").unwrap(), "False");
        assert_eq!(get_in_block(&x, "system_config", "use_nat_upnp").unwrap(), "False");
        assert_eq!(get_in_block(&x, "system_config", "packmask").unwrap(), "nations");
        assert_eq!(get_in_block(&x, "system_config", "guestlist_filename").unwrap(), "guestlist.txt");
        // LAN: no account in the file, even when one is saved
        assert_eq!(get_in_block(&x, "masterserver_account", "login").unwrap(), "");
        assert_eq!(get_in_block(&x, "masterserver_account", "password").unwrap(), "");
        // the levels got our passwords, the default ones are gone
        assert!(x.contains("<password>S3cret</password>") && x.contains("<password>Adm1n</password>") && x.contains("<password>Us3r</password>"));
        assert!(!x.contains("<password>SuperAdmin</password>"));
        // the player password did not land in the level block or vice versa
        assert_eq!(get_in_block(&x, "authorization_levels", "password").unwrap(), "S3cret");
        // untouched tags stay
        assert!(x.contains("<ladder_mode>forced</ladder_mode>") && x.contains("<connection_uploadrate>512"));
    }

    #[test]
    fn tmf_cfg_internet_and_tmuf_packmask() {
        let k = kind("tmuf").unwrap();
        let mut d = def();
        d.internet = true;
        let x = render_cfg(TMF_TEMPLATE, k, &d, &secrets());
        assert_eq!(get_in_block(&x, "masterserver_account", "login").unwrap(), "mysrv");
        assert_eq!(get_in_block(&x, "masterserver_account", "password").unwrap(), "acctpw");
        assert_eq!(get_in_block(&x, "masterserver_account", "validation_key").unwrap(), "ABC");
        assert_eq!(get_in_block(&x, "system_config", "packmask").unwrap(), "");
    }

    #[test]
    fn legacy_cfg() {
        let k = kind("eswc").unwrap();
        let x = render_cfg(LEGACY_TEMPLATE, k, &def(), &secrets());
        assert_eq!(get_in_block(&x, "system_config", "connection_type").unwrap(), "LAN");
        assert_eq!(get_in_block(&x, "system_config", "xmlrpc_allowremote").unwrap(), "False");
        // tags the template lacks are added inside their block
        assert_eq!(get_in_block(&x, "server_options", "max_spectators").unwrap(), "8");
        assert!(get_in_block(&x, "masterserver_account", "validation_key").is_none());
        assert!(x.contains("// comment the server tolerates"));
        let mut d = def();
        d.internet = true;
        let y = render_cfg(LEGACY_TEMPLATE, k, &d, &secrets());
        assert_eq!(get_in_block(&y, "system_config", "connection_type").unwrap(), "DSL_16384_4096");
    }

    #[test]
    fn new_games_cfg() {
        let tpl = "<dedicated><authorization_levels><level><name>SuperAdmin</name><password>SuperAdmin</password></level></authorization_levels><masterserver_account><login></login><password></password></masterserver_account><server_options><name></name></server_options><system_config><xmlrpc_port>5000</xmlrpc_port></system_config></dedicated>";
        let x = render_cfg(tpl, kind("tm2020").unwrap(), &def(), &secrets());
        // TM2020 needs the account even on LAN
        assert_eq!(get_in_block(&x, "masterserver_account", "login").unwrap(), "mysrv");
        assert!(get_in_block(&x, "system_config", "title").is_none());
        assert!(get_in_block(&x, "system_config", "server_p2p_port").is_none(), "TM2020 has no P2P port");
        let y = render_cfg(tpl, kind("tm2").unwrap(), &def(), &secrets());
        assert_eq!(get_in_block(&y, "system_config", "title").unwrap(), "TMStadium@nadeo");
        assert_eq!(get_in_block(&y, "masterserver_account", "login").unwrap(), "");
    }

    #[test]
    fn missing_block_is_added() {
        let x = set_in_block("<dedicated>\n</dedicated>", "system_config", "xmlrpc_port", "5003");
        assert_eq!(get_in_block(&x, "system_config", "xmlrpc_port").unwrap(), "5003");
        assert!(x.trim_end().ends_with("</dedicated>"));
    }

    #[test]
    fn match_settings_legacy() {
        let k = kind("tmnf").unwrap();
        let m = Match { mode: "rounds".into(), time_limit_s: 240, points_limit: 30, random_order: true, ..Default::default() };
        let x = render_match_settings(k, &m, &["Challenges/Horizon/A & B.Challenge.Gbx".into()]);
        assert!(x.contains("<game_mode>0</game_mode>"));
        assert!(x.contains("<timeattack_limit>240000</timeattack_limit>"));
        assert!(x.contains("<rounds_pointslimit>30</rounds_pointslimit>"));
        assert!(x.contains("<random_map_order>1</random_map_order>"));
        assert!(x.contains("<file>Challenges/Horizon/A &amp; B.Challenge.Gbx</file>"));
        assert_eq!(x.matches("<challenge>").count(), 1);
        assert_eq!(legacy_mode("ta"), 1);
        assert_eq!(legacy_mode("cup"), 5);
        assert_eq!(legacy_mode("stunts"), 4);
    }

    #[test]
    fn match_settings_script() {
        let k = kind("tm2020").unwrap();
        let m = Match { mode: "ta".into(), time_limit_s: 600, ..Default::default() };
        let x = render_match_settings(k, &m, &["Horizon/a.Map.Gbx".into(), "Horizon/b.Map.Gbx".into()]);
        assert!(x.contains("<script_name>Trackmania/TM_TimeAttack_Online</script_name>"));
        assert!(x.contains("<setting name=\"S_TimeLimit\" type=\"integer\" value=\"600\"/>"));
        assert_eq!(x.matches("<map>").count(), 2);
        assert!(!x.contains("<challenge>"));
        let y = render_match_settings(kind("tm2").unwrap(), &Match { mode: "laps".into(), laps: 3, ..Default::default() }, &[]);
        assert!(y.contains("<script_name>Laps.Script.txt</script_name>") && y.contains("S_ForceLapsNb\" type=\"integer\" value=\"3\""));
    }

    #[test]
    fn login_lists_roundtrip() {
        let x = render_login_list("guestlist", &["a.b".into(), "x<y".into()]);
        assert!(x.contains("<guestlist>") && x.contains("<login>x&lt;y</login>"));
        assert_eq!(parse_login_list(&x), vec!["a.b".to_string(), "x<y".to_string()]);
        // a file the server saved: other spacing, duplicates, upper-case tags
        let saved = "<?xml version=\"1.0\"?><blacklist><player><LOGIN> bad1 </LOGIN></player><player><login>Bad1</login></player><player><login>bad2</login></player></blacklist>";
        assert_eq!(parse_login_list(saved), vec!["bad1".to_string(), "bad2".to_string()]);
        assert!(parse_login_list("").is_empty());
        assert_eq!(render_login_list("blacklist", &[]).matches("<player>").count(), 0);
    }

    #[test]
    fn args() {
        let k = kind("tmnf").unwrap();
        let mut d = def();
        let a = start_args(k, &d, "MatchSettings/horizon.txt");
        assert_eq!(a[0], "/dedicated_cfg=dedicated_cfg.txt");
        assert_eq!(a[1], "/game_settings=MatchSettings/horizon.txt");
        assert!(a.contains(&"/lan".to_string()));
        d.internet = true;
        assert!(!start_args(k, &d, "m.txt").contains(&"/lan".to_string()));
        // no secrets and no names on the command line
        let all = start_args(k, &d, "m.txt").join(" ");
        assert!(!all.contains("acctpw") && !all.contains("mysrv") && !all.contains("Red"));
        let e = kind("eswc").unwrap();
        let l = start_args(e, &d, "m.txt");
        assert!(l.contains(&"/game=nations".to_string()) && l.contains(&"/internet".to_string()));
        d.internet = false;
        assert!(!start_args(e, &d, "m.txt").iter().any(|x| x == "/internet" || x == "/lan"));
    }

    #[test]
    fn ports() {
        // nothing taken, everything free
        let p = pick_ports(&[], &|_, _| true).unwrap();
        assert_eq!((p.game, p.p2p, p.xmlrpc), (2350, 3450, 5000));
        // our first server has 2350/3450/5000, and the game client sits on 2351
        let p = pick_ports(&[2350, 3450, 5000], &|port, _| port != 2351).unwrap();
        assert_eq!((p.game, p.p2p, p.xmlrpc), (2352, 3452, 5001));
        // a busy P2P port moves the pair
        let p = pick_ports(&[], &|port, _| port != 3450).unwrap();
        assert_eq!(p.game, 2351);
        // everything busy
        assert!(pick_ports(&[], &|_, _| false).is_none());
    }

    #[test]
    fn passwords() {
        let a = random_password();
        let b = random_password();
        assert_eq!(a.len(), 24);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
