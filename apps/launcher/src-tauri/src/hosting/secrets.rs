//! Secrets of the player's servers: XML-RPC level passwords, the server account password, the hub
//! announce token. Windows: the user's Credential Manager (generic credentials, "TM Horizon/...").
//! Elsewhere (and in tests): a JSON file readable by the user only. Values never go to logs.

use std::collections::BTreeMap;
use std::path::PathBuf;

pub fn random_bytes(buf: &mut [u8]) {
    getrandom::fill(buf).expect("no OS random source");
}

#[derive(Debug, Clone)]
pub enum Store {
    /// Windows Credential Manager.
    #[cfg(windows)]
    CredMan,
    /// A file with user-only rights (Linux, tests).
    File(PathBuf),
}

/// Keys used per server.
pub const SUPERADMIN: &str = "superadmin";
pub const ADMIN: &str = "admin";
pub const USER: &str = "user";
pub const ACCOUNT: &str = "account";
pub const HUB_TOKEN: &str = "hub-token";

fn target(server: &str, key: &str) -> String {
    format!("TM Horizon/server/{server}/{key}")
}

impl Store {
    pub fn default_for(data_dir: &std::path::Path) -> Store {
        #[cfg(windows)]
        {
            let _ = data_dir;
            Store::CredMan
        }
        #[cfg(not(windows))]
        {
            Store::File(data_dir.join("servers").join("secrets.json"))
        }
    }

    pub fn get(&self, server: &str, key: &str) -> Option<String> {
        match self {
            #[cfg(windows)]
            Store::CredMan => credman::read(&target(server, key)),
            Store::File(p) => read_file(p).remove(&target(server, key)),
        }
    }

    pub fn set(&self, server: &str, key: &str, value: &str) -> Result<(), String> {
        match self {
            #[cfg(windows)]
            Store::CredMan => credman::write(&target(server, key), value),
            Store::File(p) => {
                let mut m = read_file(p);
                m.insert(target(server, key), value.to_string());
                write_file(p, &m)
            }
        }
    }

    pub fn delete(&self, server: &str, key: &str) {
        match self {
            #[cfg(windows)]
            Store::CredMan => credman::delete(&target(server, key)),
            Store::File(p) => {
                let mut m = read_file(p);
                if m.remove(&target(server, key)).is_some() {
                    let _ = write_file(p, &m);
                }
            }
        }
    }

    pub fn delete_server(&self, server: &str) {
        for k in [SUPERADMIN, ADMIN, USER, ACCOUNT, HUB_TOKEN] {
            self.delete(server, k);
        }
    }

    /// The level password, created on first use.
    pub fn get_or_create(&self, server: &str, key: &str) -> Result<String, String> {
        if let Some(v) = self.get(server, key).filter(|v| !v.is_empty()) {
            return Ok(v);
        }
        let v = super::config::random_password();
        self.set(server, key, &v)?;
        Ok(v)
    }
}

fn read_file(p: &PathBuf) -> BTreeMap<String, String> {
    std::fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_file(p: &PathBuf, m: &BTreeMap<String, String>) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    super::procs::restrict_to_user(&tmp);
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

#[cfg(windows)]
mod credman {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn write(target: &str, value: &str) -> Result<(), String> {
        let mut t = wide(target);
        let mut user = wide("TM Horizon");
        let mut blob: Vec<u8> = value.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: t.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            // "local machine" = this user on this PC (not roaming), still per user.
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user.as_mut_ptr(),
        };
        let ok = unsafe { CredWriteW(&cred, 0) };
        // wipe our copy
        blob.iter_mut().for_each(|b| *b = 0);
        if ok == 0 {
            return Err(format!("Credential Manager: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }

    pub fn read(target: &str) -> Option<String> {
        let t = wide(target);
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            if CredReadW(t.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) == 0 || p.is_null() {
                return None;
            }
            let c = &*p;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
            CredFree(p as *const _);
            String::from_utf8(bytes).ok()
        }
    }

    pub fn delete(target: &str) {
        let t = wide(target);
        unsafe {
            CredDeleteW(t.as_ptr(), CRED_TYPE_GENERIC, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store() {
        let t = tempfile::tempdir().unwrap();
        let s = Store::File(t.path().join("s.json"));
        assert!(s.get("a", SUPERADMIN).is_none());
        let pw = s.get_or_create("a", SUPERADMIN).unwrap();
        assert_eq!(pw.len(), 24);
        assert_eq!(s.get_or_create("a", SUPERADMIN).unwrap(), pw, "stays the same");
        s.set("a", ACCOUNT, "acct").unwrap();
        s.set("b", ACCOUNT, "other").unwrap();
        s.delete_server("a");
        assert!(s.get("a", ACCOUNT).is_none() && s.get("a", SUPERADMIN).is_none());
        assert_eq!(s.get("b", ACCOUNT).as_deref(), Some("other"));
    }
}
