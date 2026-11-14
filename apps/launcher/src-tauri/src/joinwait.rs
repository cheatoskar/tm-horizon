//! Join a server with a game that TMLoader is still starting (launch::plan_join, `StartThenJoin`).
//!
//! TMLoader gets no join link: the game would try the join right at start, before it is logged in online,
//! and say "unable to connect". Instead a background thread watches the game from outside
//! (`platform::probe_window`, `launch::ReadyWatch`) and, once it is ready, hands the link to the running
//! game with `TmForever.exe /useexedir /singleinst /url="..."`, the command of the game's tmtp: association.
//! The UI shows "Joining when the game is ready" with "Join now" and "Cancel" (event `join-state`).
//! One join waits at a time; a new one replaces it.

use crate::launch::{LaunchTarget, Ready, ReadyWatch};
use crate::state::AppState;
use crate::{perf, platform};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinState {
    pub id: u64,
    /// waiting, sent, cancelled, failed
    pub state: &'static str,
    pub game: String,
    pub link: String,
    pub message: Option<String>,
}

struct Pending {
    id: u64,
    cancel: Arc<AtomicBool>,
    now: Arc<AtomicBool>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

fn emit(app: &AppHandle, s: JoinState) {
    let _ = app.emit("join-state", s);
}

fn log(app: &AppHandle, what: &str, ms: u128) {
    let st = app.state::<AppState>();
    perf::log(&st, what, ms);
}

/// Starts the wait for `exe_name` (lower-case file name, e.g. `tmforever.exe`); `handoff` is run once
/// the game is ready. Returns the join's id.
pub fn start(app: AppHandle, game: String, link: String, exe_name: String, handoff: LaunchTarget) -> u64 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    let now = Arc::new(AtomicBool::new(false));
    if let Some(old) = PENDING.lock().unwrap_or_else(|e| e.into_inner()).replace(Pending { id, cancel: cancel.clone(), now: now.clone() }) {
        old.cancel.store(true, Ordering::Relaxed);
    }
    let shown = link.clone();
    let state = move |s: &'static str, message: Option<String>| JoinState { id, state: s, game: game.clone(), link: shown.clone(), message };
    emit(&app, state("waiting", None));
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let mut watch = ReadyWatch::new(0);
        let result = loop {
            if cancel.load(Ordering::Relaxed) {
                break state("cancelled", None);
            }
            let probe = platform::probe_window(&exe_name);
            // "Join now" works as soon as the game's window is there; before that a hand-off would start a
            // second game without TMLoader's mods.
            let verdict = match watch.step(t0.elapsed().as_millis() as u64, probe) {
                Ready::Wait if now.load(Ordering::Relaxed) && probe.window => Ready::Go,
                v => v,
            };
            match verdict {
                Ready::Wait => std::thread::sleep(Duration::from_millis(500)),
                Ready::Go => {
                    let ms = t0.elapsed().as_millis();
                    let by = if now.load(Ordering::Relaxed) { "by hand" } else { "ready" };
                    break match crate::commands::execute(&app, &handoff) {
                        Ok(()) => {
                            log(&app, &format!("join-handoff ({by}) {link}: {}", handoff.display()), ms);
                            state("sent", None)
                        }
                        Err(e) => {
                            log(&app, &format!("join-handoff-failed {link}: {e}"), ms);
                            state("failed", Some(e))
                        }
                    };
                }
                Ready::Gone => {
                    log(&app, &format!("join-gone {link}"), t0.elapsed().as_millis());
                    break state("failed", Some("The game was closed before the join.".into()));
                }
                Ready::TimedOut => {
                    log(&app, &format!("join-timeout {link}"), t0.elapsed().as_millis());
                    break state("failed", Some("The game did not get ready in time.".into()));
                }
            }
        };
        {
            let mut p = PENDING.lock().unwrap_or_else(|e| e.into_inner());
            if p.as_ref().is_some_and(|x| x.id == id) {
                *p = None;
            }
        }
        emit(&app, result);
    });
    id
}

/// "Join now": skip the rest of the wait (still needs the game's window).
#[tauri::command]
pub fn join_now() -> bool {
    match PENDING.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        Some(p) => {
            p.now.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// "Cancel": the game keeps running, the link is not sent.
#[tauri::command]
pub fn join_cancel() -> bool {
    match PENDING.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        Some(p) => {
            p.cancel.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}
