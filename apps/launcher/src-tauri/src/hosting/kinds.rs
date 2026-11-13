//! What the launcher knows about each game's dedicated server: where it comes from (pinned SHA-256),
//! how its folder looks, which config dialect it reads, which ports and logins it needs, and how the
//! launcher asks it for its state. A new game is one more entry here plus, if its config dialect is
//! new, one more branch in `config.rs`.

use serde::Serialize;

/// A file the launcher downloads on demand. Never run or unpacked unless the SHA-256 matches.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub id: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    /// Folder inside the zip that becomes the server folder ("" = zip root).
    pub root: &'static str,
    /// Where the hash comes from and when it was checked (shown in the UI).
    pub note: &'static str,
}

/// Dialect of `dedicated_cfg.txt` / `dedicated.cfg`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CfgStyle {
    /// TMNF/TMUF 2011 (`GameData/Config/dedicated_cfg.txt`).
    Forever,
    /// TM Nations ESWC, Sunrise, Original: 2006 server (`dedicated.cfg` next to the exe).
    Legacy,
    /// ManiaPlanet 4 (TM2 titles): `UserData/Config/dedicated_cfg.txt`, `<title>` in system_config.
    ManiaPlanet,
    /// Trackmania (2020): like ManiaPlanet, title "Trackmania".
    Tm2020,
}

/// How game modes are written into the match settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchStyle {
    /// `<game_mode>` numbers and `<timeattack_limit>` etc. (TMF, 2006 server).
    Legacy,
    /// `<script_name>` plus `<mode_script_settings>` (TM2, TM2020).
    Script,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Built and tested against a fake server; first live run is the owner's test plan.
    Built,
    /// Config writer and start command built, never run against the real server (no hash yet or
    /// download not checked).
    Experimental,
    /// Researched only; the UI shows the reason.
    Later,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameServerKind {
    /// Launcher-side game id of the server ("tmnf", "tmuf", "eswc", "tms", "tmo", "tm2", "tm2020").
    pub id: &'static str,
    pub label: &'static str,
    pub status: Status,
    pub package: Option<Package>,
    pub exe_windows: &'static str,
    pub exe_linux: &'static str,
    pub cfg_style: CfgStyle,
    pub match_style: MatchStyle,
    /// Config file, relative to the server folder.
    pub cfg_path: &'static str,
    /// Template shipped in the zip that our config is patched from.
    pub template_path: &'static str,
    /// Value for `/dedicated_cfg=` (relative to the config folder).
    pub cfg_arg: &'static str,
    /// Folder the maps and MatchSettings are relative to.
    pub tracks_dir: &'static str,
    /// Folder the guest/black list files live in (relative to the server folder).
    pub lists_dir: &'static str,
    /// Extra start arguments (`/game=nations`, `/title=Trackmania`).
    pub extra_args: &'static [&'static str],
    /// `<packmask>` (Forever only).
    pub packmask: Option<&'static str>,
    /// Map file extension the server takes.
    pub map_ext: &'static str,
    /// A server account is needed for LAN too (TM2020).
    pub login_for_lan: bool,
    /// A server account is needed on the internet.
    pub login_for_internet: bool,
    /// Page where players create the server account (opened by a button; nothing automated).
    pub login_page: Option<&'static str>,
    /// Game id for `serverquery::query` (game-port status), None = XML-RPC only.
    pub query: Option<&'static str>,
    /// GBXRemote protocol version the server speaks (1 = 2006 server, 2 = TMF and newer).
    pub gbx_protocol: u8,
    /// TMX site for map ids and search (None = no TMX for this game).
    pub tmx: Option<&'static str>,
    /// Engines that can run this game.
    pub engines: &'static [&'static str],
    /// Why it is not built yet (status Later), shown in the UI.
    pub reason: &'static str,
}

/// Nadeo's TMF dedicated server (Windows exe and Linux binary in one zip). Downloaded once on
/// 2026-11-11 into a review folder, SHA-256 computed, readme read, nothing run. The zip holds no
/// licence text; the readme only explains the use.
pub const TMF_SERVER: Package = Package {
    id: "tmf-server-2011-02-21",
    url: "http://files2.trackmaniaforever.com/TrackmaniaServer_2011-02-21.zip",
    sha256: "dd021f49c3d58d45ee09f333015bdb35b19243a38fa65f202ca8a88fb6550c0b",
    size: 13_075_571,
    root: "",
    note: "files2.trackmaniaforever.com, checked 2026-11-11",
};

/// The 2006 server for TM Nations ESWC / Sunrise / Original (Windows exe + Linux binary). Nadeo's
/// original host is gone; this is the copy the 100% TMX servers use (Slig, who also runs
/// Dedimania). Downloaded and hashed 2026-11-11, not run. No licence file in the zip.
pub const LEGACY_SERVER: Package = Package {
    id: "tm-server-2006-05-30",
    url: "http://slig.free.fr/TM/dedicated/TmDedicatedServer_2006-05-30.zip",
    sha256: "28d79550fdd18623c47d3a428af5ce8e150402b8c4c5fa0b45d3efa4e6bf783d",
    size: 8_284_536,
    root: "TmDedicatedServer",
    note: "slig.free.fr (community mirror of Nadeo's 2006 file), checked 2026-11-11",
};

/// ManiaPlanet 4 server (TM2 titles), "Latest" zip unchanged since 2019-10-24.
pub const MP_SERVER: Package = Package {
    id: "maniaplanet-server-2019-10-24",
    url: "http://files.v04.maniaplanet.com/server/ManiaplanetServer_Latest.zip",
    sha256: "7ef745e0ee8b97e6fc3514d0d8244e2410df321e748f790badd0f5cc95e02e5f",
    size: 165_248_842,
    root: "",
    note: "files.v04.maniaplanet.com, checked 2026-11-11",
};

/// Trackmania (2020) server. Nadeo only publishes a "Latest" zip (no dated URL), so this pin breaks
/// on the next server update: the download is then refused until a launcher update carries the
/// new hash (docs/design/server-hosting.md, "TM2020 pin").
pub const TM2020_SERVER: Package = Package {
    id: "trackmania-server-2026-05-16",
    url: "https://nadeo-download.cdn.ubi.com/trackmania/TrackmaniaServer_Latest.zip",
    sha256: "5379519e729b882f67892b593c65bfe6ff11989e55f3ddd1ca6ab3029ca1df1a",
    size: 253_509_378,
    root: "",
    note: "nadeo-download.cdn.ubi.com, build 2026-05-16, checked 2026-11-11",
};

const FOREVER_ENGINES: &[&str] = &["plain", "randomizer", "xaseco"];
const LEGACY_ENGINES: &[&str] = &["plain", "randomizer"];
const NEW_ENGINES: &[&str] = &["plain"];

pub const KINDS: &[GameServerKind] = &[
    GameServerKind {
        id: "tmnf",
        label: "TrackMania Nations Forever",
        status: Status::Built,
        package: Some(TMF_SERVER),
        exe_windows: "TrackmaniaServer.exe",
        exe_linux: "TrackmaniaServer",
        cfg_style: CfgStyle::Forever,
        match_style: MatchStyle::Legacy,
        cfg_path: "GameData/Config/dedicated_cfg.txt",
        template_path: "GameData/Config/dedicated_cfg.txt",
        cfg_arg: "dedicated_cfg.txt",
        tracks_dir: "GameData/Tracks",
        lists_dir: "GameData/Config",
        extra_args: &[],
        // Same values as the 100% TMX servers run with (live-tested there).
        packmask: Some("nations"),
        map_ext: ".Challenge.Gbx",
        login_for_lan: false,
        login_for_internet: true,
        login_page: None,
        query: Some("tmnf"),
        gbx_protocol: 2,
        tmx: Some("tmnf.exchange"),
        engines: FOREVER_ENGINES,
        reason: "",
    },
    GameServerKind {
        id: "tmuf",
        label: "TrackMania United Forever",
        status: Status::Built,
        package: Some(TMF_SERVER),
        exe_windows: "TrackmaniaServer.exe",
        exe_linux: "TrackmaniaServer",
        cfg_style: CfgStyle::Forever,
        match_style: MatchStyle::Legacy,
        cfg_path: "GameData/Config/dedicated_cfg.txt",
        template_path: "GameData/Config/dedicated_cfg.txt",
        cfg_arg: "dedicated_cfg.txt",
        tracks_dir: "GameData/Tracks",
        lists_dir: "GameData/Config",
        extra_args: &[],
        packmask: Some(""),
        map_ext: ".Challenge.Gbx",
        login_for_lan: false,
        login_for_internet: true,
        login_page: None,
        query: Some("tmuf"),
        gbx_protocol: 2,
        tmx: Some("tmuf.exchange"),
        engines: FOREVER_ENGINES,
        reason: "",
    },
    GameServerKind {
        id: "eswc",
        label: "TrackMania Nations ESWC",
        status: Status::Experimental,
        package: Some(LEGACY_SERVER),
        exe_windows: "TrackManiaServer.exe",
        exe_linux: "TrackManiaServer",
        cfg_style: CfgStyle::Legacy,
        match_style: MatchStyle::Legacy,
        cfg_path: "dedicated.cfg",
        template_path: "dedicated.cfg",
        cfg_arg: "dedicated.cfg",
        tracks_dir: "GameData/Tracks",
        lists_dir: "GameData",
        extra_args: &["/game=nations"],
        packmask: None,
        map_ext: ".Challenge.Gbx",
        login_for_lan: false,
        login_for_internet: true,
        login_page: None,
        query: Some("eswc"),
        gbx_protocol: 1,
        tmx: Some("nations.tm-exchange.com"),
        engines: LEGACY_ENGINES,
        reason: "",
    },
    GameServerKind {
        id: "tms",
        label: "TrackMania Sunrise",
        status: Status::Experimental,
        package: Some(LEGACY_SERVER),
        exe_windows: "TrackManiaServer.exe",
        exe_linux: "TrackManiaServer",
        cfg_style: CfgStyle::Legacy,
        match_style: MatchStyle::Legacy,
        cfg_path: "dedicated.cfg",
        template_path: "dedicated.cfg",
        cfg_arg: "dedicated.cfg",
        tracks_dir: "GameData/Tracks",
        lists_dir: "GameData",
        extra_args: &["/game=sunrise"],
        packmask: None,
        map_ext: ".Challenge.Gbx",
        login_for_lan: false,
        login_for_internet: true,
        login_page: None,
        query: Some("tms"),
        gbx_protocol: 1,
        tmx: Some("sunrise.tm-exchange.com"),
        engines: LEGACY_ENGINES,
        reason: "",
    },
    GameServerKind {
        id: "tmo",
        label: "TrackMania Original",
        status: Status::Experimental,
        package: Some(LEGACY_SERVER),
        exe_windows: "TrackManiaServer.exe",
        exe_linux: "TrackManiaServer",
        cfg_style: CfgStyle::Legacy,
        match_style: MatchStyle::Legacy,
        cfg_path: "dedicated.cfg",
        template_path: "dedicated.cfg",
        cfg_arg: "dedicated.cfg",
        tracks_dir: "GameData/Tracks",
        lists_dir: "GameData",
        extra_args: &["/game=original"],
        packmask: None,
        map_ext: ".Challenge.Gbx",
        login_for_lan: false,
        login_for_internet: true,
        login_page: None,
        query: Some("tmo"),
        gbx_protocol: 1,
        tmx: Some("original.tm-exchange.com"),
        engines: LEGACY_ENGINES,
        reason: "",
    },
    GameServerKind {
        id: "tm2",
        label: "TrackMania² (ManiaPlanet)",
        status: Status::Experimental,
        package: Some(MP_SERVER),
        exe_windows: "ManiaPlanetServer.exe",
        exe_linux: "ManiaPlanetServer",
        cfg_style: CfgStyle::ManiaPlanet,
        match_style: MatchStyle::Script,
        cfg_path: "UserData/Config/dedicated_cfg.txt",
        template_path: "UserData/Config/dedicated_cfg.default.txt",
        cfg_arg: "dedicated_cfg.txt",
        tracks_dir: "UserData/Maps",
        lists_dir: "UserData/Config",
        extra_args: &["/title=TMStadium@nadeo"],
        packmask: None,
        map_ext: ".Map.Gbx",
        login_for_lan: false,
        login_for_internet: true,
        login_page: Some("https://www.maniaplanet.com/account/dedicated-servers"),
        query: None,
        gbx_protocol: 2,
        tmx: Some("tm.mania.exchange"),
        engines: NEW_ENGINES,
        reason: "",
    },
    GameServerKind {
        id: "tm2020",
        label: "Trackmania",
        status: Status::Experimental,
        package: Some(TM2020_SERVER),
        exe_windows: "TrackmaniaServer.exe",
        exe_linux: "TrackmaniaServer",
        cfg_style: CfgStyle::Tm2020,
        match_style: MatchStyle::Script,
        cfg_path: "UserData/Config/dedicated_cfg.txt",
        template_path: "UserData/Config/dedicated_cfg.default.txt",
        cfg_arg: "dedicated_cfg.txt",
        tracks_dir: "UserData/Maps",
        lists_dir: "UserData/Config",
        extra_args: &[],
        packmask: None,
        map_ext: ".Map.Gbx",
        login_for_lan: true,
        login_for_internet: true,
        login_page: Some("https://www.trackmania.com/player/dedicated-servers"),
        query: None,
        gbx_protocol: 2,
        tmx: Some("trackmania.exchange"),
        engines: NEW_ENGINES,
        reason: "",
    },
];

pub fn kind(id: &str) -> Option<&'static GameServerKind> {
    KINDS.iter().find(|k| k.id == id)
}

impl GameServerKind {
    pub fn exe(&self) -> &'static str {
        if cfg!(windows) {
            self.exe_windows
        } else {
            self.exe_linux
        }
    }
    /// Can it be installed now (download hash pinned)?
    pub fn installable(&self) -> bool {
        self.package.is_some_and(|p| p.sha256.len() == 64)
    }
    pub fn needs_login(&self, internet: bool) -> bool {
        if internet {
            self.login_for_internet
        } else {
            self.login_for_lan
        }
    }
    pub fn has_engine(&self, engine: &str) -> bool {
        self.engines.contains(&engine)
    }
}

/// Pinned hash check: lower-case hex, exactly what the table says.
pub fn hash_ok(p: &Package, sha256_hex: &str) -> bool {
    p.sha256.len() == 64 && p.sha256.eq_ignore_ascii_case(sha256_hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_consistent() {
        let mut ids: Vec<_> = KINDS.iter().map(|k| k.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), KINDS.len());
        for k in KINDS {
            assert!(k.engines.contains(&"plain"), "{}", k.id);
            assert!(!k.cfg_path.starts_with('/') && !k.cfg_path.contains(".."));
            if k.status == Status::Built {
                assert!(k.installable(), "{} is built but has no pinned hash", k.id);
            }
            if let Some(p) = k.login_page {
                assert!(p.starts_with("https://"));
            }
            if k.match_style == MatchStyle::Script {
                assert!(k.query.is_none());
            }
        }
        assert!(kind("tmnf").unwrap().installable());
        assert!(!kind("tmnf").unwrap().needs_login(false));
        assert!(kind("tm2020").unwrap().needs_login(false));
        assert!(kind("nope").is_none());
    }

    #[test]
    fn hash_check() {
        assert!(hash_ok(&TMF_SERVER, "DD021F49C3D58D45EE09F333015BDB35B19243A38FA65F202CA8A88FB6550C0B"));
        assert!(!hash_ok(&TMF_SERVER, "00"));
        // an empty pin never matches anything
        assert!(!hash_ok(&LEGACY_SERVER, ""));
    }
}
