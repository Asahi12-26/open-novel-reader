import type { AnalysisJob, Book, BookFile, Bookmark, Bookshelf, Chapter, Character, CharacterCorrection, Dialogue, ReadingProgress } from '../types';
import { db } from './db';
import { MAX_FILE_BYTES, parseEpub, parseTxt } from './parser';

const palette = ['#355e56', '#9e674d', '#4c5978', '#a58a52', '#6d526d', '#627a8e'];

export async function importBook(file: File, beforeExisting?: (book: Book) => Promise<unknown>): Promise<Book> {
  if (!/\.(txt|epub)$/i.test(file.name)) throw new Error('请选择 TXT 或无 DRM 的 EPUB 小说。');
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 80 MB 限制。请拆分后导入。');
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  let existing = await db.books.where('fingerprint').equals(fingerprint).first();
  // Account views can archive their original snapshot before an explicit import
  // revives a tombstone. The parser and stored book IDs remain unchanged.
  if (existing && beforeExisting) { await beforeExisting(existing); existing = await db.books.get(existing.id); }
  if (existing && existing.deletedAt === undefined) {
    // Reimport is also the recovery path for a missing original. Keep all
    // annotations and chapter anchors while restoring only verified bytes.
    if (!(await db.files.get(existing.id))) await db.files.put({ bookId: existing.id, name: file.name, mime: existing.format === 'epub' ? 'application/epub+zip' : 'text/plain', bytes: new Blob([bytes], { type: file.type }) });
    return existing;
  }
  const id = `book-${fingerprint.slice(0, 32)}`;
  const format = /\.epub$/i.test(file.name) ? 'epub' : 'txt';
  const parsed = format === 'epub' ? await parseEpub(bytes, file.name, id) : parseTxt(bytes, file.name, id);
  const now = Date.now();
  const book: Book = {
    id, title: parsed.title, author: parsed.author, language: parsed.language, format,
    fingerprint, totalWords: parsed.totalWords, chapterCount: parsed.chapters.length,
    cover: parsed.cover, coverColor: palette[parseInt(fingerprint.slice(0, 2), 16) % palette.length],
    createdAt: existing?.createdAt || now, updatedAt: now, cloudEnabled: false,
  };
  return db.transaction('rw', [db.books, db.files, db.chapters, db.syncState], async () => {
    // A second import can have finished while the EPUB was being parsed.
    const duplicate = await db.books.get(id);
    if (duplicate && duplicate.deletedAt === undefined) return duplicate;
    const tombstone = duplicate || existing;
    if (tombstone?.deletedAt !== undefined) {
      // Only importing an explicitly deleted local book can revive its cloud
      // tombstone; ordinary metadata edits and first imports never emit this.
      book.restoredAt = Math.max(Date.now(), tombstone.deletedAt + 1, tombstone.restoredAt || 0);
      book.updatedAt = Math.max(book.updatedAt, book.restoredAt);
    }
    await db.books.put(book);
    await db.files.put({ bookId: id, name: file.name, mime: format === 'epub' ? 'application/epub+zip' : 'text/plain', bytes: new Blob([bytes], { type: file.type }) });
    await db.chapters.where('bookId').equals(id).delete();
    await db.chapters.bulkPut(parsed.chapters);
    await db.syncState.put({ id: 'local', updatedAt: now });
    return book;
  });
}

export async function listChapters(bookId: string): Promise<Chapter[]> {
  return db.chapters.where('bookId').equals(bookId).sortBy('index');
}

export async function saveProgress(bookId: string, chapterId: string, paragraphIndex: number, offset = 0): Promise<void> {
  const chapter = await db.chapters.get(chapterId);
  if (!chapter || chapter.bookId !== bookId) throw new Error('无法保存：章节不存在。');
  const index = Math.max(0, Math.min(chapter.paragraphs.length - 1, Math.floor(paragraphIndex) || 0));
  const safeOffset = Math.max(0, Math.min(chapter.paragraphs[index]?.length || 0, Math.floor(offset) || 0));
  await db.transaction('rw', [db.progress, db.syncState], async () => {
    const previous = await db.progress.get(bookId);
    const now = Date.now();
    await db.progress.put({ bookId, chapterId, paragraphIndex: index, offset: safeOffset, updatedAt: now, version: (previous?.version || 0) + 1 });
    await db.syncState.put({ id: 'local', updatedAt: now });
  });
}

/** Retain a dated tombstone so reconnecting devices cannot resurrect a deletion. */
export async function deleteBook(bookId: string): Promise<void> {
  await db.transaction('rw', [db.books, db.syncState], async () => {
    const existing = await db.books.get(bookId);
    const now = Math.max(Date.now(), existing?.deletedAt || 0, existing?.restoredAt || 0);
    await db.books.update(bookId, { deletedAt: now, updatedAt: now });
    await db.syncState.put({ id: 'local', updatedAt: now });
  });
}

interface Backup {
  format: 'open-novel-reader-backup'; version: 1; exportedAt: number;
  books: Book[]; files: { bookId: string; name: string; mime: string; base64: string }[];
  chapters: Chapter[]; progress: ReadingProgress[]; bookmarks: Bookmark[]; shelves: Bookshelf[];
  characters: Character[]; dialogues: Dialogue[]; corrections: CharacterCorrection[]; jobs: AnalysisJob[];
  settings: { id: string; value: unknown }[];
}
function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(chunks.join(''));
}
function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Personal backups contain novels. API keys, auth sessions and arbitrary settings are excluded. */
export async function exportBackup(): Promise<Blob> {
  const snapshot = await db.transaction('r', db.tables, async () => ({
    books: await db.books.toArray(), files: await db.files.toArray(), chapters: await db.chapters.toArray(),
    progress: await db.progress.toArray(), bookmarks: await db.bookmarks.toArray(), shelves: await db.shelves.toArray(),
    characters: await db.characters.toArray(), dialogues: await db.dialogues.toArray(), corrections: await db.corrections.toArray(),
    jobs: await db.jobs.toArray(), settings: (await db.settings.toArray()).filter(setting => setting.id === 'preferences'),
  }));
  const files = await Promise.all(snapshot.files.map(async file => ({ bookId: file.bookId, name: file.name, mime: file.mime, base64: encodeBase64(new Uint8Array(await file.bytes.arrayBuffer())) })));
  const backup: Backup = { ...snapshot, files, format: 'open-novel-reader-backup', version: 1, exportedAt: Date.now() };
  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown, max = 1000): value is string => typeof value === 'string' && value.length <= max;
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const id = (value: unknown): value is string => str(value, 240) && value.length > 0;
const safeCover = (value: unknown): boolean => value === undefined || (str(value, 5 * 1024 * 1024) && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z\d+/=]+$/.test(value));
function invalid(): never { throw new Error('备份格式损坏或版本暂不支持；现有数据未被修改。'); }

function validateBackup(value: unknown): Backup {
  if (!object(value) || value.format !== 'open-novel-reader-backup' || value.version !== 1) invalid();
  const fields = ['books', 'files', 'chapters', 'progress', 'bookmarks', 'shelves', 'characters', 'dialogues', 'corrections', 'jobs', 'settings'] as const;
  for (const key of fields) if (!Array.isArray(value[key]) || value[key].length > 100000) invalid();
  const backup = value as unknown as Backup;
  const bookIds = new Set<string>();
  for (const row of backup.books) {
    if (!object(row) || !id(row.id) || bookIds.has(row.id) || !str(row.title, 300) || !str(row.author, 200) || !str(row.language, 100) || !['txt', 'epub'].includes(row.format) || !/^[a-f\d]{64}$/.test(row.fingerprint) || !/^#[a-f\d]{6}$/i.test(row.coverColor) || !num(row.createdAt) || !num(row.updatedAt) || !num(row.totalWords) || !num(row.chapterCount) || !safeCover(row.cover) || (row.deletedAt !== undefined && !num(row.deletedAt)) || (row.restoredAt !== undefined && (!num(row.restoredAt) || !Number.isSafeInteger(row.restoredAt))) || (row.shelfId !== undefined && !id(row.shelfId))) invalid();
    bookIds.add(row.id);
  }
  const chapterIds = new Set<string>();
  const chapterById = new Map<string, Chapter>();
  for (const row of backup.chapters) {
    if (!object(row) || !id(row.id) || chapterIds.has(row.id) || !bookIds.has(row.bookId) || !num(row.index) || !Number.isInteger(row.index) || !str(row.title, 1000) || !Array.isArray(row.paragraphs) || row.paragraphs.length > 100000 || row.paragraphs.some(text => !str(text, MAX_FILE_BYTES))) invalid();
    chapterIds.add(row.id); chapterById.set(row.id, row);
  }
  for (const row of backup.files) if (!object(row) || !bookIds.has(row.bookId) || !str(row.name) || !str(row.mime) || !str(row.base64, 115 * 1024 * 1024) || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(row.base64)) invalid();
  const locationValid = (row: { bookId: string; chapterId: string; paragraphIndex: number }) => {
    const chapter = chapterById.get(row.chapterId);
    return chapter && chapter.bookId === row.bookId && num(row.paragraphIndex) && Number.isInteger(row.paragraphIndex) && row.paragraphIndex < chapter.paragraphs.length;
  };
  for (const row of backup.progress) if (!object(row) || !locationValid(row) || !num(row.offset) || !num(row.updatedAt) || !num(row.version)) invalid();
  for (const row of backup.bookmarks) if (!object(row) || !id(row.id) || !locationValid(row) || !str(row.label, 2000) || !num(row.createdAt)) invalid();
  for (const row of backup.shelves) if (!object(row) || !id(row.id) || !str(row.name, 200) || !num(row.updatedAt) || (row.deletedAt !== undefined && !num(row.deletedAt))) invalid();
  for (const row of backup.characters) if (!object(row) || !id(row.id) || !bookIds.has(row.bookId) || !str(row.name, 300) || !Array.isArray(row.aliases) || row.aliases.some(name => !str(name, 300))) invalid();
  for (const row of backup.dialogues) if (!object(row) || !id(row.id) || !locationValid(row) || !num(row.start) || !num(row.end) || row.end < row.start || row.end > chapterById.get(row.chapterId)!.paragraphs[row.paragraphIndex].length || !str(row.text, 100000) || !(row.characterId === null || id(row.characterId)) || !num(row.confidence) || row.confidence > 1 || !['ai', 'manual'].includes(row.source) || !num(row.updatedAt)) invalid();
  for (const row of backup.corrections) if (!object(row) || !id(row.id) || !id(row.dialogueId) || !bookIds.has(row.bookId) || !(row.characterId === null || id(row.characterId)) || !num(row.updatedAt)) invalid();
  for (const row of backup.jobs) if (!object(row) || !id(row.id) || !bookIds.has(row.bookId) || !chapterIds.has(row.chapterId) || !['queued', 'running', 'paused', 'done', 'failed', 'cancelled'].includes(row.status) || !num(row.completedChunks) || !num(row.totalChunks) || !num(row.updatedAt)) invalid();
  backup.settings = backup.settings.filter(row => {
    if (!object(row) || row.id !== 'preferences' || !object(row.value)) return false;
    const prefs = row.value;
    return ['light', 'dark', 'sepia'].includes(String(prefs.theme)) && ['serif', 'sans'].includes(String(prefs.fontFamily)) && num(prefs.fontSize) && prefs.fontSize >= 12 && prefs.fontSize <= 48 && num(prefs.lineHeight) && prefs.lineHeight >= 1.2 && prefs.lineHeight <= 3 && num(prefs.readerWidth) && prefs.readerWidth >= 300 && prefs.readerWidth <= 1600 && typeof prefs.showCharacters === 'boolean';
  });
  return backup;
}

/** Validate everything before the transaction; merge into the library without deleting other books. */
export async function restoreBackup(file: File): Promise<void> {
  if (file.size > 256 * 1024 * 1024) throw new Error('备份超过 256 MB。请分批备份或导入原始书籍。');
  let raw: unknown;
  try { raw = JSON.parse(await file.text()); } catch { invalid(); }
  const backup = validateBackup(raw);
  const files: BookFile[] = backup.files.map(row => ({ bookId: row.bookId, name: row.name, mime: row.mime, bytes: new Blob([decodeBase64(row.base64)], { type: row.mime }) }));
  const bookById = new Map(backup.books.map(book => [book.id, book]));
  for (const source of files) {
    if (source.bytes.size > MAX_FILE_BYTES) invalid();
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await source.bytes.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('');
    if (bookById.get(source.bookId)?.fingerprint !== fingerprint) invalid();
  }
  await db.transaction('rw', db.tables, async () => {
    for (const book of backup.books) {
      const existing = await db.books.get(book.id);
      if (!existing || existing.updatedAt <= book.updatedAt) await db.books.put({ ...book, cloudEnabled: false });
    }
    if (files.length) await db.files.bulkPut(files);
    if (backup.chapters.length) await db.chapters.bulkPut(backup.chapters);
    for (const progress of backup.progress) {
      const current = await db.progress.get(progress.bookId);
      if (!current || current.updatedAt <= progress.updatedAt) await db.progress.put(progress);
    }
    for (const bookmark of backup.bookmarks) if (!(await db.bookmarks.get(bookmark.id))) await db.bookmarks.put(bookmark);
    for (const shelf of backup.shelves) {
      const current = await db.shelves.get(shelf.id);
      if (!current || current.updatedAt <= shelf.updatedAt) await db.shelves.put(shelf);
    }
    for (const character of backup.characters) if (!(await db.characters.get(character.id))) await db.characters.put(character);
    for (const dialogue of backup.dialogues) {
      const current = await db.dialogues.get(dialogue.id);
      if (!current || (current.updatedAt <= dialogue.updatedAt && !(current.source === 'manual' && dialogue.source === 'ai'))) await db.dialogues.put(dialogue);
    }
    for (const correction of backup.corrections) {
      const current = await db.corrections.get(correction.id);
      if (!current || current.updatedAt <= correction.updatedAt) await db.corrections.put(correction);
    }
    for (const job of backup.jobs) {
      const current = await db.jobs.get(job.id);
      if (!current || current.updatedAt <= job.updatedAt) await db.jobs.put({ ...job, status: job.status === 'running' ? 'paused' : job.status });
    }
    for (const setting of backup.settings) if (!(await db.settings.get(setting.id))) await db.settings.put(setting);
    await db.syncState.put({ id: 'local', updatedAt: Date.now() });
  });
}

export async function addSampleBook(): Promise<Book> {
  const story = `窗边的书店\n作者：Open Novel Reader\n\n第一章 雨停之前\n\n雨从傍晚下起，沿着玻璃缓缓滑落。街角的书店还亮着一盏灯，像一只没有睡意的眼睛。\n\n林晚推门进来，铃铛轻轻响了一声。她把湿透的伞收好，发现柜台后坐着一位正在修补旧书的老人。\n\n“雨这么大，进来坐一会儿吧。”老人说。\n\n“您还没有打烊吗？”林晚问。\n\n老人笑了笑：“好故事从来不赶时间。”\n\n她挑了一本薄薄的游记，在窗边坐下。纸页带着淡淡的木香，远方的海岸、山谷和城市渐渐从字里行间展开。\n\n第二章 留在页间的光\n\n第二天清晨，林晚又来到书店。路面还留着雨水，天空却已经很亮。\n\n“我想把昨天那本书买下来。”她说。\n\n“你已经读完了吗？”老人把书递给她。\n\n“还没有。我想慢慢读。”\n\n老人点头，在书里放了一张空白书签：“那就给下一次相遇留一个位置。”\n\n林晚走出门时，一束阳光落在封面上。她忽然觉得，一段新的旅程已经开始。\n\nThe End\n\nEvery book leaves a little light between its pages.\n`;
  const book = await importBook(new File([story], '窗边的书店.txt', { type: 'text/plain' }));
  if (book.author === '未知作者') await db.books.update(book.id, { author: 'Open Novel Reader' });
  return book;
}
