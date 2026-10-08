// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// On Linux this executable is also every Chromium helper process (renderer, GPU, network, utility):
// the attribute runs those and returns before `run` whenever Chromium launched us with `--type=`.
#[cfg_attr(target_os = "linux", tauri_runtime_cef::cef_entry_point)]
fn main() {
    app_lib::run();
}
