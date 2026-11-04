import { createClient, type AuthChangeEvent, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
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
export const CLOUD_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const CLOUD_BUNDLE_MAX_BYTES = 30 * 1024 * 1024;
let client: SupabaseClient | null = null;
let activeSync: Promise<SyncResult> | null = null;
let activeSyncEpoch = -1;
let accountEpoch = 0;
let cachedAuthIdentity: string | null | undefined;
let stopClientAuth: (() => void) | undefined;
const CONFIG_KEY = 'onr.cloud.public-config';
const LEGACY_ORIGIN_KEY = 'onr.cloud.legacy-owner-origin';
function rememberLegacyOrigin(origin: string) {
  if (origin && !localStorage.getItem(LEGACY_ORIGIN_KEY)) localStorage.setItem(LEGACY_ORIGIN_KEY, origin);
}

/** Public Supabase URL/publishable key only. Never store service-role or AI keys here. */
export function getCloudConfig(): CloudConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    if (typeof saved?.url === 'string' && typeof saved?.anonKey === 'string' && saved.url && saved.anonKey) {
      const url = new URL(saved.url);
      if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return { url: url.origin, anonKey: saved.anonKey };
    }
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
  rememberLegacyOrigin(getCloudConfig().url);
  accountEpoch++; cachedAuthIdentity = undefined; stopClientAuth?.(); stopClientAuth = undefined;
  if (client) { client.auth.stopAutoRefresh(); void client.removeAllChannels(); }
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: parsed.origin, anonKey: key }));
  client = null;
  window.dispatchEvent(new Event('onr-cloud-config-changed'));
}
export function getCloudClient(): SupabaseClient {
  const config = getCloudConfig();
  if (!config.url || !config.anonKey) throw new Error('请先配置 Supabase 项目地址和公开密钥。');
  if (!client) {
    rememberLegacyOrigin(config.url);
    const created = createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'onr.auth.' + new URL(config.url).host } });
    client = created;
    let knownUser: string | null | undefined;
    const { data } = created.auth.onAuthStateChange((event, session) => {
      if (client !== created) return;
      const nextUser = session?.user.id || null;
      if (event === 'SIGNED_OUT' || (knownUser !== undefined && knownUser !== nextUser)) accountEpoch++;
      knownUser = nextUser;
      cachedAuthIdentity = nextUser;
    });
    stopClientAuth = () => data.subscription.unsubscribe();
  }
  return client;
}
export async function getSession(): Promise<Session | null> {
  const config = getCloudConfig();
  if (!config.url || !config.anonKey) return null;
  const { data, error } = await getCloudClient().auth.getSession();
  if (error) throw error;
  return data.session;
}
export async function getUser(): Promise<User | null> {
  const config = getCloudConfig();
  if (!config.url || !config.anonKey) return null;
  const { data, error } = await getCloudClient().auth.getUser();
  if (error) throw error;
  return data.user;
}
export async function signUp(email: string, password: string, options?: { emailRedirectTo?: string }) {
  accountEpoch++;
  const { data, error } = await getCloudClient().auth.signUp({ email, password, options });
  if (error) throw error;
  return data;
}
export async function signIn(email: string, password: string) {
  accountEpoch++;
  const { data, error } = await getCloudClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}
export async function signOut() {
  accountEpoch++;
  const { error } = await getCloudClient().auth.signOut({ scope: 'local' });
  if (error) throw error;
}
export async function requestPasswordReset(email: string, redirectTo: string): Promise<void> {
  const { error } = await getCloudClient().auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}
export async function resendConfirmation(email: string, emailRedirectTo: string): Promise<void> {
  const { error } = await getCloudClient().auth.resend({ type: 'signup', email, options: { emailRedirectTo } });
  if (error) throw error;
}
export async function updatePassword(password: string): Promise<void> {
  accountEpoch++;
  const { error } = await getCloudClient().auth.updateUser({ password });
  if (error) throw error;
}
export async function exchangeCodeForSession(code: string): Promise<Session | null> {
  accountEpoch++;
  const { data, error } = await getCloudClient().auth.exchangeCodeForSession(code);
  if (error) throw error;
  return data.session;
}
export function subscribeAuth(callback: (session: Session | null, event: AuthChangeEvent) => void): () => void {
  const config = getCloudConfig();
  if (!config.url || !config.anonKey) return () => {};
  try {
    const { data } = getCloudClient().auth.onAuthStateChange((event, session) => callback(session, event));
    return () => data.subscription.unsubscribe();
  } catch {
    // Invalid deployment configuration must not prevent opening the offline reader.
    return () => {};
  }
}
const ownerKey = (bookId: string) => `cloud-owner:${bookId}`;
const linkKey = (scope: string, bookId: string) => `cloud-link:${scope}:${bookId}`;
const archiveKey = (scope: string, bookId: string) => `cloud-local-book:${scope}:${bookId}`;
const accountScope = (origin: string, userId: string) => `${origin}|${userId}`;
function ownerScope(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.includes('|')) return value;
  const origin = localStorage.getItem(LEGACY_ORIGIN_KEY) || getCloudConfig().url;
  return origin ? accountScope(origin, value) : undefined;
}
interface LocalAccountContext {
  userId: string; origin: string; scope: string;
  assertLive(): void; assertCurrent(): Promise<void>;
}
interface AccountContext extends LocalAccountContext { cloud: SupabaseClient }
async function captureAccount(verify = true): Promise<AccountContext> {
  const epoch = accountEpoch;
  const config = getCloudConfig();
  const session = await getSession();
  const assertLive = () => { if (accountEpoch !== epoch || getCloudConfig().url !== config.url) throw new Error('账号或云端配置已切换，本次操作停止。'); };
  assertLive();
  if (!session) throw new Error('请先登录后同步。');
  if (verify) {
    const { data, error } = await getCloudClient().auth.getUser(session.access_token);
    assertLive();
    if (error || data.user?.id !== session.user.id) throw new Error('登录状态已失效，请重新登录。');
  }
  const userId = session.user.id;
  const cloud = createClient(config.url, config.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { headers: { Authorization: `Bearer ${session.access_token}` } } });
  return { userId, origin: config.url, scope: accountScope(config.url, userId), cloud, assertLive,
    async assertCurrent() { assertLive(); const current = await getSession(); assertLive(); if (current?.user.id !== userId) throw new Error('账号已切换，本次操作停止。'); },
  };
}
async function readLink(context: AccountContext, bookId: string): Promise<Link | undefined> {
  const scoped = (await db.settings.get(linkKey(context.scope, bookId)))?.value as Link | undefined;
  if (scoped) return scoped;
  if (context.origin === localStorage.getItem(LEGACY_ORIGIN_KEY)) return (await db.settings.get(linkKey(context.userId, bookId)))?.value as Link | undefined;
}
function generatedFilePath(book: Book, userId: string): string {
  return `${userId}/${book.id}/${book.restoredAt ? `restored-${book.restoredAt}/` : ''}original.${book.format}`;
}
function allowedFilePath(path: string, book: Book, userId: string): boolean {
  return path === `${userId}/${book.id}/original.${book.format}` || path === generatedFilePath(book, userId);
}
async function currentFilePath(book: Book, userId: string, scope: string): Promise<string> {
  const scoped = (await db.settings.get(linkKey(scope, book.id)))?.value as Link | undefined;
  const legacy = !scoped && scope === accountScope(localStorage.getItem(LEGACY_ORIGIN_KEY) || '', userId) ? (await db.settings.get(linkKey(userId, book.id)))?.value as Link | undefined : undefined;
  const snapshot = (scoped || legacy)?.snapshot;
  if (snapshot?.file && snapshot.book.restoredAt === book.restoredAt && allowedFilePath(snapshot.file.path, book, userId)) return snapshot.file.path;
  return generatedFilePath(book, userId);
}
/** Local filtering needs no network. Signed-out readers retain access to their device's files. */
export async function filterBooksForAccount(books: Book[], userId?: string): Promise<Book[]> {
  if (!userId) return books;
  const scope = accountScope(getCloudConfig().url, userId);
  const owners = await db.settings.bulkGet(books.map(book => ownerKey(book.id)));
  return books.filter((_book, index) => !ownerScope(owners[index]?.value) || ownerScope(owners[index]?.value) === scope);
}
async function replaceBookRows(bundle: BookBundle): Promise<void> {
  const id = bundle.book.id;
  await db.books.put(bundle.book);
  for (const [table, rows] of [[db.chapters, bundle.chapters], [db.bookmarks, bundle.bookmarks], [db.characters, bundle.characters], [db.dialogues, bundle.dialogues], [db.corrections, bundle.corrections], [db.jobs, bundle.jobs]] as const) {
    await table.where('bookId').equals(id).delete();
    if (rows.length) await (table as typeof db.chapters).bulkPut(rows as Chapter[]);
  }
  if (bundle.progress && !bundle.book.deletedAt) await db.progress.put(bundle.progress);
  else await db.progress.delete(id);
}
async function switchLocalBook(context: LocalAccountContext, bookId: string, explicitImport: boolean): Promise<Book> {
  const originalBook = await db.books.get(bookId);
  if (!originalBook) throw new Error('本机找不到这本书。');
  const previousOwner = ownerScope((await db.settings.get(ownerKey(bookId)))?.value);
  if (previousOwner === context.scope) return originalBook;
  if (!previousOwner) {
    await db.transaction('rw', db.books, db.settings, async () => {
      context.assertLive();
      if (ownerScope((await db.settings.get(ownerKey(bookId)))?.value)) throw new Error('书籍所属账号已变更，请重试。');
      await db.settings.put({ id: ownerKey(bookId), value: context.scope });
      await db.books.update(bookId, { cloudEnabled: false });
      context.assertLive();
    });
    return { ...originalBook, cloudEnabled: false };
  }
  const previousUser = previousOwner.slice(previousOwner.lastIndexOf('|') + 1);
  const before = await bundleBook(originalBook, previousUser, previousOwner);
  const saved = (await db.settings.get(archiveKey(context.scope, bookId)))?.value as BookBundle | undefined;
  let selected: BookBundle;
  if (saved && !(explicitImport && saved.book.deletedAt !== undefined)) selected = { ...saved, book: { ...saved.book, cloudEnabled: explicitImport ? false : saved.book.cloudEnabled } };
  else {
    const file = await db.files.get(bookId);
    if (!file) throw new Error('缺少原文件，无法建立当前账号的独立副本。请重新导入。');
    const bytes = await file.bytes.arrayBuffer();
    const parsed = originalBook.format === 'epub' ? await parseEpub(bytes, file.name, bookId) : parseTxt(bytes, file.name, bookId);
    const now = Date.now();
    const restoredAt = explicitImport && saved?.book.deletedAt !== undefined ? Math.max(now, saved.book.deletedAt + 1, saved.book.restoredAt || 0) : undefined;
    selected = { schema: 1, book: { id: bookId, fingerprint: originalBook.fingerprint, format: originalBook.format, title: parsed.title, author: parsed.author, language: parsed.language, cover: parsed.cover, coverColor: originalBook.coverColor, totalWords: parsed.totalWords, chapterCount: parsed.chapters.length, createdAt: now, updatedAt: restoredAt || now, cloudEnabled: false, ...(restoredAt === undefined ? {} : { restoredAt }), ...(!explicitImport && originalBook.deletedAt !== undefined ? { deletedAt: originalBook.deletedAt } : {}) }, chapters: parsed.chapters, bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [], file: { name: file.name, mime: file.mime, path: `${context.userId}/${bookId}/original.${originalBook.format}` } };
  }
  await context.assertCurrent();
  await db.transaction('rw', [db.books, db.chapters, db.progress, db.bookmarks, db.characters, db.dialogues, db.corrections, db.jobs, db.files, db.settings], async () => {
    context.assertLive();
    const current = await db.books.get(bookId);
    if (!current || ownerScope((await db.settings.get(ownerKey(bookId)))?.value) !== previousOwner || !equal(await bundleBook(current, previousUser, previousOwner), before)) throw new Error('本机阅读数据已更新，请重试导入或同步。');
    await db.settings.put({ id: archiveKey(previousOwner, bookId), value: before });
    await replaceBookRows(selected);
    await db.settings.put({ id: ownerKey(bookId), value: context.scope });
    context.assertLive();
  });
  return selected.book;
}
/** Call only after an explicit file import. Account-private annotations are preserved in separate local snapshots. */
function captureLocalAccount(userId: string): LocalAccountContext {
  const epoch = accountEpoch; const origin = getCloudConfig().url;
  const assertLive = () => {
    if (epoch !== accountEpoch || origin !== getCloudConfig().url || (cachedAuthIdentity !== undefined && cachedAuthIdentity !== userId)) throw new Error('导入期间账号或云端已切换，请重试。');
  };
  assertLive();
  return { userId, origin, scope: accountScope(origin, userId), assertLive, async assertCurrent() { assertLive(); } };
}
export async function prepareLocalBookForAccount(bookId: string, userId?: string): Promise<Book> {
  if (!userId) { const book = await db.books.get(bookId); if (!book) throw new Error('本机找不到这本书。'); return book; }
  return switchLocalBook(captureLocalAccount(userId), bookId, true);
}

/** Explicit per-book consent. Turning off stops subsequent uploads; existing cloud copy is retained. */
export async function setBookCloud(bookId: string, enabled: boolean): Promise<void> {
  const context = await captureAccount();
  const owner = await db.settings.get(ownerKey(bookId));
  if (ownerScope(owner?.value) && ownerScope(owner?.value) !== context.scope) throw new Error('此书属于另一账号的本机副本。请先在当前账号明确重新导入原文件。');
  await context.assertCurrent();
  await db.transaction('rw', db.books, db.settings, async () => {
    context.assertLive();
    const currentOwner = ownerScope((await db.settings.get(ownerKey(bookId)))?.value);
    if (currentOwner && currentOwner !== context.scope) throw new Error('书籍所属账号已变更，请重试。');
    await db.settings.put({ id: ownerKey(bookId), value: context.scope });
    await db.books.update(bookId, { cloudEnabled: enabled, updatedAt: Date.now() });
    context.assertLive();
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
  const restoredAt = Math.max(local.book.restoredAt || 0, remote.book.restoredAt || 0, base.book.restoredAt || 0);
  const book = local.book.updatedAt >= remote.book.updatedAt ? local.book : remote.book;
  if (deletedAt && deletedAt >= restoredAt) return { schema: 1, book: { ...book, cover: undefined, deletedAt, ...(restoredAt ? { restoredAt } : {}), cloudEnabled: true }, chapters: [], bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [], file: local.file || remote.file };
  const restoration = [local.book, remote.book].filter(b => !b.deletedAt && b.restoredAt === restoredAt).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const { deletedAt: _previousDeletion, ...liveBook } = restoration || book;
  // An older tombstone's empty lists are not new annotation deletions after explicit reimport.
  const listBase = deletedAt && restoredAt > deletedAt ? { ...base, bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [] } : base;
  const progress = !local.progress ? remote.progress : !remote.progress ? local.progress :
    local.progress.updatedAt >= remote.progress.updatedAt ? local.progress : remote.progress;
  const merged: BookBundle = {
    schema: 1, book: { ...liveBook, ...(restoredAt ? { restoredAt } : {}), cloudEnabled: true },
    chapters: local.chapters.length ? local.chapters : remote.chapters, progress,
    bookmarks: mergeList(local.bookmarks, remote.bookmarks, listBase.bookmarks),
    characters: mergeList(local.characters, remote.characters, listBase.characters),
    dialogues: mergeList(local.dialogues, remote.dialogues, listBase.dialogues),
    corrections: mergeList(local.corrections, remote.corrections, listBase.corrections),
    jobs: mergeList(local.jobs, remote.jobs, listBase.jobs), file: !local.book.deletedAt && local.file ? local.file : remote.file || local.file,
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
/** The server adds JSONB formatting overhead; 30 MiB leaves headroom below its 40,000,000-byte constraint. */
export function assertCloudUploadLimits(bundle: BookBundle, originalSize: number): void {
  if (!bundle.book.deletedAt && originalSize > CLOUD_FILE_MAX_BYTES) throw new Error('这本书可继续本地阅读；云同步原文件上限为 50 MiB。本次未上传文件。');
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > CLOUD_BUNDLE_MAX_BYTES) throw new Error('这本书可继续本地阅读；云同步数据包上限为 30 MiB。请减少分析数据或保留本地备份，本次未上传文件。');
}
async function bundleBook(book: Book, userId: string, scope = accountScope(getCloudConfig().url, userId)): Promise<BookBundle> {
  const path = await currentFilePath(book, userId, scope);
  if (book.deletedAt) return { schema: 1, book: { ...book, cover: undefined }, chapters: [], bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [], file: { name: '', mime: '', path } };
  const [chapters, progress, bookmarks, characters, dialogues, corrections, jobs, file] = await Promise.all([
    db.chapters.where('bookId').equals(book.id).sortBy('index'), db.progress.get(book.id),
    db.bookmarks.where('bookId').equals(book.id).toArray(), db.characters.where('bookId').equals(book.id).toArray(),
    db.dialogues.where('bookId').equals(book.id).toArray(), db.corrections.where('bookId').equals(book.id).toArray(),
    db.jobs.where('bookId').equals(book.id).toArray(), db.files.get(book.id),
  ]);
  const sort = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  return { schema: 1, book, chapters, progress, bookmarks: sort(bookmarks), characters: sort(characters), dialogues: sort(dialogues), corrections: sort(corrections), jobs: sort(jobs),
    file: file ? { name: file.name, mime: file.mime, path } : undefined };
}
export function validateBundle(value: unknown, id: string): asserts value is BookBundle {
  const b = value as BookBundle;
  const text = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length <= max;
  const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const identifier = (v: unknown): v is string => text(v, 240) && v.length > 0;
  if (!b || b.schema !== 1 || b.book?.id !== id || !['txt', 'epub'].includes(b.book.format) || !text(b.book.title, 300) || !text(b.book.author, 200) || !text(b.book.language, 100) || !text(b.book.fingerprint, 64) || !/^[a-f\d]{64}$/.test(b.book.fingerprint) || id !== `book-${b.book.fingerprint.slice(0, 32)}` || !/^#[a-f\d]{6}$/i.test(b.book.coverColor) || !integer(b.book.createdAt) || !integer(b.book.updatedAt) || !integer(b.book.chapterCount) || !integer(b.book.totalWords) || (b.book.deletedAt !== undefined && !integer(b.book.deletedAt)) || (b.book.restoredAt !== undefined && !integer(b.book.restoredAt)) || (b.book.shelfId !== undefined && !identifier(b.book.shelfId))) throw new Error('云端书籍格式无效。');
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
  if (b.book.deletedAt !== undefined && b.book.restoredAt !== undefined && b.book.deletedAt < b.book.restoredAt) throw new Error('云端删除标记早于明确恢复，本机数据已保留，请更新客户端后重试。');
  if (b.book.deletedAt && (b.chapters.length || b.dialogues.length || b.bookmarks.length)) throw new Error('删除记录不能包含正文。');
  if (!b.book.deletedAt && (b.chapters.length !== b.book.chapterCount || !b.file)) throw new Error('云端书籍缺少原文件或章节。');
}
async function applyBundle(bundle: BookBundle, context: AccountContext, revision: number, expectedLocal?: BookBundle) {
  const { userId, cloud } = context;
  context.assertLive();
  const current = await db.books.get(bundle.book.id);
  const previousOwner = ownerScope((await db.settings.get(ownerKey(bundle.book.id)))?.value);
  if (current && current.fingerprint !== bundle.book.fingerprint) throw new Error('书籍 ID 冲突，已保留本地版本。');
  const id = bundle.book.id;
  if (bundle.file && !allowedFilePath(bundle.file.path, bundle.book, userId)) throw new Error('云端文件路径不匹配。');
  let file: BookFile | undefined;
  if (bundle.file && !bundle.book.deletedAt && !(await db.files.get(id))) {
    const { data, error } = await cloud.storage.from('novel-files').download(bundle.file.path);
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
  await context.assertCurrent();
  await db.transaction('rw', [db.books, db.chapters, db.progress, db.bookmarks, db.characters, db.dialogues, db.corrections, db.jobs, db.files, db.settings], async () => {
    context.assertLive();
    const latestBook = await db.books.get(id);
    if ((!current && latestBook) || ownerScope((await db.settings.get(ownerKey(id)))?.value) !== previousOwner) return;
    // Reading/bookmark edits made while a network upload was running must remain local.
    if (expectedLocal) {
      if (latestBook && !equal(await bundleBook(latestBook, userId), expectedLocal)) {
        // Keep the previous merge base until incoming data is actually installed.
        // Advancing it here would treat unseen remote bookmarks as local deletions on the next sync.
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
    if (bundle.book.deletedAt) await db.progress.delete(id);
    else if (bundle.progress) await db.progress.put(bundle.progress);
    if (file) await db.files.put(file);
    await db.settings.put({ id: ownerKey(id), value: context.scope });
    await db.settings.put({ id: linkKey(context.scope, id), value: { revision, snapshot: bundle } satisfies Link });
    context.assertLive();
  });
}
async function saveRemote(id: string, payload: BookBundle, revision: number, cloud: SupabaseClient): Promise<number> {
  const { data, error } = await cloud.rpc('save_reader_record', { p_id: id, p_payload: payload, p_expected_revision: revision });
  if (error) throw new Error(error.message.includes('SYNC_CONFLICT') ? '另一台设备刚修改了此书。再次同步即可合并。' : '云端保存失败：' + error.message);
  return Number(data);
}
interface Profile { preferences: Preferences; shelves: Bookshelf[] }
interface ProfileRow { payload: unknown; revision: number }
interface ProfileLink { snapshot: Profile; revision: number }
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
function emptyProfile(): Profile { return { preferences: { ...defaultPreferences }, shelves: [] }; }
/** Field-level preference merge and stable shelf IDs preserve independent offline edits. Shelf tombstones win. */
export function mergeProfiles(local: Profile, remote: Profile, base: Profile): Profile {
  const preferences = { ...defaultPreferences };
  for (const key of Object.keys(defaultPreferences) as (keyof Preferences)[]) {
    // Same-field conflicts prefer this device's intentional change; unrelated remote fields are retained.
    const value = equal(local.preferences[key], base.preferences[key]) ? remote.preferences[key] : local.preferences[key];
    Object.assign(preferences, { [key]: value });
  }
  const shelves = new Map(base.shelves.map(shelf => [shelf.id, { ...shelf }]));
  for (const shelf of [...remote.shelves, ...local.shelves]) {
    const prior = shelves.get(shelf.id);
    if (!prior) { shelves.set(shelf.id, { ...shelf }); continue; }
    const latest = shelf.updatedAt >= prior.updatedAt ? shelf : prior;
    const deletedAt = Math.max(prior.deletedAt || 0, shelf.deletedAt || 0);
    shelves.set(shelf.id, { ...latest, ...(deletedAt ? { deletedAt } : {}) });
  }
  return normalizeProfile({ preferences, shelves: [...shelves.values()] });
}
async function readLocalProfile(): Promise<Profile> {
  return normalizeProfile({ preferences: (await db.settings.get('preferences'))?.value ?? defaultPreferences, shelves: await db.shelves.toArray() });
}
/** Restore only local account snapshots before network requests; signing out preserves the current device view. */
export async function prepareLocalProfileForAccount(userId?: string): Promise<void> {
  if (!userId) return;
  const context = captureLocalAccount(userId);
  await db.transaction('rw', db.settings, db.shelves, async () => {
    context.assertLive();
    const previous = ownerScope((await db.settings.get('cloud-profile-owner'))?.value);
    if (previous === context.scope) return;
    const current = await readLocalProfile();
    const saved = (await db.settings.get(`cloud-local-profile:${context.scope}`))?.value;
    const selected = previous ? normalizeProfile(saved || emptyProfile()) : current;
    if (previous) await db.settings.put({ id: `cloud-local-profile:${previous}`, value: current });
    await db.shelves.clear();
    if (selected.shelves.length) await db.shelves.bulkPut(selected.shelves);
    await db.settings.put({ id: 'preferences', value: selected.preferences });
    await db.settings.put({ id: `cloud-local-profile:${context.scope}`, value: selected });
    await db.settings.put({ id: 'cloud-profile-owner', value: context.scope });
    context.assertLive();
  });
}
async function readRemoteProfile(userId: string, cloud: SupabaseClient): Promise<ProfileRow | null> {
  const { data, error } = await cloud.from('reader_profiles').select('payload,revision').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('偏好同步失败；请确认已执行全部数据库迁移：' + error.message);
  if (!data) return null;
  if (!Number.isSafeInteger(data.revision) || data.revision < 1) throw new Error('云端偏好版本无效，请更新数据库迁移。');
  return data as ProfileRow;
}
async function syncProfile(context: AccountContext) {
  const { userId, cloud } = context;
  const assertAccount = () => context.assertCurrent();
  const profileKey = `cloud-profile:${context.scope}`;
  let row = await readRemoteProfile(userId, cloud);
  await assertAccount();
  await db.transaction('rw', db.settings, db.shelves, async () => {
    context.assertLive();
    const owner = ownerScope((await db.settings.get('cloud-profile-owner'))?.value);
    if (owner === context.scope) return;
    const current = await readLocalProfile();
    const saved = (await db.settings.get(`cloud-local-profile:${context.scope}`))?.value;
    const previousOwner = owner;
    const selected = selectAccountProfile(current, previousOwner, context.scope, saved, row?.payload);
    if (previousOwner) {
      await db.settings.put({ id: `cloud-local-profile:${previousOwner}`, value: current });
      await db.shelves.clear();
      if (selected.shelves.length) await db.shelves.bulkPut(selected.shelves);
      await db.settings.put({ id: 'preferences', value: selected.preferences });
    }
    await db.settings.put({ id: 'cloud-profile-owner', value: context.scope });
    context.assertLive();
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) row = await readRemoteProfile(userId, cloud);
    await assertAccount();
    const local = await db.transaction('r', db.settings, db.shelves, readLocalProfile);
    const scoped = await db.settings.get(profileKey);
    const legacy = !scoped && context.origin === localStorage.getItem(LEGACY_ORIGIN_KEY) ? await db.settings.get(`cloud-profile:${userId}`) : undefined;
    const stored = (scoped || legacy)?.value as ProfileLink | Profile | undefined;
    // Prior beta snapshots lacked revisions. Keep their contents as a merge base during upgrade.
    const base = stored ? normalizeProfile('snapshot' in stored ? stored.snapshot : stored) : emptyProfile();
    const remote = row ? normalizeProfile(row.payload) : emptyProfile();
    const payload = mergeProfiles(local, remote, base);
    let revision = row?.revision || 0;
    if (!row || !equal(payload, remote)) {
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 1500000) throw new Error('分类与偏好数据过大，尚未上传；请先导出备份并减少分类。');
      const result = await cloud.rpc('save_reader_profile', { p_payload: payload, p_expected_revision: revision });
      if (result.error) {
        if (result.error.message.includes('SYNC_CONFLICT')) continue;
        throw new Error('偏好保存失败；请确认已执行全部数据库迁移：' + result.error.message);
      }
      revision = Number(result.data);
    }
    await assertAccount();
    await db.transaction('rw', db.settings, db.shelves, async () => {
      context.assertLive();
      if (ownerScope((await db.settings.get('cloud-profile-owner'))?.value) !== context.scope || !equal(await readLocalProfile(), local)) return;
      await db.shelves.clear();
      if (payload.shelves.length) await db.shelves.bulkPut(payload.shelves);
      await db.settings.put({ id: 'preferences', value: payload.preferences });
      await db.settings.put({ id: profileKey, value: { snapshot: payload, revision } satisfies ProfileLink });
      await db.settings.put({ id: `cloud-local-profile:${context.scope}`, value: payload });
      context.assertLive();
    });
    return;
  }
  throw new Error('其他设备正在修改分类与偏好。本机修改已保留，请稍后重试同步。');
}
export function syncLibrary(): Promise<SyncResult> {
  if (activeSync && activeSyncEpoch === accountEpoch) return activeSync;
  const operation = performSync().finally(() => { if (activeSync === operation) activeSync = null; });
  activeSync = operation; activeSyncEpoch = accountEpoch;
  return operation;
}
async function assertBookAuthorized(context: AccountContext, bookId: string) {
  await context.assertCurrent();
  const book = await db.books.get(bookId);
  const owner = ownerScope((await db.settings.get(ownerKey(bookId)))?.value);
  context.assertLive();
  if (!book?.cloudEnabled || owner !== context.scope) throw new Error('这本书的上传许可已取消或所属账号改变，后续同步已停止。');
}
async function restoreMissingLocalFile(context: AccountContext, book: Book, remote: BookBundle) {
  if (book.deletedAt !== undefined || !remote.file || await db.files.get(book.id)) return;
  if (!allowedFilePath(remote.file.path, remote.book, context.userId)) throw new Error('云端文件路径不匹配。');
  const { data, error } = await context.cloud.storage.from('novel-files').download(remote.file.path);
  if (error || !data) throw new Error('原文件下载失败，本机阅读数据已保留。请重试或重新导入原文件。');
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await data.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (fingerprint !== book.fingerprint) throw new Error('原文件指纹校验失败，未修改本机数据。');
  await context.assertCurrent();
  await db.transaction('rw', db.files, db.settings, async () => {
    context.assertLive();
    if (ownerScope((await db.settings.get(ownerKey(book.id)))?.value) !== context.scope) return;
    if (!await db.files.get(book.id)) await db.files.put({ bookId: book.id, name: remote.file!.name, mime: remote.file!.mime, bytes: data });
    context.assertLive();
  });
}
async function performSync(): Promise<SyncResult> {
  const context = await captureAccount();
  const { userId, cloud } = context;
  const assertAccount = () => context.assertCurrent();
  const stateId = `library:${context.scope}`;
  const result: SyncResult = { uploaded: 0, downloaded: 0, conflicts: 0 };
  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('当前离线；本地修改已保存，联网后可重试同步。');
    const rows: CloudRow[] = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await cloud.from('reader_records').select('id,payload,revision').eq('user_id', userId).order('id').range(offset, offset + 99);
      if (error) throw new Error('读取云端书架失败：' + error.message);
      await assertAccount();
      rows.push(...data as CloudRow[]);
      if (data.length < 100) break;
    }
    const remote = new Map(rows.map(r => [r.id, r]));
    // An account's own prior local snapshot or cloud copy can replace another active local view,
    // but the foreign account's annotations are archived first and never included in this account's upload.
    for (const book of await db.books.toArray()) {
      const owner = ownerScope((await db.settings.get(ownerKey(book.id)))?.value);
      if (!owner || owner === context.scope) continue;
      const saved = await db.settings.get(archiveKey(context.scope, book.id));
      const row = remote.get(book.id);
      if (!saved && !row) continue;
      if (row) validateBundle(row.payload, row.id);
      const switched = await switchLocalBook(context, book.id, false);
      if (!saved && row) {
        await applyBundle(row.payload, context, row.revision, await bundleBook(switched, userId));
        result.downloaded++;
        remote.delete(book.id);
      }
    }
    const books = await db.books.toArray();
    for (const book of books) {
      await assertAccount();
      const owner = ownerScope((await db.settings.get(ownerKey(book.id)))?.value);
      if (!book.cloudEnabled || owner !== context.scope) { remote.delete(book.id); continue; }
      const row = remote.get(book.id);
      if (row) validateBundle(row.payload, row.id);
      if (row && row.payload.book.deletedAt === undefined) await restoreMissingLocalFile(context, book, row.payload);
      const local = await bundleBook(book, userId);
      const link = await readLink(context, book.id);
      let chosen = local;
      const localChanged = !link || !equal(local, link.snapshot);
      if (row && (!link || row.revision !== link.revision)) {
        if (!localChanged) {
          await applyBundle(row.payload, context, row.revision, local); result.downloaded++; remote.delete(book.id); continue;
        }
        chosen = mergeBundles(local, row.payload, link?.snapshot || { ...local, bookmarks: [], characters: [], dialogues: [], corrections: [], jobs: [] });
        result.conflicts++;
      }
      let missingRemoteFile = false;
      if (chosen.book.deletedAt === undefined && chosen.file) {
        await assertBookAuthorized(context, book.id);
        const exists = await cloud.storage.from('novel-files').exists(chosen.file.path);
        if (exists.error && ![400, 404].includes(Number((exists.error as { status?: number }).status))) throw new Error('无法确认云端原文件状态，本机数据已保留。');
        missingRemoteFile = !exists.data;
      }
      if (localChanged || missingRemoteFile || (row && row.revision !== link?.revision)) {
        const original = chosen.book.deletedAt ? undefined : await db.files.get(book.id);
        if (!chosen.book.deletedAt && !original) throw new Error('本地原文件缺失。');
        // Validate both limits before any Storage write, including explicit restoration of a deleted cloud copy.
        assertCloudUploadLimits(chosen, original?.bytes.size || 0);
        if (!chosen.book.deletedAt && chosen.file && (!row || !row.payload.file || row.payload.book.deletedAt || missingRemoteFile)) {
          const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await original!.bytes.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
          if (fingerprint !== chosen.book.fingerprint) throw new Error('本地原文件指纹校验失败，本次未上传文件。请从备份恢复。');
          await assertBookAuthorized(context, book.id);
          const { error: uploadError } = await cloud.storage.from('novel-files').upload(chosen.file.path, original!.bytes, { upsert: true, contentType: 'application/octet-stream' });
          if (uploadError) throw new Error('原文件上传失败：' + uploadError.message);
        }
        await assertBookAuthorized(context, book.id);
        const revision = await saveRemote(book.id, chosen, row?.revision ?? 0, cloud);
        await assertAccount();
        await applyBundle(chosen, context, revision, local);
        result.uploaded++;
      }
      if (chosen.book.deletedAt && chosen.file) {
        // Repeat idempotently on every sync so a previous failed Storage deletion is retried.
        await assertBookAuthorized(context, book.id);
        const { error: deleteError } = await cloud.storage.from('novel-files').remove([chosen.file.path]);
        if (deleteError) throw new Error('删除标记已同步，原文件删除失败，请重试。');
      }
      remote.delete(book.id);
    }
    for (const row of remote.values()) {
      await assertAccount();
      validateBundle(row.payload, row.id);
      await applyBundle(row.payload, context, row.revision); result.downloaded++;
    }
    await assertAccount();
    await syncProfile(context);
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
  let unsubscribe = subscribeAuth(session => { if (session) schedule(); });
  const reconfigure = () => {
    unsubscribe();
    unsubscribe = subscribeAuth(session => { if (session) schedule(); });
    schedule();
  };
  window.addEventListener('onr-cloud-config-changed', reconfigure);
  window.addEventListener('online', schedule);
  window.addEventListener('focus', schedule);
  const interval = setInterval(schedule, 60000);
  schedule();
  return () => { disposed = true; if (timer) clearTimeout(timer); clearInterval(interval); unsubscribe(); window.removeEventListener('onr-cloud-config-changed', reconfigure); window.removeEventListener('online', schedule); window.removeEventListener('focus', schedule); };
}
