mod app_state;

use app_state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;
            std::fs::create_dir_all(&app_data_dir)?;
            let state_path = app_data_dir.join("app-state.json");
            app.manage(AppState::new(state_path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_state::app_get_bootstrap,
            app_state::app_get_messages,
            app_state::app_sync_since,
            app_state::app_create_thread,
            app_state::app_select_thread,
            app_state::app_rename_thread,
            app_state::app_toggle_pin_thread,
            app_state::app_set_thread_archived,
            app_state::app_send_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running codex tauri refactor");
}
