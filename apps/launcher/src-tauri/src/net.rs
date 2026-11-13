//! HTTP GETs (TMLoader indexes, mod zips, hub data, game setups). Plain GETs, a neutral
//! user agent, no personal data.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

/// The launcher's HTTP user agent: name, version, project page.
/// The Launcher Preview names its GitHub page instead of the website (which is not part of that release).
pub const UA: &str = if crate::RELEASE_PREVIEW {
    concat!("TM-Horizon/", env!("CARGO_PKG_VERSION"), " (+https://github.com/cheatoskar/tm-horizon)")
} else {
    concat!("TM-Horizon/", env!("CARGO_PKG_VERSION"), " (+https://tm-horizon.com)")
};

fn agent(timeout_s: u64) -> Result<ureq::Agent, String> {
    agent_ua(timeout_s, UA)
}

fn agent_ua(timeout_s: u64, ua: &str) -> Result<ureq::Agent, String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    Ok(ureq::AgentBuilder::new()
        .user_agent(ua)
        .redirects(5)
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(timeout_s))
        .tls_connector(std::sync::Arc::new(tls))
        .build())
}

/// Only https (plain http only for localhost, e.g. a hub URL while testing).
pub fn secure_url(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    l.starts_with("https://") || l.starts_with("http://localhost") || l.starts_with("http://127.0.0.1")
}

/// After redirects: an https request must still be https.
fn check_final(url: &str, r: &ureq::Response) -> Result<(), String> {
    if url.to_ascii_lowercase().starts_with("https://") && !r.get_url().to_ascii_lowercase().starts_with("https://") {
        return Err(format!("{url}: redirected to a plain http address"));
    }
    Ok(())
}

pub fn get_bytes(url: &str, max: u64) -> Result<Vec<u8>, String> {
    get_bytes_ua(url, max, UA)
}

/// Like `get_bytes`, plus the address the redirects ended at (callers check the final host).
pub fn get_bytes_final(url: &str, max: u64) -> Result<(Vec<u8>, String), String> {
    if !secure_url(url) {
        return Err(format!("{url}: only https is allowed"));
    }
    let r = agent(120)?.get(url).call().map_err(|e| format!("{url}: {e}"))?;
    check_final(url, &r)?;
    let fin = r.get_url().to_string();
    let mut buf = Vec::new();
    r.into_reader().take(max + 1).read_to_end(&mut buf).map_err(|e| format!("{url}: {e}"))?;
    if buf.len() as u64 > max {
        return Err(format!("{url}: larger than {max} bytes"));
    }
    Ok((buf, fin))
}

/// Like `get_bytes_final`, with a Referer header (openplanet.dev hands out files only from its own page).
pub fn get_bytes_final_ref(url: &str, max: u64, referer: Option<&str>) -> Result<(Vec<u8>, String), String> {
    if !secure_url(url) {
        return Err(format!("{url}: only https is allowed"));
    }
    let mut req = agent(120)?.get(url);
    if let Some(r) = referer {
        req = req.set("Referer", r);
    }
    let r = req.call().map_err(|e| format!("{url}: {e}"))?;
    check_final(url, &r)?;
    let fin = r.get_url().to_string();
    let mut buf = Vec::new();
    r.into_reader().take(max + 1).read_to_end(&mut buf).map_err(|e| format!("{url}: {e}"))?;
    if buf.len() as u64 > max {
        return Err(format!("{url}: larger than {max} bytes"));
    }
    Ok((buf, fin))
}

/// Like `get_bytes` with another user agent (some sites turn away unknown clients).
pub fn get_bytes_ua(url: &str, max: u64, ua: &str) -> Result<Vec<u8>, String> {
    if !secure_url(url) {
        return Err(format!("{url}: only https is allowed"));
    }
    let r = agent_ua(60, ua)?.get(url).call().map_err(|e| format!("{url}: {e}"))?;
    check_final(url, &r)?;
    let mut buf = Vec::new();
    r.into_reader().take(max + 1).read_to_end(&mut buf).map_err(|e| format!("{url}: {e}"))?;
    if buf.len() as u64 > max {
        return Err(format!("{url}: larger than {max} bytes"));
    }
    Ok(buf)
}

/// GET with If-None-Match. Returns (status, body unless 304, new ETag, X-RateLimit-Remaining).
pub fn get_json_etag(url: &str, etag: Option<&str>) -> Result<(u16, Option<serde_json::Value>, Option<String>, Option<i64>), String> {
    if !secure_url(url) {
        return Err(format!("{url}: only https is allowed"));
    }
    let mut req = agent(30)?.get(url);
    if let Some(e) = etag {
        req = req.set("If-None-Match", e);
    }
    let r = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let left = r.header("x-ratelimit-remaining").and_then(|v| v.parse().ok());
            if code == 403 && left == Some(0) {
                return Err("GitHub limit reached; try later".into());
            }
            return Err(format!("{url}: HTTP {code}"));
        }
        Err(e) => return Err(format!("{url}: {e}")),
    };
    let status = r.status();
    let new_etag = r.header("etag").map(String::from);
    let left = r.header("x-ratelimit-remaining").and_then(|v| v.parse().ok());
    if status == 304 {
        return Ok((304, None, new_etag.or(etag.map(String::from)), left));
    }
    let mut buf = Vec::new();
    r.into_reader().take(8 << 20).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let v = serde_json::from_slice(&buf).map_err(|e| format!("{url}: {e}"))?;
    Ok((status, Some(v), new_etag, left))
}

pub fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let b = get_bytes(url, 32 << 20)?;
    serde_json::from_slice(&b).map_err(|e| format!("{url}: {e}"))
}

/// Reachability probe: the HTTP status of a GET (body is not read), or the transport error text.
/// 4xx/5xx answers come back as `Ok(status)`; only failures to talk to the server are `Err`.
pub fn probe(url: &str, timeout_s: u64) -> Result<u16, String> {
    if !url.to_ascii_lowercase().starts_with("https://") {
        return Err("only https is allowed".into());
    }
    let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    let a = ureq::AgentBuilder::new()
        .user_agent(UA)
        .timeout(Duration::from_secs(timeout_s))
        .tls_connector(std::sync::Arc::new(tls))
        .build();
    match a.get(url).call() {
        Ok(r) => Ok(r.status()),
        Err(ureq::Error::Status(code, _)) => Ok(code),
        Err(e) => Err(e.to_string()),
    }
}

/// HEAD request: (status, content length).
pub fn head(url: &str) -> Result<(u16, Option<u64>), String> {
    let r = agent(20)?.head(url).call().map_err(|e| format!("{url}: {e}"))?;
    check_final(url, &r)?;
    Ok((r.status(), r.header("content-length").and_then(|v| v.parse().ok())))
}

/// Largest game setup the hub downloads (TMUF's is 1.2 GB).
pub const MAX_DOWNLOAD: u64 = 3 << 30;

/// Streams a download to `dest` (via `dest.part`), reporting (received, total). At most
/// `max` bytes; the .part file is removed when anything fails. One download per destination
/// at a time. Plain http is only used for URLs whose file is checked against a known SHA-256
/// afterwards (game setups, see gameinstall.rs).
pub fn download_to(url: &str, dest: &Path, max: u64, mut progress: impl FnMut(u64, Option<u64>)) -> Result<u64, String> {
    static BUSY: std::sync::Mutex<Vec<std::path::PathBuf>> = std::sync::Mutex::new(Vec::new());
    {
        let mut b = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        if b.iter().any(|p| p == dest) {
            return Err("This file is already being downloaded".into());
        }
        b.push(dest.to_path_buf());
    }
    let part = dest.with_extension("part");
    let r = (|| -> Result<u64, String> {
        let r = agent(120)?.get(url).call().map_err(|e| format!("{url}: {e}"))?;
        check_final(url, &r)?;
        let total: Option<u64> = r.header("content-length").and_then(|v| v.parse().ok());
        if total.is_some_and(|t| t > max) {
            return Err(format!("{url}: larger than {max} bytes"));
        }
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut rd = r.into_reader().take(max + 1);
        let mut buf = vec![0u8; 1 << 16];
        let mut got = 0u64;
        let mut last = 0u64;
        loop {
            let n = rd.read(&mut buf).map_err(|e| format!("{url}: {e}"))?;
            if n == 0 {
                break;
            }
            got += n as u64;
            if got > max {
                return Err(format!("{url}: larger than {max} bytes"));
            }
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            if got - last > (1 << 20) {
                progress(got, total);
                last = got;
            }
        }
        f.sync_all().map_err(|e| e.to_string())?;
        drop(f);
        progress(got, total);
        std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
        Ok(got)
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    BUSY.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| p != dest);
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_names_the_app_and_its_version() {
        assert!(UA.starts_with("TM-Horizon/"));
        assert!(UA.contains(env!("CARGO_PKG_VERSION")));
        assert!(UA.ends_with(if crate::RELEASE_PREVIEW { "(+https://github.com/cheatoskar/tm-horizon)" } else { "(+https://tm-horizon.com)" }));
        assert!(!UA.contains("TM-Hub"));
    }

    #[test]
    fn only_https_except_localhost() {
        assert!(secure_url("https://donadigo.com/modloader/index.json"));
        assert!(secure_url("http://localhost:8080/hub/"));
        assert!(!secure_url("http://unlimiter.net/modloader/index.json"));
        assert!(!secure_url("ftp://x"));
        assert!(get_bytes("http://example.com/x", 10).unwrap_err().contains("only https"));
    }
}
