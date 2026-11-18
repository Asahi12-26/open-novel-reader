mod backup;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            backup::begin_backup_archive, backup::append_backup_chunk, backup::finish_backup_archive,
            backup::abort_backup_archive,
        ]);
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_onr_backup::init());
    builder
        .run(tauri::generate_context!())
        .expect("Open Novel Reader could not start");
}
