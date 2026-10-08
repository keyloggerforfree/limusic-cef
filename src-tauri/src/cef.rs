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
        tauri::Builder::default().runtime(cef_runtime(multi))
    }
    #[cfg(not(target_os = "linux"))]
    tauri::Builder::default().runtime(tauri_runtime_wry::Wry::default())
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
