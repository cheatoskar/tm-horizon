//! "Start when I log in to Windows": one scheduled task for the current user (no admin), created
//! from an XML definition (the plain `/SC ONLOGON` form needs admin rights because it fires for
//! every user). It starts the launcher hidden with `--start-servers`; the launcher then starts the
//! servers that have autostart on. Only the command builders are tested; tests never create a task.

pub const TASK_NAME: &str = "TM Horizon\\Servers";
pub const START_FLAG: &str = "--start-servers";

fn esc(s: &str) -> String {
    super::config::xml_escape(s)
}

/// Task Scheduler XML: logon trigger for this user only, least privilege, no time limit, not on
/// battery restrictions, one instance.
pub fn task_xml(user_id: &str, exe: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts TM Horizon in the background and the game servers marked "start when I log in".</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>{flag}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        user = esc(user_id),
        exe = esc(exe),
        flag = START_FLAG
    )
}

/// `schtasks` arguments to create (or replace) the task from an XML file.
pub fn create_args(xml_path: &str) -> Vec<String> {
    vec!["/Create".into(), "/TN".into(), TASK_NAME.into(), "/XML".into(), xml_path.into(), "/F".into()]
}

pub fn delete_args() -> Vec<String> {
    vec!["/Delete".into(), "/TN".into(), TASK_NAME.into(), "/F".into()]
}

pub fn query_args() -> Vec<String> {
    vec!["/Query".into(), "/TN".into(), TASK_NAME.into()]
}

/// The task file must be UTF-16 LE with a BOM, as its header says.
pub fn utf16_with_bom(s: &str) -> Vec<u8> {
    let mut b = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
        b.extend(u.to_le_bytes());
    }
    b
}

/// "DOMAIN\user" of the current user.
pub fn current_user() -> Option<String> {
    let user = std::env::var("USERNAME").ok().filter(|u| !u.is_empty())?;
    Some(match std::env::var("USERDOMAIN") {
        Ok(d) if !d.is_empty() => format!("{d}\\{user}"),
        _ => user,
    })
}

/// Turns the task on or off to match "any server wants autostart". Windows only.
#[cfg(windows)]
pub fn apply(want: bool, exe: &std::path::Path, tmp_dir: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let run = |args: Vec<String>| -> Result<std::process::Output, String> {
        std::process::Command::new("schtasks").args(args).creation_flags(0x0800_0000).output().map_err(|e| e.to_string())
    };
    let exists = run(query_args()).map(|o| o.status.success()).unwrap_or(false);
    if !want {
        if exists {
            let o = run(delete_args())?;
            if !o.status.success() {
                return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
            }
        }
        return Ok(());
    }
    let user = current_user().ok_or("no user name")?;
    let xml = task_xml(&user, &exe.to_string_lossy());
    std::fs::create_dir_all(tmp_dir).map_err(|e| e.to_string())?;
    let f = tmp_dir.join("autostart-task.xml");
    std::fs::write(&f, utf16_with_bom(&xml)).map_err(|e| e.to_string())?;
    let o = run(create_args(&f.to_string_lossy()));
    let _ = std::fs::remove_file(&f);
    let o = o?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_for_this_user_only() {
        let x = task_xml(r"PC\Max & Co", r"C:\Users\Max\AppData\Local\TM Hub\tm-hub.exe");
        assert!(x.contains(r"<UserId>PC\Max &amp; Co</UserId>"));
        assert_eq!(x.matches("<UserId>").count(), 2, "trigger and principal both name the user");
        assert!(x.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(x.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(x.contains(r"<Command>C:\Users\Max\AppData\Local\TM Hub\tm-hub.exe</Command>"));
        assert!(x.contains("<Arguments>--start-servers</Arguments>"));
        assert!(!x.contains("HighestAvailable"));
    }

    #[test]
    fn schtasks_args() {
        assert_eq!(create_args(r"C:\t\a.xml"), vec!["/Create", "/TN", r"TM Horizon\Servers", "/XML", r"C:\t\a.xml", "/F"]);
        assert_eq!(delete_args(), vec!["/Delete", "/TN", r"TM Horizon\Servers", "/F"]);
        // never the admin-only forms
        let all = [create_args("x"), delete_args(), query_args()].concat().join(" ");
        assert!(!all.contains("ONLOGON") && !all.contains("/RL") && !all.contains("/RU"));
    }

    #[test]
    fn utf16_bom() {
        let b = utf16_with_bom("<a>");
        assert_eq!(&b[..2], &[0xFF, 0xFE]);
        assert_eq!(b.len(), 2 + 6);
    }
}
