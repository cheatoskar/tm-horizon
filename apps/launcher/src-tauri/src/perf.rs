//! A small timing log (`timings.log` in the app data folder) for start-up, scans, switches,
//! launches and mod installs, so slow spots can be measured on a real PC.
//!
//! Several threads log at the same time (scans, stats, commands on the blocking pool). Each line
//! is built first and written with one `write_all` under a lock, so lines never interleave
//! (`writeln!` on a `File` writes every piece of the format on its own).
use crate::state::AppState;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

/// Start over above this size.
const MAX_LOG: u64 = 256 * 1024;

pub fn log(st: &AppState, what: &str, ms: u128) {
    eprintln!("[perf] {what}: {ms} ms");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    append(&st.data_dir.join("timings.log"), &line(now, what, ms));
}

/// One log line: `<unix seconds>\t<what>\t<ms>\n`; tabs and line breaks in `what` become spaces.
fn line(now: u64, what: &str, ms: u128) -> String {
    let what: String = what.chars().map(|c| if c == '\t' || c == '\n' || c == '\r' { ' ' } else { c }).collect();
    format!("{now}\t{what}\t{ms}\n")
}

/// Appends a whole line in one write call; the size check and the write happen under one lock.
fn append(p: &Path, line: &str) {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if std::fs::metadata(p).map(|m| m.len() > MAX_LOG).unwrap_or(false) {
        let _ = std::fs::remove_file(p);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_is_three_fields() {
        assert_eq!(line(17, "stats: replays", 42), "17\tstats: replays\t42\n");
        assert_eq!(line(1, "a\tb\nc", 2), "1\ta b c\t2\n", "tabs and breaks in the label cannot split a line");
    }

    #[test]
    fn concurrent_writers_never_interleave() {
        let dir = std::env::temp_dir().join(format!("tmhub-perf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("timings.log");
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let p = p.clone();
                std::thread::spawn(move || {
                    for i in 0..200u128 {
                        append(&p, &line(1794427494, &format!("stats: thread {t} step {i}"), i));
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let text = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1600);
        for l in lines {
            let f: Vec<&str> = l.split('\t').collect();
            assert_eq!(f.len(), 3, "broken line: {l:?}");
            assert_eq!(f[0], "1794427494");
            assert!(f[1].starts_with("stats: thread "));
            f[2].parse::<u128>().unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
