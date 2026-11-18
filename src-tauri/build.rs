fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "begin_backup_archive", "append_backup_chunk", "finish_backup_archive", "abort_backup_archive",
    ]));
    tauri_build::try_build(attributes).expect("build reader app permissions");
}
