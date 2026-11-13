// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // limusic-cef: Chromium's helpers run on X11 like the rest of the app, and ANGLE in the GPU
    // process picks EGL's Wayland platform whenever WAYLAND_DISPLAY is set, so importing a decoded
    // video frame dereferenced the X display as a wl_display and crashed the GPU process: black
    // music videos and a frozen page. Only the helpers lose it; the browser process keeps it for
    // what it launches (a link opened in the user's browser). Still single-threaded here.
    #[cfg(target_os = "linux")]
    if std::env::args().any(|arg| arg.starts_with("--type=")) {
        std::env::remove_var("WAYLAND_DISPLAY");
    }
    app();
}

// On Linux this executable is also every Chromium helper process (renderer, GPU, network, utility):
// the attribute runs those and returns before `run` whenever Chromium launched us with `--type=`.
#[cfg_attr(target_os = "linux", tauri_runtime_cef::cef_entry_point)]
fn app() {
    app_lib::run();
}
