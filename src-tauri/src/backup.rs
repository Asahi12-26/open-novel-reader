#[cfg(not(target_os = "android"))]
use std::io::{self, Seek};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use tempfile::NamedTempFile;

const MAX_ARCHIVE_BYTES: usize = 256 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const ZIP_HEADER: &[u8] = b"PK\x03\x04";
static PENDING: Mutex<Option<BackupUpload>> = Mutex::new(None);
static SAVING: AtomicBool = AtomicBool::new(false);

struct BackupUpload {
    id: String,
    filename: String,
    total_bytes: usize,
    written: usize,
    updated_at: Instant,
    file: NamedTempFile,
}

impl BackupUpload {
    fn append(&mut self, offset: usize, bytes: &[u8]) -> Result<(), &'static str> {
        if offset != self.written || bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES
            || bytes.len() > self.total_bytes - self.written
        {
            return Err("Invalid backup data range.");
        }
        if offset == 0 && !bytes.starts_with(ZIP_HEADER) {
            return Err("Invalid backup ZIP.");
        }
        self.file.write_all(bytes).map_err(|_| "Cannot write backup data.")?;
        self.written += bytes.len();
        self.updated_at = Instant::now();
        Ok(())
    }
}

fn valid_filename(filename: &str) -> bool {
    filename.len() <= 96 && filename.starts_with("open-novel-reader-") && filename.ends_with(".zip")
        && filename.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
}

struct SaveGuard;
impl Drop for SaveGuard {
    fn drop(&mut self) {
        SAVING.store(false, Ordering::Release);
    }
}

// Android's Tauri IPC has no binary request body. Each bounded JSON chunk is
// staged inside the app cache until the user selects an OS save destination.
#[tauri::command]
pub async fn begin_backup_archive(app: tauri::AppHandle, filename: String, total_bytes: usize) -> Result<String, &'static str> {
    if !valid_filename(&filename) || !(ZIP_HEADER.len()..=MAX_ARCHIVE_BYTES).contains(&total_bytes) {
        return Err("Invalid backup filename or size.");
    }
    let mut pending = PENDING.lock().map_err(|_| "Cannot prepare backup.")?;
    if SAVING.load(Ordering::Acquire) || pending.as_ref().is_some_and(|upload| upload.updated_at.elapsed() < UPLOAD_TIMEOUT) {
        return Err("A backup save is already in progress.");
    }
    *pending = None;
    let cache = app.path().app_cache_dir().map_err(|_| "Cannot find local backup cache.")?;
    std::fs::create_dir_all(&cache).map_err(|_| "Cannot open local backup cache.")?;
    let file = tempfile::Builder::new().prefix("onr-export-").rand_bytes(24).tempfile_in(cache)
        .map_err(|_| "Cannot open local backup cache.")?;
    let id = file.path().file_name().and_then(|entry| entry.to_str()).ok_or("Invalid backup cache path.")?.to_owned();
    *pending = Some(BackupUpload { id: id.clone(), filename, total_bytes, written: 0, updated_at: Instant::now(), file });
    Ok(id)
}

#[tauri::command]
pub async fn append_backup_chunk(upload_id: String, offset: usize, bytes: Vec<u8>) -> Result<(), &'static str> {
    let mut pending = PENDING.lock().map_err(|_| "Cannot write backup data.")?;
    let upload = pending.as_mut().filter(|upload| upload.id == upload_id).ok_or("Backup upload expired.")?;
    let result = upload.append(offset, &bytes);
    if result.is_err() { *pending = None; }
    result
}

#[tauri::command]
pub async fn abort_backup_archive(upload_id: String) -> Result<(), &'static str> {
    let mut pending = PENDING.lock().map_err(|_| "Cannot abort backup.")?;
    if pending.as_ref().is_some_and(|upload| upload.id == upload_id) { *pending = None; }
    Ok(())
}

#[tauri::command]
pub async fn finish_backup_archive(app: tauri::AppHandle, upload_id: String) -> Result<bool, &'static str> {
    let mut upload = {
        let mut pending = PENDING.lock().map_err(|_| "Cannot save backup.")?;
        let candidate = pending.as_ref().filter(|upload| upload.id == upload_id).ok_or("Backup upload expired.")?;
        if candidate.written != candidate.total_bytes {
            *pending = None;
            return Err("Incomplete backup.");
        }
        SAVING.store(true, Ordering::Release);
        pending.take().ok_or("Backup upload expired.")?
    };
    let _guard = SaveGuard;
    upload.file.as_file().sync_all().map_err(|_| "Cannot write backup data.")?;
    save_archive(app, &mut upload).await
}

#[cfg(not(target_os = "android"))]
async fn save_archive(app: tauri::AppHandle, upload: &mut BackupUpload) -> Result<bool, &'static str> {
    use tauri_plugin_dialog::DialogExt;

    let Some(selected) = app.dialog().file().add_filter("ZIP", &["zip"]).set_file_name(&upload.filename).blocking_save_file() else {
        return Ok(false);
    };
    let path = selected.into_path().map_err(|_| "Unsupported backup destination.")?;
    if !path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("zip")) {
        return Err("Choose a ZIP filename.");
    }
    let parent = path.parent().ok_or("Invalid backup destination.")?;
    let mut draft = NamedTempFile::new_in(parent).map_err(|_| "Cannot open backup destination.")?;
    let source = upload.file.as_file_mut();
    source.rewind().map_err(|_| "Cannot read backup cache.")?;
    let copied = io::copy(source, &mut draft).map_err(|_| "Cannot write backup data.")?;
    if copied != upload.total_bytes as u64 { return Err("Incomplete backup."); }
    draft.as_file().sync_all().map_err(|_| "Cannot write backup data.")?;
    draft.persist(path).map_err(|_| "Cannot finalize backup file.")?;
    Ok(true)
}

#[cfg(target_os = "android")]
async fn save_archive(app: tauri::AppHandle, upload: &mut BackupUpload) -> Result<bool, &'static str> {
    let archive = upload.file.path().to_str().ok_or("Invalid backup cache path.")?;
    tauri_plugin_onr_backup::save(&app, &upload.filename, archive, upload.total_bytes).await.map_err(|_| "Cannot save the selected backup.")
}
