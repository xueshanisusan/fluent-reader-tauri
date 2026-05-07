pub mod net;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![net::net_fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
