// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { deleteBook, exportBackup, importBook, listChapters, restoreBackup, saveProgress } from './library';

vi.stubGlobal('File', NodeFile);
vi.stubGlobal('Blob', NodeBlob);
vi.stubGlobal('crypto', webcrypto);

beforeEach(async () => { await db.delete(); await db.open(); });
afterAll(async () => { await db.delete(); });
const novel = () => new File(['第一章 到来\n“你好。”小雨说。\n路边的花开了。\n第二章 归途\n我们一起回家。'], '小雨.txt', { type: 'text/plain' });

describe('local-first persistence', () => {
  it('deduplicates exact files, persists original bytes and stable positions across reopening', async () => {
    const book = await importBook(novel());
    const second = await importBook(novel());
    expect(second.id).toBe(book.id);
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
    expect((await db.books.get(book.id))?.deletedAt).toBeGreaterThan(0);
    const restored = await importBook(novel());
    expect(restored.id).toBe(book.id);
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.cloudEnabled).toBe(false);
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
