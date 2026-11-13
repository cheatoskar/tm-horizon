//! Benchmark hand-over to Horizon Host's `performance` module.
//!
//! The launcher writes `<horizon data root>\data\performance\bench-request.json`, starts the game the
//! normal way and later reads what the module wrote to `...\data\performance\bench\`:
//! `<yyyymmdd-hhmmss>_<label>.json` (summary) and `.csv` (per frame, not read here).
//! Horizon data root: legacy games `<game>\horizon\`, Forever = the TMLoader product folder of Horizon Host.
//! Nothing starts by itself; the player clicks in the game.

use crate::commands::{fail, ok, ActionResult};
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const REQUEST_FILE: &str = "bench-request.json";

/// Where Horizon Host keeps its files for this game (None = not installed).
pub fn host_root(st: &AppState, game: &str) -> Option<PathBuf> {
    use crate::horizonhost as hh;
    let r = if hh::is_legacy(game) {
        let d = st.install_dir(game)?.join(hh::format::HOST_DIR);
        hh::read_record(&d).is_some().then_some(d)
    } else if hh::is_forever(game) {
        // The host keeps settings, logs and plugin data in the product folder above its version folder
        // (`...\products\Horizon Host\data\`), so they survive an update (horizon-host src/host/main.cpp).
        hh::tml_host_root(&st.tmloader_root()?, None).and_then(|v| v.parent().map(Path::to_path_buf))
    } else {
        None
    };
    r.filter(|p| !crate::fsx::blocked(p))
}

pub fn perf_dir(host: &Path) -> PathBuf {
    host.join("data").join("performance")
}

pub fn bench_dir(host: &Path) -> PathBuf {
    perf_dir(host).join("bench")
}

/// The same characters the module keeps in file names (perf::safeLabel: ASCII letters, digits, `-_.`),
/// so the label in the results is the one typed here. Spaces become `-`.
pub fn clean_label(s: &str) -> Result<String, String> {
    let l: String = s
        .trim()
        .chars()
        .map(|c| if c == ' ' { '-' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c))
        .take(40)
        .collect();
    let l = l.trim_start_matches(['.', '_']).to_string();
    if l.is_empty() {
        Err("Label is empty".into())
    } else {
        Ok(l)
    }
}

/// The request file content.
pub fn build_request(mode: &str, map: Option<&str>, label: &str, runs: u32) -> Result<Value, String> {
    let label = clean_label(label)?;
    let runs = runs.clamp(1, 10);
    match mode {
        "map" => {
            let m = map.ok_or("Pick a map")?;
            if !m.to_lowercase().ends_with(".challenge.gbx") {
                return Err("Pick a .Challenge.Gbx map".into());
            }
            let p = Path::new(m);
            if !p.is_absolute() || !p.is_file() || crate::fsx::blocked(p) {
                return Err("The map file was not found".into());
            }
            Ok(serde_json::json!({"version":1,"mode":"map","map":m,"seconds":30,"warmup":5,"label":label,"runs":runs,"returnToMenu":true}))
        }
        "replay" => Ok(serde_json::json!({"version":1,"mode":"replay","seconds":30,"warmup":5,"label":label,"runs":runs,"returnToMenu":true})),
        _ => Err("Unknown mode".into()),
    }
}

// ------------------------------------------------------------------ results

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub file: String,
    pub game: Option<String>,
    pub label: String,
    pub run: Option<u32>,
    pub started: Option<String>,
    pub seconds: Option<f64>,
    pub frames: Option<u64>,
    pub avg_fps: Option<f64>,
    pub avg_ms: Option<f64>,
    pub median_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    pub p999_ms: Option<f64>,
    pub low1_fps: Option<f64>,
    pub low01_fps: Option<f64>,
    pub stutters: Option<u64>,
    pub present_ms_avg: Option<f64>,
    pub cpu_ms_avg: Option<f64>,
    pub draws_per_frame: Option<f64>,
    pub options: Option<Value>,
}

/// Reads one summary; any field may be missing, null or of the wrong type. None = not JSON / no object.
pub fn parse_summary(text: &str, file: &str) -> Option<Summary> {
    let v: Value = serde_json::from_str(text).ok()?;
    let o = v.as_object()?;
    let f = |k: &str| o.get(k).and_then(Value::as_f64).filter(|x| x.is_finite());
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    // The label is also part of the file name (<time>_<label>.json) when the field is missing.
    let stem = file.trim_end_matches(".json");
    let from_name = stem.split_once('_').map(|x| x.1.to_string()).unwrap_or_default();
    Some(Summary {
        file: file.into(),
        game: s("game"),
        label: s("label").filter(|l| !l.is_empty()).unwrap_or(from_name),
        run: f("run").map(|x| x as u32),
        started: s("started"),
        seconds: f("seconds"),
        frames: f("frames").map(|x| x as u64),
        avg_fps: f("avgFps"),
        avg_ms: f("avgMs"),
        median_ms: f("medianMs"),
        p99_ms: f("p99Ms"),
        p999_ms: f("p999Ms"),
        low1_fps: f("low1Fps"),
        low01_fps: f("low01Fps"),
        stutters: f("stutters").map(|x| x as u64),
        present_ms_avg: f("presentMsAvg"),
        cpu_ms_avg: f("cpuMsAvg"),
        draws_per_frame: f("drawsPerFrame"),
        options: o.get("options").filter(|x| x.is_object()).cloned(),
    })
}

/// Newest first (file names start with the time).
pub fn list_results(dir: &Path, max: usize) -> Vec<Summary> {
    let mut names: Vec<String> = crate::fsx::list(dir).into_iter().filter(|e| !e.is_dir && e.name.to_lowercase().ends_with(".json")).map(|e| e.name).collect();
    names.sort();
    names.reverse();
    names.into_iter().take(max).filter_map(|n| parse_summary(&crate::fsx::read_string(&dir.join(&n))?, &n)).collect()
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LabelStat {
    pub label: String,
    pub runs: u32,
    pub avg_fps: Option<f64>,
    pub low1_fps: Option<f64>,
    pub low01_fps: Option<f64>,
    /// Difference to the label "baseline" in percent (None for the baseline itself or without one).
    pub diff_avg: Option<f64>,
    pub diff_low1: Option<f64>,
    pub diff_low01: Option<f64>,
}

fn mean(v: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let (s, n) = v.flatten().fold((0.0, 0u32), |(s, n), x| (s + x, n + 1));
    (n > 0).then(|| s / n as f64)
}

fn pct(v: Option<f64>, base: Option<f64>) -> Option<f64> {
    match (v, base) {
        (Some(v), Some(b)) if b > 0.0 => Some((v - b) / b * 100.0),
        _ => None,
    }
}

/// Mean of the runs per label, in order of first appearance, and the difference to "baseline".
pub fn compare(results: &[Summary]) -> Vec<LabelStat> {
    let mut labels: Vec<&str> = vec![];
    for r in results {
        if !labels.contains(&r.label.as_str()) {
            labels.push(&r.label);
        }
    }
    let mut out: Vec<LabelStat> = labels
        .iter()
        .map(|l| {
            let g: Vec<&Summary> = results.iter().filter(|r| r.label == *l).collect();
            LabelStat {
                label: l.to_string(),
                runs: g.len() as u32,
                avg_fps: mean(g.iter().map(|r| r.avg_fps)),
                low1_fps: mean(g.iter().map(|r| r.low1_fps)),
                low01_fps: mean(g.iter().map(|r| r.low01_fps)),
                ..Default::default()
            }
        })
        .collect();
    if let Some(b) = out.iter().find(|s| s.label.eq_ignore_ascii_case("baseline")).cloned() {
        for s in out.iter_mut().filter(|s| !s.label.eq_ignore_ascii_case("baseline")) {
            s.diff_avg = pct(s.avg_fps, b.avg_fps);
            s.diff_low1 = pct(s.low1_fps, b.low1_fps);
            s.diff_low01 = pct(s.low01_fps, b.low01_fps);
        }
    }
    out
}

// ------------------------------------------------------------------ commands

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchState {
    pub available: bool,
    pub dir: Option<String>,
    pub last_map: Option<String>,
    pub results: Vec<Summary>,
    pub compare: Vec<LabelStat>,
}

#[tauri::command]
pub async fn bench_state(app: tauri::AppHandle, game_id: String) -> BenchState {
    crate::bg::run(move || -> BenchState {
        let st = tauri::Manager::state::<AppState>(&app);
        let prefs = crate::optimize::load_prefs(&st.data_dir);
        let Some(h) = host_root(&st, &game_id) else { return BenchState { available: false, dir: None, last_map: prefs.last_map, results: vec![], compare: vec![] } };
        let dir = bench_dir(&h);
        let results = list_results(&dir, 60);
        BenchState { available: true, dir: Some(dir.to_string_lossy().into()), last_map: prefs.last_map, compare: compare(&results), results: results.into_iter().take(12).collect() }
    })
    .await
}

/// Map file dialog; the pick is remembered. None = cancelled.
#[tauri::command]
pub async fn bench_pick_map(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let a2 = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || a2.dialog().file().set_title("Map file").add_filter("TrackMania maps", &["Gbx", "gbx"]).blocking_pick_file()).await.map_err(|e| e.to_string())?;
    let Some(p) = picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()) else { return Ok(None) };
    let st = app.state::<AppState>();
    let mut prefs = crate::optimize::load_prefs(&st.data_dir);
    prefs.last_map = Some(p.clone());
    crate::optimize::save_prefs(&st.data_dir, &prefs)?;
    Ok(Some(p))
}

/// Writes the request and starts the game the normal way (same path as Play).
#[tauri::command]
pub async fn bench_start(app: AppHandle, game_id: String, mode: String, map: Option<String>, label: String, runs: u32, profile: Option<String>) -> ActionResult {
    crate::bg::run(move || -> ActionResult {
        let st = app.state::<AppState>();
        let Some(h) = host_root(&st, &game_id) else { return fail("Horizon Client is not installed for this game") };
        let req = match build_request(&mode, map.as_deref(), &label, runs) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let text = serde_json::to_string_pretty(&req).unwrap_or_default();
        if let Err(e) = crate::fsx::write(&perf_dir(&h).join(REQUEST_FILE), text.as_bytes()) {
            return fail(e);
        }
        crate::commands::launch_with(&app, &st, game_id, profile, None, None, None, None, false)
    })
    .await
}

#[tauri::command(async)]
pub fn bench_open_folder(app: AppHandle, game_id: String) -> ActionResult {
    use tauri_plugin_opener::OpenerExt;
    let st = app.state::<AppState>();
    let Some(h) = host_root(&st, &game_id) else { return fail("Horizon Client is not installed for this game") };
    let dir = bench_dir(&h);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return fail(e.to_string());
    }
    match app.opener().open_path(dir.to_string_lossy(), None::<&str>) {
        Ok(()) => ok("Opened", Some(dir.to_string_lossy().into())),
        Err(e) => fail(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_matches_the_module() {
        // the module keeps [A-Za-z0-9._-] only; spaces become '-' here so nothing turns into '_' later
        assert_eq!(clean_label(" state cache ").unwrap(), "state-cache");
        assert_eq!(clean_label("Grüße/1").unwrap(), "Gre1");
        assert_eq!(clean_label("..base").unwrap(), "base");
        assert!(clean_label("   ").is_err());
        assert_eq!(clean_label(&"a".repeat(80)).unwrap().len(), 40);
    }

    #[test]
    fn parses_defensively() {
        let full = r#"{"version":1,"game":"tmnf","label":"baseline","run":2,"started":"2026-11-11T10:00:00Z","seconds":30.0,"frames":3000,"avgFps":100.5,"avgMs":9.9,"medianMs":9.5,"p99Ms":15,"p999Ms":30,"low1Fps":66.6,"low01Fps":33.3,"stutters":4,"presentMsAvg":1.2,"cpuMsAvg":5,"drawsPerFrame":800,"options":{"shadows":3}}"#;
        let s = parse_summary(full, "20261111-100000_baseline.json").unwrap();
        assert_eq!((s.label.as_str(), s.run, s.frames, s.stutters), ("baseline", Some(2), Some(3000), Some(4)));
        assert_eq!((s.avg_fps, s.low01_fps, s.p999_ms), (Some(100.5), Some(33.3), Some(30.0)));
        assert!(s.options.is_some());
        // Missing / null / wrong-typed fields never fail the file.
        let s = parse_summary(r#"{"avgFps":null,"run":"x","frames":"many"}"#, "20261111-100001_state-cache.json").unwrap();
        assert_eq!(s.label, "state-cache");
        assert_eq!((s.avg_fps, s.run, s.frames), (None, None, None));
        assert!(parse_summary("not json", "a.json").is_none());
        assert!(parse_summary("[1]", "a.json").is_none());
    }

    fn r(label: &str, avg: f64, low1: f64) -> Summary {
        Summary { label: label.into(), avg_fps: Some(avg), low1_fps: Some(low1), ..Default::default() }
    }

    #[test]
    fn comparison_to_baseline() {
        let list = vec![r("cache", 120.0, 90.0), r("cache", 130.0, 110.0), r("baseline", 100.0, 80.0), r("baseline", 100.0, 80.0), r("other", 50.0, 40.0)];
        let c = compare(&list);
        assert_eq!(c.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["cache", "baseline", "other"]);
        assert_eq!(c[0].runs, 2);
        assert_eq!(c[0].avg_fps, Some(125.0));
        assert_eq!(c[0].diff_avg, Some(25.0));
        assert_eq!(c[0].diff_low1, Some(25.0));
        assert_eq!(c[0].diff_low01, None, "no 0.1 % values");
        assert_eq!(c[1].diff_avg, None, "the baseline has no difference");
        assert_eq!(c[2].diff_avg, Some(-50.0));
        // No baseline: no differences.
        assert!(compare(&[r("a", 10.0, 5.0)]).iter().all(|s| s.diff_avg.is_none()));
        assert!(compare(&[]).is_empty());
    }

    #[test]
    fn request_checks() {
        let t = tempfile::tempdir().unwrap();
        let map = t.path().join("A01.Challenge.Gbx");
        std::fs::write(&map, b"x").unwrap();
        let m = map.to_string_lossy().into_owned();
        let v = build_request("map", Some(&m), " base/line? ", 99).unwrap();
        assert_eq!(v["label"], "baseline");
        assert_eq!(v["runs"], 10);
        assert_eq!(v["map"], m.as_str());
        assert_eq!(v["returnToMenu"], true);
        assert!(build_request("map", None, "a", 3).is_err());
        assert!(build_request("map", Some("relative.Challenge.Gbx"), "a", 3).is_err());
        assert!(build_request("map", Some(&m.replace("Challenge", "Map")), "a", 3).is_err());
        assert!(build_request("map", Some(&m), "  ", 3).is_err());
        let rp = build_request("replay", None, "x", 1).unwrap();
        assert_eq!(rp["mode"], "replay");
        assert!(rp.get("map").is_none());
    }

    #[test]
    fn lists_newest_first() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("20261111-100000_a.json"), r#"{"avgFps":1}"#).unwrap();
        std::fs::write(t.path().join("20261111-110000_b.json"), r#"{"avgFps":2}"#).unwrap();
        std::fs::write(t.path().join("20261111-110000_b.csv"), "x").unwrap();
        std::fs::write(t.path().join("20261111-120000_bad.json"), "oops").unwrap();
        let l = list_results(t.path(), 10);
        assert_eq!(l.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["b", "a"]);
    }
}
