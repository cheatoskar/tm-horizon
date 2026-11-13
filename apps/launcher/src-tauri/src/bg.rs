//! Blocking work of Tauri commands.
//!
//! A plain `#[tauri::command] fn` runs on the main (window) thread and freezes the window while it
//! works; `#[tauri::command(async)] fn` runs its body inside a task on one of the async runtime's
//! few worker threads (one per CPU core). File walks, hashing, downloads and process starts there
//! block that worker, and a handful of them at once (stats, scans, media, a slow server query)
//! leave no worker for a quick command such as a module switch: the click seems to hang.
//! Commands that do such work are `async fn` and hand it to the blocking pool with [`run`].

/// Runs `f` on the blocking thread pool and waits for it without holding an async worker. A
/// panic in `f` is passed on unchanged (as with the command body before).
pub async fn run<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(v) => v,
        Err(tauri::Error::JoinError(e)) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => panic!("blocking task failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn runs_on_another_thread_and_returns_the_value() {
        let here = std::thread::current().id();
        let (v, there) = tauri::async_runtime::block_on(super::run(|| (21 * 2, std::thread::current().id())));
        assert_eq!(v, 42);
        assert_ne!(here, there);
    }

    #[test]
    fn a_panic_comes_through() {
        let r = std::panic::catch_unwind(|| tauri::async_runtime::block_on(super::run(|| -> u8 { panic!("boom") })));
        assert!(r.is_err());
    }
}
