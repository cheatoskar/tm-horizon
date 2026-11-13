//! "Report a problem": collects the logs of the started profile's mods, the game's newest crash
//! logs and a short system summary into one zip on the Desktop or in Downloads. Everything is
//! redacted first (Windows user name in paths -> %USER%, the machine name -> %COMPUTER%,
//! e-mail-like strings -> <email>). Nothing is uploaded; the user sees the file list and a
//! preview before saving and sends the zip wherever the mod author wants it.

use crate::fsx;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Per file: only the last part of big logs goes into the zip.
pub const MAX_FILE: u64 = 8 << 20;
pub const PREVIEW: usize = 12 << 10;
const CRASH_LOGS: usize = 3;
const MOD_LOGS: usize = 12;

// ------------------------------------------------------------------ redaction

#[derive(Debug, Clone, Default)]
pub struct Redactor {
    pub user: Option<String>,
    pub machine: Option<String>,
}

fn word_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
}

/// Case-insensitive (ASCII) replace of every `needle`; `whole` requires word boundaries.
fn replace_ci(text: &str, needle: &str, with: &str, whole: bool) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let hay = text.to_ascii_lowercase();
    let n = needle.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut from = 0;
    while let Some(i) = hay[from..].find(&n).map(|i| i + from) {
        let end = i + n.len();
        let ok = !whole || ((i == 0 || !word_char(bytes[i - 1])) && (end >= bytes.len() || !word_char(bytes[end])));
        if ok && text.is_char_boundary(i) && text.is_char_boundary(end) {
            out.push_str(&text[last..i]);
            out.push_str(with);
            last = end;
        }
        from = end;
    }
    out.push_str(&text[last..]);
    out
}

fn email_local(c: u8) -> bool {
    c.is_ascii_alphanumeric() || b"._%+-".contains(&c)
}
fn email_domain(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'.' || c == b'-'
}

/// Replaces `local@domain.tld` with `<email>`.
pub fn redact_emails(text: &str) -> (String, usize) {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut count = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'@' {
            i += 1;
            continue;
        }
        let mut s = i;
        while s > last && email_local(b[s - 1]) {
            s -= 1;
        }
        let mut e = i + 1;
        while e < b.len() && email_domain(b[e]) {
            e += 1;
        }
        // Trailing dots or hyphens are not part of the domain.
        while e > i + 1 && (b[e - 1] == b'.' || b[e - 1] == b'-') {
            e -= 1;
        }
        let domain = &text[i + 1..e];
        let tld_ok = domain.rsplit_once('.').map(|(h, t)| !h.is_empty() && t.len() >= 2 && t.bytes().all(|c| c.is_ascii_alphabetic())).unwrap_or(false);
        if s < i && tld_ok {
            out.push_str(&text[last..s]);
            out.push_str("<email>");
            last = e;
            count += 1;
            i = e;
        } else {
            i += 1;
        }
    }
    out.push_str(&text[last..]);
    (out, count)
}

impl Redactor {
    pub fn from_env() -> Self {
        let user = std::env::var("USERNAME").ok().or_else(|| std::env::var("USER").ok()).filter(|u| u.len() >= 2);
        let machine = std::env::var("COMPUTERNAME").ok().or_else(|| std::env::var("HOSTNAME").ok()).filter(|m| m.len() >= 2);
        Redactor { user, machine }
    }

    pub fn redact(&self, text: &str) -> String {
        let mut t = text.to_string();
        if let Some(u) = &self.user {
            for (a, b) in [("\\users\\", "\\Users\\"), ("/users/", "/Users/"), ("/home/", "/home/"), ("\\\\users\\\\", "\\\\Users\\\\")] {
                t = replace_ci(&t, &format!("{a}{u}"), &format!("{b}%USER%"), false);
            }
            // The profile folder name can also stand alone after a drive letter path was cut.
            t = replace_ci(&t, &format!("users\\{u}"), "Users\\%USER%", false);
        }
        if let Some(m) = &self.machine {
            t = replace_ci(&t, m, "%COMPUTER%", true);
        }
        redact_emails(&t).0
    }
}

// ------------------------------------------------------------------ collecting

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportFile {
    /// Path inside the zip, e.g. "logs/TMVS/tmvs.log". Also the id used to leave a file out.
    pub id: String,
    /// Where it comes from (redacted).
    pub path: String,
    /// What it is: "TM Vibrant Shaders log", "Crash log", ...
    pub label: String,
    pub size: u64,
    /// Not text: copied as it is (not redacted), off by default.
    pub binary: bool,
    pub include: bool,
    /// Start of the redacted text (empty for binary files).
    pub preview: String,
    #[serde(skip)]
    pub source: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub game: String,
    pub summary: String,
    pub files: Vec<ReportFile>,
}

#[derive(Debug, Clone, Default)]
pub struct EnabledMod {
    pub id: String,
    pub version: Option<String>,
    pub pinned: bool,
    pub server: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ReportInput {
    pub game_id: String,
    pub game_name: String,
    pub documents: Option<PathBuf>,
    pub tmloader_root: Option<PathBuf>,
    pub tmloader_version: Option<String>,
    pub profile: Option<String>,
    pub mods: Vec<EnabledMod>,
    pub install: Option<String>,
    pub install_source: Option<String>,
    pub launcher_version: String,
    pub os: String,
    pub gpus: Vec<String>,
    /// ESWC/Sunrise/Original folders with Horizon Host (every install and instance of the game,
    /// so a test copy added by hand is in the report too).
    pub horizon_dirs: Vec<PathBuf>,
}

fn is_binary(head: &[u8]) -> bool {
    head.iter().take(8192).any(|&b| b == 0)
}

/// Files of `dir` whose name matches `pred`, newest first.
fn newest(dir: &Path, pred: impl Fn(&str) -> bool, max: usize) -> Vec<PathBuf> {
    let mut v: Vec<_> = fsx::list(dir).into_iter().filter(|e| e.is_file && pred(&e.name.to_lowercase())).map(|e| e.path).collect();
    v.sort_by_key(|p| std::cmp::Reverse(fsx::mtime(p)));
    v.truncate(max);
    v
}

fn has_mod(input: &ReportInput, id: &str) -> bool {
    input.mods.iter().any(|m| m.id.eq_ignore_ascii_case(id))
}

/// (source file, zip folder, label) for everything the report would include.
pub fn candidates(input: &ReportInput) -> Vec<(PathBuf, String, String)> {
    let mut out = Vec::new();
    let forever = matches!(input.game_id.as_str(), "tmnf" | "tmuf");
    let log = |n: &str| n.ends_with(".log") || n.ends_with(".txt");
    if let Some(docs) = &input.documents {
        let tm = docs.join("TrackMania");
        if forever || crate::launch::title_id(&input.game_id).is_some() {
            if has_mod(input, "TM Vibrant Shaders") || !forever {
                for p in newest(&tm.join("TMVS"), |n| n.ends_with(".log"), MOD_LOGS) {
                    out.push((p, "logs/TMVS".into(), "TM Vibrant Shaders log".into()));
                }
            }
        }
        if forever {
            let clips = tm.join("TMClips").join("tmclips.log");
            if fsx::is_file(&clips) {
                out.push((clips, "logs/TMClips".into(), "TM Clips log".into()));
            }
            if has_mod(input, "TMInterface") {
                let tmi = docs.join("TMInterface");
                for p in newest(&tmi, |n| n.ends_with(".log"), MOD_LOGS) {
                    out.push((p, "logs/TMInterface".into(), "TMInterface log".into()));
                }
                for p in newest(&tmi.join("Logs"), log, MOD_LOGS) {
                    out.push((p, "logs/TMInterface".into(), "TMInterface log".into()));
                }
            }
            for p in newest(&tm.join("LogCrash"), |_| true, CRASH_LOGS) {
                out.push((p, "crash".into(), "Crash log".into()));
            }
        }
    }
    if forever {
        if let Some(root) = &input.tmloader_root {
            for p in newest(root, |n| n.ends_with(".log"), 4) {
                out.push((p, "logs/TMLoader".into(), "TMLoader log".into()));
            }
            let products = crate::tmloader::products_dir(root);
            for m in &input.mods {
                let Some(v) = &m.version else { continue };
                let vdir = products.join(&m.id).join(v);
                if !fsx::is_inside(&vdir, &products) {
                    continue;
                }
                for p in newest(&vdir, |n| n.ends_with(".log"), MOD_LOGS) {
                    out.push((p, format!("logs/{}", sanitize(&m.id)), format!("{} log", m.id)));
                }
            }
        }
    }
    // Horizon Host: newest logs and the profile.json of the last start (game folder / TMLoader).
    for d in &input.horizon_dirs {
        out.extend(crate::horizonhost::report_logs(Some(d), None));
    }
    if forever {
        out.extend(crate::horizonhost::report_logs(None, input.tmloader_root.as_deref()));
    }
    out.retain(|(p, _, _)| !fsx::blocked(p));
    out
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect()
}

/// Last `max` bytes of a file (big logs: the end is what matters).
fn read_tail(p: &Path, max: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    fsx::check(p).ok()?;
    let mut f = std::fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    if len > max {
        f.seek(SeekFrom::Start(len - max)).ok()?;
    }
    let mut buf = Vec::new();
    f.take(max).read_to_end(&mut buf).ok()?;
    Some(buf)
}

pub fn summary(input: &ReportInput) -> String {
    let mut s = String::new();
    let mut line = |k: &str, v: &str| s.push_str(&format!("{k:<18}{v}\n"));
    line("Report", "TM Horizon problem report (nothing was uploaded)");
    line("Created", &fsx::now_iso());
    line("Launcher", &format!("TM Horizon {}", input.launcher_version));
    line("Windows", &input.os);
    for g in &input.gpus {
        line("GPU", g);
    }
    line("Game", &format!("{} ({})", input.game_name, input.game_id));
    if let Some(i) = &input.install {
        line("Install", &format!("{i}{}", input.install_source.as_ref().map(|s| format!(" [{s}]")).unwrap_or_default()));
    }
    if let Some(v) = &input.tmloader_version {
        line("TMLoader", v);
    }
    if let Some(p) = &input.profile {
        line("Profile", p);
    }
    if input.mods.is_empty() {
        line("Mods", "none");
    }
    for m in &input.mods {
        let v = m.version.clone().unwrap_or_else(|| "not installed".into());
        let pin = if m.pinned { " (pinned)" } else { "" };
        let srv = m.server.as_ref().map(|x| format!("  from {x}")).unwrap_or_default();
        line("Mod", &format!("{} {v}{pin}{srv}", m.id));
    }
    s
}

pub fn collect(input: &ReportInput, r: &Redactor) -> Report {
    let mut files: Vec<ReportFile> = Vec::new();
    for (src, folder, label) in candidates(input) {
        let name = src.file_name().map(|n| sanitize(&n.to_string_lossy())).unwrap_or_default();
        let mut id = format!("{folder}/{name}");
        let mut n = 2;
        while files.iter().any(|f| f.id == id) {
            id = format!("{folder}/{n}-{name}");
            n += 1;
        }
        let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
        let head = fsx::read_bytes_prefix(&src, 8192).unwrap_or_default();
        let binary = is_binary(&head);
        let preview = if binary {
            String::new()
        } else {
            let t = read_tail(&src, MAX_FILE).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            let red = r.redact(&t);
            let mut p: String = red.chars().take(PREVIEW).collect();
            if p.len() < red.len() {
                p.push_str("\n…");
            }
            p
        };
        files.push(ReportFile { id, path: r.redact(&src.to_string_lossy()), label, size, binary, include: !binary, preview, source: src });
    }
    Report { game: input.game_id.clone(), summary: r.redact(&summary(input)), files }
}

/// Writes the zip: summary.txt plus the selected files (text redacted, binary as is).
pub fn save(report: &Report, selected: &[String], r: &Redactor, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = fsx::stamp();
    let mut path = dir.join(format!("TMHub-report-{}-{stamp}.zip", sanitize(&report.game)));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("TMHub-report-{}-{stamp}-{n}.zip", sanitize(&report.game)));
        n += 1;
    }
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut list = String::from("Files in this report (paths redacted):\n");
    for f in report.files.iter().filter(|f| selected.contains(&f.id)) {
        let Some(bytes) = read_tail(&f.source, MAX_FILE) else { continue };
        let data = if f.binary { bytes } else { r.redact(&String::from_utf8_lossy(&bytes)).into_bytes() };
        zip.start_file(f.id.as_str(), opts).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
        list.push_str(&format!("  {}  <- {}{}\n", f.id, f.path, if f.binary { " (binary, not redacted)" } else { "" }));
    }
    zip.start_file("summary.txt", opts).map_err(|e| e.to_string())?;
    zip.write_all(format!("{}\n{list}", report.summary).as_bytes()).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn red() -> Redactor {
        Redactor { user: Some("Oskar".into()), machine: Some("DESKTOP-AB12".into()) }
    }

    #[test]
    fn redacts_user_machine_and_mail() {
        let t = r"Loaded C:\Users\oskar\Documents\TrackMania\TMVS\tmvs.ini on desktop-ab12 (mail me: a.b+tm@example.co.uk). Host DESKTOP-AB12X stays.";
        let o = red().redact(t);
        assert!(o.contains(r"C:\Users\%USER%\Documents"), "{o}");
        assert!(o.contains("on %COMPUTER% ("), "{o}");
        assert!(o.contains("mail me: <email>)"), "{o}");
        assert!(o.contains("DESKTOP-AB12X"), "{o}");
        assert!(!o.to_lowercase().contains("oskar"));
        let fwd = red().redact("/c/Users/Oskar/x and C:/Users/OSKAR/y");
        assert_eq!(fwd, "/c/Users/%USER%/x and C:/Users/%USER%/y");
    }

    #[test]
    fn emails_only_with_domain() {
        assert_eq!(redact_emails("player@home and x@y.z1 and @tag").1, 0);
        let (o, n) = redact_emails("contact: dev@tm-hub.app.");
        assert_eq!(n, 1);
        assert_eq!(o, "contact: <email>.");
    }

    #[test]
    fn collects_forever_logs_and_zips() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("Documents");
        let tm = docs.join("TrackMania");
        std::fs::create_dir_all(tm.join("TMVS")).unwrap();
        std::fs::create_dir_all(tm.join("LogCrash")).unwrap();
        std::fs::create_dir_all(docs.join("TMInterface")).unwrap();
        std::fs::write(tm.join("TMVS").join("tmvs.log"), r"start C:\Users\Oskar\Documents ok").unwrap();
        std::fs::write(tm.join("TMVS").join("notes.txt"), "not a log").unwrap();
        for i in 0..5 {
            std::fs::write(tm.join("LogCrash").join(format!("LogCrash_{i}.txt")), format!("crash {i} on DESKTOP-AB12")).unwrap();
        }
        std::fs::write(tm.join("LogCrash").join("dump.bin"), [0u8, 1, 2, 0, 5]).unwrap();
        std::fs::write(docs.join("TMInterface").join("tmi.log"), "tmi").unwrap();
        let root = t.path().join("TMLoader");
        crate::tmloader::tests::fake_root(&root);
        let vdir = crate::tmloader::products_dir(&root).join("ChampionMod").join("1.0.0");
        std::fs::create_dir_all(&vdir).unwrap();
        std::fs::write(vdir.join("ChampionMod.log"), "champion").unwrap();
        let input = ReportInput {
            game_id: "tmnf".into(),
            game_name: "TrackMania Nations Forever".into(),
            documents: Some(docs),
            tmloader_root: Some(root),
            profile: Some("default".into()),
            mods: vec![
                EnabledMod { id: "TM Vibrant Shaders".into(), version: Some("1.4.2".into()), ..Default::default() },
                EnabledMod { id: "ChampionMod".into(), version: Some("1.0.0".into()), pinned: true, server: Some("https://x/".into()) },
            ],
            launcher_version: "0.2.0".into(),
            os: "Windows 11".into(),
            ..Default::default()
        };
        let rep = collect(&input, &red());
        let ids: Vec<&str> = rep.files.iter().map(|f| f.id.as_str()).collect();
        assert!(ids.contains(&"logs/TMVS/tmvs.log"));
        assert!(!ids.iter().any(|i| i.contains("notes.txt")));
        assert!(ids.contains(&"logs/ChampionMod/ChampionMod.log"));
        assert!(!ids.iter().any(|i| i.contains("TMInterface")), "TMInterface not in the profile");
        assert_eq!(rep.files.iter().filter(|f| f.label == "Crash log").count(), 3);
        let tmvs = rep.files.iter().find(|f| f.id == "logs/TMVS/tmvs.log").unwrap();
        assert!(tmvs.preview.contains("%USER%") && !tmvs.preview.contains("Oskar"));
        assert!(rep.summary.contains("ChampionMod 1.0.0 (pinned)  from https://x/"));

        let out = t.path().join("out");
        let first_crash = rep.files.iter().find(|f| f.label == "Crash log").unwrap().id.clone();
        let selected: Vec<String> = rep.files.iter().filter(|f| f.include && f.id != first_crash).map(|f| f.id.clone()).collect();
        let zp = save(&rep, &selected, &red(), &out).unwrap();
        let mut z = zip::ZipArchive::new(std::fs::File::open(&zp).unwrap()).unwrap();
        let names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.contains(&"summary.txt".to_string()));
        assert!(!names.contains(&first_crash));
        let mut s = String::new();
        std::io::Read::read_to_string(&mut z.by_name("logs/TMVS/tmvs.log").unwrap(), &mut s).unwrap();
        assert_eq!(s, r"start C:\Users\%USER%\Documents ok");
    }
}
