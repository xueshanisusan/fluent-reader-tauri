// Fires OS notifications for rule-flagged items at the end of ingest.
//
// Matches the legacy Electron fluent-reader behavior: notification title is the
// item title, body is the source name, and the call is suppressed when the
// main window is focused (so a user actively using the app isn't pestered).
// Failures are logged and swallowed -- notification dispatch is a UX side
// effect, not a data-correctness concern, and an OS daemon hiccup should
// never poison ingest.

use crate::models::NewItem;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

pub fn dispatch(app: &tauri::AppHandle, source_name: &str, items: &[NewItem]) {
    // `all` returns true on an empty slice, so this also short-circuits the
    // no-items case. Don't "fix" it.
    if items.iter().all(|i| !i.notify) {
        return;
    }
    if !notifications_enabled(app) {
        return;
    }
    if window_focused(app) {
        return;
    }
    for it in items {
        if !it.notify {
            continue;
        }
        let res = app
            .notification()
            .builder()
            .title(&it.title)
            .body(source_name)
            .show();
        if let Err(e) = res {
            eprintln!("[notify] dispatch failed: {e}");
        }
    }
}

// Reads `notificationsEnabled` from the same `settings.json` the frontend
// writes via tauri-plugin-store. Default-to-true when the key is missing
// (matches the frontend's DEFAULTS — store may be empty on first run).
fn notifications_enabled(app: &tauri::AppHandle) -> bool {
    let Ok(store) = app.store("settings.json") else {
        return true;
    };
    store
        .get("notificationsEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn window_focused(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}
