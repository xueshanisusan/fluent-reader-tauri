pub mod commands;
pub mod db;
pub mod feeds;
pub mod models;
pub mod net;
pub mod repo;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("fluent-reader.db");
            let pool = tauri::async_runtime::block_on(db::open(&db_path))?;
            app.manage(AppState { pool });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::groups_list,
            commands::groups_create,
            commands::groups_rename,
            commands::groups_set_expanded,
            commands::groups_set_position,
            commands::groups_delete,
            commands::sources_list,
            commands::sources_create,
            commands::sources_rename,
            commands::sources_set_group,
            commands::sources_set_icon_url,
            commands::sources_set_fetch_frequency,
            commands::sources_set_hidden,
            commands::sources_set_last_fetched,
            commands::sources_delete,
            commands::rules_list,
            commands::rules_create,
            commands::rules_update,
            commands::rules_delete,
            commands::items_list,
            commands::items_insert,
            commands::items_mark_read,
            commands::items_set_starred,
            commands::items_unread_counts,
            net::net_fetch,
            feeds::sources_ingest,
            feeds::feeds_discover,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
