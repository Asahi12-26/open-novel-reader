import { invoke, isTauri } from '@tauri-apps/api/core';
import { download } from '../ui/common';

type SaveResult = 'saved' | 'downloaded' | 'cancelled';
type BackupWriter = (archive: Blob) => Promise<SaveResult>;
type BackupWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
    createWritable(): Promise<{ write(blob: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
  }>;
};

const BACKUP_CHUNK_SIZE = 256 * 1024;

async function writeNativeBackup(filename: string, archive: Blob): Promise<SaveResult> {
  const uploadId = await invoke<string>('begin_backup_archive', { filename, totalBytes: archive.size });
  try {
    // Mobile IPC serializes requests as JSON. Bound each conversion so large
    // archives can pass through the bridge without another full archive copy.
    for (let offset = 0; offset < archive.size; offset += BACKUP_CHUNK_SIZE) {
      const bytes = new Uint8Array(await archive.slice(offset, offset + BACKUP_CHUNK_SIZE).arrayBuffer());
      await invoke('append_backup_chunk', { uploadId, offset, bytes });
    }
    const written = await invoke<boolean>('finish_backup_archive', { uploadId });
    return written ? 'saved' : 'cancelled';
  } catch (error) {
    await invoke('abort_backup_archive', { uploadId }).catch(() => {});
    throw error;
  }
}

// Browser save pickers must be opened during the click gesture, before packing the ZIP.
export async function chooseBackupWriter(filename: string): Promise<BackupWriter | undefined> {
  if (isTauri()) return async archive => {
    try { return await writeNativeBackup(filename, archive); }
    catch { throw new Error('无法保存备份。请检查存储空间并换一个可写的位置重试。'); }
  };
  const browser = window as BackupWindow;
  if (!browser.showSaveFilePicker) return async archive => { download(archive, filename); return 'downloaded'; };
  try {
    const file = await browser.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'ZIP 书库备份', accept: { 'application/zip': ['.zip'] } }] });
    return async archive => {
      const output = await file.createWritable();
      try { await output.write(archive); await output.close(); return 'saved'; }
      catch (error) { await output.abort().catch(() => {}); throw error; }
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    // Some installed browser shells expose the picker but deny access.
    if (error instanceof DOMException && error.name === 'SecurityError') return async archive => { download(archive, filename); return 'downloaded'; };
    throw error;
  }
}

export async function matchesBackupFile(savedFile: File, archive: Blob): Promise<boolean> {
  if (savedFile.size !== archive.size) return false;
  const blockSize = 1024 * 1024;
  for (let start = 0; start < archive.size; start += blockSize) {
    const [saved, original] = await Promise.all([
      savedFile.slice(start, start + blockSize).arrayBuffer(), archive.slice(start, start + blockSize).arrayBuffer(),
    ]);
    const bytes = new Uint8Array(original);
    if (!new Uint8Array(saved).every((byte, i) => byte === bytes[i])) return false;
  }
  return true;
}
