import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { db } from '../core/db';
import { MAX_FILE_BYTES, parseEpub, parseTxt } from '../core/parser';
import { defaultPreferences } from '../types';
import type { Book, BookFile, Chapter, ReadingProgress, Bookmark, Character, Dialogue, CharacterCorrection, AnalysisJob, Bookshelf, Preferences } from '../types';

export interface CloudConfig { url: string; anonKey: string }
export interface SyncResult { uploaded: number; downloaded: number; conflicts: number }
export interface BookBundle {
  schema: 1; book: Book; chapters: Chapter[]; progress?: ReadingProgress;
  bookmarks: Bookmark[]; characters: Character[]; dialogues: Dialogue[];
  corrections: CharacterCorrection[]; jobs: AnalysisJob[];
  file?: { name: string; mime: string; path: string };
}
interface CloudRow { id: string; payload: BookBundle; revision: number }
interface Link { revision: number; snapshot: BookBundle }
let client: SupabaseClient | null = null;
let activeSync: Promise<SyncResult> | null = null;
const CONFIG_KEY = 'onr.cloud.public-config';

/** Public Supabase URL/publishable key only. Never store service-role or AI keys here. */
export function getCloudConfig(): CloudConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    if (saved?.url && saved?.anonKey) return saved;
  } catch { /* invalid public configuration can be replaced */ }
  return { url: import.meta.env.VITE_SUPABASE_URL || '', anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || '' };
}
export function configureCloud(url: string, anonKey: string): void {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('云端地址必须使用 HTTPS。');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('请使用项目根地址。');
  const key = anonKey.trim();
  if (!key || key.startsWith('sb_secret_')) throw new Error('仅可使用 Supabase publishable / anon 公钥。');
  if (key.split('.').length === 3) {
    try { if (JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role !== 'anon') throw new Error('禁止配置服务端密钥。'); }
    catch { throw new Error('请使用有效的 anon 公钥，不能使用 service_role 密钥。'); }
  } else if (!key.startsWith('sb_publishable_')) throw new Error('请使用 Supabase publishable / anon 公钥。');
  if (client) { client.auth.stopAutoRefresh(); void client.removeAllChannels(); }
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: parsed.origin, anonKey: key }));
  client = null;
}
export function getCloudClient(): SupabaseClient {
  const config = getCloudConfig();
  if (!config.url || !config.anonKey) throw new Error('请先配置 Supabase 项目地址和公开密钥。');
  return client ??= createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'onr.auth.' + new URL(config.url).host } });
}
export async function getSession(): Promise<Session | null> {
  const config = getCloudConfig();
  if (!config.url || !config.anonKey) return null;
  const { data, error } = await getCloudClient().auth.getSession();
  if (error) throw new Error(error.message);
  return data.session;
}
export async function signUp(email: string, password: string) {
  const { data, error } = await getCloudClient().auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  return data;
}
export async function signIn(email: string, password: string) {
  const { data, error } = await getCloudClient().auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data.session;
}
export async function signOut() {
  const { error } = await getCloudClient().auth.signOut();
  if (error) throw new Error(error.message);
}
export function subscribeAuth(callback: (session: Session | null) => void): () => void {
  const config = getCloudConfig();
  if (!config.url || !config.anonKey) return () => {};
  const { data } = getCloudClient().auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}
async function requireUser() {
  const { data, error } = await getCloudClient().auth.getUser();
  if (error || !data.user) throw new Error('请先登录后同步。');
  return data.user;
}
const ownerKey = (bookId: string) => `cloud-owner:${bookId}`;
const linkKey = (userId: string, bookId: string) => `cloud-link:${userId}:${bookId}`;

/** Explicit per-book consent. Turning off stops subsequent uploads; existing cloud copy is retained. */
export async function setBookCloud(bookId: string, enabled: boolean): Promise<void> {
  const user = await requireUser();
  const owner = await db.settings.get(ownerKey(bookId));
  if (owner && owner.value !== user.id) throw new Error('此书关联另一账号。请导出备份后在独立浏览器配置中使用该账号。');
  await db.transaction('rw', db.books, db.settings, async () => {
    if (enabled) await db.settings.put({ id: ownerKey(bookId), value: user.id });
    await db.books.update(bookId, { cloudEnabled: enabled, updatedAt: Date.now() });
  });
}

function equal(a: unknown, b: unknown) {
  // PostgreSQL jsonb reorders object keys. Compare canonical JSON instead of wire ordering.
  const canonical = (value: unknown) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  return canonical(a) === canonical(b);
}
function mergeList<T extends { id: string }>(local: T[], remote: T[], base: T[]): T[] {
  const l = new Map(local.map(x => [x.id, x]));
  const r = new Map(remote.map(x => [x.id, x]));
  const b = new Map(base.map(x => [x.id, x]));
  const result: T[] = [];
  for (const id of new Set([...l.keys(), ...r.keys()])) {
    // A deletion on either device is a deletion, preventing accidental resurrection.
    if (b.has(id) && (!l.has(id) || !r.has(id))) continue;
    const left = l.get(id); const right = r.get(id);
    if (!left) { if (right) result.push(right); continue; }
    if (!right || equal(right, b.get(id))) { result.push(left); continue; }
    if (equal(left, b.get(id))) { result.push(right); continue; }
    const lt = (left as T & { updatedAt?: number }).updatedAt ?? 0;
    const rt = (right as T & { updatedAt?: number }).updatedAt ?? 0;
    result.push(lt >= rt ? left : right);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
/** Three-way merge; permanent tombstones win and corrections remain separate from AI output. */
export function mergeBundles(local: BookBundle, remote: BookBundle, base: BookBundle): BookBundle {
  const deletedAt = Math.max(local.book.deletedAt || 0, remote.book.deletedAt || 0);
  const book = local.book.updatedAt >= remote.book.updatedAt ? local.book : remote.book;
  if (deletedAt) return { schema: 1, book: { ...book, cover: undefined, deletedAt, cloudEnabled: true }, chapters: [], bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [], file: local.file || remote.file };
  const progress = !local.progress ? remote.progress : !remote.progress ? local.progress :
    local.progress.updatedAt >= remote.progress.updatedAt ? local.progress : remote.progress;
  const merged: BookBundle = {
    schema: 1, book: { ...book, ...(deletedAt ? { deletedAt } : {}), cloudEnabled: true },
    chapters: local.chapters.length ? local.chapters : remote.chapters, progress,
    bookmarks: mergeList(local.bookmarks, remote.bookmarks, base.bookmarks),
    characters: mergeList(local.characters, remote.characters, base.characters),
    dialogues: mergeList(local.dialogues, remote.dialogues, base.dialogues),
    corrections: mergeList(local.corrections, remote.corrections, base.corrections),
    jobs: mergeList(local.jobs, remote.jobs, base.jobs), file: local.file || remote.file,
  };
  const characters = new Map(merged.characters.map(c => [c.id, c]));
  const previousCharacters = new Map([...base.characters, ...remote.characters, ...local.characters].map(c => [c.id, c]));
  const remap = (id: string | null): string | null => {
    if (!id || characters.has(id)) return id;
    const old = previousCharacters.get(id);
    return old ? merged.characters.find(c => [c.name, ...c.aliases].some(name => [old.name, ...old.aliases].includes(name)))?.id || null : null;
  };
  merged.corrections = merged.corrections.map(c => ({ ...c, characterId: remap(c.characterId) }));
  const corrections = new Map(merged.corrections.map(c => [c.dialogueId, c]));
  merged.dialogues = merged.dialogues.map(d => {
    const correction = corrections.get(d.id);
    return correction ? { ...d, characterId: correction.characterId, source: 'manual', confidence: 1 } : { ...d, characterId: remap(d.characterId) };
  });
  return merged;
}
async function bundleBook(book: Book, userId: string): Promise<BookBundle> {
  if (book.deletedAt) return { schema: 1, book: { ...book, cover: undefined }, chapters: [], bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [], file: { name: '', mime: '', path: `${userId}/${book.id}/original.${book.format}` } };
  const [chapters, progress, bookmarks, characters, dialogues, corrections, jobs, file] = await Promise.all([
    db.chapters.where('bookId').equals(book.id).sortBy('index'), db.progress.get(book.id),
    db.bookmarks.where('bookId').equals(book.id).toArray(), db.characters.where('bookId').equals(book.id).toArray(),
    db.dialogues.where('bookId').equals(book.id).toArray(), db.corrections.where('bookId').equals(book.id).toArray(),
    db.jobs.where('bookId').equals(book.id).toArray(), db.files.get(book.id),
  ]);
  const sort = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  return { schema: 1, book, chapters, progress, bookmarks: sort(bookmarks), characters: sort(characters), dialogues: sort(dialogues), corrections: sort(corrections), jobs: sort(jobs),
    file: file ? { name: file.name, mime: file.mime, path: `${userId}/${book.id}/original.${book.format}` } : undefined };
}
export function validateBundle(value: unknown, id: string): asserts value is BookBundle {
  const b = value as BookBundle;
  const text = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length <= max;
  const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const identifier = (v: unknown): v is string => text(v, 240) && v.length > 0;
  if (!b || b.schema !== 1 || b.book?.id !== id || !['txt', 'epub'].includes(b.book.format) || !text(b.book.title, 300) || !text(b.book.author, 200) || !text(b.book.language, 100) || !text(b.book.fingerprint, 64) || !/^[a-f\d]{64}$/.test(b.book.fingerprint) || id !== `book-${b.book.fingerprint.slice(0, 32)}` || !/^#[a-f\d]{6}$/i.test(b.book.coverColor) || !integer(b.book.createdAt) || !integer(b.book.updatedAt) || !integer(b.book.chapterCount) || !integer(b.book.totalWords) || (b.book.deletedAt !== undefined && !integer(b.book.deletedAt)) || (b.book.shelfId !== undefined && !identifier(b.book.shelfId))) throw new Error('云端书籍格式无效。');
  for (const key of ['chapters', 'bookmarks', 'characters', 'dialogues', 'corrections', 'jobs'] as const) {
    if (!Array.isArray(b[key]) || b[key].length > 100000 || b[key].some(x => !x || x.bookId !== id || !identifier(x.id)) || new Set(b[key].map(x => x.id)).size !== b[key].length) throw new Error('云端数据的书籍引用无效。');
  }
  if (b.chapters.some((c, index) => c.index !== index || c.id !== `${id}:ch:${index}` || !text(c.title) || !Array.isArray(c.paragraphs) || c.paragraphs.length > 100000 || c.paragraphs.some(p => !text(p, 5 * 1024 * 1024)) || (c.sourcePath !== undefined && !text(c.sourcePath, 2000)))) throw new Error('云端章节格式无效。');
  const chapters = new Map(b.chapters.map(c => [c.id, c]));
  const location = (row: { chapterId: string; paragraphIndex: number }) => {
    const chapter = chapters.get(row.chapterId);
    return chapter && integer(row.paragraphIndex) && row.paragraphIndex < chapter.paragraphs.length;
  };
  const characterIds = new Set(b.characters.map(c => c.id));
  if (b.characters.some(c => !text(c.name, 300) || !Array.isArray(c.aliases) || c.aliases.length > 300 || c.aliases.some(a => !text(a, 300)))) throw new Error('云端人物数据无效。');
  if (b.progress && (b.progress.bookId !== id || !location(b.progress) || !integer(b.progress.offset) || b.progress.offset > chapters.get(b.progress.chapterId)!.paragraphs[b.progress.paragraphIndex].length || !integer(b.progress.updatedAt) || !integer(b.progress.version))) throw new Error('云端进度无效。');
  if (b.bookmarks.some(m => !location(m) || !text(m.label, 2000) || !integer(m.createdAt))) throw new Error('云端书签无效。');
  for (const d of b.dialogues) {
    const paragraph = chapters.get(d.chapterId)?.paragraphs[d.paragraphIndex];
    if (!location(d) || !integer(d.start) || !integer(d.end) || d.start >= d.end || d.end > paragraph!.length || paragraph!.slice(d.start, d.end) !== d.text || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1 || !['ai', 'manual'].includes(d.source) || !integer(d.updatedAt) || !(d.characterId === null || characterIds.has(d.characterId)) || (d.model !== undefined && !text(d.model, 100))) throw new Error('云端对白位置或来源无效。');
  }
  const dialogueIds = new Set(b.dialogues.map(d => d.id));
  if (b.corrections.some(c => !dialogueIds.has(c.dialogueId) || !(c.characterId === null || characterIds.has(c.characterId)) || !integer(c.updatedAt))) throw new Error('云端纠错数据无效。');
  if (b.jobs.some(j => !chapters.has(j.chapterId) || !['queued', 'running', 'paused', 'done', 'failed', 'cancelled'].includes(j.status) || !integer(j.completedChunks) || !integer(j.totalChunks) || j.completedChunks > j.totalChunks || !integer(j.updatedAt) || (j.error !== undefined && !text(j.error, 2000)))) throw new Error('云端任务无效。');
  if (b.file && (!text(b.file.name) || !text(b.file.mime, 200) || !text(b.file.path, 1000))) throw new Error('云端文件记录无效。');
  if (b.book.cover && (!text(b.book.cover, 5 * 1024 * 1024) || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(b.book.cover))) throw new Error('云端封面格式无效。');
  if (b.book.deletedAt && (b.chapters.length || b.dialogues.length || b.bookmarks.length)) throw new Error('删除记录不能包含正文。');
  if (!b.book.deletedAt && (b.chapters.length !== b.book.chapterCount || !b.file)) throw new Error('云端书籍缺少原文件或章节。');
}
async function applyBundle(bundle: BookBundle, userId: string, revision: number, expectedLocal?: BookBundle, cloud = getCloudClient()) {
  const current = await db.books.get(bundle.book.id);
  if (current && current.fingerprint !== bundle.book.fingerprint) throw new Error('书籍 ID 冲突，已保留本地版本。');
  const id = bundle.book.id;
  if (bundle.file && bundle.file.path !== `${userId}/${id}/original.${bundle.book.format}`) throw new Error('云端文件路径不匹配。');
  let file: BookFile | undefined;
  if (bundle.file && !bundle.book.deletedAt && !(await db.files.get(id))) {
    const expectedPath = `${userId}/${id}/original.${bundle.book.format}`;
    if (bundle.file.path !== expectedPath) throw new Error('云端文件路径不匹配。');
    const { data, error } = await cloud.storage.from('novel-files').download(expectedPath);
    if (error) throw new Error('下载原文件失败，请重试。');
    file = { bookId: id, name: bundle.file.name, mime: bundle.file.mime, bytes: data };
  }
  if (!bundle.book.deletedAt) {
    const original = file || await db.files.get(id);
    if (!original || original.bytes.size > MAX_FILE_BYTES) throw new Error('原文件缺失或超过限制。');
    const bytes = await original.bytes.arrayBuffer();
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (fingerprint !== bundle.book.fingerprint) throw new Error('原文件指纹校验失败，已保留本地数据。');
    const parsed = bundle.book.format === 'epub' ? await parseEpub(bytes, original.name, id) : parseTxt(bytes, original.name, id);
    if (!equal(parsed.chapters, bundle.chapters)) throw new Error('云端章节与原文件不一致，已保留本地数据。');
  }
  await db.transaction('rw', [db.books, db.chapters, db.progress, db.bookmarks, db.characters, db.dialogues, db.corrections, db.jobs, db.files, db.settings], async () => {
    // Reading/bookmark edits made while a network upload was running must remain local.
    if (expectedLocal) {
      const latestBook = await db.books.get(id);
      if (latestBook && !equal(await bundleBook(latestBook, userId), expectedLocal)) {
        await db.settings.put({ id: linkKey(userId, id), value: { revision, snapshot: bundle } satisfies Link });
        return;
      }
    }
    await db.books.put({ ...bundle.book, cloudEnabled: true });
    for (const [table, rows] of [
      [db.chapters, bundle.chapters], [db.bookmarks, bundle.bookmarks], [db.characters, bundle.characters],
      [db.dialogues, bundle.dialogues], [db.corrections, bundle.corrections], [db.jobs, bundle.jobs],
    ] as const) {
      await table.where('bookId').equals(id).delete();
      // Each tuple contains matching typed rows; Dexie's generic union cannot express that relationship.
      if (rows.length) await (table as typeof db.chapters).bulkPut(rows as Chapter[]);
    }
    if (bundle.progress) await db.progress.put(bundle.progress);
    if (file) await db.files.put(file);
    await db.settings.put({ id: ownerKey(id), value: userId });
    await db.settings.put({ id: linkKey(userId, id), value: { revision, snapshot: bundle } satisfies Link });
  });
}
async function saveRemote(id: string, payload: BookBundle, revision: number, cloud: SupabaseClient): Promise<number> {
  const { data, error } = await cloud.rpc('save_reader_record', { p_id: id, p_payload: payload, p_expected_revision: revision });
  if (error) throw new Error(error.message.includes('SYNC_CONFLICT') ? '另一台设备刚修改了此书。再次同步即可合并。' : '云端保存失败：' + error.message);
  return Number(data);
}
interface Profile { preferences: Preferences; shelves: Bookshelf[] }
function normalizeProfile(value: unknown): Profile {
  const p = value as Partial<Profile> | null;
  const v = p?.preferences;
  const preferences: Preferences = v && ['light', 'dark', 'sepia'].includes(v.theme) && ['serif', 'sans'].includes(v.fontFamily) && Number.isFinite(v.fontSize) && v.fontSize >= 12 && v.fontSize <= 48 && Number.isFinite(v.lineHeight) && v.lineHeight >= 1.2 && v.lineHeight <= 3 && Number.isFinite(v.readerWidth) && v.readerWidth >= 300 && v.readerWidth <= 1600 && typeof v.showCharacters === 'boolean' ?
    { theme: v.theme, fontFamily: v.fontFamily, fontSize: v.fontSize, lineHeight: v.lineHeight, readerWidth: v.readerWidth, showCharacters: v.showCharacters } : { ...defaultPreferences };
  if (!p || !Array.isArray(p.shelves) || p.shelves.length > 10000 || p.shelves.some(s => !s || typeof s.id !== 'string' || s.id.length > 240 || typeof s.name !== 'string' || s.name.length > 200 || !Number.isSafeInteger(s.updatedAt) || s.updatedAt < 0 || (s.deletedAt !== undefined && (!Number.isSafeInteger(s.deletedAt) || s.deletedAt < 0)))) throw new Error('云端分类格式无效。');
  return { preferences, shelves: p.shelves.map(s => ({ id: s.id, name: s.name, updatedAt: s.updatedAt, ...(s.deletedAt === undefined ? {} : { deletedAt: s.deletedAt }) })).sort((a, b) => a.id.localeCompare(b.id)) };
}
/** An account switch starts from that account's saved data or a neutral profile, never the previous one. */
export function selectAccountProfile(current: unknown, previousOwner: string | undefined, userId: string, saved: unknown, remote: unknown): Profile {
  if (!previousOwner || previousOwner === userId) return normalizeProfile(current);
  return normalizeProfile(saved || remote || { preferences: defaultPreferences, shelves: [] });
}
async function syncProfile(userId: string, cloud: SupabaseClient, assertAccount: () => Promise<void>) {
  const profileKey = `cloud-profile:${userId}`;
  const owner = await db.settings.get('cloud-profile-owner');
  const pref = await db.settings.get('preferences');
  const shelves = await db.shelves.toArray();
  const { data, error } = await cloud.from('reader_profiles').select('payload,updated_at').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('偏好同步失败：' + error.message);
  await assertAccount();
  const last = await db.settings.get(profileKey);
  const saved = await db.settings.get(`cloud-local-profile:${userId}`);
  const current = { preferences: pref?.value ?? defaultPreferences, shelves };
  const previousOwner = typeof owner?.value === 'string' ? owner.value : undefined;
  let payload = selectAccountProfile(current, previousOwner, userId, saved?.value, data?.payload);
  const switched = previousOwner !== undefined && previousOwner !== userId;
  const firstLink = previousOwner === undefined && !last && data?.payload;
  if (firstLink) {
    const remote = normalizeProfile(data.payload);
    const categories = new Map([...remote.shelves, ...payload.shelves].map(s => [s.id, s]));
    payload = { preferences: pref ? payload.preferences : remote.preferences, shelves: [...categories.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  }
  if (switched) {
    await db.settings.put({ id: `cloud-local-profile:${previousOwner}`, value: normalizeProfile(current) });
  }
  if (switched || firstLink) {
    // A new account with no profile gets a neutral baseline. Never upload another account's local categories.
    await db.transaction('rw', db.settings, db.shelves, async () => {
      await db.shelves.clear();
      if (payload.shelves.length) await db.shelves.bulkPut(payload.shelves);
      await db.settings.put({ id: 'preferences', value: payload.preferences });
    });
  }
  if ((!last && !data) || firstLink || (last && !equal(last.value, payload))) {
    // The authenticated user's profile is scoped by RLS. Book files are handled separately.
    const { error: writeError } = await cloud.from('reader_profiles').upsert({ user_id: userId, payload, updated_at: new Date().toISOString() });
    if (writeError) throw new Error('偏好保存失败：' + writeError.message);
  } else if (data?.payload) {
    payload = normalizeProfile(data.payload);
    await db.transaction('rw', db.settings, db.shelves, async () => {
      await db.shelves.clear();
      if (payload.shelves.length) await db.shelves.bulkPut(payload.shelves);
      await db.settings.put({ id: 'preferences', value: payload.preferences });
    });
  }
  await db.settings.put({ id: profileKey, value: payload });
  await db.settings.put({ id: `cloud-local-profile:${userId}`, value: payload });
  await db.settings.put({ id: 'cloud-profile-owner', value: userId });
}
export function syncLibrary(): Promise<SyncResult> {
  return activeSync ??= performSync().finally(() => { activeSync = null; });
}
async function performSync(): Promise<SyncResult> {
  const user = await requireUser();
  const session = await getSession();
  if (!session || session.user.id !== user.id) throw new Error('账号已切换，请重新同步。');
  const config = getCloudConfig();
  // Pin the JWT to this operation. Changing the singleton's account mid-upload can never redirect A's book into B's account.
  const cloud = createClient(config.url, config.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { headers: { Authorization: `Bearer ${session.access_token}` } } });
  const assertAccount = async () => {
    const current = await getSession();
    if (current?.user.id !== user.id || getCloudConfig().url !== config.url) throw new Error('账号或云端配置已切换，本次同步停止。');
  };
  const stateId = `library:${user.id}`;
  const result: SyncResult = { uploaded: 0, downloaded: 0, conflicts: 0 };
  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('当前离线；本地修改已保存，联网后可重试同步。');
    const rows: CloudRow[] = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await cloud.from('reader_records').select('id,payload,revision').eq('user_id', user.id).order('id').range(offset, offset + 99);
      if (error) throw new Error('读取云端书架失败：' + error.message);
      await assertAccount();
      rows.push(...data as CloudRow[]);
      if (data.length < 100) break;
    }
    const remote = new Map(rows.map(r => [r.id, r]));
    const books = await db.books.toArray();
    for (const book of books) {
      await assertAccount();
      const owner = await db.settings.get(ownerKey(book.id));
      if (!book.cloudEnabled || owner?.value !== user.id) { remote.delete(book.id); continue; }
      const local = await bundleBook(book, user.id);
      const row = remote.get(book.id);
      const link = (await db.settings.get(linkKey(user.id, book.id)))?.value as Link | undefined;
      if (row) validateBundle(row.payload, row.id);
      let chosen = local;
      const localChanged = !link || !equal(local, link.snapshot);
      if (row && (!link || row.revision !== link.revision)) {
        if (!localChanged) {
          await applyBundle(row.payload, user.id, row.revision, local, cloud); result.downloaded++; remote.delete(book.id); continue;
        }
        chosen = mergeBundles(local, row.payload, link?.snapshot || { ...local, bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [] });
        result.conflicts++;
      }
      if (localChanged || (row && row.revision !== link?.revision)) {
        if (!chosen.book.deletedAt && chosen.file && (!row || !row.payload.file)) {
          const original = await db.files.get(book.id);
          if (!original) throw new Error('本地原文件缺失。');
          const { error: uploadError } = await cloud.storage.from('novel-files').upload(chosen.file.path, original.bytes, { upsert: true, contentType: 'application/octet-stream' });
          if (uploadError) throw new Error('原文件上传失败：' + uploadError.message);
        }
        await assertAccount();
        const revision = await saveRemote(book.id, chosen, row?.revision ?? 0, cloud);
        await assertAccount();
        await applyBundle(chosen, user.id, revision, local, cloud);
        result.uploaded++;
      }
      if (chosen.book.deletedAt && chosen.file) {
        // Repeat idempotently on every sync so a previous failed Storage deletion is retried.
        const { error: deleteError } = await cloud.storage.from('novel-files').remove([chosen.file.path]);
        if (deleteError) throw new Error('删除标记已同步，原文件删除失败，请重试。');
      }
      remote.delete(book.id);
    }
    for (const row of remote.values()) {
      await assertAccount();
      validateBundle(row.payload, row.id);
      await applyBundle(row.payload, user.id, row.revision, undefined, cloud); result.downloaded++;
    }
    await assertAccount();
    await syncProfile(user.id, cloud, assertAccount);
    await db.syncState.put({ id: stateId, updatedAt: Date.now(), lastSyncedAt: Date.now() });
    return result;
  } catch (error) {
    await db.syncState.put({ id: stateId, updatedAt: Date.now(), error: error instanceof Error ? error.message : '同步失败。' });
    throw error;
  }
}

export interface AutoSyncState { status: 'syncing' | 'idle' | 'error'; result?: SyncResult; error?: string }
/** Reconnection/focus retry is cloud-only. This module never invokes paid AI requests. */
export function startAutoSync(onState?: (state: AutoSyncState) => void): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (disposed || !navigator.onLine) return;
    try {
      if (!(await getSession()) || disposed) return;
      onState?.({ status: 'syncing' });
      const result = await syncLibrary();
      if (!disposed) onState?.({ status: 'idle', result });
    } catch (error) { if (!disposed) onState?.({ status: 'error', error: error instanceof Error ? error.message : '同步失败，请手动重试。' }); }
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void run(); }, 1500); };
  const unsubscribe = subscribeAuth(session => { if (session) schedule(); });
  window.addEventListener('online', schedule);
  window.addEventListener('focus', schedule);
  const interval = setInterval(schedule, 60000);
  schedule();
  return () => { disposed = true; if (timer) clearTimeout(timer); clearInterval(interval); unsubscribe(); window.removeEventListener('online', schedule); window.removeEventListener('focus', schedule); };
}
