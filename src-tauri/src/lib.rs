pub mod commands;
pub mod db;
pub mod feeds;
pub mod llm;
pub mod models;
pub mod net;
pub mod notify;
pub mod opml;
pub mod repo;
pub mod rules;
pub mod search;
pub mod service;
pub mod translate;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("fluent-reader.db");
            let pool = tauri::async_runtime::block_on(db::open(&db_path))?;
            app.manage(AppState { pool });
            app.manage(llm::ManagedState::default());
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
            commands::items_by_ids,
            commands::items_insert,
            commands::items_mark_read,
            commands::items_set_starred,
            commands::items_set_hidden,
            commands::items_unread_counts,
            search::items_search,
            net::net_fetch,
            feeds::sources_ingest,
            feeds::feeds_discover,
            feeds::items_backfill_thumbs,
            opml::feeds_import_opml,
            opml::feeds_export_opml,
            service::service_authenticate,
            service::service_forget,
            service::service_sync,
            service::service_mark,
            service::service_mark_feed_read,
            translate::translate_segments,
            llm::model_catalog,
            llm::model_status,
            llm::model_download,
            llm::model_import,
            llm::runtime_start,
            llm::runtime_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            // Reap the managed llama-server so it doesn't outlive the app as a
            // zombie holding RAM + its port. take() makes this idempotent across
            // ExitRequested (may fire per-window) and the final Exit.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(st) = handle.try_state::<llm::ManagedState>() {
                    let mut guard = st.runtime.blocking_lock();
                    if let Some(rt) = guard.take() {
                        let _ = rt.child.kill();
                    }
                }
            }
        });
}
