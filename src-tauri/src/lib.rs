// The bundled web frontend owns IndexedDB data. No unrestricted filesystem,
// shell, HTTP or secret-reading commands are exposed to imported book content.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Open Novel Reader could not start");
}
