//! Engines ("controllers"): what runs next to (or around) the dedicated server. Each one prepares
//! its files and says how to start; the manager (mod.rs) starts, watches and stops the process.
//!
//! - `plain`: Nadeo's dedicated server alone; the launcher is the only controller (lists, kick,
//!   ban over XML-RPC).
//! - `randomizer`: the 100% TMX server (github.com/cheatoskar/100-TMX-Server, AGPL-3.0, fork of
//!   BigBang1112/randomizer-anywhere). It downloads and starts the dedicated server itself; we
//!   write its config.toml and pin the dedicated server's hash in it.
//! - `xaseco`: not shipped. XAseco 1.16 needs PHP 5 (mysql_*), see docs/design/server-hosting.md.

use super::config::{self, CfgSecrets};
use super::kinds::{GameServerKind, MatchStyle};
use super::model::{MapRef, ServerDef};
use super::secrets::{self, Store};
use super::xmlrpc::{Client, Value};
use std::path::{Path, PathBuf};

pub struct Ctx<'a> {
    pub data: &'a Path,
    /// `<data>/servers/<id>`
    pub dir: &'a Path,
    pub kind: &'static GameServerKind,
    pub def: &'a ServerDef,
    pub secrets: &'a Store,
    pub fetch: &'a dyn Fn(&str, &Path) -> Result<(), String>,
    pub progress: &'a dyn Fn(&str),
}

#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// Folder of the dedicated server (lists, logs).
    pub server_dir: PathBuf,
    /// XML-RPC login the launcher uses.
    pub rpc_level: String,
    pub rpc_password: String,
}

pub trait Engine {
    fn id(&self) -> &'static str;
    /// Writes everything and returns how to start. Downloads what is missing.
    fn prepare(&self, c: &Ctx) -> Result<LaunchPlan, String>;
    /// Called once XML-RPC answers after a start: settings the engine cannot put into a file.
    fn after_start(&self, _c: &Ctx, _rpc: &mut Client) -> Result<(), String> {
        Ok(())
    }
}

pub fn engine(id: &str) -> Option<Box<dyn Engine>> {
    match id {
        "plain" => Some(Box::new(Plain)),
        "randomizer" => Some(Box::new(Randomizer)),
        _ => None,
    }
}

/// The dedicated server folder of a plain server.
pub fn dedicated_dir(dir: &Path) -> PathBuf {
    dir.join("dedicated")
}

/// Unpacks the dedicated server into `dest` and keeps an untouched copy of the config template.
fn install_server(c: &Ctx, dest: &Path) -> Result<(), String> {
    let p = c.kind.package.ok_or("host.err.noPackage")?;
    (c.progress)("download");
    let zip = super::deps::ensure_package(c.data, &p, c.fetch)?;
    (c.progress)("unpack");
    super::deps::install_package(&zip, &p, dest)?;
    let tpl = dest.join(c.kind.template_path);
    let keep = template_copy(dest, c.kind);
    if !keep.exists() {
        std::fs::copy(&tpl, &keep).map_err(|e| format!("template: {e}"))?;
    }
    Ok(())
}

fn template_copy(dest: &Path, k: &GameServerKind) -> PathBuf {
    dest.join(format!("{}.horizon-template", k.template_path))
}

fn cfg_target(dest: &Path, k: &GameServerKind) -> PathBuf {
    let tp = Path::new(k.cfg_path);
    dest.join(tp.parent().unwrap_or(Path::new(""))).join(k.cfg_arg)
}

/// Map files go into `<tracks>/<sub>/Horizon/`; returns their paths relative to the tracks folder.
pub fn place_maps(c: &Ctx, tracks: &Path) -> Result<Vec<String>, String> {
    let sub = if c.kind.match_style == MatchStyle::Legacy { "Challenges/Horizon" } else { "Horizon" };
    let to = tracks.join(sub);
    let _ = std::fs::remove_dir_all(&to);
    std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
    let mut out = vec![];
    for (i, m) in c.def.maps.iter().enumerate() {
        let (src, base) = match m {
            MapRef::File { path, name } => (PathBuf::from(path), name.clone()),
            MapRef::Tmx { id, name } => (tmx_map(c, *id)?, if name.is_empty() { format!("tmx{id}") } else { name.clone() }),
        };
        let bytes = std::fs::read(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        // only maps: a replay or other .Gbx never reaches the server, whatever its name
        if bytes.len() > 8 << 20 || super::mapfiles::check_map_bytes(&bytes).is_err() || matches!(m, MapRef::File { path, .. } if !super::mapfiles::has_map_ext(path)) {
            return Err(format!("host.err.mapFile:{}", src.display()));
        }
        let safe: String = crate::serverquery::strip_format(&base).chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.')).take(60).collect();
        let file = format!("{:03}_{}{}", i + 1, safe.trim(), c.kind.map_ext);
        std::fs::write(to.join(&file), &bytes).map_err(|e| e.to_string())?;
        out.push(format!("{sub}/{file}"));
    }
    Ok(out)
}

/// TMX download URL of a map id for the game's exchange.
pub fn tmx_url(site: &str, id: u64) -> String {
    match site {
        "tm.mania.exchange" | "trackmania.exchange" => format!("https://{site}/mapgbx/{id}"),
        _ => format!("https://{site}/trackgbx/{id}"),
    }
}

/// A TMX map: the server's own copy (added in the map picker), else the old shared cache, else it
/// is downloaded now into the server's folder.
fn tmx_map(c: &Ctx, id: u64) -> Result<PathBuf, String> {
    let site = c.kind.tmx.ok_or("host.err.noTmx")?;
    let m = MapRef::Tmx { id, name: String::new() };
    if let Some(f) = super::mapfiles::file_of(c.data, c.dir, Some(site), &m) {
        return Ok(f);
    }
    let f = super::mapfiles::tmx_file(c.dir, id);
    std::fs::create_dir_all(f.parent().unwrap_or(c.dir)).map_err(|e| e.to_string())?;
    (c.progress)("maps");
    (c.fetch)(&tmx_url(site, id), &f)?;
    Ok(f)
}

fn write_lists(c: &Ctx, server_dir: &Path) -> Result<(), String> {
    let d = server_dir.join(c.kind.lists_dir);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    std::fs::write(d.join("guestlist.txt"), config::render_login_list("guestlist", &c.def.guests)).map_err(|e| e.to_string())?;
    std::fs::write(d.join("blacklist.txt"), config::render_login_list("blacklist", &c.def.blacklist)).map_err(|e| e.to_string())?;
    Ok(())
}

fn level_secrets(c: &Ctx) -> Result<CfgSecrets, String> {
    let id = &c.def.id;
    Ok(CfgSecrets {
        superadmin: c.secrets.get_or_create(id, secrets::SUPERADMIN)?,
        admin: c.secrets.get_or_create(id, secrets::ADMIN)?,
        user: c.secrets.get_or_create(id, secrets::USER)?,
        account_password: c.secrets.get(id, secrets::ACCOUNT).unwrap_or_default(),
    })
}

pub struct Plain;

impl Engine for Plain {
    fn id(&self) -> &'static str {
        "plain"
    }

    fn prepare(&self, c: &Ctx) -> Result<LaunchPlan, String> {
        let k = c.kind;
        let dest = dedicated_dir(c.dir);
        install_server(c, &dest)?;
        let s = level_secrets(c)?;
        if c.def.internet || k.login_for_lan {
            if c.def.server_login.is_empty() || s.account_password.is_empty() {
                return Err("host.err.needLogin".into());
            }
        }
        let template = std::fs::read_to_string(template_copy(&dest, k)).map_err(|e| format!("template: {e}"))?;
        let cfg = cfg_target(&dest, k);
        std::fs::write(&cfg, config::render_cfg(&template, k, c.def, &s)).map_err(|e| e.to_string())?;
        super::procs::restrict_to_user(&cfg);
        let tracks = dest.join(k.tracks_dir);
        let maps = place_maps(c, &tracks)?;
        std::fs::create_dir_all(tracks.join("MatchSettings")).map_err(|e| e.to_string())?;
        std::fs::write(tracks.join("MatchSettings").join("horizon.txt"), config::render_match_settings(k, &c.def.matchs, &maps)).map_err(|e| e.to_string())?;
        write_lists(c, &dest)?;
        Ok(LaunchPlan {
            program: dest.join(k.exe()),
            args: config::start_args(k, c.def, "MatchSettings/horizon.txt"),
            cwd: dest.clone(),
            env: vec![],
            server_dir: dest,
            rpc_level: "SuperAdmin".into(),
            rpc_password: s.superadmin,
        })
    }
}

// ------------------------------------------------------------------ randomizer

pub struct Randomizer;

/// Game value of the randomizer's config.
pub fn randomizer_game(game: &str) -> Option<&'static str> {
    Some(match game {
        "tmnf" => "TMNF",
        "tmuf" => "TMUF",
        "eswc" => "TMN",
        "tms" => "TMS",
        "tmo" => "TMO",
        _ => return None,
    })
}

fn toml_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => {}
            '\t' => o.push_str("\\t"),
            c if c.is_control() => {}
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// config.toml for the 100% TMX server, from the server's settings. The account password is not in
/// here (it goes through RANDANY_SERVER_PASSWORD); the XML-RPC password is the controller's own
/// (it logs in as SuperAdmin/SuperAdmin, XML-RPC stays on 127.0.0.1).
pub fn randomizer_toml(d: &ServerDef) -> Result<String, String> {
    let game = randomizer_game(&d.game).ok_or("host.err.engine")?;
    let r = &d.randomizer;
    let preset = if r.preset.is_empty() { format!("100tmx_{}", game.to_ascii_lowercase()) } else { r.preset.clone() };
    let auto_skip = if r.auto_skip.is_empty() { "AuthorMedal" } else { r.auto_skip.as_str() };
    if !["AuthorMedal", "GoldMedal", "SilverMedal", "BronzeMedal", "Finished", "None"].contains(&auto_skip) {
        return Err("host.err.autoSkip".into());
    }
    // Empty AdminLogins means "everyone is admin" in the randomizer; "-" means nobody.
    let admins = if d.admins.is_empty() { "-".to_string() } else { d.admins.join(",") };
    let plain = crate::serverquery::strip_format(&d.name);
    let tmf = matches!(game, "TMNF" | "TMUF");
    let mut o = String::new();
    let mut kv = |k: &str, v: String| o.push_str(&format!("{k} = {v}\n"));
    kv("Game", toml_str(game));
    kv("TmxGame", toml_str(game));
    kv("BindIP", toml_str(""));
    kv("XmlRpcPort", d.ports.xmlrpc.to_string());
    kv("AutoSkipMode", toml_str(auto_skip));
    kv("TimeLimit", (r.time_limit_min as u64 * 60_000).to_string());
    kv("Preset", toml_str(&preset));
    kv("ServerName", toml_str(plain.trim()));
    kv("ServerDisplayName", toml_str(&d.name));
    kv("ServerComment", toml_str(&d.comment));
    kv("GameSettings", toml_str("MatchSettings/Randomizer.txt"));
    kv("AutoStart", "true".into());
    kv("AdminLogins", toml_str(&admins));
    kv("ReplayServerPort", (if r.web_port == 0 { 8090 } else { r.web_port }).to_string());
    kv("PublicHost", toml_str(""));
    kv("ConnectionUploadRate", if tmf { "10240".into() } else { "0".into() });
    kv("Lan", (!d.internet).to_string());
    kv("DiscordWebhookUrl", toml_str(""));
    kv("DiscordWebhookUrlHard", toml_str(""));
    kv("ServerPort", d.ports.game.to_string());
    kv("ServerP2PPort", d.ports.p2p.to_string());
    kv("ServerLogin", toml_str(if d.internet { &d.server_login } else { "" }));
    kv("ServerValidationKey", toml_str(if d.internet && tmf { &d.validation_key } else { "" }));
    o.push_str("\n[DownloadUrls]\n");
    o.push_str(&format!("TMF = {}\nTM = {}\n", toml_str(super::kinds::TMF_SERVER.url), toml_str(super::kinds::LEGACY_SERVER.url)));
    o.push_str("\n[DownloadSha256]\n");
    o.push_str(&format!("TMF = {}\nTM = {}\n", toml_str(super::kinds::TMF_SERVER.sha256), toml_str(super::kinds::LEGACY_SERVER.sha256)));
    Ok(o)
}

/// Where the randomizer puts its dedicated server (next to its exe).
pub fn randomizer_server_dir(inst: &Path, game: &str) -> PathBuf {
    match game {
        "tmnf" | "tmuf" => inst.join("Servers").join("TMF"),
        _ => inst.join("Servers").join("TM").join("TmDedicatedServer"),
    }
}

impl Engine for Randomizer {
    fn id(&self) -> &'static str {
        "randomizer"
    }

    fn prepare(&self, c: &Ctx) -> Result<LaunchPlan, String> {
        let toml = randomizer_toml(c.def)?;
        if c.def.internet && (c.def.server_login.is_empty() || c.secrets.get(&c.def.id, secrets::ACCOUNT).unwrap_or_default().is_empty()) {
            return Err("host.err.needLogin".into());
        }
        (c.progress)("download");
        let (dist, _version) = super::deps::ensure_randomizer(c.data)?;
        let inst = c.dir.join("randomizer");
        std::fs::create_dir_all(&inst).map_err(|e| e.to_string())?;
        // the 100 MB exe once per drive (hard link), the small files copied
        super::deps::link_or_copy(&dist.join(super::deps::randomizer_exe()), &inst.join(super::deps::randomizer_exe()))?;
        for sub in ["Presets", "WebStatus"] {
            if dist.join(sub).is_dir() {
                super::deps::copy_tree(&dist.join(sub), &inst.join(sub))?;
            }
        }
        if dist.join("config.default.toml").is_file() {
            std::fs::copy(dist.join("config.default.toml"), inst.join("config.default.toml")).map_err(|e| e.to_string())?;
        }
        let cfg = inst.join("config.toml");
        std::fs::write(&cfg, toml).map_err(|e| e.to_string())?;
        super::procs::restrict_to_user(&cfg);
        // Pre-place the verified dedicated server, so it does not have to come down twice.
        let server_dir = randomizer_server_dir(&inst, &c.def.game);
        if let Some(p) = c.kind.package {
            if let Ok(zip) = super::deps::ensure_package(c.data, &p, c.fetch) {
                let base = if p.root.is_empty() { server_dir.clone() } else { server_dir.parent().unwrap_or(&server_dir).to_path_buf() };
                let _ = super::deps::extract_zip(&zip, "", &base);
            }
        }
        write_lists(c, &server_dir)?;
        let mut env = vec![];
        if c.def.internet {
            if let Some(pw) = c.secrets.get(&c.def.id, secrets::ACCOUNT) {
                env.push(("RANDANY_SERVER_PASSWORD".to_string(), pw));
            }
        }
        Ok(LaunchPlan {
            program: inst.join(super::deps::randomizer_exe()),
            args: vec!["--dedicated".into()],
            cwd: inst.clone(),
            env,
            server_dir,
            rpc_level: "SuperAdmin".into(),
            rpc_password: "SuperAdmin".into(),
        })
    }

    /// Player password, slots and lists: the randomizer has no keys for them, so they are set over
    /// XML-RPC once the server answers.
    fn after_start(&self, c: &Ctx, rpc: &mut Client) -> Result<(), String> {
        apply_live_options(c.def, rpc)
    }
}

/// Options that can be changed on a running server.
pub fn apply_live_options(d: &ServerDef, rpc: &mut Client) -> Result<(), String> {
    let e = |e: super::xmlrpc::RpcError| e.to_string();
    rpc.call("SetServerPassword", &[d.password.as_str().into()]).map_err(e)?;
    rpc.call("SetServerPasswordForSpectator", &[d.spec_password.as_str().into()]).map_err(e)?;
    rpc.call("SetMaxPlayers", &[Value::Int(d.max_players as i64)]).map_err(e)?;
    rpc.call("SetMaxSpectators", &[Value::Int(d.max_spectators as i64)]).map_err(e)?;
    let _ = rpc.call("LoadGuestList", &["guestlist.txt".into()]);
    let _ = rpc.call("LoadBlackList", &["blacklist.txt".into()]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::kinds::kind;
    use super::super::model::Ports;
    use super::*;

    #[test]
    fn toml_for_randomizer() {
        let d = ServerDef {
            id: "a".into(),
            game: "tmnf".into(),
            engine: "randomizer".into(),
            name: "$0bf100% \"TMX\"".into(),
            internet: true,
            server_login: "srvlogin".into(),
            ports: Ports { game: 2352, p2p: 3452, xmlrpc: 5002 },
            ..Default::default()
        };
        let t = randomizer_toml(&d).unwrap();
        assert!(t.contains("Game = \"TMNF\"\n"));
        assert!(t.contains("Preset = \"100tmx_tmnf\"\n"));
        assert!(t.contains("ServerDisplayName = \"$0bf100% \\\"TMX\\\"\"\n"));
        assert!(t.contains("ServerName = \"100% \\\"TMX\\\"\"\n"));
        assert!(t.contains("AdminLogins = \"-\"\n"), "no admins -> nobody, not everyone");
        assert!(t.contains("Lan = false\n") && t.contains("ServerPort = 2352\n") && t.contains("XmlRpcPort = 5002\n"));
        assert!(t.contains("ServerLogin = \"srvlogin\""));
        assert!(t.contains(&format!("TMF = \"{}\"", super::super::kinds::TMF_SERVER.sha256)));
        assert!(!t.to_lowercase().contains("serverpassword"), "the account password goes through the environment");
        let mut e = d.clone();
        e.game = "eswc".into();
        e.internet = false;
        e.admins = vec!["me".into(), "you".into()];
        let t = randomizer_toml(&e).unwrap();
        assert!(t.contains("Game = \"TMN\"") && t.contains("Preset = \"100tmx_tmn\"") && t.contains("AdminLogins = \"me,you\""));
        assert!(t.contains("ServerLogin = \"\"") && t.contains("Lan = true") && t.contains("ConnectionUploadRate = 0"));
        let mut bad = d.clone();
        bad.game = "tm2020".into();
        assert!(randomizer_toml(&bad).is_err());
        bad.game = "tmnf".into();
        bad.randomizer.auto_skip = "Rocket".into();
        assert!(randomizer_toml(&bad).is_err());
    }

    #[test]
    fn tmx_urls() {
        assert_eq!(tmx_url("tmnf.exchange", 12), "https://tmnf.exchange/trackgbx/12");
        assert_eq!(tmx_url("trackmania.exchange", 7), "https://trackmania.exchange/mapgbx/7");
        assert_eq!(randomizer_server_dir(Path::new("r"), "eswc"), Path::new("r").join("Servers").join("TM").join("TmDedicatedServer"));
    }

    // Full prepare of a plain TMNF server against a fake download (a tiny zip with the template).
    #[test]
    fn plain_prepare_writes_everything() {
        use std::io::Write;
        let t = tempfile::tempdir().unwrap();
        let data = t.path();
        let zip_path = data.join("fake.zip");
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("GameData/Config/dedicated_cfg.txt", o).unwrap();
            z.write_all(b"<dedicated><authorization_levels><level><name>SuperAdmin</name><password>SuperAdmin</password></level></authorization_levels><masterserver_account><login></login><password></password></masterserver_account><server_options><name></name></server_options><system_config><xmlrpc_port>5000</xmlrpc_port></system_config></dedicated>").unwrap();
            z.start_file("TrackmaniaServer.exe", o).unwrap();
            z.write_all(b"MZ").unwrap();
            z.finish().unwrap();
        }
        let zip_bytes = std::fs::read(&zip_path).unwrap();
        let map = data.join("My.Challenge.Gbx");
        std::fs::write(&map, super::super::mapfiles::tests::map_bytes("My", "me", 1000)).unwrap();
        // A kind like TMNF but pinned to the fake zip.
        use sha2::Digest;
        let hash: &'static str = Box::leak(hex::encode(sha2::Sha256::digest(&zip_bytes)).into_boxed_str());
        let mut k = *kind("tmnf").unwrap();
        k.package = Some(super::super::kinds::Package { sha256: hash, ..super::super::kinds::TMF_SERVER });
        let k: &'static GameServerKind = Box::leak(Box::new(k));
        let d = ServerDef { id: "s1".into(), name: "$f00Test".into(), maps: vec![MapRef::File { path: map.to_string_lossy().into(), name: "My".into() }], guests: vec!["buddy".into()], ..Default::default() };
        let store = Store::File(data.join("secrets.json"));
        let dir = data.join("servers").join("s1");
        let fetch = |_: &str, dest: &Path| std::fs::write(dest, &zip_bytes).map_err(|e| e.to_string());
        let steps = std::cell::RefCell::new(vec![]);
        let progress = |s: &str| steps.borrow_mut().push(s.to_string());
        let c = Ctx { data, dir: &dir, kind: k, def: &d, secrets: &store, fetch: &fetch, progress: &progress };
        let plan = Plain.prepare(&c).unwrap();
        let ded = dir.join("dedicated");
        assert_eq!(plan.program, ded.join(k.exe()));
        let cfg = std::fs::read_to_string(ded.join("GameData/Config/dedicated_cfg.txt")).unwrap();
        let pw = store.get("s1", secrets::SUPERADMIN).unwrap();
        assert_eq!(plan.rpc_password, pw);
        assert!(cfg.contains(&format!("<password>{pw}</password>")) && cfg.contains("<name>$f00Test</name>"));
        let ms = std::fs::read_to_string(ded.join("GameData/Tracks/MatchSettings/horizon.txt")).unwrap();
        assert!(ms.contains("<file>Challenges/Horizon/001_My.Challenge.Gbx</file>"));
        assert!(ded.join("GameData/Tracks/Challenges/Horizon/001_My.Challenge.Gbx").is_file());
        assert!(std::fs::read_to_string(ded.join("GameData/Config/guestlist.txt")).unwrap().contains("<login>buddy</login>"));
        assert!(ded.join("GameData/Config/dedicated_cfg.txt.horizon-template").is_file());
        assert!(plan.args.iter().all(|a| !a.contains(&pw)));
        assert_eq!(steps.borrow()[0], "download");
        // a second prepare keeps the passwords and patches from the untouched template
        let plan2 = Plain.prepare(&c).unwrap();
        assert_eq!(plan2.rpc_password, pw);
        // internet without an account is refused before anything starts
        let mut d2 = d.clone();
        d2.internet = true;
        let c2 = Ctx { def: &d2, ..c };
        assert_eq!(Plain.prepare(&c2).unwrap_err(), "host.err.needLogin");
        // a file that is not a map is refused
        std::fs::write(&map, b"not a gbx").unwrap();
        let c3 = Ctx { def: &d, ..c2 };
        assert!(Plain.prepare(&c3).unwrap_err().starts_with("host.err.mapFile"));
        std::fs::write(&map, super::super::mapfiles::tests::replay_bytes()).unwrap();
        assert!(Plain.prepare(&c3).unwrap_err().starts_with("host.err.mapFile"), "a replay is refused too");
        // a TMX map added in the picker sits in the server's folder and is used without a download
        std::fs::create_dir_all(dir.join("maps")).unwrap();
        std::fs::write(dir.join("maps").join("tmx-77.Gbx"), super::super::mapfiles::tests::map_bytes("T", "me", 1000)).unwrap();
        let d4 = ServerDef { maps: vec![MapRef::Tmx { id: 77, name: "$f00Red".into() }], ..d.clone() };
        let c4 = Ctx { def: &d4, ..c3 };
        Plain.prepare(&c4).unwrap();
        assert!(ded.join("GameData/Tracks/Challenges/Horizon/001_Red.Challenge.Gbx").is_file());
    }
}
