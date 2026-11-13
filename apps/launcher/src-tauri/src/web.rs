//! The embedded browser for TMX and TM RPG Trial (Maps page), ManiaPark (Skins page) and
//! TMTAS Exchange (TAS corner on the Forever page): one child webview
//! laid over a placeholder in the page. TMX and ManiaPark forbid frames (X-Frame-Options), so
//! an iframe cannot work; a real webview can.
//!
//! Logins persist like in a browser: the embedded view has its own WebView2 profile folder
//! (`<local app data>\EmbeddedWeb`), separate from the launcher UI's storage, never incognito,
//! never cleared on exit. TM Horizon stores no passwords; "Sign out of embedded sites" clears that
//! profile.
//!
//! Downloads of .Gbx (maps, replays) and skin/mod files are caught and saved straight into the
//! selected game's folders; everything else goes to the user's Downloads folder as usual.

use crate::state::AppState;
use crate::{fsx, maps, net, skins};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewUrl};

pub const LABEL: &str = "embed";

/// "Play in <game>" buttons on the TM-Exchange sites (see web_play.js), added to every page load.
pub const PLAY_SCRIPT: &str = include_str!("web_play.js");
/// Hosts whose track downloads the play buttons may start.
const PLAY_HOSTS: [&str; 5] = ["nations.tm-exchange.com", "sunrise.tm-exchange.com", "original.tm-exchange.com", "tmnf.exchange", "tmuf.exchange"];
/// Download started by a play button: opened in the game when it finishes.
static PENDING_PLAY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// A Play on tmnf/tmuf.exchange while Nations/United Forever runs: the site's `/trackplay/<id>` answers with a
/// `tmtp:///:tmx:download:<game>?token=...` link, which the running game takes over (download and play) through
/// its own handler. Set when the launcher asked for it, so only that answer is opened, and only shortly after.
static PENDING_TRACKPLAY: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

/// `tmtp:///:tmx:download:tmnf|tmu?token=<token>` exactly (what tmnf.exchange / tmuf.exchange answer for trackplay).
pub fn tmx_trackplay_link(u: &str) -> bool {
    let Some(rest) = u.strip_prefix("tmtp:///:tmx:download:") else { return false };
    let Some((game, token)) = rest.split_once("?token=") else { return false };
    matches!(game, "tmnf" | "tmu") && !token.is_empty() && token.len() <= 512 && token.chars().all(|c| c.is_ascii_alphanumeric() || "-_.~%".contains(c))
}

/// The trackplay page for a trackgbx download of tmnf/tmuf.exchange, when TmForever.exe runs; else None.
fn trackplay_url(t: &Url) -> Option<Url> {
    let host = t.host_str()?.to_ascii_lowercase();
    if host != "tmnf.exchange" && host != "tmuf.exchange" {
        return None;
    }
    if !crate::platform::running_process_names().iter().any(|p| p.eq_ignore_ascii_case("TmForever.exe")) {
        return None;
    }
    let id = t.path().strip_prefix("/trackgbx/")?;
    Url::parse(&format!("https://{host}/trackplay/{id}")).ok()
}

// ------------------------------------------------------------------ login seen in another site

/// Cookie names per cookie domain at the last finished page load. Logging in or out adds or removes
/// a session cookie (values of analytics cookies change on every load, names do not), so a change of
/// the NAMES of a domain means "signed in or out there".
static COOKIE_NAMES: std::sync::Mutex<Option<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>>> = std::sync::Mutex::new(None);
/// Hosts whose page was loaded before such a change: reloaded once the next time they finish loading.
static STALE_HOSTS: std::sync::Mutex<std::collections::BTreeSet<String>> = std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Cookie domains whose set of names changed between two snapshots.
pub fn changed_cookie_domains(before: &std::collections::BTreeMap<String, std::collections::BTreeSet<String>>, now: &std::collections::BTreeMap<String, std::collections::BTreeSet<String>>) -> Vec<String> {
    let mut out: Vec<String> = now.iter().filter(|(d, n)| before.get(*d) != Some(*n)).map(|(d, _)| d.clone()).collect();
    out.extend(before.keys().filter(|d| !now.contains_key(*d)).cloned());
    out.sort();
    out.dedup();
    out
}

/// The listed sites a cookie domain belongs to (the domain itself, its subdomains, or a parent).
pub fn hosts_of_cookie_domain(domain: &str) -> Vec<&'static str> {
    let d = domain.trim_start_matches('.').to_ascii_lowercase();
    SITES.iter().map(|(h, _)| *h).chain(["maniapark.com"]).filter(|h| *h == d || h.ends_with(&format!(".{d}")) || d.ends_with(&format!(".{h}"))).collect()
}

/// After a page finished loading (call off the main thread: reading cookies on it deadlocks
/// WebView2): notes sign-ins and sign-outs, marks the other pages of that site family stale and
/// reloads this page once when it was itself loaded before a sign-in elsewhere.
fn after_page_load<R: Runtime>(app: &AppHandle<R>, page_host: &str) {
    let Some(w) = app.get_webview(LABEL) else { return };
    let Ok(cookies) = w.cookies() else { return };
    let mut now: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> = std::collections::BTreeMap::new();
    for c in &cookies {
        let d = c.domain().unwrap_or("").trim_start_matches('.').to_ascii_lowercase();
        if !hosts_of_cookie_domain(&d).is_empty() {
            now.entry(d).or_default().insert(c.name().to_string());
        }
    }
    let changed = {
        let mut prev = COOKIE_NAMES.lock().unwrap_or_else(|e| e.into_inner());
        let changed = prev.as_ref().map(|p| changed_cookie_domains(p, &now)).unwrap_or_default();
        *prev = Some(now);
        changed
    };
    let mut stale = STALE_HOSTS.lock().unwrap_or_else(|e| e.into_inner());
    for d in &changed {
        for h in hosts_of_cookie_domain(d) {
            if h != page_host {
                stale.insert(h.to_string());
            }
        }
    }
    if stale.remove(page_host) && changed.is_empty() {
        drop(stale);
        let _ = w.reload();
    }
}

/// `tmhub-play:<encoded https://<exchange>/trackgbx/<id>>` -> the download URL (only those).
pub fn play_target(u: &str) -> Option<Url> {
    let rest = u.strip_prefix("tmhub-play:")?;
    let decoded = url::form_urlencoded::parse(format!("u={rest}").as_bytes()).find(|(k, _)| k == "u")?.1.into_owned();
    let t = Url::parse(&decoded).ok()?;
    let host = t.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let id = t.path().strip_prefix("/trackgbx/")?;
    (t.scheme() == "https" && t.username().is_empty() && t.port().is_none() && PLAY_HOSTS.contains(&host) && !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
        .then_some(t)
}

/// Same download as the one a play button asked for (query and fragment ignored).
fn same_download(a: &str, b: &str) -> bool {
    let k = |s: &str| s.split(['?', '#']).next().unwrap_or("").trim_end_matches('/').to_ascii_lowercase();
    k(a) == k(b)
}

#[derive(Debug, Clone, Default)]
pub struct WebState {
    /// "maps" (TMX, TM RPG Trial), "skins" (ManiaPark) or "tas" (TMTAS Exchange).
    pub mode: String,
    pub game: String,
    /// Site within the mode: "" (default: the game's TMX / ManiaPark), "rpg" (TM RPG Trial) or a
    /// host from SITES picked in the site switcher.
    pub site: String,
}

pub const TMTAS_HOST: &str = "tmtas.exchange";
pub const RPG_HOST: &str = "tmrpgtrial.com";
/// Games TM RPG Trial covers (Trackmania 2020 RPG/Trial maps).
pub const RPG_GAMES: [&str; 1] = ["tm2020"];
/// Games TMTAS Exchange covers.
pub const TMTAS_GAMES: [&str; 3] = ["tmnf", "tmuf", "tm2020"];

/// Sites the site switcher can open, with the games each one covers. Map and replay downloads go
/// into the selected game's folders. ManiaPark (skins) has its own page and download rules.
/// Map tools: 100tmx.com Map Inspector (opens on the inspector page) and the GBX.NET web tools.
pub const INSPECTOR_HOST: &str = "100tmx.com";
/// gbx.tools is a placeholder page; the site switcher lists its tools (subdomains), all allowed in the view.
pub const GBXTOOLS_HOST: &str = "gbx.tools";
pub const GBXTOOLS_SITES: [&str; 3] = ["explorer.gbx.tools", "3d.gbx.tools", "revalidate.gbx.tools"];
pub const NC_HOST: &str = "nc.gbx.tools";
pub const NC_GAMES: [&str; 3] = ["tmnf", "tmuf", "tm2020"];
pub const INSPECTOR_GAMES: [&str; 5] = ["tmnf", "tmuf", "tmn-eswc", "tm-original", "tm-sunrise"];
pub const GBXTOOLS_GAMES: [&str; 11] = ["tmnf", "tmuf", "tmn-eswc", "tm-original", "tm-sunrise", "tm2-stadium", "tm2-canyon", "tm2-valley", "tm2-lagoon", "sm-storm", "tm2020"];

pub const SITES: [(&str, &[&str]); 17] = [
    ("tmnf.exchange", &["tmnf"]),
    ("tmuf.exchange", &["tmuf"]),
    ("nations.tm-exchange.com", &["tmn-eswc"]),
    ("original.tm-exchange.com", &["tm-original"]),
    ("sunrise.tm-exchange.com", &["tm-sunrise"]),
    ("tm.mania.exchange", &["tm2-stadium", "tm2-canyon", "tm2-valley", "tm2-lagoon"]),
    ("sm.mania.exchange", &["sm-storm"]),
    ("trackmania.exchange", &["tm2020"]),
    ("item.exchange", &["tm2020"]),
    ("item.mania.exchange", &["tm2-stadium", "tm2-canyon", "tm2-valley", "tm2-lagoon", "sm-storm"]),
    (TMTAS_HOST, &TMTAS_GAMES),
    (RPG_HOST, &RPG_GAMES),
    (INSPECTOR_HOST, &INSPECTOR_GAMES),
    (GBXTOOLS_SITES[0], &GBXTOOLS_GAMES),
    (GBXTOOLS_SITES[1], &GBXTOOLS_GAMES),
    (GBXTOOLS_SITES[2], &GBXTOOLS_GAMES),
    (NC_HOST, &NC_GAMES),
];

fn host_is(host: &str, domain: &str) -> bool {
    let h = host.to_lowercase();
    h == domain || h.ends_with(&format!(".{domain}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageEvent {
    pub url: String,
    pub loading: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub url: String,
    pub path: Option<String>,
    pub folder: Option<String>,
    pub game: String,
    pub mode: String,
    /// "map", "replay", "skin", "mod", "file"
    pub kind: String,
    pub caught: bool,
    pub success: Option<bool>,
    pub message: Option<String>,
    /// Started by a "Play in <game>" button: the launcher opens the map once it is saved.
    #[serde(default)]
    pub play: bool,
}

pub fn profile_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("tm-horizon")).join("EmbeddedWeb")
}

pub fn home_url(mode: &str, game: &str, site: &str) -> Option<String> {
    if mode != "skins" {
        if let Some((h, games)) = SITES.iter().find(|(h, _)| *h == site) {
            let path = if *h == INSPECTOR_HOST { "tools/map-inspector" } else { "" };
            return games.contains(&game).then(|| format!("https://{h}/{path}"));
        }
    }
    match (mode, site) {
        ("skins", _) => Some(skins::home_url(game).to_string()),
        ("tas", _) => TMTAS_GAMES.contains(&game).then(|| format!("https://{TMTAS_HOST}/")),
        ("maps", "rpg") => RPG_GAMES.contains(&game).then(|| format!("https://{RPG_HOST}/")),
        _ => maps::tmx_site(game).map(|h| format!("https://{h}/")),
    }
}

pub fn allowed_host(mode: &str, host: &str) -> bool {
    maps::exchange_host(host)
        || skins::park_host(host)
        || (mode == "skins" && host_is(host, "mania.exchange"))
        || ((mode == "tas" || mode == "maps") && (host_is(host, TMTAS_HOST) || host_is(host, "item.exchange")))
        || (mode == "maps" && (host_is(host, RPG_HOST) || host_is(host, INSPECTOR_HOST) || host_is(host, GBXTOOLS_HOST)))
}

/// Steam app ids of the TrackMania games (steam://run/<id>, steam://rungameid/<id>).
const STEAM_IDS: [&str; 9] = ["11020", "7200", "228760", "232910", "243360", "600720", "229870", "2225070", "375900"];

/// Game links a site may hand to the OS, after the user confirms in the launcher: server joins
/// (tmtp://, maniaplanet://, trackmania:// in the same strict form as Play uses), Steam starts
/// of the TrackMania games and Ubisoft Connect's Trackmania. Anything else is dropped.
pub fn allowed_game_link(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    if l.starts_with("tmtp:") || l.starts_with("maniaplanet:") || l.starts_with("trackmania:") {
        return crate::launch::valid_join(u);
    }
    for pre in ["steam://run/", "steam://rungameid/"] {
        if let Some(id) = l.strip_prefix(pre) {
            return STEAM_IDS.contains(&id.trim_end_matches('/'));
        }
    }
    l == "uplay://launch/5595/0" || l == "uplay://launch/5595"
}

/// Where a download goes. None = not ours (default location).
fn route<R: Runtime>(app: &AppHandle<R>, url: &Url, suggested: &Path) -> (Option<PathBuf>, DownloadInfo) {
    let st = app.state::<AppState>();
    let web = st.web.lock().unwrap().clone();
    let docs = crate::platform::documents_dir().unwrap_or_default();
    let install_dir = st.install_dir(&web.game);
    let mut info = DownloadInfo {
        url: url.to_string(),
        path: None,
        folder: None,
        game: web.game.clone(),
        mode: web.mode.clone(),
        kind: "file".into(),
        caught: false,
        success: None,
        message: None,
        play: false,
    };
    let name = suggested.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let target = if let Some(kind) = maps::gbx_kind(&name).filter(|k| *k != maps::GbxKind::Other) {
        info.kind = if kind == maps::GbxKind::Replay { "replay" } else { "map" }.into();
        maps::route(&web.game, suggested, &docs, install_dir.as_deref())
    } else if web.mode == "skins" {
        let page = st.web_page.lock().unwrap().clone();
        let r = skins::route(&web.game, url.as_str(), &page, &name, &docs, install_dir.as_deref());
        if let Some((kind, p)) = &r {
            info.kind = kind.as_str().into();
            // Installed list (skinlib.rs): which ManiaPark asset this file is.
            crate::skinlib::note_source(&st.data_dir, p, url.as_str());
        }
        r.map(|(_, p)| p)
    } else {
        None
    };
    if let Some(t) = &target {
        st.routed.lock().unwrap().push(t.clone());
        info.caught = true;
        info.path = Some(t.to_string_lossy().into());
        info.folder = t.parent().map(|p| p.to_string_lossy().into());
    }
    (target, info)
}

fn builder<R: Runtime>(app: &AppHandle<R>, url: Url) -> WebviewBuilder<R> {
    let a1 = app.clone();
    let a2 = app.clone();
    let a3 = app.clone();
    let a4 = app.clone();
    let b = WebviewBuilder::new(LABEL, WebviewUrl::External(url)).data_directory(profile_dir(app)).initialization_script(PLAY_SCRIPT);
    // Browser add-ons (addons.rs) live in this profile only; the launcher UI's own webview keeps
    // extensions off. WebView2 needs the switch when the environment is created.
    #[cfg(windows)]
    let b = b.browser_extensions_enabled(true);
    b
        .on_navigation(move |u| {
            if u.scheme() == "tmhub-play" {
                // A "Play in <game>" button: download that track (caught as usual), then open it.
                if let Some(t) = play_target(u.as_str()) {
                    // Forever running: hand the map to the running game (TMX's own trackplay link), no new start.
                    if let Some(tp) = trackplay_url(&t) {
                        *PENDING_TRACKPLAY.lock().unwrap() = Some(std::time::Instant::now());
                        let a = a1.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Some(w) = a.get_webview(LABEL) {
                                let _ = w.navigate(tp);
                            }
                        });
                        return false;
                    }
                    *PENDING_PLAY.lock().unwrap() = Some(t.to_string());
                    let a = a1.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(w) = a.get_webview(LABEL) {
                            let _ = w.navigate(t);
                        }
                    });
                }
                return false;
            }
            if u.scheme() == "http" || u.scheme() == "https" || u.scheme() == "about" || u.scheme() == "data" || u.scheme() == "blob" {
                return true;
            }
            // The answer to our own trackplay request: open it at once (the game's tmtp handler forwards it to the
            // running game). Any other tmtp link still goes through the launcher's question below.
            if tmx_trackplay_link(u.as_str()) && PENDING_TRACKPLAY.lock().unwrap().take().is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(30)) {
                use tauri_plugin_opener::OpenerExt;
                let _ = a1.opener().open_url(u.as_str(), None::<&str>);
                return false;
            }
            // Never opened directly: the launcher asks first (see allowed_game_link).
            if allowed_game_link(u.as_str()) {
                let _ = a1.emit_to("main", "web-external", u.to_string());
            }
            false
        })
        .on_new_window(move |u, _features| {
            // target=_blank: exchange pages stay in the view, the rest opens in the browser.
            let mode = a2.state::<AppState>().web.lock().unwrap().mode.clone();
            if u.host_str().map(|h| allowed_host(&mode, h)).unwrap_or(false) {
                if let Some(w) = a2.get_webview(LABEL) {
                    let _ = w.navigate(u);
                }
            } else if u.scheme() == "https" || u.scheme() == "http" || allowed_game_link(u.as_str()) {
                // Other sites open in the browser, but only after the user confirms in the launcher.
                let _ = a2.emit_to("main", "web-external", u.to_string());
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_w, p| {
            let url = p.url().to_string();
            *a3.state::<AppState>().web_page.lock().unwrap() = url.clone();
            if matches!(p.event(), PageLoadEvent::Finished) {
                let host = p.url().host_str().unwrap_or("").to_ascii_lowercase();
                let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
                let a = a3.clone();
                std::thread::spawn(move || after_page_load(&a, &host));
            }
            let _ = a3.emit_to("main", "web-page", PageEvent { url, loading: matches!(p.event(), PageLoadEvent::Started) });
        })
        .on_download(move |_w, ev| {
            match ev {
                DownloadEvent::Requested { url, destination } => {
                    let (target, info) = route(&a4, &url, destination);
                    if let Some(t) = target {
                        *destination = t;
                    }
                    let _ = a4.emit_to("main", "web-download", info);
                }
                DownloadEvent::Finished { url, path, success } => {
                    let st = a4.state::<AppState>();
                    let web = st.web.lock().unwrap().clone();
                    let mut info = DownloadInfo {
                        url: url.to_string(),
                        folder: path.as_ref().and_then(|p| p.parent()).map(|p| p.to_string_lossy().into()),
                        path: path.as_ref().map(|p| p.to_string_lossy().into()),
                        game: web.game,
                        mode: web.mode,
                        kind: "file".into(),
                        caught: false,
                        success: Some(success),
                        message: None,
                        play: false,
                    };
                    {
                        let mut pending = PENDING_PLAY.lock().unwrap();
                        if pending.as_deref().is_some_and(|p| same_download(p, url.as_str())) {
                            info.play = success;
                            *pending = None;
                        }
                    }
                    if let Some(p) = &path {
                        let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                        info.kind = match maps::gbx_kind(&name) {
                            Some(maps::GbxKind::Map) => "map",
                            Some(maps::GbxKind::Replay) => "replay",
                            _ => "file",
                        }
                        .into();
                        info.caught = st.was_routed(p);
                        if info.caught && info.kind == "file" {
                            info.kind = skins::kind_of_path(p).unwrap_or("skin").into();
                        }
                    }
                    let _ = a4.emit_to("main", "web-download-done", info);
                }
                _ => {}
            }
            true
        })
}

pub fn show<R: Runtime>(app: &AppHandle<R>, mode: &str, game: &str, site: &str, url: Option<String>, x: f64, y: f64, w: f64, h: f64) -> Result<String, String> {
    let st = app.state::<AppState>();
    let changed = {
        let mut ws = st.web.lock().unwrap();
        let changed = ws.mode != mode || ws.game != game || ws.site != site;
        ws.mode = mode.into();
        ws.game = game.into();
        ws.site = site.into();
        changed || url.is_some()
    };
    let target = match url {
        Some(u) => u,
        None => home_url(mode, game, site).ok_or("No site for this game")?,
    };
    let parsed = Url::parse(&target).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" || !parsed.host_str().map(|h| allowed_host(mode, h)).unwrap_or(false) {
        return Err(format!("Not a page TM Horizon shows inside: {target}"));
    }
    let pos = LogicalPosition::new(x, y);
    let size = LogicalSize::new(w.max(1.0), h.max(1.0));
    match app.get_webview(LABEL) {
        Some(wv) => {
            if changed || st.web_force_nav.swap(false, std::sync::atomic::Ordering::Relaxed) {
                wv.navigate(parsed).map_err(|e| e.to_string())?;
            }
            wv.set_position(pos).map_err(|e| e.to_string())?;
            wv.set_size(size).map_err(|e| e.to_string())?;
            wv.show().map_err(|e| e.to_string())?;
        }
        None => {
            let window = app.get_window("main").ok_or("no main window")?;
            window.add_child(builder(app, parsed), pos, size).map_err(|e| e.to_string())?;
            // Load the installed add-ons into the new view's profile (and drop unknown ones).
            let a = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = crate::addons::cmd::sync_now(&a) {
                    let _ = a.emit_to("main", "addons-error", e);
                }
            });
        }
    }
    Ok(target)
}

pub fn navigate<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<(), String> {
    let wv = app.get_webview(LABEL).ok_or("not open")?;
    let mode = app.state::<AppState>().web.lock().unwrap().mode.clone();
    let u = Url::parse(url).map_err(|e| e.to_string())?;
    if u.scheme() != "https" || !u.host_str().map(|h| allowed_host(&mode, h)).unwrap_or(false) {
        return Err("Not an exchange page".into());
    }
    wv.navigate(u).map_err(|e| e.to_string())
}

pub fn bounds<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn nav<R: Runtime>(app: &AppHandle<R>, action: &str) -> Result<(), String> {
    let wv = app.get_webview(LABEL).ok_or("not open")?;
    match action {
        "back" => wv.eval("history.back()"),
        "forward" => wv.eval("history.forward()"),
        "reload" => wv.reload(),
        _ => Ok(()),
    }
    .map_err(|e| e.to_string())
}

/// Signs out of every embedded site: clears cookies, storage and cache of the embedded profile.
pub fn clear<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let existing = app.get_webview(LABEL);
    let wv = match existing {
        Some(w) => w,
        None => {
            // A hidden, tiny view on the same profile, just to clear it.
            let window = app.get_window("main").ok_or("no main window")?;
            let w = window
                .add_child(builder(app, Url::parse("about:blank").unwrap()), LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
                .map_err(|e| e.to_string())?;
            let _ = w.hide();
            w
        }
    };
    wv.clear_all_browsing_data().map_err(|e| e.to_string())?;
    app.state::<AppState>().web_force_nav.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Where a caught download would go for `game` (same rules as the download itself).
pub fn folder_for(game: &str, kind: &str, name: &str, docs: &Path, install_dir: Option<&Path>) -> Option<PathBuf> {
    match kind {
        "map" => maps::download_dir(game, maps::GbxKind::Map, docs, install_dir),
        "replay" => maps::download_dir(game, maps::GbxKind::Replay, docs, install_dir),
        "skin" => skins::target_dir(game, skins::SkinKind::Skin, name, docs),
        "mod" => skins::target_dir(game, skins::SkinKind::Mod, name, docs),
        _ => None,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTarget {
    pub game: String,
    pub folder: Option<String>,
    /// The download already sits in this folder (same game, or a game sharing the folder).
    pub here: bool,
    /// Another game earlier in the list uses the same folder.
    pub shared_with: Option<String>,
}

/// Folders a caught download would go to for each game, with shared folders marked.
pub fn copy_targets(path: &Path, kind: &str, games: &[(String, Option<PathBuf>)], docs: &Path) -> Vec<CopyTarget> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let src_dir = path.parent().map(fsx::norm);
    let mut seen: Vec<(String, String)> = vec![];
    games
        .iter()
        .map(|(g, install)| {
            let folder = folder_for(g, kind, &name, docs, install.as_deref());
            let key = folder.as_deref().map(fsx::norm);
            let shared_with = key.as_ref().and_then(|k| seen.iter().find(|(_, f)| f == k).map(|(g2, _)| g2.clone()));
            if let Some(k) = &key {
                seen.push((g.clone(), k.clone()));
            }
            CopyTarget { game: g.clone(), here: key.is_some() && key == src_dir, folder: folder.map(|f| f.to_string_lossy().into()), shared_with }
        })
        .collect()
}

/// Copies a caught download into the folders of more games; folders that already have it (or that
/// an earlier game in the list shares) are skipped. Only files the embedded browser saved itself.
pub fn copy_to(path: &Path, kind: &str, games: &[(String, Option<PathBuf>)], docs: &Path, routed: &[PathBuf]) -> Result<Vec<(String, String)>, String> {
    if !routed.iter().any(|r| r == path) || !fsx::is_file(path) {
        return Err("Not a download from the embedded browser".into());
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("No file name")?;
    let mut out = vec![];
    for t in copy_targets(path, kind, games, docs) {
        let Some(folder) = t.folder.map(PathBuf::from) else { continue };
        if t.here || t.shared_with.is_some() || fsx::blocked(&folder) {
            continue;
        }
        let dest = maps::unique_path(&folder, &name);
        fsx::copy(path, &dest)?;
        out.push((t.game, dest.to_string_lossy().into()));
    }
    Ok(out)
}

/// Hosts whose icon the site switcher may fetch (the sites it lists).
pub fn icon_host_ok(host: &str) -> bool {
    host == "maniapark.com" || SITES.iter().any(|(h, _)| *h == host)
}

fn icon_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if b.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.starts_with(&[0xFF, 0xD8]) {
        Some("image/jpeg")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Browser-like user agent for the icon requests (a few sites answer unknown clients with 403).
const ICON_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// The site's icon as a data: URL, fetched once and cached in `cache_dir`. Candidates in order: the
/// <link rel=icon / shortcut icon / apple-touch-icon> of the start page (relative hrefs resolved),
/// /favicon.ico, /apple-touch-icon.png. Only ico/png/webp/jpeg/gif are used (SVG could carry
/// scripts); when nothing loads the UI uses the bundled icon in public/site-icons, then the game
/// cover.
pub fn site_icon(cache_dir: &Path, host: &str) -> Result<String, String> {
    use base64::Engine;
    if !icon_host_ok(host) {
        return Err("Unknown site".into());
    }
    let file = cache_dir.join("site-icons").join(format!("{host}.bin"));
    let cached = std::fs::read(&file).ok().filter(|b| icon_mime(b).is_some());
    let bytes = match cached {
        Some(b) => b,
        None => {
            // A site without a usable icon (gbx.tools has only an SVG) is asked again after a week, not on
            // every start: the UI shows the bundled icon meanwhile.
            let none = cache_dir.join("site-icons").join(format!("{host}.none"));
            if std::fs::metadata(&none).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age < std::time::Duration::from_secs(7 * 86_400)) {
                return Err("No icon".into());
            }
            let get = |url: &str| net::get_bytes_ua(url, 768 << 10, ICON_UA).ok().filter(|b| icon_mime(b).is_some());
            let page = format!("https://{host}/");
            let html = net::get_bytes_ua(&page, 2 << 20, ICON_UA).unwrap_or_default();
            let html = String::from_utf8_lossy(&html).to_string();
            let mut urls: Vec<String> = icon_hrefs(&html).iter().filter_map(|h| resolve_href(&page, h)).collect();
            urls.push(format!("https://{host}/favicon.ico"));
            urls.push(format!("https://{host}/apple-touch-icon.png"));
            let mut tried = std::collections::HashSet::new();
            let Some(b) = urls.into_iter().filter(|u| tried.insert(u.clone())).find_map(|u| get(&u)) else {
                if !html.is_empty() {
                    if let Some(p) = none.parent() {
                        let _ = std::fs::create_dir_all(p);
                    }
                    let _ = fsx::write(&none, b"");
                }
                return Err("No icon".into());
            };
            if let Some(p) = file.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let _ = fsx::write(&file, &b);
            b
        }
    };
    let mime = icon_mime(&bytes).ok_or("No icon")?;
    // WebView2 does not render every .ico in a data: URL (multi-size icons stayed empty boxes) and some
    // sites hand out 600 px PNGs: the UI gets one small PNG (largest frame, at most 64 px).
    if let Some(png) = small_png(&bytes) {
        return Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)));
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// Any icon (ico: its largest frame) as a PNG of at most 64x64; None when it cannot be decoded.
fn small_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let img = if img.width() > 64 || img.height() > 64 { img.resize(64, 64, image::imageops::FilterType::Lanczos3) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// Value of attribute `name` in one tag's text (quoted or bare), case-insensitive name.
fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace() || lower.as_bytes()[at - 1] == b'"' || lower.as_bytes()[at - 1] == b'\'';
        let rest = tag[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let rest = rest[1..].trim_start();
        let q = rest.chars().next()?;
        let v = if q == '"' || q == '\'' { rest[1..].split(q).next()? } else { rest.split(|c: char| c.is_whitespace() || c == '>').next()? };
        return Some(v.replace("&amp;", "&"));
    }
    None
}

/// hrefs of the page's icon links, best first: rel=icon / shortcut icon, then apple-touch-icon.
/// SVG icons and data: URLs are skipped; stylesheets that merely have "icon" in their name are not
/// icon links (only the rel value counts).
fn icon_hrefs(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let (mut plain, mut touch) = (Vec::new(), Vec::new());
    let mut from = 0;
    while let Some(i) = lower[from..].find("<link") {
        let start = from + i;
        let Some(e) = lower[start..].find('>') else { break };
        let end = start + e;
        from = end;
        let tag = &html[start..end];
        let Some(rel) = tag_attr(tag, "rel") else { continue };
        let Some(href) = tag_attr(tag, "href") else { continue };
        let rel = rel.to_ascii_lowercase();
        let rels: Vec<&str> = rel.split_whitespace().collect();
        let path = href.to_ascii_lowercase();
        let path = path.split(['?', '#']).next().unwrap_or("");
        if href.is_empty() || path.ends_with(".svg") || path.starts_with("data:") || tag_attr(tag, "type").is_some_and(|t| t.to_ascii_lowercase().contains("svg")) {
            continue;
        }
        if rels.contains(&"icon") {
            plain.push(href);
        } else if rels.iter().any(|r| r.starts_with("apple-touch-icon")) {
            touch.push(href);
        }
    }
    plain.extend(touch);
    plain
}

/// First icon link (kept for the tests and simple callers).
#[cfg(test)]
fn icon_href(html: &str) -> Option<String> {
    icon_hrefs(html).into_iter().next()
}

/// Absolute https URL of `href` seen from the page `base` (https://host/ or https://host/path).
fn resolve_href(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.starts_with("https://") {
        return Some(href.to_string());
    }
    if href.starts_with("http://") {
        return Some(format!("https://{}", &href[7..]));
    }
    let rest = base.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if let Some(r) = href.strip_prefix("//") {
        return Some(format!("https://{r}"));
    }
    if let Some(r) = href.strip_prefix('/') {
        return Some(format!("https://{host}/{r}"));
    }
    if href.contains(':') {
        return None;
    }
    let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for seg in href.split('/') {
        match seg {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    Some(format!("https://{host}/{}", parts.join("/")))
}

/// The user navigated inside the view to another listed site: remember game and site without
/// reloading the page (the next show() then sees no change).
pub fn follow<R: Runtime>(app: &AppHandle<R>, game: &str, site: &str) -> Result<(), String> {
    let ok = SITES.iter().any(|(h, games)| *h == site && games.contains(&game));
    if !ok {
        return Err("Unknown site".into());
    }
    let st = app.state::<AppState>();
    let mut ws = st.web.lock().unwrap();
    ws.game = game.into();
    ws.site = site.into();
    Ok(())
}

/// Result of the quick reachability check of a page about to be shown.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebCheck {
    /// "ok" | "offline" | "dns" | "timeout" | "server" | "other"
    pub reason: String,
    pub status: Option<u16>,
}

fn check_of(reason: &str, status: Option<u16>) -> WebCheck {
    WebCheck { reason: reason.into(), status }
}

/// HTTP status -> reason class. Everything below 500 counts as reachable (403 from a bot filter,
/// 404 of a deep link: the page itself shows that).
pub fn classify_status(status: u16) -> WebCheck {
    if status >= 500 { check_of("server", Some(status)) } else { check_of("ok", Some(status)) }
}

/// Transport error text (ureq / OS) -> reason class.
pub fn classify_error(msg: &str) -> WebCheck {
    let m = msg.to_lowercase();
    let has = |xs: &[&str]| xs.iter().any(|x| m.contains(x));
    let reason = if has(&["timed out", "timeout", "os error 10060", "os error 110"]) {
        "timeout"
    } else if has(&["dns", "failed to lookup", "no such host", "name or service not known", "os error 11001", "os error 11004", "nodename nor servname"]) {
        "dns"
    } else if has(&["connection refused", "network is unreachable", "network unreachable", "no route to host", "os error 10061", "os error 10051", "os error 10065", "os error 111", "os error 101", "connection reset", "connection aborted", "os error 10053", "os error 10054"]) {
        "offline"
    } else {
        "other"
    };
    check_of(reason, None)
}

/// Quick check (about 6 s at most) whether the page can be reached. https and listed hosts only.
pub fn check(mode: &str, url: &str) -> WebCheck {
    let Ok(u) = Url::parse(url) else { return check_of("other", None) };
    let Some(h) = u.host_str() else { return check_of("other", None) };
    if u.scheme() != "https" || !allowed_host(mode, h) {
        return check_of("other", None);
    }
    match net::probe(u.as_str(), 6) {
        Ok(s) => classify_status(s),
        Err(e) => classify_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_classes() {
        assert_eq!(classify_status(200).reason, "ok");
        assert_eq!(classify_status(404).reason, "ok");
        assert_eq!(classify_status(403).reason, "ok");
        assert_eq!(classify_status(502), WebCheck { reason: "server".into(), status: Some(502) });
        assert_eq!(classify_error("Dns Failed: failed to lookup address information").reason, "dns");
        assert_eq!(classify_error("Connection Failed: Connect error: connection refused (os error 10061)").reason, "offline");
        assert_eq!(classify_error("Network is unreachable (os error 101)").reason, "offline");
        assert_eq!(classify_error("Connection Failed: timed out reading response").reason, "timeout");
        assert_eq!(classify_error("Connection Failed: tls handshake eof").reason, "other");
    }

    #[test]
    fn check_refuses_foreign_or_plain() {
        assert_eq!(check("maps", "http://tmnf.exchange/").reason, "other");
        assert_eq!(check("maps", "https://example.com/").reason, "other");
        assert_eq!(check("maps", "not a url").reason, "other");
    }

    #[test]
    fn tmx_trackplay_links_only_in_their_exact_form() {
        assert!(tmx_trackplay_link("tmtp:///:tmx:download:tmnf?token=abc-DEF_123"));
        assert!(tmx_trackplay_link("tmtp:///:tmx:download:tmu?token=x"));
        assert!(!tmx_trackplay_link("tmtp:///:tmx:download:tm2?token=x"));
        assert!(!tmx_trackplay_link("tmtp:///:tmx:download:tmnf?token="));
        assert!(!tmx_trackplay_link("tmtp:///:tmx:download:tmnf?token=a b"));
        assert!(!tmx_trackplay_link("tmtp:///:tmx:download:tmnf?token=a\"&x"));
        assert!(!tmx_trackplay_link("tmtp://#join=abc"));
    }

    #[test]
    fn play_buttons_only_for_exchange_track_downloads() {
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let t = play_target(&format!("tmhub-play:{}", enc("https://sunrise.tm-exchange.com/trackgbx/12345"))).unwrap();
        assert_eq!(t.as_str(), "https://sunrise.tm-exchange.com/trackgbx/12345");
        assert!(play_target(&format!("tmhub-play:{}", enc("https://nations.tm-exchange.com/trackgbx/7?packid=3"))).is_some());
        assert!(play_target(&format!("tmhub-play:{}", enc("https://evil.example/trackgbx/1"))).is_none());
        assert!(play_target(&format!("tmhub-play:{}", enc("http://sunrise.tm-exchange.com/trackgbx/1"))).is_none());
        assert!(play_target(&format!("tmhub-play:{}", enc("https://sunrise.tm-exchange.com/tracksearch"))).is_none());
        assert!(play_target(&format!("tmhub-play:{}", enc("https://sunrise.tm-exchange.com.evil.example/trackgbx/1"))).is_none());
        assert!(same_download("https://sunrise.tm-exchange.com/trackgbx/1", "https://SUNRISE.tm-exchange.com/trackgbx/1?x=1"));
        assert!(!same_download("https://sunrise.tm-exchange.com/trackgbx/1", "https://sunrise.tm-exchange.com/trackgbx/12"));
        assert!(PLAY_SCRIPT.contains("/trackgbx/") && PLAY_SCRIPT.contains("tmhub-play:"));
    }

    #[test]
    fn hosts_need_a_dot_boundary() {
        assert!(allowed_host("skins", "maniapark.com"));
        assert!(allowed_host("skins", "sm.mania.exchange"));
        assert!(!allowed_host("skins", "evilmania.exchange"));
        assert!(!allowed_host("maps", "evil-tmnf.exchange.example"));
        assert!(allowed_host("tas", "tmtas.exchange"));
        assert!(!allowed_host("tas", "nottmtas.exchange"));
        assert!(allowed_host("maps", "tmrpgtrial.com"));
        assert!(allowed_host("maps", "explorer.gbx.tools") && allowed_host("maps", "100tmx.com"));
        assert!(!allowed_host("skins", "100tmx.com") && !allowed_host("maps", "evil100tmx.com"));
        assert_eq!(home_url("maps", "tmnf", "100tmx.com").as_deref(), Some("https://100tmx.com/tools/map-inspector"));
        assert!(!allowed_host("skins", "tmrpgtrial.com"));
    }

    #[test]
    fn home_urls_per_mode_and_site() {
        assert_eq!(home_url("maps", "tmnf", "").as_deref(), Some("https://tmnf.exchange/"));
        assert_eq!(home_url("maps", "tm2020", "rpg").as_deref(), Some("https://tmrpgtrial.com/"));
        assert_eq!(home_url("maps", "tmnf", "rpg"), None);
        assert_eq!(home_url("tas", "tmuf", "").as_deref(), Some("https://tmtas.exchange/"));
        assert_eq!(home_url("tas", "tm2-stadium", ""), None);
        // Site switcher: a listed host for a game it covers, nothing else.
        assert_eq!(home_url("maps", "tm2020", "item.exchange").as_deref(), Some("https://item.exchange/"));
        assert_eq!(home_url("maps", "tmnf", "tmtas.exchange").as_deref(), Some("https://tmtas.exchange/"));
        assert_eq!(home_url("maps", "tm-sunrise", "sunrise.tm-exchange.com").as_deref(), Some("https://sunrise.tm-exchange.com/"));
        assert_eq!(home_url("maps", "tmnf", "item.exchange"), None);
        assert_eq!(home_url("maps", "tmnf", "evil.example"), Some("https://tmnf.exchange/".into()));
        assert!(allowed_host("maps", "item.exchange") && allowed_host("maps", "item.mania.exchange"));
        assert!(!allowed_host("maps", "notitem.exchange"));
    }

    #[test]
    fn game_links_are_whitelisted() {
        assert!(allowed_game_link("tmtp://#join=frl_cup"));
        assert!(allowed_game_link("maniaplanet://#join=relay@TMStadium@nadeo"));
        assert!(allowed_game_link("steam://rungameid/11020"));
        assert!(allowed_game_link("uplay://launch/5595/0"));
        assert!(!allowed_game_link("steam://install/12345"));
        assert!(!allowed_game_link("steam://rungameid/730"));
        assert!(!allowed_game_link("tmtp://#join=x\" /evil"));
        assert!(!allowed_game_link("uplay://launch/1/0"));
        assert!(!allowed_game_link("ms-settings:"));
    }

    #[test]
    fn sign_in_elsewhere_marks_the_site_family() {
        use std::collections::{BTreeMap, BTreeSet};
        let set = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();
        let mut a: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        a.insert("tmnf.exchange".into(), set(&["_ga"]));
        let mut b = a.clone();
        assert!(changed_cookie_domains(&a, &b).is_empty());
        b.insert("tmnf.exchange".into(), set(&["_ga", ".AspNetCore.Identity"]));
        assert_eq!(changed_cookie_domains(&a, &b), vec!["tmnf.exchange"]);
        assert_eq!(changed_cookie_domains(&b, &a), vec!["tmnf.exchange"]);
        assert_eq!(hosts_of_cookie_domain(".tmnf.exchange"), vec!["tmnf.exchange"]);
        let mx = hosts_of_cookie_domain("mania.exchange");
        assert!(mx.contains(&"tm.mania.exchange") && mx.contains(&"sm.mania.exchange") && mx.contains(&"item.mania.exchange"));
        assert!(hosts_of_cookie_domain("google.com").is_empty());
    }

    #[test]
    fn icon_links_and_copy_targets() {
        assert_eq!(icon_href(r#"<head><link rel="stylesheet" href="a.css"><link rel="icon" type="image/png" href="/img/fav.png"></head>"#).as_deref(), Some("/img/fav.png"));
        assert_eq!(icon_href(r#"<link rel="icon" href="/x.svg">"#), None);
        // Stylesheets with "icon" in the name are no icon links; apple-touch-icon comes after rel=icon.
        let page = r#"<link href="./_app/IconButton.css" rel="stylesheet"><link rel="apple-touch-icon" href="/t.png"><link href='./favicon.png' rel='shortcut icon'><link rel="icon" sizes="800x800" href="https://images.mania.exchange/l.png?v=1&amp;x=2">"#;
        assert_eq!(icon_hrefs(page), vec!["./favicon.png", "https://images.mania.exchange/l.png?v=1&x=2", "/t.png"]);
        assert_eq!(resolve_href("https://tmtas.exchange/", "./favicon.png").as_deref(), Some("https://tmtas.exchange/favicon.png"));
        assert_eq!(resolve_href("https://a.example/x/y.html", "../i.ico").as_deref(), Some("https://a.example/i.ico"));
        assert_eq!(resolve_href("https://a.example/", "//cdn.example/i.png").as_deref(), Some("https://cdn.example/i.png"));
        assert_eq!(resolve_href("https://a.example/", "/ixicon.png").as_deref(), Some("https://a.example/ixicon.png"));
        assert_eq!(resolve_href("https://a.example/", "javascript:x"), None);
        assert!(icon_host_ok("tmnf.exchange") && icon_host_ok("maniapark.com") && !icon_host_ok("evil.example"));
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("Documents");
        let src = docs.join("TrackMania/Skins/Vehicles/CarCommon/Blue.zip");
        let games = vec![("tmnf".to_string(), None), ("tmuf".to_string(), None), ("tm2-stadium".to_string(), None), ("tm2-canyon".to_string(), None)];
        let ts = copy_targets(&src, "skin", &games, &docs);
        assert!(ts[0].here && ts[1].here, "TMNF and TMUF share Documents/TrackMania");
        assert_eq!(ts[1].shared_with.as_deref(), Some("tmnf"));
        assert!(!ts[2].here && ts[2].folder.as_deref().unwrap().contains("StadiumCar"));
        assert!(ts[3].folder.as_deref().unwrap().contains("CanyonCar"));
        // Only files the browser saved itself are copied.
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, "PK").unwrap();
        assert!(copy_to(&src, "skin", &games, &docs, &[]).is_err());
        let done = copy_to(&src, "skin", &games, &docs, &[src.clone()]).unwrap();
        assert_eq!(done.len(), 2);
        assert!(docs.join("ManiaPlanet/Skins/Models/StadiumCar/Blue.zip").is_file());
    }
}
