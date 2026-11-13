//! Downloads the servers and tools need, on demand, into the launcher's data folder: pinned SHA-256
//! (or GitHub's digest for release assets), checked before anything is unpacked, nothing installed
//! system-wide. Also the pinned runtimes for controllers that need one (PHP, MariaDB, Python) and
//! the MariaDB config builder (127.0.0.1 only, generated password), for the controller engines
//! that are not built yet (docs/design/server-hosting.md).

use super::kinds::Package;
use std::path::{Path, PathBuf};

/// `<data>/servers/_cache/<file>`: verified downloads, reused for every server.
pub fn cache_dir(data: &Path) -> PathBuf {
    data.join("servers").join("_cache")
}

fn file_name_of(url: &str) -> String {
    url.rsplit('/').next().unwrap_or("download.zip").split(['?', '#']).next().unwrap_or("download.zip").to_string()
}

/// Downloads `p` once (or reuses the cached file when its hash still matches). Returns the path.
pub fn ensure_package(data: &Path, p: &Package, fetch: &dyn Fn(&str, &Path) -> Result<(), String>) -> Result<PathBuf, String> {
    if p.sha256.len() != 64 {
        return Err(format!("{}: no pinned SHA-256, not downloaded", p.id));
    }
    let dir = cache_dir(data);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{}-{}", &p.sha256[..12], file_name_of(p.url)));
    if dest.is_file() && super::kinds::hash_ok(p, &crate::gameinstall::sha256_file(&dest)?) {
        return Ok(dest);
    }
    fetch(p.url, &dest)?;
    let got = crate::gameinstall::sha256_file(&dest)?;
    if !super::kinds::hash_ok(p, &got) {
        let _ = std::fs::remove_file(&dest);
        return Err(format!("{}: SHA-256 {got} does not match the pinned {}; deleted. The file changed on its host.", p.id, p.sha256));
    }
    Ok(dest)
}

/// The real download (plain http is fine: the hash is checked afterwards).
pub fn http_fetch(url: &str, dest: &Path) -> Result<(), String> {
    crate::net::download_to(url, dest, 1 << 30, |_, _| {}).map(|_| ())
}

/// Unpacks `zip` into `dest`, taking only entries under `root/` (root stripped). Refuses unsafe
/// paths. Files already there are overwritten.
pub fn extract_zip(zip: &Path, root: &str, dest: &Path) -> Result<usize, String> {
    let f = std::fs::File::open(zip).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    let prefix = if root.is_empty() { String::new() } else { format!("{}/", root.trim_end_matches('/')) };
    let mut n = 0;
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = e.enclosed_name() else { return Err(format!("Unsafe path in zip: {}", e.name())) };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let Some(rel) = rel.strip_prefix(&prefix) else { continue };
        if rel.is_empty() {
            continue;
        }
        let out = dest.join(rel);
        if e.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?;
        std::io::copy(&mut e, &mut w).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = e.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o755));
        }
        n += 1;
    }
    Ok(n)
}

/// Unpacks a package into `dest` unless the marker says this exact file is already there.
pub fn install_package(zip: &Path, p: &Package, dest: &Path) -> Result<bool, String> {
    let marker = dest.join(".horizon-package");
    if std::fs::read_to_string(&marker).ok().as_deref() == Some(p.sha256) {
        return Ok(false);
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    extract_zip(zip, p.root, dest)?;
    std::fs::write(&marker, p.sha256).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Hard link when possible (same drive), copy otherwise. For the 100 MB controller exe per server.
pub fn link_or_copy(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        let _ = std::fs::remove_file(to);
    }
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if std::fs::hard_link(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map(|_| ()).map_err(|e| e.to_string())
}

pub fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let t = to.join(e.file_name());
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            copy_tree(&e.path(), &t)?;
        } else {
            std::fs::copy(e.path(), &t).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ the owner's randomizer

pub const RANDOMIZER_REPO: &str = "cheatoskar/100-TMX-Server";

/// Release asset the launcher takes: a zip of the self-contained single-file publish
/// (`RandomizerAnywhere.exe` + `config.default.toml` + `Presets/` + `WebStatus/`).
pub fn randomizer_asset_ok(name: &str, _tag: &str) -> bool {
    let want = if cfg!(windows) { "randomizeranywhere-win-x64.zip" } else { "randomizeranywhere-linux-x64.zip" };
    name.eq_ignore_ascii_case(want)
}

pub fn randomizer_exe() -> &'static str {
    if cfg!(windows) {
        "RandomizerAnywhere.exe"
    } else {
        "RandomizerAnywhere"
    }
}

/// Folder with a ready publish of the randomizer: `TMHUB_RANDOMIZER_DIR` (a local `dotnet publish`
/// output, for testing before a release exists), or the newest GitHub release, downloaded with
/// GitHub's SHA-256 digest into `<data>/servers/_tools/randomizer/<tag>/`.
pub fn ensure_randomizer(data: &Path) -> Result<(PathBuf, String), String> {
    if let Ok(d) = std::env::var("TMHUB_RANDOMIZER_DIR") {
        let d = PathBuf::from(d);
        if d.join(randomizer_exe()).is_file() {
            return Ok((d, "local build".into()));
        }
        return Err(format!("TMHUB_RANDOMIZER_DIR has no {}", randomizer_exe()));
    }
    let rel = crate::net::get_json(&format!("https://api.github.com/repos/{RANDOMIZER_REPO}/releases/latest"))
        .map_err(|_| "randomizer.noRelease".to_string())?;
    let a = crate::linuxsetup::pick_asset(RANDOMIZER_REPO, &rel, randomizer_asset_ok).map_err(|_| "randomizer.noRelease".to_string())?;
    let safe_tag: String = a.tag.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    let dir = data.join("servers").join("_tools").join("randomizer").join(&safe_tag);
    if dir.join(randomizer_exe()).is_file() && std::fs::read_to_string(dir.join(".horizon-package")).ok().as_deref() == Some(a.sha256.as_str()) {
        return Ok((dir, a.tag));
    }
    let zip = cache_dir(data).join(format!("{}-{}", &a.sha256[..12], a.name));
    if !zip.is_file() || crate::gameinstall::sha256_file(&zip)? != a.sha256 {
        http_fetch(&a.url, &zip)?;
        let got = crate::gameinstall::sha256_file(&zip)?;
        if got != a.sha256 {
            let _ = std::fs::remove_file(&zip);
            return Err(format!("{}: SHA-256 {got} does not match GitHub's {}; deleted", a.name, a.sha256));
        }
    }
    extract_zip(&zip, "", &dir)?;
    std::fs::write(dir.join(".horizon-package"), &a.sha256).map_err(|e| e.to_string())?;
    Ok((dir, a.tag))
}

// ------------------------------------------------------------------ runtimes (controllers later)

/// Pinned runtimes for controllers that need one. Hashes checked 2026-11-11 against the
/// publishers' own checksum files (php: sha256sum.txt, MariaDB: sha256sums.txt) and by download.
pub const PHP_84: Package = Package {
    id: "php-8.4.27-nts-x64",
    url: "https://downloads.php.net/~windows/releases/php-8.4.27-1-nts-Win32-vs17-x64.zip",
    sha256: "dbae154a0a89791f36c3d48e68bae797878333e7d6cb5721e74617de59b63ab7",
    size: 35_296_081,
    root: "",
    note: "windows.php.net, matches its sha256sum.txt",
};
pub const MARIADB_118: Package = Package {
    id: "mariadb-11.8.9-winx64",
    url: "https://archive.mariadb.org/mariadb-11.8.9/winx64-packages/mariadb-11.8.9-winx64.zip",
    sha256: "830c46727d9278eae212ae3eca44eeb9e71b2a68704e95f344a64fba7b1963f5",
    size: 97_016_251,
    root: "mariadb-11.8.9-winx64",
    note: "archive.mariadb.org, matches its sha256sums.txt (LTS until 2030)",
};
pub const PYTHON_312_EMBED: Package = Package {
    id: "python-3.12.10-embed-amd64",
    url: "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip",
    sha256: "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
    size: 11_133_606,
    root: "",
    note: "python.org, hashed by download",
};

/// my.ini for a private MariaDB: localhost only, own data folder, no networking beyond 127.0.0.1.
pub fn mariadb_ini(base: &Path, datadir: &Path, port: u16) -> String {
    let p = |x: &Path| x.to_string_lossy().replace('\\', "/");
    format!(
        "[mysqld]\nbasedir={}\ndatadir={}\nbind-address=127.0.0.1\nport={port}\nskip-name-resolve\nlocal-infile=0\ncharacter-set-server=utf8mb4\ncollation-server=utf8mb4_unicode_ci\nmax_connections=20\n[client]\nport={port}\nhost=127.0.0.1\n",
        p(base),
        p(datadir)
    )
}

/// `mariadb-install-db` arguments for the first start (root password generated by us).
pub fn mariadb_install_args(datadir: &Path, port: u16, root_pw: &str) -> Vec<String> {
    vec![format!("--datadir={}", datadir.to_string_lossy()), format!("--port={port}"), format!("--password={root_pw}")]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(p: &Path, entries: &[(&str, &[u8])]) {
        let f = std::fs::File::create(p).unwrap();
        let mut z = zip::ZipWriter::new(f);
        for (n, d) in entries {
            z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(d).unwrap();
        }
        z.finish().unwrap();
    }

    fn sha(b: &[u8]) -> String {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(b))
    }

    #[test]
    fn package_hash_gate() {
        let t = tempfile::tempdir().unwrap();
        let body = b"zipbytes".to_vec();
        let hash: &'static str = Box::leak(sha(&body).into_boxed_str());
        let p = Package { id: "t", url: "http://x/a.zip", sha256: hash, size: 8, root: "", note: "" };
        let calls = std::cell::Cell::new(0);
        let good = |_: &str, d: &Path| {
            calls.set(calls.get() + 1);
            std::fs::write(d, &body).map_err(|e| e.to_string())
        };
        let a = ensure_package(t.path(), &p, &good).unwrap();
        assert!(a.is_file());
        // cached: no second download
        ensure_package(t.path(), &p, &good).unwrap();
        assert_eq!(calls.get(), 1);
        // a changed file on the host is refused and deleted
        std::fs::remove_file(&a).unwrap();
        let evil = |_: &str, d: &Path| std::fs::write(d, b"evil").map_err(|e| e.to_string());
        let e = ensure_package(t.path(), &p, &evil).unwrap_err();
        assert!(e.contains("does not match"));
        assert!(!a.exists());
        // no pin, no download
        let unpinned = Package { sha256: "", ..p };
        assert!(ensure_package(t.path(), &unpinned, &good).unwrap_err().contains("no pinned"));
    }

    #[test]
    fn extract_with_root_and_marker() {
        let t = tempfile::tempdir().unwrap();
        let z = t.path().join("s.zip");
        make_zip(&z, &[("TmDedicatedServer/dedicated.cfg", b"<dedicated/>"), ("TmDedicatedServer/GameData/x.txt", b"x"), ("other/skip.txt", b"s")]);
        let dest = t.path().join("out");
        let p = Package { id: "t", url: "", sha256: "ab", size: 0, root: "TmDedicatedServer", note: "" };
        assert!(install_package(&z, &p, &dest).unwrap());
        assert!(dest.join("dedicated.cfg").is_file() && dest.join("GameData/x.txt").is_file());
        assert!(!dest.join("skip.txt").exists() && !dest.join("other").exists());
        assert!(!install_package(&z, &p, &dest).unwrap(), "same package: not unpacked again");
    }

    #[test]
    fn extract_refuses_traversal() {
        let t = tempfile::tempdir().unwrap();
        let z = t.path().join("bad.zip");
        make_zip(&z, &[("../evil.txt", b"x")]);
        assert!(extract_zip(&z, "", &t.path().join("o")).is_err());
        assert!(!t.path().join("evil.txt").exists());
    }

    #[test]
    fn randomizer_asset_name() {
        assert!(randomizer_asset_ok(if cfg!(windows) { "RandomizerAnywhere-win-x64.zip" } else { "RandomizerAnywhere-linux-x64.zip" }, "v1"));
        assert!(!randomizer_asset_ok("RandomizerAnywhere.exe", "v1"));
        assert!(!randomizer_asset_ok("Source code (zip)", "v1"));
    }

    #[test]
    fn mariadb_local_only() {
        let ini = mariadb_ini(Path::new(r"C:\d\mariadb"), Path::new(r"C:\d\db"), 3307);
        assert!(ini.contains("bind-address=127.0.0.1\n"));
        assert!(ini.contains("port=3307") && ini.contains("datadir=C:/d/db") && ini.contains("local-infile=0"));
        let a = mariadb_install_args(Path::new("/d/db"), 3307, "pw");
        assert!(a.contains(&"--password=pw".to_string()));
        for p in [PHP_84, MARIADB_118, PYTHON_312_EMBED] {
            assert_eq!(p.sha256.len(), 64);
            assert!(p.url.starts_with("https://"));
        }
    }
}
