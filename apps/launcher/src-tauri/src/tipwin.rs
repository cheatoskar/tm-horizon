//! Tooltip over the embedded browser. The embedded page is a native child webview on top of the app's
//! own webview, so no HTML tooltip can be drawn over it. Instead of moving the page aside, a label
//! that would overlap it is shown in one small reusable native window: transparent, borderless,
//! always on top, never activated, click-through, placed in screen coordinates. Never moves or hides
//! the embedded page. The page is `public/tip.html` (a label and two themes).

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "tip";
const HEIGHT: f64 = 30.0;

/// Window styles: tool window (no taskbar entry), no activation, transparent to the mouse.
#[cfg(windows)]
fn no_activate(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT};
    if let Ok(h) = w.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(h.0 as _, GWL_EXSTYLE);
            SetWindowLongPtrW(h.0 as _, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT) as isize);
        }
    }
}

#[cfg(not(windows))]
fn no_activate(_: &tauri::WebviewWindow) {}

/// Shows `label` with its left edge at `x` and its vertical centre at `y` (logical pixels in the main
/// window's content area), `w` logical pixels wide.
pub fn show(app: &AppHandle, label: &str, x: f64, y: f64, w: f64, dark: bool) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("no main window")?;
    let sf = main.scale_factor().map_err(|e| e.to_string())?;
    let inner = main.inner_position().map_err(|e| e.to_string())?;
    let pos = PhysicalPosition::new(inner.x + (x * sf).round() as i32, inner.y + ((y - HEIGHT / 2.0) * sf).round() as i32);
    let size = tauri::LogicalSize::new(w.max(20.0), HEIGHT);
    let text = serde_json::to_string(label).map_err(|e| e.to_string())?;
    let win = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => {
            let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("tip.html".into()))
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .inner_size(size.width, size.height)
                .build()
                .map_err(|e| e.to_string())?;
            no_activate(&w);
            let _ = w.set_ignore_cursor_events(true);
            w
        }
    };
    win.set_size(size).map_err(|e| e.to_string())?;
    win.set_position(pos).map_err(|e| e.to_string())?;
    // Text and theme: set on the loaded page (the theme can change between two labels).
    let _ = win.eval(format!("document.documentElement.dataset.theme={};var t=document.getElementById('t');if(t)t.textContent={text};", if dark { "'dark'" } else { "'light'" }));
    // Windows resets the extended styles now and then: set them before every show.
    no_activate(&win);
    win.show().map_err(|e| e.to_string())
}

pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}
