use std::sync::Mutex;
use tauri::Manager;

pub struct AppQuitState(pub Mutex<bool>);

#[tauri::command]
pub fn exit_app(state: tauri::State<'_, AppQuitState>, app: tauri::AppHandle) {
    *state.0.lock().unwrap() = true;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.close();
    }
}
