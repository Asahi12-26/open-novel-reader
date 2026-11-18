// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { chooseBackupWriter } from './backup-file';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('../ui/common', () => ({ download: vi.fn() }));

const filename = 'open-novel-reader-backup-test.zip';
const chunkSize = 256 * 1024;
const draftId = 'onr-export-staging-test';

describe('native backup IPC', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
  });

  it('sends ordered bounded byte chunks and reports a cancelled save without a second picker', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(draftId)
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    const bytes = new Uint8Array(chunkSize + 4);
    bytes.set([0x50, 0x4b, 3, 4]);
    bytes.set([1, 2, 3, 4], chunkSize);
    const write = await chooseBackupWriter(filename);
    expect(await write?.(new Blob([bytes]))).toBe('cancelled');
    expect(invoke).toHaveBeenNthCalledWith(1, 'begin_backup_archive', { filename, totalBytes: chunkSize + 4 });
    expect(invoke).toHaveBeenNthCalledWith(2, 'append_backup_chunk', {
      uploadId: draftId, offset: 0, bytes: bytes.subarray(0, chunkSize),
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'append_backup_chunk', {
      uploadId: draftId, offset: chunkSize, bytes: Uint8Array.of(1, 2, 3, 4),
    });
    expect(invoke).toHaveBeenNthCalledWith(4, 'finish_backup_archive', { uploadId: draftId });
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it('aborts staging after a failed chunk and leaves the save dialog unopened', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(draftId).mockRejectedValueOnce(new Error('write failed'));
    const write = await chooseBackupWriter(filename);
    await expect(write?.(new Blob([Uint8Array.of(0x50, 0x4b, 3, 4)]))).rejects.toThrow('无法保存备份');
    expect(invoke).toHaveBeenNthCalledWith(3, 'abort_backup_archive', { uploadId: draftId });
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
