import type { AnalysisJob, AvatarRevision, Book, BookFile, Bookmark, Bookshelf, Chapter, Character, CharacterAvatar, CharacterCorrection, Dialogue, ReadingProgress } from '../types';
import { db } from './db';
import { MAX_AVATAR_BYTES, validAvatarRevision, validateAvatarImage } from './avatar';
import { bookAccountScope, bookOwnerKey, bookOwnerScope } from './book-owner';
import { MAX_FILE_BYTES, parseEpub, parseTxt } from './parser';
import { mergeCharacterIdentity, validCharacterIdentity, validIdentityGraph } from '../services/character-identity';
import { installBookStory, readBookStory, rebindStoryScope, validateBookStory, type BookStoryData } from './story-data';
import { chooseSeriesRecord, isSeries, type Series } from './series-types';
import { invalidBackup, MAX_BACKUP_BYTES, originalEntry, portraitEntry, readBackupArchive, writeBackupArchive, type ArchiveAsset } from './backup-archive';

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
  format: 'open-novel-reader-backup' | 'open-novel-reader-zip'; version: 1; exportedAt: number;
  books: Book[]; files: Array<Omit<BookFile, 'bytes'> & { base64?: string; entry?: string }>;
  chapters: Chapter[]; progress: ReadingProgress[]; bookmarks: Bookmark[]; shelves: Bookshelf[];
  characters: Character[]; dialogues: Dialogue[]; corrections: CharacterCorrection[]; jobs: AnalysisJob[];
  avatars?: Array<AvatarRevision & { base64?: string; entry?: string }>;
  stories?: { bookId: string; data: BookStoryData }[];
  series?: Series[];
  settings: { id: string; value: unknown }[];
}
export interface BackupAccount {
  origin: string;
  userId?: string;
  assertCurrent?: () => void;
}

async function accessibleBackupBooks(books: Book[], account?: BackupAccount) {
  account?.assertCurrent?.();
  if (!account?.userId) return books;
  const scope = bookAccountScope(account.origin, account.userId);
  const owners = await db.settings.bulkGet(books.map(book => bookOwnerKey(book.id)));
  return books.filter((_book, index) => {
    const owner = bookOwnerScope(owners[index]?.value, account.origin);
    return !owner || owner === scope;
  });
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

function readBackupSnapshot(account?: BackupAccount, includeLocalSeries = false) {
  return db.transaction('r', db.tables, async () => {
    const books = await accessibleBackupBooks(await db.books.toArray(), account);
    const bookIds = new Set(books.map(book => book.id));
    const bookData = <T extends { bookId: string }>(rows: T[]) => rows.filter(row => bookIds.has(row.bookId));
    const characters = bookData(await db.characters.toArray());
    const characterIds = new Set(characters.map(character => character.id));
    const seriesScope = account?.userId ? bookAccountScope(account.origin, account.userId) : 'local';
    const scopes = includeLocalSeries && seriesScope !== 'local' ? ['local', seriesScope] : [seriesScope];
    const series = (await db.series.where('scope').anyOf(scopes).toArray()).map(row => ({ ...row, scope: 'local' }));
    const owners = includeLocalSeries ? await db.settings.bulkGet(books.map(book => bookOwnerKey(book.id))) : [];
    const characterByBook = new Map<string, Set<string>>();
    for (const character of characters) {
      const ids = characterByBook.get(character.bookId) ?? new Set<string>();
      ids.add(character.id);
      characterByBook.set(character.bookId, ids);
    }
    const stories: NonNullable<Backup['stories']> = [];
    for (const [index, book] of books.entries()) {
      if (book.deletedAt) continue;
      const scope = includeLocalSeries && !owners[index] ? 'local' : seriesScope;
      const data = await readBookStory(book.id, scope, characterByBook.get(book.id) ?? new Set<string>());
      if (data) stories.push({ bookId: book.id, data: rebindStoryScope(data, 'local') });
    }
    const settings = backupPreferences((await db.settings.get('preferences'))?.value);
    return {
      books, files: bookData(await db.files.toArray()), chapters: bookData(await db.chapters.toArray()),
      progress: bookData(await db.progress.toArray()), bookmarks: bookData(await db.bookmarks.toArray()), shelves: await db.shelves.toArray(),
      characters, dialogues: bookData(await db.dialogues.toArray()), corrections: bookData(await db.corrections.toArray()),
      avatars: bookData(await db.avatars.toArray()).filter(row => characterIds.has(row.characterId)),
      jobs: bookData(await db.jobs.toArray()), settings: settings ? [{ id: 'preferences', value: settings }] : [], series, stories,
    };
  });
}
/** Personal backups contain novels. API keys, auth sessions and arbitrary settings are excluded. */
export async function exportBackup(account?: BackupAccount): Promise<Blob> {
  const snapshot = await readBackupSnapshot(account);
  const files = await Promise.all(snapshot.files.map(async file => ({ bookId: file.bookId, name: file.name, mime: file.mime, base64: encodeBase64(new Uint8Array(await file.bytes.arrayBuffer())) })));
  const avatars = await Promise.all(snapshot.avatars.map(async ({ characterId, bookId, updatedAt, revision, digest, image }) => ({
    characterId, bookId, updatedAt, revision,
    ...(image && digest ? { digest, base64: encodeBase64(new Uint8Array(await image.arrayBuffer())) } : {}),
  })));
  const backup: Backup = { ...snapshot, files, avatars, format: 'open-novel-reader-backup', version: 1, exportedAt: Date.now() };
  account?.assertCurrent?.();
  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

export async function exportZipBackup(account?: BackupAccount): Promise<Blob> {
  const snapshot = await readBackupSnapshot(account, true);
  const assets: ArchiveAsset[] = [];
  const files = snapshot.files.map(({ bytes, ...file }, index) => {
    const entry = originalEntry(index);
    assets.push({ path: entry, bytes });
    return { ...file, entry };
  });
  const avatars = snapshot.avatars.map(({ image, digest, ...avatar }, index) => {
    if (!image || !digest) return avatar;
    const entry = portraitEntry(index);
    assets.push({ path: entry, bytes: image });
    return { ...avatar, digest, entry };
  });
  const includedFiles = new Set(files.map(file => file.bookId));
  if (snapshot.books.some(book => !book.deletedAt && !includedFiles.has(book.id))) {
    throw new Error('本机有书籍缺少原文件。请从原小说重新导入后再备份，现有阅读数据已保留。');
  }
  const metadata: Backup = { ...snapshot, files, avatars, format: 'open-novel-reader-zip', version: 1, exportedAt: Date.now() };
  validateBackup(metadata, new Set(assets.map(item => item.path)));
  const archive = await writeBackupArchive(metadata, assets);
  account?.assertCurrent?.();
  return archive;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown, max = 1000): value is string => typeof value === 'string' && value.length <= max;
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const id = (value: unknown): value is string => str(value, 240) && value.length > 0;
const safeCover = (value: unknown): boolean => value === undefined || (str(value, 5 * 1024 * 1024) && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z\d+/=]+$/.test(value));
const invalid: () => never = invalidBackup;
function backupPreferences(value: unknown) {
  if (!object(value)) return;
  const { theme, fontFamily, fontSize, lineHeight, readerWidth, showCharacters, showAvatars } = value;
  if (!['light', 'dark', 'sepia'].includes(String(theme)) || !['serif', 'sans'].includes(String(fontFamily)) ||
      !num(fontSize) || fontSize < 12 || fontSize > 48 || !num(lineHeight) || lineHeight < 1.2 || lineHeight > 3 ||
      !num(readerWidth) || readerWidth < 300 || readerWidth > 1600 || typeof showCharacters !== 'boolean' ||
      (showAvatars !== undefined && typeof showAvatars !== 'boolean')) return;
  return { theme, fontFamily, fontSize, lineHeight, readerWidth, showCharacters, ...(showAvatars === undefined ? {} : { showAvatars }) };
}

function validateBackup(value: unknown, entries?: ReadonlySet<string>): Backup {
  if (!object(value) || value.format !== (entries ? 'open-novel-reader-zip' : 'open-novel-reader-backup') || value.version !== 1) invalid();
  const fields = ['books', 'files', 'chapters', 'progress', 'bookmarks', 'shelves', 'characters', 'dialogues', 'corrections', 'jobs', 'settings'] as const;
  for (const key of fields) if (!Array.isArray(value[key]) || value[key].length > 100000) invalid();
  if (entries && (!Number.isSafeInteger(value.exportedAt) || Object.keys(value).some(key =>
    ![...fields, 'avatars', 'stories', 'series', 'format', 'version', 'exportedAt'].some(field => field === key)))) invalid();
  const backup = value as unknown as Backup;
  const bookIds = new Set<string>();
  for (const row of backup.books) {
    if (!object(row) || !id(row.id) || bookIds.has(row.id) || !str(row.title, 300) || !str(row.author, 200) || !str(row.language, 100) || !['txt', 'epub'].includes(row.format) || !/^[a-f\d]{64}$/.test(row.fingerprint) || !/^#[a-f\d]{6}$/i.test(row.coverColor) || !num(row.createdAt) || !num(row.updatedAt) || !num(row.totalWords) || !num(row.chapterCount) || !safeCover(row.cover) || (row.deletedAt !== undefined && !num(row.deletedAt)) || (row.restoredAt !== undefined && (!num(row.restoredAt) || !Number.isSafeInteger(row.restoredAt))) || (row.shelfId !== undefined && !id(row.shelfId))) invalid();
    bookIds.add(row.id);
    if (entries && (row.id !== `book-${row.fingerprint.slice(0, 32)}` || typeof row.cloudEnabled !== 'boolean' || !Number.isSafeInteger(row.chapterCount))) invalid();
  }
  const chapterIds = new Set<string>();
  const chapterById = new Map<string, Chapter>();
  for (const row of backup.chapters) {
    if (!object(row) || !id(row.id) || chapterIds.has(row.id) || !bookIds.has(row.bookId) || !num(row.index) || !Number.isInteger(row.index) || !str(row.title, 1000) || !Array.isArray(row.paragraphs) || row.paragraphs.length > 100000 || row.paragraphs.some(text => !str(text, MAX_FILE_BYTES))) invalid();
    chapterIds.add(row.id); chapterById.set(row.id, row);
  }
  const referred = new Set<string>();
  const originals = new Set<string>();
  const asset = (row: { entry?: string; base64?: string }, path: string, maxBase64: number) => {
    if (entries) {
      if (row.entry !== path || row.base64 !== undefined || !entries.has(path)) invalid();
      referred.add(path);
    } else if (!str(row.base64, maxBase64) || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(row.base64)) invalid();
  };
  for (const [index, row] of backup.files.entries()) {
    if (!object(row) || !bookIds.has(row.bookId) || !str(row.name) || !str(row.mime, 200) || originals.has(row.bookId)) invalid();
    asset(row, originalEntry(index), 115 * 1024 * 1024);
    originals.add(row.bookId);
  }
  if (entries && backup.books.some(book => !book.deletedAt && !originals.has(book.id))) invalid();
  const locationValid = (row: { bookId: string; chapterId: string; paragraphIndex: number }) => {
    const chapter = chapterById.get(row.chapterId);
    return chapter && chapter.bookId === row.bookId && num(row.paragraphIndex) && Number.isInteger(row.paragraphIndex) && row.paragraphIndex < chapter.paragraphs.length;
  };
  for (const row of backup.progress) if (!object(row) || !locationValid(row) || !num(row.offset) || !num(row.updatedAt) || !num(row.version)) invalid();
  for (const row of backup.bookmarks) if (!object(row) || !id(row.id) || !locationValid(row) || !str(row.label, 2000) || !num(row.createdAt)) invalid();
  for (const row of backup.shelves) if (!object(row) || !id(row.id) || !str(row.name, 200) || !num(row.updatedAt) || (row.deletedAt !== undefined && !num(row.deletedAt))) invalid();
  for (const row of backup.characters) if (!object(row) || !id(row.id) || !bookIds.has(row.bookId) || !str(row.name, 300) || !Array.isArray(row.aliases) || row.aliases.some(name => !str(name, 300)) || !validCharacterIdentity(row.identity)) invalid();
  if (new Set(backup.characters.map(row => row.id)).size !== backup.characters.length || !validIdentityGraph(backup.characters, backup.chapters)) invalid();
  if (backup.avatars !== undefined) {
    if (!Array.isArray(backup.avatars) || backup.avatars.length > backup.characters.length) invalid();
    const owners = new Map(backup.characters.map(row => [row.id, row.bookId]));
    const seen = new Set<string>();
    for (const [index, row] of backup.avatars.entries()) {
      if (!validAvatarRevision(row) || owners.get(row.characterId) !== row.bookId || seen.has(row.characterId)) invalid();
      if (row.digest !== undefined) asset(row, portraitEntry(index), 4 * Math.ceil(MAX_AVATAR_BYTES / 3));
      else if (row.base64 !== undefined || row.entry !== undefined) invalid();
      seen.add(row.characterId);
    }
  }
  if (entries && referred.size !== entries.size) invalid();
  for (const row of backup.dialogues) if (!object(row) || !id(row.id) || !locationValid(row) || !num(row.start) || !num(row.end) || row.end < row.start || row.end > chapterById.get(row.chapterId)!.paragraphs[row.paragraphIndex].length || !str(row.text, 100000) || !(row.characterId === null || id(row.characterId)) || !num(row.confidence) || row.confidence > 1 || !['ai', 'manual'].includes(row.source) || !num(row.updatedAt) || (row.speakerLabel !== undefined && !str(row.speakerLabel, 80))) invalid();
  for (const row of backup.corrections) if (!object(row) || !id(row.id) || !id(row.dialogueId) || !bookIds.has(row.bookId) || !(row.characterId === null || id(row.characterId)) || !num(row.updatedAt)) invalid();
  for (const row of backup.jobs) if (!object(row) || !id(row.id) || !bookIds.has(row.bookId) || !chapterIds.has(row.chapterId) || !['queued', 'running', 'paused', 'done', 'failed', 'cancelled'].includes(row.status) || !num(row.completedChunks) || !num(row.totalChunks) || !num(row.updatedAt)) invalid();
  const chaptersByBook = new Map<string, Chapter[]>();
  const characterBook = new Map(backup.characters.map(character => [character.id, character.bookId]));
  const dialogueBook = new Map(backup.dialogues.map(dialogue => [dialogue.id, dialogue.bookId]));
  for (const row of backup.chapters) {
    const group = chaptersByBook.get(row.bookId) || [];
    group.push(row); chaptersByBook.set(row.bookId, group);
  }
  const sameBookPerson = (id: string | null, bookId: string) => id === null || characterBook.get(id) === bookId;
  if (entries && (
    backup.books.some(book => {
      const chapters = (chaptersByBook.get(book.id) || []).sort((left, right) => left.index - right.index);
      return (!book.deletedAt && chapters.length !== book.chapterCount) ||
        chapters.some((chapter, index) => chapter.index !== index || chapter.id !== `${book.id}:ch:${index}`);
    }) || backup.progress.some(row => !Number.isSafeInteger(row.offset) || row.offset > chapterById.get(row.chapterId)!.paragraphs[row.paragraphIndex].length) ||
    backup.dialogues.some(row => !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) ||
      chapterById.get(row.chapterId)!.paragraphs[row.paragraphIndex].slice(row.start, row.end) !== row.text || !sameBookPerson(row.characterId, row.bookId) ||
      (row.possibleCharacterIds !== undefined && (!Array.isArray(row.possibleCharacterIds) || row.possibleCharacterIds.some(id => characterBook.get(id) !== row.bookId)))) ||
    backup.corrections.some(row => dialogueBook.get(row.dialogueId) !== row.bookId || !sameBookPerson(row.characterId, row.bookId)) ||
    backup.jobs.some(row => chapterById.get(row.chapterId)?.bookId !== row.bookId || row.completedChunks > row.totalChunks) ||
    new Set(backup.progress.map(row => row.bookId)).size !== backup.progress.length ||
    [backup.bookmarks, backup.dialogues, backup.corrections, backup.jobs, backup.shelves].some(rows => new Set(rows.map(row => row.id)).size !== rows.length)
  )) invalid();
  if (backup.series !== undefined && (
    !Array.isArray(backup.series) || backup.series.length > 5000 ||
    !backup.series.every(value => isSeries(value) && value.scope === 'local') ||
    new Set(backup.series.map(value => value.id)).size !== backup.series.length
  )) invalid();
  if (backup.stories !== undefined) {
    if (!Array.isArray(backup.stories) || backup.stories.length > backup.books.length) invalid();
    const seen = new Set<string>();
    const books = new Map(backup.books.map(book => [book.id, book]));
    const group = <T extends { bookId: string }>(rows: T[]) => {
      const grouped = new Map<string, T[]>();
      for (const value of rows) {
        const items = grouped.get(value.bookId) ?? [];
        items.push(value);
        grouped.set(value.bookId, items);
      }
      return grouped;
    };
    const chapters = chaptersByBook;
    const characters = group(backup.characters);
    const dialogues = group(backup.dialogues);
    for (const row of backup.stories) {
      if (!object(row) || !id(row.bookId) || seen.has(row.bookId) || !books.has(row.bookId) ||
        !validateBookStory(row.data, books.get(row.bookId)!, chapters.get(row.bookId) || [], characters.get(row.bookId) || [], dialogues.get(row.bookId) || [], 'local')) invalid();
      seen.add(row.bookId);
    }
  }
  backup.settings = backup.settings.flatMap(row => {
    const value = object(row) && row.id === 'preferences' ? backupPreferences(row.value) : undefined;
    return value ? [{ id: 'preferences', value }] : [];
  });
  return backup;
}

type RestoreMode = 'merge' | 'replace';
type AssetReader = (path: string, mime: string) => Promise<Blob>;

/** Old JSON archives remain readable as merges. */
export async function restoreBackup(file: File, account?: BackupAccount): Promise<void> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('备份超过 256 MiB，现有数据未被修改。');
  let raw: unknown;
  try { raw = JSON.parse(await file.text()); } catch { invalid(); }
  return restoreValidatedBackup(validateBackup(raw), 'merge', account);
}

export async function restoreZipBackup(file: File, { mode, account }: { mode: RestoreMode; account?: BackupAccount }): Promise<void> {
  if (mode !== 'merge' && mode !== 'replace') throw new Error('请选择备份恢复方式，现有数据未被修改。');
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
    if (mode === 'replace') throw new Error('旧版 JSON 只能合并恢复，请选择有效的阅见 ZIP 备份。现有数据未被修改。');
    return restoreBackup(file, account);
  }
  const archive = await readBackupArchive(file);
  return restoreValidatedBackup(validateBackup(archive.manifest, archive.names), mode, account, archive.read);
}

async function deleteLocalLibrary(bookIds: string[], removeLocalProfile: boolean) {
  if (bookIds.length) {
    for (const table of [
      db.files, db.chapters, db.progress, db.bookmarks, db.characters, db.dialogues, db.corrections, db.jobs,
      db.avatars, db.plotEvents, db.chapterSummaries, db.dialogueCorrectionRevisions,
    ]) await table.where('bookId').anyOf(bookIds).delete();
    for (const table of [db.seriesBooks, db.seriesCharacterLinks]) {
      await table.where('bookId').anyOf(bookIds).and(row => row.scope === 'local').delete();
    }
    await db.books.bulkDelete(bookIds);
    const session = await db.settings.get('readerSession');
    if (typeof session?.value === 'string' && bookIds.includes(session.value)) await db.settings.delete('readerSession');
  }
  const localSeries = await db.series.where('scope').equals('local').primaryKeys();
  const stillUsed = new Set((await db.seriesBooks.where('scope').equals('local').toArray()).map(row => row.seriesId));
  const unused = localSeries.filter(id => !stillUsed.has(id));
  if (unused.length) {
    await db.seriesCharacters.where('seriesId').anyOf(unused).and(row => row.scope === 'local').delete();
    await db.series.bulkDelete(unused);
  }
  if (removeLocalProfile) {
    await db.shelves.bulkDelete(await db.shelves.toCollection().primaryKeys());
    await db.settings.delete('preferences');
  }
}

async function restoreValidatedBackup(backup: Backup, mode: RestoreMode, account?: BackupAccount, readAsset?: AssetReader) {
  const asset = async ({ entry, base64 }: { entry?: string; base64?: string }, mime: string) =>
    readAsset ? readAsset(entry!, mime) : new Blob([decodeBase64(base64!)], { type: mime });
  const files: BookFile[] = [];
  for (const source of backup.files) {
    const { bookId, name, mime } = source;
    files.push({ bookId, name, mime, bytes: await asset(source, mime) });
  }
  const bookById = new Map(backup.books.map(book => [book.id, book]));
  const chaptersByBook = new Map<string, Chapter[]>();
  if (readAsset) for (const chapter of backup.chapters) {
    const rows = chaptersByBook.get(chapter.bookId) ?? [];
    rows.push(chapter); chaptersByBook.set(chapter.bookId, rows);
  }
  for (const source of files) {
    if (source.bytes.size > MAX_FILE_BYTES) invalid();
    const bytes = await source.bytes.arrayBuffer();
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    const book = bookById.get(source.bookId);
    if (!book || book.fingerprint !== fingerprint) invalid();
    if (readAsset && !book.deletedAt) {
      try {
        const parsed = book.format === 'epub' ? await parseEpub(bytes, source.name, source.bookId) : parseTxt(bytes, source.name, source.bookId);
        const stored = (chaptersByBook.get(source.bookId) || []).sort((a, b) => a.index - b.index);
        const text = (chapters: Chapter[]) => chapters.map(({ title, paragraphs }) => [title, paragraphs]);
        if (JSON.stringify(text(parsed.chapters)) !== JSON.stringify(text(stored))) invalid();
      } catch { invalid(); }
    }
  }
  const avatars: CharacterAvatar[] = [];
  for (const source of backup.avatars ?? []) {
    const { characterId, bookId, updatedAt, revision, digest } = source;
    const row = { characterId, bookId, updatedAt, revision };
    if (digest) {
      const image = await asset(source, 'image/png');
      try { if (await validateAvatarImage(image) !== digest) invalid(); } catch { invalid(); }
      avatars.push({ ...row, image, digest });
    } else avatars.push(row);
  }
  await db.transaction('rw', db.tables, async () => {
    if ((await accessibleBackupBooks(backup.books, account)).length !== backup.books.length) {
      throw new Error('备份包含本机另一账号拥有的书籍。请切回原账号恢复。现有数据未被修改。');
    }
    const currentBooks = await db.books.toArray();
    const owners = await db.settings.bulkGet(currentBooks.map(book => bookOwnerKey(book.id)));
    const protectedIds = new Set(currentBooks.filter((book, index) => book.cloudEnabled || !!owners[index]?.value).map(book => book.id));
    const profileBound = !!account?.userId || !!(await db.settings.get('cloud-profile-owner'))?.value;
    const localRows = <T extends { bookId: string }>(rows: T[]) => rows.filter(row => !protectedIds.has(row.bookId));
    const chapterRows = localRows(backup.chapters);
    const characterRows = localRows(backup.characters);
    const avatarRows = localRows(avatars);
    const seriesScope = 'local';
    const localBackupBooks = backup.books.filter(book => !protectedIds.has(book.id));
    // Verify key collisions against the live library before replacing any rows.
    for (const [table, rows] of [
      [db.chapters, chapterRows], [db.bookmarks, localRows(backup.bookmarks)], [db.characters, characterRows],
      [db.dialogues, localRows(backup.dialogues)], [db.corrections, localRows(backup.corrections)], [db.jobs, localRows(backup.jobs)],
    ] as const) {
      const existing = await table.bulkGet(rows.map(row => row.id));
      if (existing.some((row, index) => row && row.bookId !== rows[index].bookId)) invalid();
    }
    const currentFingerprints = new Map(currentBooks.map(book => [book.id, book.fingerprint]));
    if (localBackupBooks.some(book => currentFingerprints.has(book.id) && currentFingerprints.get(book.id) !== book.fingerprint)) invalid();
    if (mode === 'replace') await deleteLocalLibrary(currentBooks.filter(book => !protectedIds.has(book.id)).map(book => book.id), !profileBound);
    for (const book of localBackupBooks) {
      const existing = await db.books.get(book.id);
      if (!existing || (existing.updatedAt <= book.updatedAt && (!book.deletedAt || existing.deletedAt))) await db.books.put({ ...book, cloudEnabled: false });
    }
    if (files.length) await db.files.bulkPut(localRows(files));
    if (chapterRows.length) await db.chapters.bulkPut(chapterRows);
    for (const progress of localRows(backup.progress)) {
      const current = await db.progress.get(progress.bookId);
      if (!current || current.updatedAt <= progress.updatedAt) await db.progress.put(progress);
    }
    for (const bookmark of localRows(backup.bookmarks)) if (!(await db.bookmarks.get(bookmark.id))) await db.bookmarks.put(bookmark);
    for (const shelf of profileBound ? [] : backup.shelves) {
      const current = await db.shelves.get(shelf.id);
      if (!current || current.updatedAt <= shelf.updatedAt) await db.shelves.put(shelf);
    }
    if (characterRows.length) {
      const affectedBookIds = [...new Set(characterRows.map(character => character.bookId))];
      const [existingRows, currentRows, chapters] = await Promise.all([
        db.characters.where('bookId').anyOf(affectedBookIds).toArray(),
        db.characters.bulkGet(characterRows.map(character => character.id)),
        db.chapters.where('bookId').anyOf(affectedBookIds).toArray(),
      ]);
      const mergedCharacters = new Map(existingRows.map(character => [character.id, character]));
      const changed = characterRows.map((character, index) => {
        const current = currentRows[index];
        if (current && current.bookId !== character.bookId) invalid();
        const merged = current ? mergeCharacterIdentity(current, character) : character;
        mergedCharacters.set(merged.id, merged);
        return merged;
      });
      if (!validIdentityGraph([...mergedCharacters.values()], chapters)) invalid();
      await db.characters.bulkPut(changed);
    }
    // A backup can fill a missing avatar. Preserve an existing image or intentional reset.
    if (avatarRows.length) {
      const current = await db.avatars.bulkGet(avatarRows.map(row => row.characterId));
      if (current.some((row, index) => row && row.bookId !== avatarRows[index].bookId)) invalid();
      await db.avatars.bulkPut(avatarRows.filter((_, index) => !current[index]));
    }
    for (const dialogue of localRows(backup.dialogues)) {
      const current = await db.dialogues.get(dialogue.id);
      if (!current || (current.source !== 'manual' && (dialogue.source === 'manual' || current.updatedAt <= dialogue.updatedAt))) await db.dialogues.put(dialogue);
    }
    for (const correction of localRows(backup.corrections)) {
      const current = await db.corrections.get(correction.id);
      if (!current) await db.corrections.put(correction);
    }
    for (const job of localRows(backup.jobs)) {
      const current = await db.jobs.get(job.id);
      if (!current || current.updatedAt <= job.updatedAt) await db.jobs.put({ ...job, status: job.status === 'running' ? 'paused' : job.status });
    }
    for (const row of backup.series ?? []) {
      const existing = await db.series.get(row.id);
      if (existing && existing.scope !== seriesScope) continue;
      const next = { ...row, scope: seriesScope };
      await db.series.put(existing ? chooseSeriesRecord(existing, next) : next);
    }
    for (const { bookId, data } of localRows(backup.stories ?? [])) {
      const book = await db.books.get(bookId);
      if (!book || book.deletedAt) continue;
      const existing = await db.series.bulkGet(data.series.map(row => row.id));
      const collisions = new Set(data.series.filter((_, index) => existing[index] && existing[index]!.scope !== seriesScope).map(row => row.id));
      await installBookStory(bookId, rebindStoryScope({
        ...data, series: data.series.filter(row => !collisions.has(row.id)), memberships: data.memberships.filter(row => !collisions.has(row.seriesId)),
        people: data.people.filter(row => !collisions.has(row.seriesId)), links: data.links.filter(row => !collisions.has(row.seriesId)),
      }, seriesScope));
    }
    for (const setting of profileBound ? [] : backup.settings) if (!(await db.settings.get(setting.id))) await db.settings.put(setting);
    account?.assertCurrent?.();
    await db.syncState.put({ id: 'local', updatedAt: Date.now() });
  });
}

export async function addSampleBook(): Promise<Book> {
  const story = `窗边的书店\n作者：Open Novel Reader\n\n第一章 雨停之前\n\n雨从傍晚下起，沿着玻璃缓缓滑落。街角的书店还亮着一盏灯，像一只没有睡意的眼睛。\n\n林晚推门进来，铃铛轻轻响了一声。她把湿透的伞收好，发现柜台后坐着一位正在修补旧书的老人。\n\n“雨这么大，进来坐一会儿吧。”老人说。\n\n“您还没有打烊吗？”林晚问。\n\n老人笑了笑：“好故事从来不赶时间。”\n\n她挑了一本薄薄的游记，在窗边坐下。纸页带着淡淡的木香，远方的海岸、山谷和城市渐渐从字里行间展开。\n\n第二章 留在页间的光\n\n第二天清晨，林晚又来到书店。路面还留着雨水，天空却已经很亮。\n\n“我想把昨天那本书买下来。”她说。\n\n“你已经读完了吗？”老人把书递给她。\n\n“还没有。我想慢慢读。”\n\n老人点头，在书里放了一张空白书签：“那就给下一次相遇留一个位置。”\n\n林晚走出门时，一束阳光落在封面上。她忽然觉得，一段新的旅程已经开始。\n\nThe End\n\nEvery book leaves a little light between its pages.\n`;
  const book = await importBook(new File([story], '窗边的书店.txt', { type: 'text/plain' }));
  if (book.author === '未知作者') await db.books.update(book.id, { author: 'Open Novel Reader' });
  return book;
}
