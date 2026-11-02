import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeChapter, clearAIKey, correctDialogue, estimateAnalysis, extractDialogues, setAIKey, validateAttributions } from './ai';
import { mergeBundles, selectAccountProfile, validateBundle, type BookBundle } from './cloud';
import { db } from '../core/db';
import type { Book, Chapter } from '../types';

const book: Book = { id: 'test-book', title: 'Test', author: 'Author', format: 'txt', language: 'zh', coverColor: '#123', fingerprint: 'f', totalWords: 10, chapterCount: 1, createdAt: 1, updatedAt: 1, cloudEnabled: true };
const chapter: Chapter = { id: 'test-chapter', bookId: book.id, index: 0, title: '第一章', paragraphs: ['“你好。”小林说。', '“Hello,” Alice said. “Come in.”', "Don't worry, I'll be back."] };
const bundle = (): BookBundle => ({ schema: 1, book: { ...book }, chapters: [chapter], bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [] });
afterEach(async () => {
  clearAIKey(); vi.restoreAllMocks();
  await Promise.all([db.jobs.clear(), db.dialogues.clear(), db.corrections.clear(), db.chapters.clear()]);
});
describe('dialogue and authorization boundaries', () => {
  it('extracts exact Chinese and English offsets without treating apostrophes as dialogue', () => {
    const candidates = extractDialogues(chapter);
    expect(candidates).toHaveLength(3);
    for (const candidate of candidates) expect(chapter.paragraphs[candidate.paragraphIndex].slice(candidate.start, candidate.end)).toBe(candidate.text);
    expect(extractDialogues({ ...chapter, paragraphs: ['张三说：「走吧。」', "'Hello,' she said."] })).toHaveLength(2);
  });
  it('marks missing, invented-id, and low-confidence output as unknown', () => {
    const candidates = extractDialogues(chapter);
    const result = validateAttributions({ dialogues: [{ id: candidates[0].id, speaker: '小林', confidence: 0.9 }, { id: candidates[1].id, speaker: 'Alice', confidence: 0.6 }, { id: 'invented', speaker: 'Bad', confidence: 1 }] }, candidates);
    expect(result.map(r => r.speaker)).toEqual(['小林', null, null]);
  });
  it('rejects analysis before any network call without explicit paid authorization', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    setAIKey('test-key-that-is-never-used');
    const task = analyzeChapter({ bookId: book.id, chapterId: chapter.id, model: 'deepseek-flash', budgetUsd: 0.1, authorized: false as true });
    await expect(task.done).rejects.toThrow('授权');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('estimates a bounded positive cost and no cost for chapters without quotes', () => {
    expect(estimateAnalysis(chapter).estimatedMaxUsd).toBeGreaterThan(0);
    expect(estimateAnalysis(chapter).estimatedMaxUsd).toBeLessThan(0.1);
    expect(estimateAnalysis({ ...chapter, paragraphs: ['纯叙述。'] }).estimatedMaxUsd).toBe(0);
  });
  it('stores manual attribution separately from model data', async () => {
    const candidate = extractDialogues(chapter)[0];
    await db.dialogues.put({ ...candidate, chapterId: chapter.id, bookId: book.id, characterId: null, confidence: 0.2, source: 'ai', updatedAt: 1 });
    await correctDialogue(candidate.id, null);
    expect((await db.corrections.get(`manual:${candidate.id}`))?.characterId).toBeNull();
    expect((await db.dialogues.get(candidate.id))?.source).toBe('manual');
  });
});
describe('three-way cloud merge', () => {
  it('preserves a bookmark added offline and a newer remote reading position', () => {
    const base = bundle(); const local = bundle(); const remote = bundle();
    local.bookmarks.push({ id: 'b', bookId: book.id, chapterId: chapter.id, paragraphIndex: 0, label: 'Hi', createdAt: 2 });
    remote.progress = { bookId: book.id, chapterId: chapter.id, paragraphIndex: 1, offset: 0, updatedAt: 10, version: 2 };
    const result = mergeBundles(local, remote, base);
    expect(result.bookmarks).toHaveLength(1); expect(result.progress?.paragraphIndex).toBe(1);
  });
  it('does not resurrect deleted bookmarks or books from a stale device', () => {
    const base = bundle(); base.bookmarks.push({ id: 'b', bookId: book.id, chapterId: chapter.id, paragraphIndex: 0, label: 'Hi', createdAt: 1 });
    const local = structuredClone(base); const remote = structuredClone(base);
    local.bookmarks = []; local.book.deletedAt = 3; remote.book.updatedAt = 20;
    const result = mergeBundles(local, remote, base);
    expect(result.bookmarks).toEqual([]); expect(result.book.deletedAt).toBe(3);
  });
  it('keeps a manual correction authoritative over a newer remote AI attribution', () => {
    const base = bundle(); const local = bundle(); const remote = bundle();
    const candidate = extractDialogues(chapter)[0];
    local.corrections.push({ id: `manual:${candidate.id}`, dialogueId: candidate.id, bookId: book.id, characterId: null, updatedAt: 5 });
    remote.characters.push({ id: 'ai-person', bookId: book.id, name: 'Guessed', aliases: [] });
    remote.dialogues.push({ ...candidate, bookId: book.id, chapterId: chapter.id, characterId: 'ai-person', confidence: 0.99, source: 'ai', updatedAt: 20 });
    const result = mergeBundles(local, remote, base);
    expect(result.dialogues[0].characterId).toBeNull(); expect(result.dialogues[0].source).toBe('manual');
  });
});
describe('account boundary and incoming cloud data', () => {
  it('does not carry categories/preferences from account A into a new account B', () => {
    const current = { preferences: { theme: 'dark' }, shelves: [{ id: 'private-a', name: 'A private collection', updatedAt: 1 }] };
    const result = selectAccountProfile(current, 'user-a', 'user-b', null, null);
    expect(result.shelves).toEqual([]); expect(result.preferences.theme).toBe('light');
  });
  it('restores only B own stored profile when switching back to B', () => {
    const saved = { preferences: {}, shelves: [{ id: 'b', name: 'B collection', updatedAt: 2 }] };
    expect(selectAccountProfile({ preferences: {}, shelves: [] }, 'user-a', 'user-b', saved, null).shelves[0].id).toBe('b');
  });
  it('rejects a remote progress position outside the original chapter', () => {
    const fingerprint = 'a'.repeat(64); const id = `book-${fingerprint.slice(0, 32)}`;
    const remote = bundle();
    remote.book = { ...book, id, fingerprint, coverColor: '#123456' };
    remote.chapters = [{ ...chapter, id: `${id}:ch:0`, bookId: id }];
    remote.file = { path: `user-a/${id}/original.txt`, name: 'test.txt', mime: 'text/plain' };
    expect(() => validateBundle(remote, id)).not.toThrow();
    remote.progress = { bookId: id, chapterId: `${id}:ch:0`, paragraphIndex: 999, offset: 0, updatedAt: 1, version: 1 };
    expect(() => validateBundle(remote, id)).toThrow('进度');
  });
});
