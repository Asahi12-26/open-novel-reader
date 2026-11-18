// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { db } from './db';
import { deleteBook, exportBackup, exportZipBackup, importBook, listChapters, restoreBackup, restoreZipBackup, saveProgress } from './library';
import { defaultPreferences } from '../types';
import { seriesBookId } from './series-types';

vi.stubGlobal('File', NodeFile);
vi.stubGlobal('Blob', NodeBlob);
vi.stubGlobal('crypto', webcrypto);

beforeEach(async () => { await db.delete(); await db.open(); });
afterAll(async () => { await db.delete(); });
const novel = () => new File(['第一章 到来\n“你好。”小雨说。\n路边的花开了。\n第二章 归途\n我们一起回家。'], '小雨.txt', { type: 'text/plain' });

describe('local-first persistence', () => {
  it('restores a missing original on explicit reimport without changing reading data', async () => {
    const book = await importBook(novel());
    const chapters = await listChapters(book.id);
    await saveProgress(book.id, chapters[0].id, 1, 2);
    await db.bookmarks.put({ id: 'kept-marker', bookId: book.id, chapterId: chapters[0].id, paragraphIndex: 1, label: '我的停靠点', createdAt: 10 });
    const position = await db.progress.get(book.id);
    await db.files.delete(book.id);
    expect(await importBook(novel())).toEqual(book);
    expect(await (await db.files.get(book.id))!.bytes.text()).toBe(await novel().text());
    expect(await db.progress.get(book.id)).toEqual(position);
    expect(await db.bookmarks.get('kept-marker')).toBeDefined();
    expect(await listChapters(book.id)).toEqual(chapters);
  });
  it('deduplicates exact files, persists original bytes and stable positions across reopening', async () => {
    const book = await importBook(novel());
    const second = await importBook(novel());
    expect(second.id).toBe(book.id);
    expect(book.restoredAt).toBeUndefined();
    expect(second.restoredAt).toBeUndefined();
    expect(await db.books.count()).toBe(1);
    const chapters = await listChapters(book.id);
    await saveProgress(book.id, chapters[0].id, 1, 3);
    db.close(); await db.open();
    expect((await db.files.get(book.id))?.bytes.size).toBe(novel().size);
    expect(await db.progress.get(book.id)).toMatchObject({ chapterId: chapters[0].id, paragraphIndex: 1, offset: 3, version: 1 });
    expect((await listChapters(book.id))[0].paragraphs[0]).toBe('“你好。”小雨说。');
  });

  it('keeps delete tombstones and allows explicit reimport without silently enabling uploads', async () => {
    const book = await importBook(novel());
    await db.books.update(book.id, { cloudEnabled: true });
    await deleteBook(book.id);
    const deletedAt = (await db.books.get(book.id))!.deletedAt!;
    expect(deletedAt).toBeGreaterThan(0);
    const restored = await importBook(novel());
    expect(restored.id).toBe(book.id);
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.cloudEnabled).toBe(false);
    expect(restored.restoredAt).toBeGreaterThan(deletedAt);
    const duplicate = await importBook(novel());
    expect(duplicate.restoredAt).toBe(restored.restoredAt);
  });

  it('makes later explicit deletion win even when an earlier tombstone had a future timestamp', async () => {
    const book = await importBook(novel());
    const futureDeletedAt = Date.now() + 60_000;
    await db.books.update(book.id, { deletedAt: futureDeletedAt, updatedAt: futureDeletedAt });
    const restored = await importBook(novel());
    expect(restored.restoredAt).toBe(futureDeletedAt + 1);
    await deleteBook(book.id);
    const deleted = (await db.books.get(book.id))!;
    expect(deleted.deletedAt).toBeGreaterThanOrEqual(restored.restoredAt!);
    expect(deleted.restoredAt).toBe(restored.restoredAt);
  });

  it('preserves explicit restoration markers through backup and rejects invalid markers atomically', async () => {
    const book = await importBook(novel());
    await deleteBook(book.id);
    const restored = await importBook(novel());
    const backup = await exportBackup();
    const raw = JSON.parse(await backup.text());
    for (const marker of [-1, 1.5, '123', null, Number.MAX_SAFE_INTEGER + 1]) {
      raw.books[0].restoredAt = marker;
      await expect(restoreBackup(new File([JSON.stringify(raw)], 'bad-marker.json'))).rejects.toThrow('未被修改');
      expect((await db.books.get(book.id))!.restoredAt).toBe(restored.restoredAt);
    }
    await db.delete(); await db.open();
    await restoreBackup(new File([backup], 'restored.json'));
    expect((await db.books.get(book.id))!.restoredAt).toBe(restored.restoredAt);
    expect((await db.books.get(book.id))!.cloudEnabled).toBe(false);
  });

  it('round-trips backup bytes and corrections, excludes secrets, and preserves unrelated books', async () => {
    const book = await importBook(novel());
    const chapters = await listChapters(book.id);
    await saveProgress(book.id, chapters[1].id, 0);
    await db.corrections.put({ id: 'correction-1', dialogueId: 'dialogue-1', bookId: book.id, characterId: null, updatedAt: 123 });
    await db.settings.put({ id: 'api-key', value: 'MUST-NOT-EXPORT' });
    const backup = await exportBackup();
    expect(await backup.text()).not.toContain('MUST-NOT-EXPORT');
    const originalBytes = await (await db.files.get(book.id))!.bytes.text();
    await db.delete(); await db.open();
    const unrelated = await importBook(new File(['Chapter One\nA different story.'], 'Other.txt'));
    await restoreBackup(new File([backup], 'reader-backup.json'));
    expect(await db.books.count()).toBe(2);
    expect(await db.books.get(unrelated.id)).toBeDefined();
    expect(await (await db.files.get(book.id))!.bytes.text()).toBe(originalBytes);
    expect((await db.progress.get(book.id))?.chapterId).toBe(chapters[1].id);
    expect((await db.corrections.get('correction-1'))?.characterId).toBeNull();
    expect((await db.books.get(book.id))?.cloudEnabled).toBe(false);
  });

  it('rejects invalid backups before modifying existing data', async () => {
    const book = await importBook(novel());
    const raw = JSON.parse(await (await exportBackup()).text());
    raw.chapters[0].paragraphs = [null];
    raw.books[0].title = 'Corrupted';
    await expect(restoreBackup(new File([JSON.stringify(raw)], 'bad.json'))).rejects.toThrow('未被修改');
    expect((await db.books.get(book.id))?.title).toBe('小雨');
    expect((await listChapters(book.id))[0].paragraphs[0]).toBe('“你好。”小雨说。');
  });

  it('does not replace a current manual correction or newer position with an older backup', async () => {
    const book = await importBook(novel());
    const chapters = await listChapters(book.id);
    await db.dialogues.put({ id: 'dialogue-1', bookId: book.id, chapterId: chapters[0].id, paragraphIndex: 0, start: 0, end: 5, text: '“你好。”', characterId: null, confidence: 0.1, source: 'ai', updatedAt: 1 });
    await saveProgress(book.id, chapters[0].id, 0);
    const backup = await exportBackup();
    await db.dialogues.update('dialogue-1', { source: 'manual', characterId: 'human-character', updatedAt: 100 });
    await db.progress.update(book.id, { chapterId: chapters[1].id, paragraphIndex: 0, updatedAt: Date.now() + 1000 });
    await restoreBackup(new File([backup], 'old.json'));
    expect((await db.dialogues.get('dialogue-1'))?.source).toBe('manual');
    expect((await db.dialogues.get('dialogue-1'))?.characterId).toBe('human-character');
    expect((await db.progress.get(book.id))?.chapterId).toBe(chapters[1].id);
  });
});

describe('portable ZIP backup', () => {
  it('writes original bytes separately and restores reading data, summaries, plot events and a local series', async () => {
    const book = await importBook(novel());
    const [chapter] = await listChapters(book.id);
    const text = chapter.paragraphs[0];
    const end = { chapterIndex: 0, paragraphIndex: 0, offset: text.length };
    const evidence = { chapterId: chapter.id, paragraphIndex: 0, start: 0, end: text.length, text };
    const seriesId = '387e92d7-6f31-438c-bcea-2305ebf4b665';
    await saveProgress(book.id, chapter.id, 0, 2);
    await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, theme: 'dark', privateToken: 'DO-NOT-ARCHIVE-TOKEN' } });
    await db.settings.put({ id: 'book-analysis-budget:example', value: 'DO-NOT-ARCHIVE-LEDGER' });
    await db.series.put({ id: seriesId, name: '测试系列', scope: 'local', updatedAt: 1 });
    await db.seriesBooks.put({ id: seriesBookId(seriesId, book.id), seriesId, bookId: book.id, scope: 'local', position: 0, updatedAt: 2 });
    await db.plotEvents.put({ id: 'plot-1', bookId: book.id, chapterId: chapter.id, seriesId,
      order: { ...end, offset: 0 }, revisions: [{ id: 'note-1', description: '小雨在打招呼', evidence, visibleAt: end, characterIds: [], confidence: .95, status: 'active', kind: 'fact', source: 'ai', updatedAt: 3 }] });
    await db.chapterSummaries.put({ chapterId: chapter.id, bookId: book.id,
      fragments: [{ id: 'fragment-1', from: { ...end, offset: 0 }, through: end, text: '相遇', evidence: [evidence], characterIds: [], model: 'fixture', updatedAt: 4 }], revisions: [] });
    const archive = await exportZipBackup();
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(['files/0.bin', 'manifest.json']);
    const manifest = await zip.file('manifest.json')!.async('text');
    expect(manifest).not.toMatch(/DO-NOT-ARCHIVE|base64/);
    expect(await zip.file('files/0.bin')!.async('text')).toBe(await novel().text());
    await db.delete(); await db.open();
    await restoreZipBackup(new File([archive], 'local-backup.zip'), { mode: 'merge' });
    expect(await db.books.get(book.id)).toMatchObject({ id: book.id, cloudEnabled: false });
    expect(await db.progress.get(book.id)).toMatchObject({ chapterId: chapter.id, offset: 2 });
    expect(await db.settings.get('preferences')).toMatchObject({ value: { theme: 'dark' } });
    expect(await db.seriesBooks.get(seriesBookId(seriesId, book.id))).toBeDefined();
    expect(await db.plotEvents.get('plot-1')).toMatchObject({ bookId: book.id });
    expect((await db.chapterSummaries.get(chapter.id))?.fragments[0].text).toBe('相遇');
  });

  it('replaces only device-local books and keeps live owner data and preferences unchanged', async () => {
    const saved = await importBook(novel());
    const cloud = await importBook(new File(['Chapter One\nOwner-owned original.'], 'Cloud.txt'));
    await db.settings.put({ id: `cloud-owner:${cloud.id}`, value: 'https://test.example|owner' });
    await db.books.update(cloud.id, { cloudEnabled: true });
    const backup = await exportZipBackup();
    const newLocal = await importBook(new File(['Chapter One\nOnly on this device since the backup.'], 'New.txt'));
    await db.books.update(cloud.id, { title: 'Updated private title' });
    await db.books.update(saved.id, { title: 'Changed local title' });
    await db.settings.put({ id: 'cloud-profile-owner', value: 'https://test.example|owner' });
    await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, theme: 'sepia' } });
    await restoreZipBackup(new File([backup], 'local-backup.zip'), { mode: 'replace' });
    expect(await db.books.get(newLocal.id)).toBeUndefined();
    expect(await db.files.get(newLocal.id)).toBeUndefined();
    expect(await listChapters(newLocal.id)).toEqual([]);
    expect(await db.books.get(saved.id)).toMatchObject({ title: saved.title, cloudEnabled: false });
    expect(await db.books.get(cloud.id)).toMatchObject({ title: 'Updated private title', cloudEnabled: true });
    expect(await db.settings.get(`cloud-owner:${cloud.id}`)).toMatchObject({ value: 'https://test.example|owner' });
    expect(await db.settings.get('preferences')).toMatchObject({ value: { theme: 'sepia' } });
  });

  it('rejects unexpected entries, missing original, CRC damage or a corrupt legacy JSON replacement atomically', async () => {
    const original = await importBook(novel());
    const backup = await exportZipBackup();
    const bytes = await backup.arrayBuffer();
    const file = (value: BlobPart) => new File([value], 'backup.zip');
    const bad = new JSZip();
    bad.file('../extra.txt', 'unexpected', { createFolders: false });
    await expect(restoreZipBackup(file(await bad.generateAsync({ type: 'arraybuffer' })), { mode: 'replace' })).rejects.toThrow('未被修改');

    const missing = await JSZip.loadAsync(bytes);
    missing.remove('files/0.bin');
    await expect(restoreZipBackup(file(await missing.generateAsync({ type: 'arraybuffer' })), { mode: 'replace' })).rejects.toThrow('未被修改');

    const corrupt = new Uint8Array(bytes.slice(0));
    const header = new DataView(corrupt.buffer);
    const firstPayload = 30 + header.getUint16(26, true);
    corrupt[firstPayload] ^= 1;
    await expect(restoreZipBackup(file(corrupt), { mode: 'replace' })).rejects.toThrow('未被修改');

    await expect(restoreZipBackup(new File([await exportBackup()], 'legacy.json'), { mode: 'replace' })).rejects.toThrow('只能合并');
    expect(await db.books.get(original.id)).toEqual(original);
    expect(await (await db.files.get(original.id))!.bytes.text()).toBe(await novel().text());
  });
});
