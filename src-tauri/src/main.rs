#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{Emitter, LogicalSize, Manager, Size};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct SidecarState(Mutex<Option<CommandChild>>);

fn extract_server_url(line: &str) -> Option<String> {
    let marker = "ProviderManager running at ";
    let start = line.find(marker)? + marker.len();
    let rest = line[start..].trim();
    rest.split_whitespace().next().map(|value| value.to_string())
}

fn shutdown_sidecar(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let Ok(mut child) = state.0.lock() else {
        return;
    };
    if let Some(child) = child.take() {
        let _ = child.kill();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main webview window is missing");
            let _ = window.set_min_size(Some(Size::Logical(LogicalSize::new(1052.0, 700.0))));
            let sidecar = app
                .shell()
                .sidecar("provider-manager")?
                .env("CPM_NO_AUTO_OPEN", "1")
                .env("HOST", "127.0.0.1");
            let (mut rx, child) = sidecar.spawn()?;

            app.manage(SidecarState(Mutex::new(Some(child))));
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            if let Some(url) = extract_server_url(&line) {
                                if let Ok(parsed) = url.parse() {
                                    let _ = window.navigate(parsed);
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            let line = String::from_utf8_lossy(&bytes).to_string();
                            let _ = window.emit("server-stderr", line);
                        }
                        CommandEvent::Terminated(payload) => {
                            let _ = window.emit("server-terminated", format!("{payload:?}"));
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                shutdown_sidecar(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
