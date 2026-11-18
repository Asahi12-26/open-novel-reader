use serde::{Deserialize, Serialize};
use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, AppHandle, Manager, Runtime};

struct AndroidBackup<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs<'a> {
    filename: &'a str,
    archive: &'a str,
    total_bytes: usize,
}

#[derive(Deserialize)]
struct SaveResult {
    saved: bool,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("onr-backup")
        .setup(|app, api| {
            let plugin = api.register_android_plugin("io.github.opennovelreader.backup", "BackupPlugin")?;
            app.manage(AndroidBackup(plugin));
            Ok(())
        })
        .build()
}

pub async fn save<R: Runtime>(app: &AppHandle<R>, filename: &str, archive: &str, total_bytes: usize) -> Result<bool, tauri::plugin::mobile::PluginInvokeError> {
    let handle = app.state::<AndroidBackup<R>>().0.clone();
    let result: SaveResult = handle.run_mobile_plugin_async("saveArchive", SaveArgs { filename, archive, total_bytes }).await?;
    Ok(result.saved)
}
