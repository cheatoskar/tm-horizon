//! How each game is started and how a downloaded map is opened. Pure argument building,
//! unit tested; the only side effect is `execute`, which hands a finished plan to the
//! platform layer (or to the shell for store URLs).
//!
//! | Game | Start | Open a map |
//! |---|---|---|
//! | Forever + TMLoader profile | `TMLoader.exe run TmForever "<profile>"` | same + `"/file=<map>"` |
//! | Forever, no mods | `TmForever.exe` (Steam: `steam://rungameid/<id>`; `TmForeverLauncher.exe` with "Start with the game's launcher") | `TmForever.exe /useexedir /singleinst /file="<map>"` |
//! | Nations ESWC 1.80 | `TmNationsESWC.exe` (or its Nadeo launcher) | `TmNationsESWC.exe /file="<map>"` only when its exe has a `/file` switch (`exe_switches`), else saved + started |
//! | ManiaPlanet titles | `ManiaPlanet.exe /title=<TitleId>` | `ManiaPlanet.exe /useexedir /singleinst /title=<TitleId> /file="<map>"` |
//! | Trackmania (2020) | `uplay://launch/5595/0`, `steam://rungameid/2225070` or the Epic URL | `Trackmania.exe /useexedir /singleinst /file="<map>"` |
//! | Original, Sunrise | exe | same rule as ESWC |
//!
//! `exe_switches` looks for a switch as its own NUL-terminated string, the way TmForever.exe keeps them
//! (`/url\0/file\0/logfilename...`). Read on my PC (read only): the unofficial TmNationsESWC.exe 1.80
//! and the Sunrise repack's TmSunrise.exe contain "/file", "/url" and "/joinmatch" only inside `</file>`,
//! `</url>` (XML tags) and `/joinmatch.php` (a web path), not as switches, so for them a map from TMX
//! is saved under Downloaded and the game is started. If a build with real switches turns up, it opens
//! the map directly without a code change.
//! | Turbo | store URL or exe | none: saved, started |
//! | TrackMania (2003) | exe | none |
//! | DS / Wii (emulated) | `melonDS.exe <dump>`, `Dolphin.exe -b -e <dump> [-C ...]` | none |

use crate::scan::InstallInfo;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// One command-line argument. `Raw` is written verbatim on Windows so `/file="C:\a b\x.Gbx"`
/// comes out exactly like the game's own file association; `Plain` is quoted when needed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t", content = "v")]
pub enum Arg {
    Plain(String),
    Raw(String),
}

impl Arg {
    pub fn plain(s: impl Into<String>) -> Self {
        Arg::Plain(s.into())
    }
    pub fn raw(s: impl Into<String>) -> Self {
        Arg::Raw(s.into())
    }
    /// The argument as one argv element without Windows quoting (for Wine/umu, which quote again).
    pub fn unquoted(&self) -> String {
        match self {
            Arg::Plain(s) => s.clone(),
            Arg::Raw(s) => s.replace('"', ""),
        }
    }
    /// How the argument appears in a Windows command line.
    pub fn display(&self) -> String {
        match self {
            Arg::Raw(s) => s.clone(),
            Arg::Plain(s) => quote(s),
        }
    }
}

pub fn quote(s: &str) -> String {
    if s.is_empty() || s.contains([' ', '\t', '"']) {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LaunchTarget {
    Exe { exe: PathBuf, args: Vec<Arg>, cwd: Option<PathBuf> },
    Url { url: String },
}

impl LaunchTarget {
    pub fn display(&self) -> String {
        match self {
            LaunchTarget::Url { url } => url.clone(),
            LaunchTarget::Exe { exe, args, .. } => {
                let mut s = quote(&exe.to_string_lossy());
                for a in args {
                    s.push(' ');
                    s.push_str(&a.display());
                }
                s
            }
        }
    }
}

/// What finally runs. On Windows the runner is the exe itself; on Linux it wraps the exe in
/// wine or umu-run with one prefix per game (see docs/linux.md).
#[derive(Debug, Clone, PartialEq)]
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<Arg>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Runner {
    Native,
    Wine { wine: PathBuf, prefix: PathBuf },
    Umu { prefix: PathBuf, game_id: String, proton: Option<String> },
    /// Steam's Proton script outside Steam: `proton run <exe>` with the game's compatdata folder
    /// (Linux, Steam installs; see platform/wine.rs).
    Proton { proton: PathBuf, compat_data: PathBuf, steam_root: Option<PathBuf>, app_id: Option<u32> },
}

pub fn wrap(runner: &Runner, exe: &Path, args: &[Arg], cwd: Option<&Path>) -> CommandSpec {
    match runner {
        Runner::Native => CommandSpec {
            program: exe.to_path_buf(),
            args: args.to_vec(),
            cwd: cwd.map(Path::to_path_buf),
            env: vec![],
        },
        Runner::Wine { wine, prefix } => CommandSpec {
            program: wine.clone(),
            args: std::iter::once(Arg::plain(exe.to_string_lossy()))
                .chain(args.iter().map(|a| Arg::plain(a.unquoted())))
                .collect(),
            cwd: cwd.map(Path::to_path_buf),
            env: vec![("WINEPREFIX".into(), prefix.to_string_lossy().into())],
        },
        Runner::Umu { prefix, game_id, proton } => {
            let mut env = vec![
                ("WINEPREFIX".to_string(), prefix.to_string_lossy().into_owned()),
                ("GAMEID".to_string(), game_id.clone()),
            ];
            if let Some(p) = proton {
                env.push(("PROTONPATH".into(), p.clone()));
            }
            CommandSpec {
                program: PathBuf::from("umu-run"),
                args: std::iter::once(Arg::plain(exe.to_string_lossy()))
                    .chain(args.iter().map(|a| Arg::plain(a.unquoted())))
                    .collect(),
                cwd: cwd.map(Path::to_path_buf),
                env,
            }
        }
        Runner::Proton { proton, compat_data, steam_root, app_id } => {
            let mut env = vec![
                ("STEAM_COMPAT_DATA_PATH".to_string(), compat_data.to_string_lossy().into_owned()),
                ("STEAM_COMPAT_CLIENT_INSTALL_PATH".to_string(), steam_root.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
            ];
            if let Some(id) = app_id {
                env.push(("SteamAppId".into(), id.to_string()));
                env.push(("SteamGameId".into(), id.to_string()));
            }
            CommandSpec {
                program: proton.clone(),
                args: [Arg::plain("run"), Arg::plain(exe.to_string_lossy())]
                    .into_iter()
                    .chain(args.iter().map(|a| Arg::plain(a.unquoted())))
                    .collect(),
                cwd: cwd.map(Path::to_path_buf),
                env,
            }
        }
    }
}

pub fn title_id(game_id: &str) -> Option<&'static str> {
    Some(match game_id {
        "tm2-stadium" => "TMStadium@nadeo",
        "tm2-canyon" => "TMCanyon@nadeo",
        "tm2-valley" => "TMValley@nadeo",
        "tm2-lagoon" => "TMLagoon@nadeo",
        "sm-storm" => "SMStorm@nadeo",
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Family {
    Forever,
    Eswc,
    ManiaPlanet,
    Tm2020,
    Turbo,
    Legacy,
    /// The first TrackMania (2003): its exe, no mods, no Horizon Client.
    Classic,
    /// Console games: the emulator exe with the dump (consoles.rs).
    Console,
}

pub fn family(game_id: &str) -> Option<Family> {
    Some(match game_id {
        "tmnf" | "tmuf" => Family::Forever,
        "tmn-eswc" => Family::Eswc,
        "tm2020" => Family::Tm2020,
        "tm-turbo" => Family::Turbo,
        "tm-original" | "tm-sunrise" => Family::Legacy,
        "tm-2003" => Family::Classic,
        g if crate::consoles::is_console(g) => Family::Console,
        g if title_id(g).is_some() => Family::ManiaPlanet,
        _ => return None,
    })
}

pub struct PlanInput<'a> {
    pub game_id: &'a str,
    pub install: &'a InstallInfo,
    /// TMLoader.exe, when TMLoader is installed.
    pub tmloader_exe: Option<&'a Path>,
    /// TMLoader profile name; None = start without mods.
    pub profile: Option<&'a str>,
    /// Start the game's own Nadeo launcher (menu with the settings, then Play) instead of the game exe:
    /// ESWC (`TmNationsESWCLauncher.exe`) and Forever (`TmForeverLauncher.exe`, only without a TMLoader
    /// profile and without a join link). Ignored when the install has no launcher exe.
    pub use_launcher: bool,
    /// tmtp:// or maniaplanet:// join link.
    pub join: Option<&'a str>,
}

fn exe_of(i: &InstallInfo) -> Result<PathBuf, String> {
    i.exe.as_ref().map(PathBuf::from).ok_or_else(|| "No exe known for this install".to_string())
}

fn cwd_of(i: &InstallInfo) -> Option<PathBuf> {
    Some(PathBuf::from(&i.path))
}

fn tmloader<'a>(p: &PlanInput<'a>) -> Option<(&'a Path, &'a str)> {
    match (p.tmloader_exe, p.profile) {
        (Some(exe), Some(profile)) => Some((exe, profile)),
        _ => None,
    }
}

pub(crate) fn tmloader_run(exe: &Path, profile: &str, extra: Vec<Arg>) -> LaunchTarget {
    // Same arguments TMLoader's own desktop shortcut uses: run <game> "<profile>".
    let mut args = vec![Arg::plain("run"), Arg::plain("TmForever"), Arg::plain(profile)];
    args.extend(extra);
    LaunchTarget::Exe { exe: exe.to_path_buf(), args, cwd: exe.parent().map(Path::to_path_buf) }
}

/// A join link the games understand and nothing else: tmtp://, maniaplanet:// or trackmania://,
/// at most 300 characters from a small set (no quotes, spaces or control characters), so it
/// cannot break out of the `/url="..."` argument.
pub fn valid_join(j: &str) -> bool {
    let l = j.to_ascii_lowercase();
    (l.starts_with("tmtp://") || l.starts_with("maniaplanet://") || l.starts_with("trackmania://"))
        && j.len() <= 300
        && j.chars().all(|c| c.is_ascii_alphanumeric() || "/:#@._~=&%+-!$,;?".contains(c))
}

/// A map path that can go into `/file="..."`: no quotes or control characters.
pub fn valid_file_arg(f: &str) -> bool {
    !f.is_empty() && !f.chars().any(|c| c == '"' || c.is_control())
}

pub fn plan_launch(p: &PlanInput) -> Result<LaunchTarget, String> {
    let fam = family(p.game_id).ok_or_else(|| format!("Unknown game {}", p.game_id))?;
    if let Some(j) = p.join {
        if !valid_join(j) {
            return Err("Not a valid join link".into());
        }
    }
    let i = p.install;
    Ok(match fam {
        Family::Forever => {
            if let Some((exe, profile)) = tmloader(p) {
                let extra = p.join.map(|j| vec![Arg::plain(format!("/url={j}"))]).unwrap_or_default();
                tmloader_run(exe, profile, extra)
            } else if let Some(j) = p.join {
                // Same as the tmtp: association.
                LaunchTarget::Exe {
                    exe: exe_of(i)?,
                    args: vec![Arg::raw("/useexedir"), Arg::raw("/singleinst"), Arg::raw(format!("/url=\"{j}\""))],
                    cwd: cwd_of(i),
                }
            } else if let (Some(l), true) = (&i.launcher, p.use_launcher) {
                LaunchTarget::Exe { exe: PathBuf::from(l), args: vec![], cwd: cwd_of(i) }
            } else if let Some(url) = &i.launch {
                LaunchTarget::Url { url: url.clone() }
            } else {
                LaunchTarget::Exe { exe: exe_of(i)?, args: vec![], cwd: cwd_of(i) }
            }
        }
        Family::Eswc => {
            let exe = match (&i.launcher, p.use_launcher) {
                (Some(l), true) => PathBuf::from(l),
                _ => exe_of(i)?,
            };
            LaunchTarget::Exe { exe, args: vec![], cwd: cwd_of(i) }
        }
        Family::ManiaPlanet => {
            let title = title_id(p.game_id).unwrap();
            let args = match p.join {
                Some(j) => vec![Arg::raw("/useexedir"), Arg::raw("/singleinst"), Arg::raw(format!("/url=\"{j}\""))],
                None => vec![Arg::plain(format!("/title={title}"))],
            };
            LaunchTarget::Exe { exe: exe_of(i)?, args, cwd: cwd_of(i) }
        }
        Family::Console => {
            if i.rom.is_none() {
                return Err("Pick your dump file first".into());
            }
            LaunchTarget::Exe { exe: exe_of(i)?, args: i.extra_args.iter().map(Arg::plain).collect(), cwd: PathBuf::from(exe_of(i)?).parent().map(Path::to_path_buf) }
        }
        Family::Tm2020 | Family::Turbo | Family::Legacy | Family::Classic => match &i.launch {
            Some(url) => LaunchTarget::Url { url: url.clone() },
            None => LaunchTarget::Exe { exe: exe_of(i)?, args: vec![], cwd: cwd_of(i) },
        },
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapPlan {
    pub target: LaunchTarget,
    /// The game opens the map itself; false = it only starts, the map waits under Downloaded.
    pub direct: bool,
}

/// Command-line switches found in an old game's exe (ESWC, Original, Sunrise), see `exe_switches`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExeSwitches {
    pub file: bool,
    pub singleinst: bool,
}

/// Looks for `/file` and `/singleinst` as ASCII or UTF-16 strings in an exe (read only).
pub fn exe_switches(bytes: &[u8]) -> ExeSwitches {
    let has = |s: &str| {
        let a = s.as_bytes();
        let w: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        // A string of its own: NUL (or the start) before it, NUL, '=', space, quote or '%' after it.
        // "</file>" (XML) and "/joinmatch.php" (a web path) do not count.
        let ends = |next: Option<&u8>| matches!(next, None | Some(0) | Some(b'=') | Some(b' ') | Some(b'"') | Some(b'%'));
        let starts = |i: usize| i == 0 || bytes[i - 1] == 0;
        bytes.windows(a.len()).enumerate().any(|(i, x)| x.eq_ignore_ascii_case(a) && starts(i) && ends(bytes.get(i + a.len())))
            || bytes.windows(w.len()).enumerate().any(|(i, x)| x == w.as_slice() && starts(i) && ends(bytes.get(i + w.len())))
    };
    ExeSwitches { file: has("/file"), singleinst: has("/singleinst") }
}

pub fn plan_open_map(p: &PlanInput, map: &Path) -> Result<MapPlan, String> {
    plan_open_map_with(p, map, &ExeSwitches::default())
}

/// `sw`: switches of the old game's exe (ESWC, Original, Sunrise); ignored for the other games.
pub fn plan_open_map_with(p: &PlanInput, map: &Path, sw: &ExeSwitches) -> Result<MapPlan, String> {
    let fam = family(p.game_id).ok_or_else(|| format!("Unknown game {}", p.game_id))?;
    let i = p.install;
    let file = map.to_string_lossy();
    if !valid_file_arg(&file) {
        return Err("This file name cannot be passed to the game".into());
    }
    let assoc = |extra: Vec<Arg>| -> Result<LaunchTarget, String> {
        let mut args = vec![Arg::raw("/useexedir"), Arg::raw("/singleinst")];
        args.extend(extra);
        args.push(Arg::raw(format!("/file=\"{file}\"")));
        Ok(LaunchTarget::Exe { exe: exe_of(i)?, args, cwd: cwd_of(i) })
    };
    Ok(match fam {
        Family::Forever => match tmloader(p) {
            Some((exe, profile)) => MapPlan { target: tmloader_run(exe, profile, vec![Arg::plain(format!("/file={file}"))]), direct: true },
            None => MapPlan { target: assoc(vec![])?, direct: true },
        },
        Family::ManiaPlanet => {
            let title = title_id(p.game_id).unwrap();
            MapPlan { target: assoc(vec![Arg::plain(format!("/title={title}"))])?, direct: true }
        }
        Family::Tm2020 => MapPlan { target: assoc(vec![])?, direct: true },
        // The game exe itself (never ESWC's Nadeo launcher), only with the switches it has.
        Family::Eswc | Family::Legacy if sw.file => {
            let mut args = if sw.singleinst { vec![Arg::raw("/singleinst")] } else { vec![] };
            args.push(Arg::raw(format!("/file=\"{file}\"")));
            MapPlan { target: LaunchTarget::Exe { exe: exe_of(i)?, args, cwd: cwd_of(i) }, direct: true }
        }
        Family::Eswc | Family::Turbo | Family::Legacy | Family::Classic => {
            MapPlan { target: plan_launch(&PlanInput { join: None, ..*p })?, direct: false }
        }
        Family::Console => return Err("Maps are not opened in console games".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst(path: &str, exe: &str) -> InstallInfo {
        InstallInfo {
            source: "Installer".into(),
            path: path.into(),
            exe: Some(format!("{path}\\{exe}")),
            launcher: None,
            launch: None,
            modified: None,
            note: None,
            steam_app_id: None,
            rom: None,
            extra_args: vec![],
        }
    }

    fn input<'a>(game: &'a str, i: &'a InstallInfo) -> PlanInput<'a> {
        PlanInput { game_id: game, install: i, tmloader_exe: None, profile: None, use_launcher: false, join: None }
    }

    const TML: &str = r"C:\Users\me\AppData\Local\TMLoader\TMLoader.exe";

    #[test]
    fn join_links_and_file_args_are_validated() {
        assert!(valid_join("tmtp://#join=frl_cup"));
        assert!(valid_join("tmtp:///#join=85.214.10.7:2350"));
        assert!(valid_join("maniaplanet://#join=tm2_relay@TMStadium@nadeo"));
        assert!(!valid_join(r#"tmtp://#join=x" /file=C:\evil.Gbx"#));
        assert!(!valid_join("tmtp://#join=a b"));
        assert!(!valid_join("https://example.com"));
        assert!(!valid_join("tmtp://\u{7}"));
        let i = inst(r"C:\TmNationsForever", "TmForever.exe");
        let bad = PlanInput { join: Some(r#"tmtp://x" /evil"#), ..input("tmnf", &i) };
        assert!(plan_launch(&bad).is_err());
        assert!(plan_open_map(&input("tmnf", &i), Path::new(r#"C:\a" /x.Gbx"#)).is_err());
        assert!(valid_file_arg(r"C:\Users\me\Documents\TrackMania\Tracks\Challenges\Downloaded\A07 (1).Challenge.Gbx"));
    }

    #[test]
    fn forever_with_profile_uses_tmloader_run() {
        let i = inst(r"C:\Program Files (x86)\TmUnitedForever", "TmForever.exe");
        let tml = PathBuf::from(TML);
        let p = PlanInput { tmloader_exe: Some(&tml), profile: Some("New Profile 1"), ..input("tmuf", &i) };
        let t = plan_launch(&p).unwrap();
        assert_eq!(t.display(), r#"C:\Users\me\AppData\Local\TMLoader\TMLoader.exe run TmForever "New Profile 1""#);
        match &t {
            LaunchTarget::Exe { cwd, args, .. } => {
                let _ = &cwd;
                #[cfg(windows)]
                assert_eq!(cwd.as_deref(), Some(Path::new(r"C:\Users\me\AppData\Local\TMLoader")));
                assert_eq!(args.len(), 3);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn forever_without_mods_starts_exe_or_steam() {
        let i = inst(r"C:\Program Files (x86)\TmNationsForever", "TmForever.exe");
        let t = plan_launch(&input("tmnf", &i)).unwrap();
        assert_eq!(t.display(), r#""C:\Program Files (x86)\TmNationsForever\TmForever.exe""#);
        let mut s = inst(r"E:\SteamLibrary\steamapps\common\TrackMania Nations Forever", "TmForever.exe");
        s.launch = Some("steam://rungameid/11020".into());
        assert_eq!(plan_launch(&input("tmnf", &s)).unwrap(), LaunchTarget::Url { url: "steam://rungameid/11020".into() });
    }

    #[test]
    fn forever_can_start_its_own_launcher() {
        let mut i = inst(r"C:\Program Files (x86)\TmUnitedForever", "TmForever.exe");
        // No launcher exe in the folder: the switch changes nothing.
        assert!(plan_launch(&PlanInput { use_launcher: true, ..input("tmuf", &i) }).unwrap().display().ends_with(r#"TmForever.exe""#));
        i.launcher = Some(r"C:\Program Files (x86)\TmUnitedForever\TmForeverLauncher.exe".into());
        assert!(plan_launch(&input("tmuf", &i)).unwrap().display().ends_with(r#"TmForever.exe""#), "off: the game directly");
        let on = PlanInput { use_launcher: true, ..input("tmuf", &i) };
        assert_eq!(plan_launch(&on).unwrap().display(), r#""C:\Program Files (x86)\TmUnitedForever\TmForeverLauncher.exe""#);
        // Steam install: on = the launcher exe, off = Steam as before.
        let mut s = i.clone();
        s.launch = Some("steam://rungameid/11020".into());
        assert!(plan_launch(&PlanInput { use_launcher: true, ..input("tmnf", &s) }).unwrap().display().ends_with(r#"TmForeverLauncher.exe""#));
        // A TMLoader profile or a join link wins: the launcher cannot pass them on.
        let tml = PathBuf::from(TML);
        assert!(plan_launch(&PlanInput { tmloader_exe: Some(&tml), profile: Some("p"), ..on }).unwrap().display().contains("TMLoader.exe run"));
        assert!(plan_launch(&PlanInput { join: Some("tmtp://#join=x"), ..on }).unwrap().display().contains("TmForever.exe"));
    }

    #[test]
    fn forever_map_matches_file_association() {
        let i = inst(r"C:\Program Files (x86)\TmUnitedForever", "TmForever.exe");
        let map = Path::new(r"C:\Users\me\Documents\TrackMania\Tracks\Challenges\Downloaded\A07 Race.Challenge.Gbx");
        let m = plan_open_map(&input("tmuf", &i), map).unwrap();
        assert!(m.direct);
        assert_eq!(
            m.target.display(),
            r#""C:\Program Files (x86)\TmUnitedForever\TmForever.exe" /useexedir /singleinst /file="C:\Users\me\Documents\TrackMania\Tracks\Challenges\Downloaded\A07 Race.Challenge.Gbx""#
        );
        let tml = PathBuf::from(TML);
        let p = PlanInput { tmloader_exe: Some(&tml), profile: Some("default"), ..input("tmuf", &i) };
        let m = plan_open_map(&p, map).unwrap();
        assert_eq!(
            m.target.display(),
            r#"C:\Users\me\AppData\Local\TMLoader\TMLoader.exe run TmForever default "/file=C:\Users\me\Documents\TrackMania\Tracks\Challenges\Downloaded\A07 Race.Challenge.Gbx""#
        );
    }

    #[test]
    fn eswc_starts_game_exe_or_launcher_and_has_no_file_option() {
        let mut i = inst(r"C:\Users\me\Games\TMN-ESWC-inoffiziell", "TmNationsESWC.exe");
        i.launcher = Some(r"C:\Users\me\Games\TMN-ESWC-inoffiziell\TmNationsESWCLauncher.exe".into());
        let t = plan_launch(&input("tmn-eswc", &i)).unwrap();
        assert_eq!(t.display(), r"C:\Users\me\Games\TMN-ESWC-inoffiziell\TmNationsESWC.exe");
        let p = PlanInput { use_launcher: true, ..input("tmn-eswc", &i) };
        assert!(plan_launch(&p).unwrap().display().ends_with("TmNationsESWCLauncher.exe"));
        let m = plan_open_map(&input("tmn-eswc", &i), Path::new(r"C:\x\a.Challenge.Gbx")).unwrap();
        assert!(!m.direct);
        assert!(!m.target.display().contains("/file"));
        // The exe has /file: the map opens directly, with the game exe even when the launcher is the start option.
        let sw = exe_switches(b"\0/joinmatch\0/url\0/file\0/filex");
        assert_eq!(sw, ExeSwitches { file: true, singleinst: false });
        let m = plan_open_map_with(&p, Path::new(r"C:\x\a b.Challenge.Gbx"), &sw).unwrap();
        assert!(m.direct);
        assert_eq!(m.target.display(), r#"C:\Users\me\Games\TMN-ESWC-inoffiziell\TmNationsESWC.exe /file="C:\x\a b.Challenge.Gbx""#);
    }

    #[test]
    fn legacy_exe_switches() {
        assert_eq!(exe_switches(b"no switches here /filename\0"), ExeSwitches::default());
        // What the ESWC and Sunrise exes really contain: XML tags and a web path, no switches.
        assert_eq!(exe_switches(b"um>\0\0\0\0</file>\n\0stuse>\0</url>\n\0%s/joinmatch.php?log"), ExeSwitches::default());
        let wide: Vec<u8> = "/singleinst\0/file=".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(exe_switches(&wide), ExeSwitches { file: true, singleinst: true });
        let i = inst(r"E:\Games\TrackMania Sunrise", "TmSunrise.exe");
        let m = plan_open_map_with(&input("tm-sunrise", &i), Path::new(r"E:\Games\TrackMania Sunrise\GameData\Tracks\Challenges\Downloaded\x.Challenge.Gbx"), &ExeSwitches { file: true, singleinst: false }).unwrap();
        assert!(m.direct);
        assert!(m.target.display().ends_with(r#"TmSunrise.exe" /file="E:\Games\TrackMania Sunrise\GameData\Tracks\Challenges\Downloaded\x.Challenge.Gbx""#));
        // Without /file it only starts.
        let m = plan_open_map_with(&input("tm-sunrise", &i), Path::new(r"E:\x.Challenge.Gbx"), &ExeSwitches::default()).unwrap();
        assert!(!m.direct);
        // Turbo never gets /file.
        let t = inst(r"C:\Turbo", "TrackManiaTurbo.exe");
        assert!(!plan_open_map_with(&input("tm-turbo", &t), Path::new(r"C:\x.Map.Gbx"), &ExeSwitches { file: true, singleinst: true }).unwrap().direct);
    }

    #[test]
    fn maniaplanet_titles() {
        let i = inst(r"C:\Program Files (x86)\ManiaPlanet", "ManiaPlanet.exe");
        let t = plan_launch(&input("tm2-canyon", &i)).unwrap();
        assert_eq!(t.display(), r#""C:\Program Files (x86)\ManiaPlanet\ManiaPlanet.exe" /title=TMCanyon@nadeo"#);
        let m = plan_open_map(&input("tm2-stadium", &i), Path::new(r"C:\D\Maps\Downloaded\x.Map.Gbx")).unwrap();
        assert_eq!(
            m.target.display(),
            r#""C:\Program Files (x86)\ManiaPlanet\ManiaPlanet.exe" /useexedir /singleinst /title=TMStadium@nadeo /file="C:\D\Maps\Downloaded\x.Map.Gbx""#
        );
    }

    #[test]
    fn trackmania_uses_store_url() {
        let mut i = inst(r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\games\Trackmania", "Trackmania.exe");
        i.launch = Some("uplay://launch/5595/0".into());
        assert_eq!(plan_launch(&input("tm2020", &i)).unwrap().display(), "uplay://launch/5595/0");
        let m = plan_open_map(&input("tm2020", &i), Path::new(r"C:\M\a.Map.Gbx")).unwrap();
        assert!(m.target.display().ends_with(r#"Trackmania.exe" /useexedir /singleinst /file="C:\M\a.Map.Gbx""#));
    }

    #[test]
    fn console_games_start_the_emulator_with_the_dump() {
        let mut i = inst(r"D:\Wii", "Dolphin.exe");
        i.exe = Some(r"C:\Emu\Dolphin\Dolphin.exe".into());
        assert!(plan_launch(&input("tm-wii", &i)).is_err(), "no dump picked");
        i.rom = Some(r"D:\Wii\TrackMania (Europe).rvz".into());
        i.extra_args = crate::consoles::launch_args(crate::consoles::Emu::Dolphin, i.rom.as_deref().unwrap(), &Default::default());
        assert_eq!(plan_launch(&input("tm-wii", &i)).unwrap().display(), r#"C:\Emu\Dolphin\Dolphin.exe -b -e "D:\Wii\TrackMania (Europe).rvz""#);
        assert_eq!(family("tm-ds"), Some(Family::Console));
        assert_eq!(family("tm-2003"), Some(Family::Classic));
    }

    #[test]
    fn join_links() {
        let i = inst(r"C:\TMUF", "TmForever.exe");
        let p = PlanInput { join: Some("tmtp://#join=myserver"), ..input("tmuf", &i) };
        assert_eq!(plan_launch(&p).unwrap().display(), r#"C:\TMUF\TmForever.exe /useexedir /singleinst /url="tmtp://#join=myserver""#);
    }

    #[test]
    fn runners_wrap_for_linux() {
        let args = vec![Arg::raw("/useexedir"), Arg::raw(r#"/file="C:\a b\x.Gbx""#)];
        let exe = Path::new(r"C:\Games\TmForever.exe");
        let native = wrap(&Runner::Native, exe, &args, None);
        assert_eq!(native.program, exe);
        assert_eq!(native.args, args);
        let umu = wrap(
            &Runner::Umu { prefix: "/home/u/Games/tmuf".into(), game_id: "umu-7200".into(), proton: None },
            exe,
            &args,
            None,
        );
        assert_eq!(umu.program, PathBuf::from("umu-run"));
        assert_eq!(umu.args[2], Arg::plain(r"/file=C:\a b\x.Gbx"));
        assert!(umu.env.contains(&("GAMEID".into(), "umu-7200".into())));
    }
}
