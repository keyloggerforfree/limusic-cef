//! What the limusic-cef fork adds over upstream: Chromium (CEF) on Linux instead of WebKitGTK.
//!
//! Kept in one file so that merging upstream touches as little as possible. Upstream's WebKitGTK
//! code stays where it is, verbatim, under `#[cfg(webkitgtk)]`, a cfg nothing ever sets (declared
//! in Cargo.toml's `[lints]`), and its callers reach the stand-ins below under the same names.
//! An upstream edit to that code then merges cleanly and compiles to nothing. What cannot be done
//! that way (picking the runtime, the session.rs cookie thread) is a call into this module.
//!
//! When merging upstream, the thing a clean merge will not catch is *new* Linux code that uses
//! `webkit2gtk` or `gtk` (GTK 3): gate it `#[cfg(webkitgtk)]` too, or port it.

use tauri::AppHandle;

/// `tauri::Builder::default()`, with this platform's runtime picked: CEF on Linux, wry elsewhere.
///
/// On Linux it first hands the launch to a copy that is already running, if there is one, and
/// exits; see [`hand_off_to_running_instance`].
pub fn builder() -> tauri::Builder {
    #[cfg(target_os = "linux")]
    {
        let multi = std::env::var_os("LIMUSIC_MULTI").is_some();
        if !multi {
            hand_off_to_running_instance();
        }
        // GTK 4 on X11 takes WM_CLASS from the program name, and nothing on the CEF stack sets one
        // (winit-gtk4's GtkApplication has no id), so the window had an empty class and the
        // desktop could not match it to limusic.desktop (`StartupWMClass=limusic-app`) for its
        // icon. Before the runtime, which opens the display.
        // SAFETY: a static NUL-terminated string, set before any other thread touches GLib.
        unsafe { glib_sys::g_set_prgname(c"limusic-app".as_ptr()) };
        let plugin =
            tauri::plugin::Builder::<_, ()>::new("limusic-cef").js_init_script(DRAG_SCRIPT).build();
        tauri::Builder::default().runtime(cef_runtime(multi)).plugin(plugin)
    }
    #[cfg(not(target_os = "linux"))]
    tauri::Builder::default().runtime(tauri_runtime_wry::Wry::default())
}

/// The desktop's `gtk-decoration-layout`, for the titlebar's window buttons, read the way upstream
/// does in lib.rs `setup` but from GTK 4, the toolkit the CEF runtime runs on. Main thread only.
#[cfg(target_os = "linux")]
pub fn read_button_layout() {
    if let Some(layout) = gtk4::Settings::default().and_then(|s| s.gtk_decoration_layout()) {
        let _ = crate::commands::BUTTON_LAYOUT.set(layout.into());
    }
}

/// The CEF runtime as the Linux build configures it.
///
/// Session cookies persist: the login webview (session.rs) keeps its own Google session so a
/// re-login is one click, and Chromium drops session cookies at exit unless told otherwise.
///
/// The profile (cookies, cache, `cef.log`) lives in `{user cache}/com.limusic.desktop/cef`. Under
/// `LIMUSIC_MULTI` with `XDG_DATA_HOME` moved, the second copy gets its own next to its own
/// database: Chromium allows one browser process per profile, and a second one on the same
/// directory hands itself to the first and fails to start.
#[cfg(target_os = "linux")]
fn cef_runtime(multi: bool) -> tauri_runtime_cef::Cef {
    let cef = tauri_runtime_cef::Cef::default()
        .persist_session_cookies(true)
        // Chrome-style CEF keeps Chromium's session restore, which defaults to "continue where
        // you left off" (1). After any exit Chromium counts as a crash (a kill, a logout, Ctrl-C),
        // the next launch reopened every page of the previous run as a bare `tauri.localhost -
        // Chromium` window, outside Tauri, each booting another copy of the UI. 5 is "open the
        // new tab page", which an app with no browser UI never shows. Resuming the song is ours
        // (the queue and position in SQLite), not Chromium's.
        .profile_preference_value("session.restore_on_startup", 5);
    match std::env::var_os("XDG_DATA_HOME").filter(|_| multi) {
        Some(data) => {
            cef.root_cache_path(std::path::Path::new(&data).join("com.limusic.desktop").join("cef"))
        }
        None => cef,
    }
}

/// Give this launch to the copy that is already running, and exit, before CEF starts.
///
/// tauri-plugin-single-instance does this from its plugin setup, which on CEF is too late: by then
/// `cef::initialize` has run, found the first copy's profile locked, relayed our command line to
/// Chromium's own process singleton (where the runtime drops it, deep links aside) and failed, so
/// the second copy dies as "webview runtime not installed" and the first never hears about it. The
/// plugin still owns the name; this is its client half, called first. Same name, path, interface
/// and arguments as `tauri-plugin-single-instance/src/platform_impl/linux.rs`, from
/// tauri.conf.json's `identifier`. Any failure (no session bus, nobody owns the name) means there
/// is nobody to hand to, and we start normally.
#[cfg(target_os = "linux")]
fn hand_off_to_running_instance() {
    const NAME: &str = "com.limusic.desktop.SingleInstance";
    const PATH: &str = "/com/limusic/desktop/SingleInstance";

    let Ok(conn) = zbus::blocking::Connection::session() else { return };
    let argv: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect();
    let cwd = std::env::current_dir().unwrap_or_default().to_string_lossy().into_owned();
    let sent = conn.call_method(
        Some(NAME),
        PATH,
        Some("org.SingleInstance.DBus"),
        "ExecuteCallback",
        &(argv, cwd),
    );
    if sent.is_ok() {
        std::process::exit(0);
    }
}

/// `data-tauri-drag-region` (the titlebar, the mini player) on CEF.
///
/// Tauri's own drag.js asks for `start_dragging`, which winit-gtk4 turns into
/// `gdk_toplevel_begin_move` with the last button press GTK saw. On Linux the runtime runs
/// everything on X11 (XWayland under a Wayland session) and embeds Chromium as a child X window,
/// so the press goes to Chromium, GTK never sees one, and the call fails without a word. This
/// script picks out the same presses drag.js does (its `isDragRegion`, copied; double clicks stay
/// drag.js's maximize toggle) and calls [`cef_start_dragging`] instead. It listens on `window` in
/// the capture phase, ahead of drag.js on `document`, which stops propagation once it has its
/// press. `__TAURI_INTERNALS__.invoke` is frozen, so it cannot be rerouted in place.
///
/// The move starts once the pointer has travelled a few pixels with the button down, as GTK's
/// titlebars do, not on the press. The window manager grabs the pointer for a move, so Chromium
/// never saw the click's release and counted the next click as a first one again: double-click to
/// maximize took three clicks.
///
/// Resizing has the same problem: ResizeBorders.svelte's `startResizeDragging` goes through
/// winit-gtk4 as well. Its edge strips are the only elements with a compass `*-resize` cursor, so
/// a press on one sends that direction along instead.
#[cfg(target_os = "linux")]
const DRAG_SCRIPT: &str = r#"
(() => {
  const ATTR = 'data-tauri-drag-region'
  const CLICKABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'])
  const ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'])
  const clickable = (el) =>
    CLICKABLE.has(el.tagName) ||
    (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') ||
    (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') ||
    ROLES.has(el.getAttribute('role'))
  const isDragRegion = (path) => {
    for (const el of path) {
      if (!(el instanceof HTMLElement)) continue
      const attr = el.getAttribute(ATTR)
      if (clickable(el) && attr === null) return false
      if (attr === null) continue
      if (attr === 'false') return false
      if (attr === 'deep') return true
      if (attr === '' || attr === 'true') return el === path[0]
    }
    return false
  }
  const EDGE = /^(n|s|e|w|ne|nw|se|sw)-resize$/
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !window.__TAURI_INTERNALS__) return
    const edge = e.target instanceof Element && getComputedStyle(e.target).cursor.match(EDGE)
    if (edge) {
      window.__TAURI_INTERNALS__.invoke('cef_start_dragging', { edge: edge[1] }).catch(() => {})
    } else if (e.detail === 1 && isDragRegion(e.composedPath())) {
      const { screenX: x, screenY: y } = e
      const stop = () => {
        window.removeEventListener('mousemove', move, true)
        window.removeEventListener('mouseup', stop, true)
      }
      const move = (m) => {
        if (!(m.buttons & 1)) return stop()
        if (Math.abs(m.screenX - x) + Math.abs(m.screenY - y) < 4) return
        stop()
        window.__TAURI_INTERNALS__.invoke('cef_start_dragging').catch(() => {})
      }
      window.addEventListener('mousemove', move, true)
      window.addEventListener('mouseup', stop, true)
    }
  }, true)
})()
"#;

/// Move the window with the pointer, or resize it from `edge` (`n`, `se`, ...), the way Chromium
/// does for its own frameless windows on X11: let go of the pointer and ask the window manager
/// with `_NET_WM_MOVERESIZE`. Called by [`DRAG_SCRIPT`]. Mutter, KWin and the other EWMH window
/// managers, XWayland included, take it.
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn cef_start_dragging(window: tauri::Window, edge: Option<String>) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use x11_dl::xlib;

    // _NET_WM_MOVERESIZE_SIZE_TOPLEFT (0) clockwise to _SIZE_LEFT (7), then _MOVE (8).
    let action: std::os::raw::c_long = match edge.as_deref() {
        None => 8,
        Some("nw") => 0,
        Some("n") => 1,
        Some("ne") => 2,
        Some("e") => 3,
        Some("se") => 4,
        Some("s") => 5,
        Some("sw") => 6,
        Some("w") => 7,
        Some(_) => return,
    };
    const NORMAL_APP: std::os::raw::c_long = 1; // source indication

    let xid = match window.window_handle().map(|h| h.as_raw()) {
        Ok(RawWindowHandle::Xlib(h)) => h.window,
        other => {
            tracing::warn!(handle = ?other.map(|_| ()), "window drag: no X11 window");
            return;
        }
    };
    let Ok(x) = xlib::Xlib::open() else { return };
    // SAFETY: a private display connection, opened and closed here; every pointer handed to Xlib
    // is a live local.
    unsafe {
        let display = (x.XOpenDisplay)(std::ptr::null());
        if display.is_null() {
            return;
        }
        let root = (x.XDefaultRootWindow)(display);
        let (mut root_ret, mut child) = (0, 0);
        let (mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0);
        let on_screen = (x.XQueryPointer)(
            display,
            root,
            &mut root_ret,
            &mut child,
            &mut rx,
            &mut ry,
            &mut wx,
            &mut wy,
            &mut mask,
        );
        if on_screen != 0 {
            (x.XUngrabPointer)(display, xlib::CurrentTime);
            let mut ev: xlib::XClientMessageEvent = std::mem::zeroed();
            ev.type_ = xlib::ClientMessage;
            ev.window = xid as xlib::Window;
            ev.message_type = (x.XInternAtom)(display, c"_NET_WM_MOVERESIZE".as_ptr(), xlib::False);
            ev.format = 32;
            let l = [rx as _, ry as _, action, xlib::Button1 as _, NORMAL_APP];
            for (i, v) in l.into_iter().enumerate() {
                ev.data.set_long(i, v);
            }
            let mut ev = xlib::XEvent::from(ev);
            (x.XSendEvent)(
                display,
                root,
                xlib::False,
                xlib::SubstructureRedirectMask | xlib::SubstructureNotifyMask,
                &mut ev,
            );
            (x.XFlush)(display);
        }
        (x.XCloseDisplay)(display);
    }
}

/// The URL a hidden webview loads a registered URI scheme's document from (webview.rs's harness).
///
/// Tauri hands a `WebviewUrl::CustomProtocol` URL to the runtime unchanged. wry rewrote
/// `scheme://localhost/` into whatever its engine serves; CEF serves a custom scheme only at
/// `http://<scheme>.localhost` (tauri-runtime-cef's `custom_scheme_url`), so asking it for
/// `limusicharness://localhost/` loaded no harness and the cipher webview never became ready.
pub fn custom_protocol_url(scheme: &str) -> String {
    if cfg!(target_os = "linux") {
        format!("http://{scheme}.localhost/")
    } else {
        format!("{scheme}://localhost/")
    }
}

/// `run_on_main_thread`, for a closure that reads the webview cookie store. session.rs calls it in
/// place of upstream's `run_on_main_thread` wherever the closure reads cookies.
///
/// WebKitGTK and WKWebView drive the platform event loop while they wait for the store, so they
/// are written to be called from the thread that owns it. CEF is the opposite: its cookie visitor
/// runs on that thread *after* the read has started waiting, so a read that blocks the main thread
/// waits for itself forever. Linux runs `f` on a worker instead. Building and destroying windows
/// from there is fine: the runtime posts those to the event loop.
pub trait CookieThread {
    fn run_on_cookie_thread(&self, f: impl FnOnce() + Send + 'static) -> tauri::Result<()>;
}

impl CookieThread for AppHandle {
    fn run_on_cookie_thread(&self, f: impl FnOnce() + Send + 'static) -> tauri::Result<()> {
        #[cfg(target_os = "linux")]
        {
            tauri::async_runtime::spawn_blocking(f);
            Ok(())
        }
        #[cfg(not(target_os = "linux"))]
        self.run_on_main_thread(f)
    }
}

/// Upstream's WebKit settings tuning (lib.rs `tune_webview`). Chromium has no per-view switches
/// for the media and 3D stacks it turned off, so there is nothing to do.
#[cfg(target_os = "linux")]
pub(crate) fn tune_webview_labelled(_app: &AppHandle, _label: &str, _media: bool) {}

/// Upstream's WebGL toggle for the ambient light (lib.rs `set_webgl`). WebGL is always on in
/// Chromium.
#[cfg(target_os = "linux")]
pub(crate) fn set_webgl(_app: &AppHandle, _on: bool) {}

/// Linux's `nativevideo` on CEF: never available. Upstream's nativevideo.rs draws the music video
/// with mpv into a GTK 3 GLArea under the WebKitGTK view, which cannot exist beside CEF's GTK 4.
/// Without it the player view uses the `<video>` element, as on macOS, and the ambient glow takes
/// its macOS path. lib.rs points `mod nativevideo` here; the file stays in the tree so upstream's
/// edits to it keep merging.
#[cfg(target_os = "linux")]
pub mod nativevideo {
    use std::sync::Arc;

    use crate::state::AppState;

    pub fn available() -> bool {
        false
    }

    pub fn install(_win: &tauri::WebviewWindow, _state: Arc<AppState>) {}

    pub async fn set_rect(
        _app: &tauri::AppHandle,
        _state: Arc<AppState>,
        _rect: Option<[f64; 4]>,
    ) -> bool {
        false
    }

    pub async fn next_frame(_after: u32) -> Option<Arc<[u8]>> {
        None
    }
}
