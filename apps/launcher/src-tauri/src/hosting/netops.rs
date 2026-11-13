//! Internet side of a server: UPnP mappings for the game and P2P ports only (never XML-RPC), the
//! Windows Firewall rule (needs admin: we only build the command, the player confirms it in UAC),
//! the reachability self-test through the hub, and the hub listing (submit + announce).

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::Duration;

// ------------------------------------------------------------------ UPnP

/// Mappings for a server: game and P2P port, TCP and UDP. XML-RPC is never in here.
pub fn mappings_for(game: u16, p2p: Option<u16>) -> Vec<(&'static str, u16)> {
    let mut v = vec![("TCP", game), ("UDP", game)];
    if let Some(p) = p2p {
        v.push(("TCP", p));
        v.push(("UDP", p));
    }
    v
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpnpResult {
    pub ok: bool,
    /// "TCP:2350" entries that were added.
    pub mapped: Vec<String>,
    pub external_ip: Option<String>,
    /// i18n code: "upnp.none" (no router answered), "upnp.refused", ...
    pub error: Option<String>,
    pub detail: Option<String>,
    /// Our mapping failed and the server was started with its own UPnP (use_nat_upnp) as a fallback.
    pub server_fallback: bool,
}

fn local_ip_towards(gw: SocketAddr) -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect(gw).ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(v) => Some(v),
        _ => None,
    }
}

fn proto(p: &str) -> igd_next::PortMappingProtocol {
    if p == "UDP" {
        igd_next::PortMappingProtocol::UDP
    } else {
        igd_next::PortMappingProtocol::TCP
    }
}

/// Lease of a mapping. Renewed while the server runs; routers that only take permanent leases get
/// 0 and the mapping is removed on stop (or on the next launcher start, from the PID file).
pub const LEASE_S: u32 = 3600;

pub fn upnp_map(game: u16, p2p: Option<u16>, label: &str) -> UpnpResult {
    let mut opts = igd_next::SearchOptions::default();
    opts.timeout = Some(Duration::from_secs(4));
    let gw = match igd_next::search_gateway(opts) {
        Ok(g) => g,
        Err(e) => return UpnpResult { error: Some("upnp.none".into()), detail: Some(e.to_string()), ..Default::default() },
    };
    let Some(local) = local_ip_towards(gw.addr) else {
        return UpnpResult { error: Some("upnp.none".into()), detail: Some("no local address".into()), ..Default::default() };
    };
    let mut out = UpnpResult { external_ip: gw.get_external_ip().ok().map(|i| i.to_string()), ..Default::default() };
    for (p, port) in mappings_for(game, p2p) {
        let to = SocketAddr::from((local, port));
        let desc = format!("TM Horizon {label}");
        let r = match gw.add_port(proto(p), port, to, LEASE_S, &desc) {
            Err(igd_next::AddPortError::OnlyPermanentLeasesSupported) => gw.add_port(proto(p), port, to, 0, &desc),
            r => r,
        };
        match r {
            Ok(()) => out.mapped.push(format!("{p}:{port}")),
            Err(e) => {
                out.error = Some("upnp.refused".into());
                out.detail = Some(format!("{p} {port}: {e}"));
            }
        }
    }
    out.ok = out.error.is_none();
    out
}

/// Removes mappings ("TCP:2350"); errors are ignored (the router may have dropped them already).
pub fn upnp_unmap(entries: &[String]) {
    if entries.is_empty() {
        return;
    }
    let mut opts = igd_next::SearchOptions::default();
    opts.timeout = Some(Duration::from_secs(3));
    let Ok(gw) = igd_next::search_gateway(opts) else { return };
    for e in entries {
        if let Some((p, port)) = e.split_once(':') {
            if let Ok(port) = port.parse::<u16>() {
                let _ = gw.remove_port(proto(p), port);
            }
        }
    }
}

// ------------------------------------------------------------------ addresses

/// Private, CGNAT (100.64.0.0/10), loopback, link-local: a router WAN address in one of these
/// means another NAT sits in front of the router.
pub fn non_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || (o[0] == 100 && (64..128).contains(&o[1])) || o[0] == 0 || o[0] >= 224
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reach {
    /// "reachable" | "cgnat" | "router" | "firewall" | "upnp-off" | "hub" (self-test not possible)
    pub verdict: String,
    pub public_ip: Option<String>,
    pub tcp: Option<String>,
    pub detail: Option<String>,
}

/// Plain verdict from the hub's answer and what UPnP said.
/// `hub_tcp`: "open" | "closed" | "timeout" | None (hub not reachable).
pub fn verdict(hub_ip: Option<&str>, hub_tcp: Option<&str>, upnp: Option<&UpnpResult>) -> Reach {
    let mk = |v: &str, d: Option<String>| Reach { verdict: v.into(), public_ip: hub_ip.map(String::from), tcp: hub_tcp.map(String::from), detail: d };
    let Some(tcp) = hub_tcp else { return mk("hub", None) };
    if tcp == "open" {
        return mk("reachable", None);
    }
    // Router's WAN address not public, or not the address the hub sees: carrier-grade NAT.
    if let Some(ext) = upnp.and_then(|u| u.external_ip.as_deref()) {
        let ext_ip: Option<Ipv4Addr> = ext.parse().ok();
        if ext_ip.is_some_and(non_public_v4) || hub_ip.is_some_and(|h| h != ext) {
            return mk("cgnat", Some(ext.to_string()));
        }
    }
    match upnp {
        None => mk("upnp-off", None),
        Some(u) if !u.ok => mk("router", u.detail.clone()),
        // mapped and still closed: Windows Firewall (or the server is not running)
        Some(_) => mk("firewall", None),
    }
}

// ------------------------------------------------------------------ firewall

/// Name of our rule for one server program.
pub fn firewall_rule_name(server_id: &str) -> String {
    format!("TM Horizon server {server_id}")
}

/// `netsh` arguments that add inbound allow rules (TCP and UDP) for the server program on its game
/// and P2P ports. The XML-RPC port is never in the list.
pub fn firewall_add_args(server_id: &str, program: &str, game: u16, p2p: Option<u16>) -> Vec<Vec<String>> {
    let ports = match p2p {
        Some(p) => format!("{game},{p}"),
        None => game.to_string(),
    };
    ["TCP", "UDP"]
        .iter()
        .map(|proto| {
            vec![
                "advfirewall".into(),
                "firewall".into(),
                "add".into(),
                "rule".into(),
                format!("name={}", firewall_rule_name(server_id)),
                "dir=in".into(),
                "action=allow".into(),
                format!("program={program}"),
                format!("protocol={proto}"),
                format!("localport={ports}"),
                "enable=yes".into(),
                "profile=private,public".into(),
            ]
        })
        .collect()
}

pub fn firewall_delete_args(server_id: &str) -> Vec<String> {
    vec!["advfirewall".into(), "firewall".into(), "delete".into(), "rule".into(), format!("name={}", firewall_rule_name(server_id))]
}

/// One `cmd /s /c "..."` parameter string that runs all netsh calls in one elevated window (one UAC
/// prompt). Each argument with spaces is quoted; quotes inside values are refused.
pub fn elevated_cmd_line(calls: &[Vec<String>]) -> Result<String, String> {
    let mut parts = vec![];
    for c in calls {
        let mut s = String::from("netsh");
        for a in c {
            if a.contains('"') || a.contains('&') || a.contains('|') || a.contains('^') || a.contains('%') {
                return Err(format!("unsafe character in {a}"));
            }
            s.push(' ');
            match a.split_once('=') {
                Some((k, v)) if v.contains(' ') => s.push_str(&format!("{k}=\"{v}\"")),
                _ => s.push_str(a),
            }
        }
        parts.push(s);
    }
    Ok(format!("/s /c \"{}\"", parts.join(" & ")))
}

/// Runs the firewall command elevated (UAC prompt). Windows only.
#[cfg(windows)]
pub fn run_elevated_cmd(params: &str) -> Result<i32, String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, file, par) = (w("runas"), w("cmd.exe"), w(params));
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = par.as_ptr();
        info.nShow = 0; // SW_HIDE
        if ShellExecuteExW(&mut info) == 0 {
            return Err("cancelled".into());
        }
        if info.hProcess.is_null() {
            return Ok(0);
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 0u32;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        Ok(code as i32)
    }
}

/// Is our rule there? (`netsh ... show rule` needs no admin.)
#[cfg(windows)]
pub fn firewall_rule_exists(server_id: &str) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("netsh")
        .args(["advfirewall", "firewall", "show", "rule"])
        .arg(format!("name={}", firewall_rule_name(server_id)))
        .creation_flags(0x0800_0000)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ------------------------------------------------------------------ hub

/// `POST <hub>/v1/servers/reachability {port}` -> (ip the hub saw, "open"|"closed"|"timeout").
pub fn hub_reach(hub: &str, port: u16) -> Result<(String, String), String> {
    if !crate::hubindex::hub_url_ok(hub) {
        return Err("hub address must be https".into());
    }
    let url = format!("{}/v1/servers/reachability", hub.trim_end_matches('/'));
    let r = ureq::post(&url).set("User-Agent", crate::net::UA).timeout(Duration::from_secs(20)).send_json(serde_json::json!({ "port": port }));
    let v: serde_json::Value = match r {
        Ok(r) => r.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(429, _)) => return Err("too-often".into()),
        Err(e) => return Err(e.to_string()),
    };
    Ok((v["ip"].as_str().unwrap_or("").to_string(), v["tcp"].as_str().unwrap_or("").to_string()))
}

/// `POST <hub>/v1/servers` (same review flow as the website form). Returns the submission id.
pub fn hub_submit(hub: &str, game: &str, address: &str, name: &str, contact: &str) -> Result<String, String> {
    if !crate::hubindex::hub_url_ok(hub) {
        return Err("hub address must be https".into());
    }
    let url = format!("{}/v1/servers", hub.trim_end_matches('/'));
    let body = serde_json::json!({ "game": game, "address": address, "name": name, "contact": contact });
    match ureq::post(&url).set("User-Agent", crate::net::UA).timeout(Duration::from_secs(20)).send_json(body) {
        Ok(r) => Ok(r.into_json::<serde_json::Value>().map_err(|e| e.to_string())?["id"].as_str().unwrap_or("").to_string()),
        Err(ureq::Error::Status(409, _)) => Err("exists".into()),
        Err(ureq::Error::Status(code, r)) => Err(format!("{code} {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Announce {
    pub name: String,
    pub players: u32,
    pub max_players: u32,
    pub spectators: u32,
    pub map: Option<String>,
    pub mode: Option<String>,
}

pub fn hub_announce(hub: &str, token: &str, a: &Announce) -> Result<(), String> {
    if !crate::hubindex::hub_url_ok(hub) || !token.starts_with("tmhs_") {
        return Err("bad hub or token".into());
    }
    let url = format!("{}/v1/servers/announce", hub.trim_end_matches('/'));
    ureq::post(&url)
        .set("User-Agent", crate::net::UA)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(15))
        .send_json(serde_json::to_value(a).map_err(|e| e.to_string())?)
        .map(|_| ())
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            e => e.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_maps_xmlrpc() {
        let m = mappings_for(2351, Some(3451));
        assert_eq!(m, vec![("TCP", 2351), ("UDP", 2351), ("TCP", 3451), ("UDP", 3451)]);
        assert!(!m.iter().any(|(_, p)| (5000..5100).contains(p)));
        assert_eq!(mappings_for(2350, None).len(), 2);
    }

    #[test]
    fn cgnat_detection() {
        assert!(non_public_v4("100.64.1.2".parse().unwrap()));
        assert!(non_public_v4("100.127.255.1".parse().unwrap()));
        assert!(!non_public_v4("100.128.0.1".parse().unwrap()));
        assert!(non_public_v4("192.168.178.1".parse().unwrap()));
        assert!(non_public_v4("10.0.0.1".parse().unwrap()));
        assert!(!non_public_v4("85.10.20.30".parse().unwrap()));
    }

    #[test]
    fn verdicts() {
        let up = |ok: bool, ext: &str| UpnpResult { ok, external_ip: Some(ext.into()), mapped: vec![], error: (!ok).then(|| "upnp.refused".into()), detail: None, server_fallback: false };
        assert_eq!(verdict(Some("85.1.2.3"), Some("open"), None).verdict, "reachable");
        assert_eq!(verdict(None, None, None).verdict, "hub");
        // router WAN address is CGNAT space
        assert_eq!(verdict(Some("85.1.2.3"), Some("timeout"), Some(&up(true, "100.70.1.1"))).verdict, "cgnat");
        // router sees another public address than the hub: NAT in front
        assert_eq!(verdict(Some("85.1.2.3"), Some("timeout"), Some(&up(true, "85.9.9.9"))).verdict, "cgnat");
        assert_eq!(verdict(Some("85.1.2.3"), Some("closed"), None).verdict, "upnp-off");
        assert_eq!(verdict(Some("85.1.2.3"), Some("closed"), Some(&up(false, "85.1.2.3"))).verdict, "router");
        assert_eq!(verdict(Some("85.1.2.3"), Some("closed"), Some(&up(true, "85.1.2.3"))).verdict, "firewall");
    }

    #[test]
    fn firewall_command() {
        let calls = firewall_add_args("abc", r"C:\Users\Me\AppData\Local\app\servers\abc\dedicated\TrackmaniaServer.exe", 2351, Some(3451));
        assert_eq!(calls.len(), 2);
        assert!(calls[0].contains(&"protocol=TCP".to_string()) && calls[1].contains(&"protocol=UDP".to_string()));
        assert!(calls[0].contains(&"localport=2351,3451".to_string()));
        let all = calls.concat().join(" ");
        assert!(!all.contains("5000") && !all.contains("500"), "no XML-RPC port: {all}");
        let line = elevated_cmd_line(&calls).unwrap();
        assert!(line.starts_with("/s /c \"netsh advfirewall firewall add rule name=\"TM Horizon server abc\" dir=in"));
        assert!(line.contains(" & netsh "));
        assert!(line.contains(r#"program=C:\Users\Me\AppData\Local\app\servers\abc\dedicated\TrackmaniaServer.exe"#));
        // a path with spaces is quoted
        let spaced = elevated_cmd_line(&firewall_add_args("x", r"C:\Users\Max Mustermann\T.exe", 2350, None)).unwrap();
        assert!(spaced.contains(r#"program="C:\Users\Max Mustermann\T.exe""#));
        // shell metacharacters are refused, not escaped
        assert!(elevated_cmd_line(&firewall_add_args("x", r"C:\a&calc.exe", 2350, None)).is_err());
        assert!(elevated_cmd_line(&firewall_add_args("x", r"C:\%PATH%\a.exe", 2350, None)).is_err());
        assert_eq!(firewall_delete_args("abc").last().unwrap(), "name=TM Horizon server abc");
    }
}
