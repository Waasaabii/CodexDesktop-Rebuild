mod bridge;

use bridge::BridgeState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            bridge::bridge_get_sentry_init_options,
            bridge::bridge_get_build_flavor,
            bridge::bridge_sync_since,
            bridge::bridge_show_context_menu,
            bridge::bridge_send_message,
            bridge::bridge_send_worker_message,
            bridge::bridge_trigger_sentry_test_error
        ])
        .run(tauri::generate_context!())
        .expect("error while running codex tauri refactor");
}

