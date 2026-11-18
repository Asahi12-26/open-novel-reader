import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookBundle } from './cloud';
import type { ReaderDatabase as Database } from '../core/db';

const state = vi.hoisted(() => ({ database: undefined as Database | undefined, cloud: undefined as MemoryTransport | undefined }));
vi.mock('../core/db', async importOriginal => {
  const actual = await importOriginal<typeof import('../core/db')>();
  return { ReaderDatabase: actual.ReaderDatabase, get db() { return state.database || actual.db; } };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: (_url: string, _key: string, options?: { global?: { headers?: { Authorization?: string } } }) => state.cloud!.client(options?.global?.headers?.Authorization?.replace('Bearer ', '')) }));
import { db, ReaderDatabase } from '../core/db';
import { resetCharacterAvatar, validateAvatarImage } from '../core/avatar';
import { importBook, listChapters, saveProgress, deleteBook, exportBackup, restoreBackup } from '../core/library';
import { CLOUD_BUNDLE_MAX_BYTES, CLOUD_FILE_MAX_BYTES, configureCloud, filterBooksForAccount, getPrivateCloudAccess, prepareLocalBookForAccount, prepareLocalProfileForAccount, setBookCloud, syncLibrary } from './cloud';
import { initializeCharacterIdentity, manualAddAlias } from './character-identity';
import { defaultPreferences } from '../types';
import { seriesBookId } from '../core/series-types';

interface TransportRow { id: string; payload: BookBundle; revision: number }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Transport fake only: actual syncLibrary, import/parser, file verification and two Dexie databases run unchanged.
 * This validates client reconciliation; it does not claim to validate hosted Supabase/Postgres RLS. */
class MemoryTransport {
  private activeUser = 'account-a';
  private authListeners = new Set<(event: string, session: { user: { id: string }; access_token: string } | null) => void>();
  get currentUser() { return this.activeUser; }
  set currentUser(value: string) {
    this.activeUser = value;
    for (const callback of this.authListeners) callback(value ? 'SIGNED_IN' : 'SIGNED_OUT', value ? { user: { id: value }, access_token: value } : null);
  }
  records = new Map<string, Map<string, TransportRow>>();
  profiles = new Map<string, { payload: { preferences: typeof defaultPreferences; shelves: { id: string; name: string; updatedAt: number; deletedAt?: number }[] }; revision: number }>();
  files = new Map<string, Blob>();
  avatarFiles = new Map<string, Blob>();
  avatarUploads = 0;
  avatarDownloads = 0;
  beforeNextAvatarUpload?: () => Promise<void>;
  afterNextAvatarDownload?: () => Promise<void>;
  uploads = 0;
  recordReads = 0;
  fileChecks = 0;
  allowedPrivateUsers = new Set(['account-a', 'account-b']);
  privateAccessError = false;
  beforeNextPrivateAccess?: () => Promise<void>;
  beforeNextSave?: () => Promise<void>;
  failUploadPath?: { path: string; status: number };
  afterNextSave?: () => Promise<void>;
  beforeNextGetUser?: () => Promise<void>;
  afterNextUpload?: () => Promise<void>;
  afterNextDownload?: () => Promise<void>;
  beforeNextRemove?: () => Promise<void>;
  beforeNextProfileWrite?: () => Promise<void>;
  afterNextProfileSave?: () => Promise<void>;
  profileWrites = 0;
  rows(user = this.currentUser) {
    let rows = this.records.get(user);
    if (!rows) { rows = new Map(); this.records.set(user, rows); }
    return rows;
  }
  client(pinnedUser?: string) {
    const user = () => pinnedUser || this.currentUser;
    return {
      auth: {
        getUser: async () => { const id = this.currentUser; const callback = this.beforeNextGetUser; this.beforeNextGetUser = undefined; await callback?.(); return { data: { user: { id } }, error: null }; },
        getSession: async () => ({ data: { session: { user: { id: this.currentUser }, access_token: this.currentUser } }, error: null }),
        stopAutoRefresh: () => {}, onAuthStateChange: (callback: (event: string, session: { user: { id: string }; access_token: string } | null) => void) => {
          this.authListeners.add(callback); callback('INITIAL_SESSION', this.currentUser ? { user: { id: this.currentUser }, access_token: this.currentUser } : null);
          return { data: { subscription: { unsubscribe: () => { this.authListeners.delete(callback); } } } };
        },
      },
      removeAllChannels: async () => {},
      from: (table: string) => {
        let selected = '';
        let requestedId = '';
        const query = {
          select: (fields: string) => { selected = fields; return query; },
          eq: (field: string, value: string) => { if (field === 'id') requestedId = value; return query; },
          order: () => query,
          range: async (start: number, end: number) => {
            expect(selected).toBe('id,revision');
            const data = [...this.rows(user()).values()].map(({ id, revision }) => ({ id, revision }));
            return { data: data.sort((a, b) => a.id.localeCompare(b.id)).slice(start, end + 1), error: null };
          },
          maybeSingle: async () => {
            if (table === 'reader_records') {
              expect(selected).toBe('id,payload,revision');
              this.recordReads++;
              const data = this.rows(user()).get(requestedId);
              return { data: data ? clone(data) : null, error: null };
            }
            return { data: this.profiles.has(user()) ? clone(this.profiles.get(user())) : null, error: null };
          },
        };
        if (!['reader_records', 'reader_profiles'].includes(table)) throw new Error('Unexpected table');
        return query;
      },
      rpc: async (name: string, args: { p_id: string; p_payload: BookBundle; p_expected_revision: number }) => {
        if (name === 'reader_has_private_cloud') {
          const callback = this.beforeNextPrivateAccess; this.beforeNextPrivateAccess = undefined; await callback?.();
          return this.privateAccessError ? { data: null, error: { message: 'GATE_UNAVAILABLE' } } : { data: this.allowedPrivateUsers.has(user()), error: null };
        }
        if (name === 'save_reader_profile') {
          this.profileWrites++;
          const before = this.beforeNextProfileWrite; this.beforeNextProfileWrite = undefined; await before?.();
          const previous = this.profiles.get(user());
          if ((previous?.revision || 0) !== args.p_expected_revision) return { data: null, error: { message: 'SYNC_CONFLICT' } };
          const revision = (previous?.revision || 0) + 1;
          this.profiles.set(user(), { payload: clone(args.p_payload) as unknown as NonNullable<ReturnType<typeof this.profiles.get>>['payload'], revision });
          const after = this.afterNextProfileSave; this.afterNextProfileSave = undefined; await after?.();
          return { data: revision, error: null };
        }
        const before = this.beforeNextSave; this.beforeNextSave = undefined; await before?.();
        const rows = this.rows(user()); const previous = rows.get(args.p_id);
        if ((previous?.revision || 0) !== args.p_expected_revision) return { data: null, error: { message: 'SYNC_CONFLICT' } };
        const revision = (previous?.revision || 0) + 1;
        rows.set(args.p_id, { id: args.p_id, payload: clone(args.p_payload), revision });
        const callback = this.afterNextSave; this.afterNextSave = undefined;
        await callback?.();
        return { data: revision, error: null };
      },
      storage: { from: (bucket: string) => bucket === 'character-avatars' ? {
        upload: async (path: string, bytes: Blob) => {
          const callback = this.beforeNextAvatarUpload; this.beforeNextAvatarUpload = undefined; await callback?.();
          if (!path.startsWith(user() + '/') || this.avatarFiles.has(path)) return { error: { message: 'NOT_ALLOWED_OR_EXISTS' } };
          this.avatarUploads++; this.avatarFiles.set(path, bytes); return { error: null };
        },
        download: async (path: string) => {
          this.avatarDownloads++;
          const data = path.startsWith(user() + '/') && this.avatarFiles.get(path) || null;
          const callback = this.afterNextAvatarDownload; this.afterNextAvatarDownload = undefined; await callback?.();
          return { data, error: data ? null : { message: 'NOT_FOUND' } };
        },
      } : ({
        exists: async (path: string) => { this.fileChecks++; return { data: this.files.has(path), error: null }; },
        upload: async (path: string, bytes: Blob) => {
          if (this.failUploadPath?.path === path) return { error: { status: this.failUploadPath.status } };
          this.files.set(path, bytes); this.uploads++;
          const callback = this.afterNextUpload; this.afterNextUpload = undefined; await callback?.();
          return { error: null };
        },
        download: async (path: string) => { const result = { data: this.files.get(path), error: this.files.has(path) ? null : { message: 'NOT_FOUND' } }; const callback = this.afterNextDownload; this.afterNextDownload = undefined; await callback?.(); return result; },
        remove: async (paths: string[]) => { const callback = this.beforeNextRemove; this.beforeNextRemove = undefined; await callback?.(); for (const path of paths) this.files.delete(path); return { error: null }; },
      }) },
    };
  }
}

vi.stubGlobal('File', NodeFile);
vi.stubGlobal('Blob', NodeBlob);
vi.stubGlobal('crypto', webcrypto);
let deviceA: Database; let deviceB: Database; let transport: MemoryTransport;
const story = '第一章 初见\n“你好。”小雨说。\n窗外的花开了。\n第二章 归途\n我们一起回家。';
const novel = () => new File([story], '小雨.txt', { type: 'text/plain' });
async function setPortrait(bookId: string, characterId: string, tone: number) {
  const pngChunk = (type: string, bytes: Buffer) => {
    const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length); header.write(type, 4);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), bytes])));
    return Buffer.concat([header, bytes, crc]);
  };
  const dimensions = Buffer.alloc(13); dimensions.writeUInt32BE(256); dimensions.writeUInt32BE(256, 4);
  dimensions[8] = 8; dimensions[9] = 6;
  const pixels = Buffer.alloc(256 * 1025, tone);
  for (let index = 0; index < pixels.length; index += 1025) pixels[index] = 0;
  const image = new Blob([new Uint8Array(Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', dimensions),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0)),
  ]))], { type: 'image/png' });
  const digest = await validateAvatarImage(image);
  const previous = await db.avatars.get(characterId);
  const row = { bookId, characterId, image, digest, revision: crypto.randomUUID(), updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1) };
  await db.characters.put({ bookId, id: characterId, name: '小雨', aliases: ['雨姑娘'] });
  await db.avatars.put(row);
  return row;
}
beforeEach(async () => {
  transport = new MemoryTransport(); state.cloud = transport;
  deviceA = new ReaderDatabase('sync-device-a-' + crypto.randomUUID());
  deviceB = new ReaderDatabase('sync-device-b-' + crypto.randomUUID());
  state.database = deviceA;
  localStorage.clear(); configureCloud('https://sync-test.supabase.co', 'sb_publishable_test_only');
});
afterEach(async () => { await deviceA.delete(); await deviceB.delete(); state.database = undefined; });
async function consentAndUpload() {
  const book = await importBook(novel());
  await setBookCloud(book.id, true); await syncLibrary();
  return book;
}

describe('two-device client synchronization with an offline transport', () => {
  it('keeps an unapproved series volume and its evidence out of the approved volume, and restores story data on a second device', async () => {
    const first = await consentAndUpload();
    const other = await importBook(new File(['第一章 外传\n另一册私有原文。'], '外传.txt', { type: 'text/plain' }));
    await prepareLocalBookForAccount(other.id, 'account-a');
    const scope = 'https://sync-test.supabase.co|account-a';
    const seriesId = crypto.randomUUID();
    await db.series.put({ id: seriesId, scope, name: '渡口系列', updatedAt: 1 });
    for (const [index, book] of [first, other].entries()) {
      await db.seriesBooks.put({ id: seriesBookId(seriesId, book.id), scope, seriesId, bookId: book.id, position: index, updatedAt: 2 });
      const [chapter] = await listChapters(book.id);
      const text = chapter.paragraphs[0];
      await db.plotEvents.put({
        id: `${chapter.id}:event`, bookId: book.id, chapterId: chapter.id, seriesId,
        order: { chapterIndex: 0, paragraphIndex: 0, offset: 0 },
        revisions: [{ id: crypto.randomUUID(), description: index ? '私有剧情不能跟随另一册' : '公开同步选择内的剧情', characterIds: [],
          kind: 'fact', source: 'ai', status: 'active', confidence: .9, updatedAt: 5,
          evidence: { chapterId: chapter.id, paragraphIndex: 0, start: 0, end: text.length, text },
          visibleAt: { chapterIndex: 0, paragraphIndex: 0, offset: text.length } }],
      });
    }
    await syncLibrary();
    expect(transport.rows().has(other.id)).toBe(false);
    const row = transport.rows().get(first.id)!;
    const payload = row.payload;
    expect(payload.story?.memberships.map(row => row.bookId)).toEqual([first.id]);
    expect(JSON.stringify(payload)).not.toContain('私有剧情');
    expect(JSON.stringify(payload)).not.toContain(other.id);
    // A legacy client's metadata update can omit the optional extension.
    const { story: _legacyField, ...legacyPayload } = payload;
    transport.rows().set(first.id, { ...row, revision: row.revision + 1, payload: legacyPayload });
    await syncLibrary();
    expect(transport.rows().get(first.id)?.payload.story).toEqual(payload.story);
    transport.currentUser = 'account-b';
    expect((await filterBooksForAccount(await db.books.toArray(), 'account-b')).map(book => book.id)).not.toContain(first.id);
    const otherAccount = { origin: 'https://sync-test.supabase.co', userId: 'account-b' };
    const otherBackup = await (await exportBackup(otherAccount)).text();
    expect(otherBackup).not.toContain('渡口系列');
    expect(otherBackup).not.toContain('公开同步选择内的剧情');
    await prepareLocalBookForAccount(first.id, 'account-b');
    expect(await db.plotEvents.where('bookId').equals(first.id).count()).toBe(0);
    await setBookCloud(first.id, true);
    await syncLibrary();
    expect(transport.rows().get(first.id)?.payload.story).toBeUndefined();
    transport.currentUser = 'account-a';
    await syncLibrary();
    expect(await db.plotEvents.where('bookId').equals(first.id).count()).toBe(1);
    state.database = deviceB;
    await syncLibrary();
    expect(await db.plotEvents.where('bookId').equals(first.id).count()).toBe(1);
    expect(await db.series.get(seriesId)).toMatchObject({ scope, name: '渡口系列' });
    const backup = await exportBackup({ origin: 'https://sync-test.supabase.co', userId: 'account-a' });
    expect(await backup.text()).not.toContain('account-a');
    await deviceB.delete();
    await deviceB.open();
    await restoreBackup(new File([backup], '小说备份.json'));
    expect(await db.plotEvents.where('bookId').equals(first.id).count()).toBe(1);
    expect(await db.series.get(seriesId)).toMatchObject({ scope: 'local', name: '渡口系列' });
  });

  it('upgrades a populated V0.5 database without changing book, character, avatar, progress or correction records', async () => {
    const legacy = new Dexie(deviceA.name);
    legacy.version(1).stores({
      books: 'id, fingerprint, updatedAt, shelfId', files: 'bookId', chapters: 'id, bookId, [bookId+index]',
      progress: 'bookId, updatedAt', bookmarks: 'id, bookId, chapterId', shelves: 'id, updatedAt',
      characters: 'id, bookId', dialogues: 'id, bookId, chapterId', corrections: 'id, bookId, dialogueId',
      jobs: 'id, bookId, chapterId, status', settings: 'id', syncState: 'id, updatedAt',
    });
    legacy.version(2).stores({ avatars: 'characterId, bookId' });
    const bookId = 'older-book';
    const chapterId = 'older-chapter';
    const characterId = 'older-character';
    const position = { chapterIndex: 0, paragraphIndex: 0, offset: 0 };
    const portrait = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const character = initializeCharacterIdentity({ id: characterId, bookId, name: '小雨', aliases: [] }, position);
    const progress = { bookId, chapterId, paragraphIndex: 0, offset: 2, updatedAt: 2, version: 1 };
    const bookmark = { id: 'older-bookmark', bookId, chapterId, paragraphIndex: 0, label: '旧书签', createdAt: 3 };
    const correction = { id: 'older-correction', bookId, dialogueId: 'older-line', characterId, updatedAt: 4 };
    try {
      await legacy.open();
      expect(legacy.verno).toBe(2);
      await legacy.table('books').put({ id: bookId, title: '旧书', updatedAt: 1 });
      await legacy.table('characters').put(character);
      await legacy.table('avatars').put({ characterId, bookId, image: portrait, revision: 'older-avatar', updatedAt: 5 });
      await legacy.table('progress').put(progress);
      await legacy.table('bookmarks').put(bookmark);
      await legacy.table('corrections').put(correction);
    } finally { legacy.close(); }
    await deviceA.open();
    expect(deviceA.verno).toBe(3);
    expect(await db.books.get(bookId)).toMatchObject({ id: bookId, title: '旧书', updatedAt: 1 });
    expect(await db.characters.get(characterId)).toEqual(character);
    const avatar = await db.avatars.get(characterId);
    expect(avatar?.revision).toBe('older-avatar');
    expect(new Uint8Array(await avatar!.image!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await db.progress.get(bookId)).toEqual(progress);
    expect(await db.bookmarks.get(bookmark.id)).toEqual(bookmark);
    expect(await db.corrections.get(correction.id)).toEqual(correction);
    expect(await db.plotEvents.count()).toBe(0);
    expect(await db.series.count()).toBe(0);
  });
  it('uploads only after per-book consent and syncs verified Blob bytes and reset revisions on two devices', async () => {
    const { id } = await importBook(novel());
    const initial = await setPortrait(id, 'rain', 129);
    await syncLibrary();
    expect(transport.avatarUploads).toBe(0);
    expect(transport.rows().size).toBe(0);
    await setBookCloud(id, true);
    await syncLibrary();
    expect(transport.avatarUploads).toBe(1);
    expect(transport.rows().get(id)?.payload.avatars).toEqual([{
      bookId: id, characterId: 'rain', revision: initial.revision, updatedAt: initial.updatedAt, digest: initial.digest,
    }]);
    expect([...transport.avatarFiles.keys()]).toEqual([`account-a/${id}/initial/${initial.digest}.png`]);
    state.database = deviceB;
    await syncLibrary();
    expect(transport.avatarDownloads).toBe(1);
    const downloaded = await db.avatars.get('rain');
    expect(downloaded?.revision).toBe(initial.revision);
    await expect(validateAvatarImage(downloaded!.image!)).resolves.toBe(initial.digest);
    await syncLibrary();
    expect(transport.avatarDownloads).toBe(1);
    expect(transport.avatarUploads).toBe(1);
    await resetCharacterAvatar(id, 'rain');
    await syncLibrary();
    state.database = deviceA;
    await syncLibrary();
    expect((await db.avatars.get('rain'))?.image).toBeUndefined();
    expect(transport.rows().get(id)?.payload.avatars?.[0].digest).toBeUndefined();
    expect(transport.avatarUploads).toBe(1);
  });

  it('keeps avatar rows isolated when importing the same novel and archives the first account offline', async () => {
    const book = await consentAndUpload();
    const first = await setPortrait(book.id, 'shared-id', 156);
    await syncLibrary();
    transport.currentUser = 'account-b';
    await syncLibrary();
    expect(await filterBooksForAccount(await db.books.toArray(), 'account-b')).toEqual([]);
    await importBook(novel(), imported => prepareLocalBookForAccount(imported.id, 'account-b'));
    expect(await db.avatars.get('shared-id')).toBeUndefined();
    const second = await setPortrait(book.id, 'shared-id', 176);
    await setBookCloud(book.id, true);
    await syncLibrary();
    expect(transport.rows('account-b').get(book.id)?.payload.avatars?.[0].digest).toBe(second.digest);
    expect(transport.rows('account-a').get(book.id)?.payload.avatars?.[0].digest).toBe(first.digest);
    transport.currentUser = 'account-a';
    await prepareLocalBookForAccount(book.id, 'account-a');
    expect((await db.avatars.get('shared-id'))?.digest).toBe(first.digest);
    await expect(validateAvatarImage((await db.avatars.get('shared-id'))!.image!)).resolves.toBe(first.digest);
  });

  it('preserves the local portrait when a new cloud portrait fails verification', async () => {
    const book = await consentAndUpload();
    const original = await setPortrait(book.id, 'rain', 145);
    await syncLibrary();
    state.database = deviceB;
    await syncLibrary();
    state.database = deviceA;
    const newer = await setPortrait(book.id, 'rain', 195);
    await syncLibrary();
    transport.avatarFiles.set(`account-a/${book.id}/initial/${newer.digest}.png`, new Blob(['bad bytes'], { type: 'image/png' }));
    state.database = deviceB;
    const other = await importBook(new File(['第一章 另一本书\n内容仍然可以同步。'], '另一本.txt'));
    await setBookCloud(other.id, true);
    await expect(syncLibrary()).rejects.toThrow('头像下载或内容校验失败');
    expect((await db.avatars.get('rain'))?.digest).toBe(original.digest);
    await expect(validateAvatarImage((await db.avatars.get('rain'))!.image!)).resolves.toBe(original.digest);
    expect(transport.rows().has(other.id)).toBe(true);
  });

  it('stops additional portrait uploads and metadata after consent is revoked in flight', async () => {
    const book = await consentAndUpload();
    await setPortrait(book.id, 'first-draw', 141);
    await setPortrait(book.id, 'next-draw', 178);
    transport.beforeNextAvatarUpload = () => setBookCloud(book.id, false);
    await expect(syncLibrary()).rejects.toThrow('上传许可已取消');
    expect((await db.books.get(book.id))?.cloudEnabled).toBe(false);
    expect(transport.avatarUploads).toBe(1);
    expect(transport.rows().get(book.id)?.payload.avatars).toBeUndefined();
    expect(await db.avatars.where('bookId').equals(book.id).count()).toBe(2);
    await syncLibrary();
    expect(transport.avatarUploads).toBe(1);
    await setBookCloud(book.id, true);
    await syncLibrary();
    expect(transport.avatarUploads).toBe(2);
    expect(transport.rows().get(book.id)?.payload.avatars).toHaveLength(2);
  });

  it('keeps avatar edits made during metadata CAS and resynchronizes the latest revision', async () => {
    const book = await consentAndUpload();
    const first = await setPortrait(book.id, 'rain', 144);
    let newerDigest = '';
    transport.afterNextSave = async () => { newerDigest = (await setPortrait(book.id, 'rain', 200)).digest; };
    await syncLibrary();
    expect((await db.avatars.get('rain'))?.digest).toBe(newerDigest);
    expect(transport.rows().get(book.id)?.payload.avatars?.[0].digest).toBe(first.digest);
    await syncLibrary();
    expect(transport.rows().get(book.id)?.payload.avatars?.[0].digest).toBe(newerDigest);
  });

  it('retains a compatible avatar manifest when a legacy device omits it', async () => {
    const book = await consentAndUpload();
    const first = await setPortrait(book.id, 'rain', 143);
    await syncLibrary();
    const cloud = transport.rows().get(book.id)!;
    const payload = { ...cloud.payload, avatars: undefined, book: { ...cloud.payload.book, title: '旧设备修改的标题', updatedAt: Date.now() + 10 } };
    transport.rows().set(book.id, { ...cloud, revision: cloud.revision + 1, payload });
    await syncLibrary();
    expect((await db.books.get(book.id))?.title).toBe('旧设备修改的标题');
    expect((await db.avatars.get('rain'))?.digest).toBe(first.digest);
    expect(transport.rows().get(book.id)?.payload.avatars?.[0].digest).toBe(first.digest);
    expect(transport.avatarUploads).toBe(1);
  });

  it('requires file opt-in, downloads verified original bytes, and separates metadata from progress', async () => {
    const book = await importBook(novel());
    await syncLibrary(); expect(transport.uploads).toBe(0); expect(transport.rows().size).toBe(0);
    await setBookCloud(book.id, true); await syncLibrary();
    state.database = deviceB;
    expect((await syncLibrary()).downloaded).toBe(1);
    expect(await (await db.files.get(book.id))!.bytes.text()).toBe(story);
    const chapters = await listChapters(book.id);
    await saveProgress(book.id, chapters[0].id, 1, 2); await syncLibrary();
    state.database = deviceA;
    await db.books.update(book.id, { title: '本机重新命名', updatedAt: Date.now() + 10 });
    await syncLibrary();
    expect((await db.books.get(book.id))?.title).toBe('本机重新命名');
    expect(await db.progress.get(book.id)).toMatchObject({ paragraphIndex: 1, offset: 2 });
    expect(transport.rows().get(book.id)?.payload.progress).toMatchObject({ paragraphIndex: 1, offset: 2 });
  });
  it('polls revisions without refetching unchanged books or checking their Storage objects', async () => {
    const book = await consentAndUpload();
    state.database = deviceB; await syncLibrary({ verifyUnchangedFiles: false });
    const reads = transport.recordReads; const checks = transport.fileChecks;
    await syncLibrary({ verifyUnchangedFiles: false });
    expect(transport.recordReads).toBe(reads);
    expect(transport.fileChecks).toBe(checks);
    state.database = deviceA;
    await db.books.update(book.id, { author: '新的作者名', updatedAt: Date.now() + 10 });
    await syncLibrary({ verifyUnchangedFiles: false });
    expect(transport.recordReads).toBe(reads);
    state.database = deviceB; await syncLibrary({ verifyUnchangedFiles: false });
    expect(transport.recordReads).toBe(reads + 1);
    expect((await db.books.get(book.id))?.author).toBe('新的作者名');
  });
  it('retries a book revision race with current local progress and merges independent book metadata edits', async () => {
    const book = await consentAndUpload();
    const chapter = (await listChapters(book.id))[0];
    await db.books.update(book.id, { title: '本机修改书名', updatedAt: Date.now() + 10 });
    transport.beforeNextSave = async () => {
      const current = transport.rows().get(book.id)!;
      transport.rows().set(book.id, { ...current, revision: current.revision + 1, payload: { ...current.payload,
        book: { ...current.payload.book, author: '远程修改作者', updatedAt: Date.now() + 100 } } });
      await saveProgress(book.id, chapter.id, 1, 2);
    };
    expect(await syncLibrary()).toMatchObject({ uploaded: 1, conflicts: 1 });
    expect(transport.rows().get(book.id)?.payload).toMatchObject({
      book: { title: '本机修改书名', author: '远程修改作者' },
      progress: { paragraphIndex: 1, offset: 2 },
    });
    expect(await db.books.get(book.id)).toMatchObject({ title: '本机修改书名', author: '远程修改作者' });
  });
  it('preserves both versions of a conflicting metadata field and syncs after the reader aligns them', async () => {
    const book = await consentAndUpload();
    state.database = deviceB; await syncLibrary();
    await db.books.update(book.id, { title: '另一台的标题', updatedAt: Date.now() + 100 });
    await syncLibrary();
    state.database = deviceA;
    await db.books.update(book.id, { title: '此处的标题', updatedAt: Date.now() + 10 });
    await expect(syncLibrary()).rejects.toThrow('书名在两台设备上都有不同修改');
    expect((await db.books.get(book.id))?.title).toBe('此处的标题');
    expect(transport.rows().get(book.id)?.payload.book.title).toBe('另一台的标题');
    await db.books.update(book.id, { title: '另一台的标题', updatedAt: Date.now() + 200 });
    await expect(syncLibrary()).resolves.toMatchObject({ uploaded: 1 });
  });
  it('keeps unrelated books and preferences syncing through a project upload limit or interrupted upload', async () => {
    const limited = await importBook(novel());
    const other = await importBook(new File(['Chapter One\nAnother local story.'], 'Other.txt'));
    await setBookCloud(limited.id, true); await setBookCloud(other.id, true);
    await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, theme: 'dark' } });
    transport.failUploadPath = { path: `account-a/${limited.id}/original.txt`, status: 413 };
    await expect(syncLibrary()).rejects.toThrow('文件超出当前云项目上传限制');
    expect(transport.rows().has(other.id)).toBe(true);
    expect(transport.rows().has(limited.id)).toBe(false);
    expect(transport.profiles.get('account-a')?.payload.preferences.theme).toBe('dark');
    expect(await listChapters(limited.id)).toHaveLength(2);
    transport.failUploadPath.status = 503;
    await expect(syncLibrary()).rejects.toThrow('未完成的文件将从头上传');
    transport.failUploadPath = undefined;
    expect(await syncLibrary()).toMatchObject({ uploaded: 1 });
    expect(transport.rows().size).toBe(2);
  });
  it('keeps offline changes local and converges on reconnect without requiring another import', async () => {
    const book = await consentAndUpload();
    const chapter = (await listChapters(book.id))[0];
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      await saveProgress(book.id, chapter.id, 1, 2);
      await expect(syncLibrary()).rejects.toThrow('当前离线');
      expect(transport.rows().get(book.id)?.payload.progress).toBeUndefined();
      expect(await db.progress.get(book.id)).toMatchObject({ paragraphIndex: 1, offset: 2 });
    } finally { offline.mockRestore(); }
    await syncLibrary();
    state.database = deviceB; await syncLibrary();
    expect(await db.progress.get(book.id)).toMatchObject({ paragraphIndex: 1, offset: 2 });
  });
  it('does not send cloud data for an authenticated account outside the owner whitelist', async () => {
    transport.currentUser = 'account-b';
    transport.allowedPrivateUsers.delete('account-b');
    const book = await importBook(novel());
    expect(await getPrivateCloudAccess('account-b')).toBe('denied');
    await expect(setBookCloud(book.id, true)).rejects.toThrow('未获准');
    await expect(syncLibrary()).rejects.toThrow('未获准');
    expect(transport.recordReads).toBe(0);
    expect(transport.uploads).toBe(0);
    expect(await listChapters(book.id)).toHaveLength(2);
    expect(await filterBooksForAccount([book])).toContain(book);
  });
  it('fails closed when owner verification is unavailable or the authenticated session changes during it', async () => {
    const book = await importBook(novel());
    transport.privateAccessError = true;
    expect(await getPrivateCloudAccess('account-a')).toBe('unavailable');
    await expect(setBookCloud(book.id, true)).rejects.toThrow('暂时无法验证私有云权限');
    transport.privateAccessError = false;
    transport.beforeNextPrivateAccess = async () => { transport.currentUser = 'account-b'; };
    expect(await getPrivateCloudAccess('account-a')).toBe('unavailable');
    expect((await db.books.get(book.id))?.cloudEnabled).toBe(false);
    expect(transport.uploads).toBe(0);
  });
  it('allows the active owner to revoke upload consent offline even when the server gate is inaccessible', async () => {
    const book = await consentAndUpload();
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      transport.privateAccessError = true;
      await setBookCloud(book.id, false);
      expect((await db.books.get(book.id))?.cloudEnabled).toBe(false);
      expect(await listChapters(book.id)).toHaveLength(2);
      expect(transport.rows().has(book.id)).toBe(true);
    } finally { offline.mockRestore(); }
  });
  it('retains a remote bookmark when local reading changes during a merged upload', async () => {
    const book = await consentAndUpload();
    state.database = deviceB; await syncLibrary();
    const chapter = (await listChapters(book.id))[0];
    await db.bookmarks.put({ id: 'remote-bookmark', bookId: book.id, chapterId: chapter.id, paragraphIndex: 0, label: '另一台设备的书签', createdAt: Date.now() });
    await syncLibrary();
    state.database = deviceA;
    await db.books.update(book.id, { title: '上传中的改名', updatedAt: Date.now() + 10 });
    transport.afterNextSave = async () => { await saveProgress(book.id, chapter.id, 1, 2); };
    await syncLibrary();
    await syncLibrary();
    expect(await db.progress.get(book.id)).toMatchObject({ paragraphIndex: 1, offset: 2 });
    expect((await db.bookmarks.get('remote-bookmark'))?.label).toBe('另一台设备的书签');
    expect(transport.rows().get(book.id)?.payload.bookmarks.map(b => b.id)).toContain('remote-bookmark');
  });
  it('preserves identity history on an otherwise unchanged device receiving a legacy upload', async () => {
    const book = await consentAndUpload();
    const at = { chapterIndex: 0, paragraphIndex: 0, offset: 0 };
    const original = initializeCharacterIdentity({ id: 'rain', bookId: book.id, name: '小雨', aliases: [] }, at);
    await db.characters.put(original);
    await manualAddAlias(original.id, '归人', { ...at, chapterIndex: 1 });
    await syncLibrary();

    const cloud = transport.rows().get(book.id)!;
    const legacy = { id: original.id, bookId: book.id, name: '小雨', aliases: ['旧版改名'] };
    transport.rows().set(book.id, { ...cloud, revision: cloud.revision + 1, payload: { ...cloud.payload, characters: [legacy] } });
    await syncLibrary();
    const recovered = (await db.characters.get(original.id))!;
    expect(recovered.identity?.events).toMatchObject([{ source: 'manual', kind: 'alias', value: '归人' }]);
    expect(recovered.aliases).toContain('旧版改名');
    expect(transport.rows().get(book.id)?.payload.characters).toEqual([recovered]);

    const next = transport.rows().get(book.id)!;
    transport.rows().set(book.id, { ...next, revision: next.revision + 1, payload: { ...next.payload, characters: [] } });
    await expect(syncLibrary()).rejects.toThrow('本机记录已保留');
    expect(await db.characters.get(original.id)).toEqual(recovered);
  });
  it('keeps new local identity history when a legacy device removes the same person', async () => {
    const book = await consentAndUpload();
    const legacy = { id: 'rain', bookId: book.id, name: '小雨', aliases: [] };
    await db.characters.put(legacy);
    await syncLibrary();
    const recorded = initializeCharacterIdentity(legacy, { chapterIndex: 0, paragraphIndex: 0, offset: 0 });
    await db.characters.put(recorded);
    const cloud = transport.rows().get(book.id)!;
    transport.rows().set(book.id, { ...cloud, revision: cloud.revision + 1, payload: { ...cloud.payload, characters: [] } });
    await expect(syncLibrary()).rejects.toThrow('本机记录已保留');
    expect(await db.characters.get(legacy.id)).toEqual(recorded);
  });
  it('keeps an opted-out device local until re-enabled, then propagates a remote tombstone', async () => {
    const book = await consentAndUpload();
    state.database = deviceB; await syncLibrary(); await setBookCloud(book.id, false);
    state.database = deviceA; await deleteBook(book.id); await syncLibrary();
    expect(transport.files.size).toBe(0); expect(transport.rows().get(book.id)?.payload.chapters).toEqual([]);
    state.database = deviceB; await syncLibrary();
    expect((await db.books.get(book.id))?.deletedAt).toBeUndefined();
    expect((await db.books.get(book.id))?.cloudEnabled).toBe(false);
    await setBookCloud(book.id, true); await syncLibrary();
    expect((await db.books.get(book.id))?.deletedAt).toBeGreaterThan(0);
  });
  it('rejects a corrupted downloaded original before changing the destination library', async () => {
    const book = await consentAndUpload();
    const path = transport.rows().get(book.id)!.payload.file!.path;
    transport.files.set(path, new Blob(['Incorrect file bytes']));
    state.database = deviceB;
    const other = await importBook(new File(['Chapter One\nA different novel.'], 'Other.txt'));
    await expect(syncLibrary()).rejects.toThrow('指纹');
    expect(await db.books.get(other.id)).toBeDefined(); expect(await db.books.get(book.id)).toBeUndefined();
  });
  it('does not upload the prior account book or categories after an account switch', async () => {
    await consentAndUpload();
    await db.shelves.put({ id: 'private-a', name: 'A 的私人分类', updatedAt: Date.now() });
    await syncLibrary();
    transport.currentUser = 'account-b'; await syncLibrary(); await syncLibrary();
    expect(transport.rows('account-b').size).toBe(0);
    expect(JSON.stringify(transport.profiles.get('account-b'))).not.toContain('A 的私人分类');
  });
  it('merges offline category additions and independent preference fields on both devices', async () => {
    await syncLibrary(); state.database = deviceB; await syncLibrary();
    state.database = deviceA;
    await db.shelves.put({ id: 'shelf-a', name: 'A 新增', updatedAt: 1 });
    await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, theme: 'dark' } });
    state.database = deviceB;
    await db.shelves.put({ id: 'shelf-b', name: 'B 新增', updatedAt: 2 });
    await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, fontSize: 26 } });
    state.database = deviceA; await syncLibrary(); state.database = deviceB; await syncLibrary();
    expect((await db.shelves.toArray()).map(s => s.id).sort()).toEqual(['shelf-a', 'shelf-b']);
    expect((await db.settings.get('preferences'))?.value).toMatchObject({ theme: 'dark', fontSize: 26 });
    state.database = deviceA; await syncLibrary();
    expect((await db.shelves.toArray()).map(s => s.id).sort()).toEqual(['shelf-a', 'shelf-b']);
    await db.shelves.update('shelf-a', { deletedAt: 10, updatedAt: 10 });
    state.database = deviceB; await db.shelves.update('shelf-a', { name: '旧设备稍后改名', updatedAt: 20 });
    state.database = deviceA; await syncLibrary(); state.database = deviceB; await syncLibrary();
    expect((await db.shelves.get('shelf-a'))?.deletedAt).toBe(10);
  });
  it('retries profile CAS conflicts with fresh local and remote data instead of losing edits', async () => {
    await syncLibrary();
    await db.shelves.put({ id: 'local-category', name: '本机新增', updatedAt: 1 });
    const before = transport.profileWrites;
    transport.beforeNextProfileWrite = async () => {
      const row = transport.profiles.get(transport.currentUser)!;
      row.payload.shelves.push({ id: 'racing-category', name: '另一台设备同时新增', updatedAt: 2 });
      row.payload.preferences.theme = 'sepia'; row.revision++;
      await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, fontSize: 29 } });
    };
    await syncLibrary();
    expect(transport.profileWrites - before).toBe(2);
    expect((await db.shelves.toArray()).map(s => s.id).sort()).toEqual(['local-category', 'racing-category']);
    expect((await db.settings.get('preferences'))?.value).toMatchObject({ theme: 'sepia', fontSize: 29 });
  });
  it('keeps the old profile base if preferences change while a merged profile is being saved', async () => {
    await syncLibrary(); state.database = deviceB; await syncLibrary();
    await db.shelves.put({ id: 'remote-category', name: '远端新增', updatedAt: 1 }); await syncLibrary();
    state.database = deviceA;
    await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, theme: 'dark' } });
    transport.afterNextProfileSave = async () => { await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, theme: 'dark', fontSize: 30 } }); };
    await syncLibrary(); await syncLibrary();
    expect((await db.shelves.get('remote-category'))?.name).toBe('远端新增');
    expect((await db.settings.get('preferences'))?.value).toMatchObject({ theme: 'dark', fontSize: 30 });
  });
  it('lets explicit reimport restore a cloud tombstone and its bytes, while stale metadata cannot revive it', async () => {
    const book = await consentAndUpload();
    state.database = deviceB; await syncLibrary();
    state.database = deviceA; await deleteBook(book.id); await syncLibrary();
    const deletedAt = (await db.books.get(book.id))!.deletedAt!;
    state.database = deviceB;
    await db.books.update(book.id, { title: '旧设备只修改了书名', updatedAt: deletedAt + 1000 });
    await syncLibrary(); expect((await db.books.get(book.id))?.deletedAt).toBe(deletedAt);
    const restored = await importBook(novel()); expect(restored.restoredAt).toBeGreaterThan(deletedAt);
    await setBookCloud(book.id, true); await syncLibrary();
    expect(transport.rows().get(book.id)?.payload.book.deletedAt).toBeUndefined(); expect(transport.files.size).toBe(1);
    state.database = deviceA; await syncLibrary();
    expect((await db.books.get(book.id))?.deletedAt).toBeUndefined();
    const fresh = new ReaderDatabase('sync-fresh-restored-' + crypto.randomUUID());
    state.database = fresh;
    try { await syncLibrary(); expect(await (await db.files.get(book.id))!.bytes.text()).toBe(story); }
    finally { await fresh.delete(); }
  });
  it('rejects an oversized source before uploading or creating a cloud book', async () => {
    const book = await importBook(novel());
    const file = (await db.files.get(book.id))!;
    await db.files.put({ ...file, bytes: new Blob([new Uint8Array(CLOUD_FILE_MAX_BYTES + 1)]) });
    await setBookCloud(book.id, true);
    await expect(syncLibrary()).rejects.toThrow('50 MiB');
    expect(transport.uploads).toBe(0); expect(transport.rows().size).toBe(0); expect(await db.books.get(book.id)).toBeDefined();
  });
  it('rejects an oversized envelope before any original file upload', async () => {
    const book = await importBook(novel());
    await db.books.update(book.id, { cover: 'data:image/png;base64,' + 'A'.repeat(CLOUD_BUNDLE_MAX_BYTES) });
    await setBookCloud(book.id, true);
    await expect(syncLibrary()).rejects.toThrow('30 MiB');
    expect(transport.uploads).toBe(0); expect(transport.rows().size).toBe(0);
  });
  it('exports a restorable backup after a remote tombstone removes chapters previously read here', async () => {
    const book = await consentAndUpload();
    state.database = deviceB; await syncLibrary();
    const chapter = (await listChapters(book.id))[0];
    await saveProgress(book.id, chapter.id, 1, 2); await syncLibrary();
    state.database = deviceA; await deleteBook(book.id); await syncLibrary();
    state.database = deviceB; await syncLibrary();
    const backup = await exportBackup();
    const fresh = new ReaderDatabase('sync-deleted-backup-' + crypto.randomUUID());
    state.database = fresh;
    try {
      await expect(restoreBackup(new File([backup], 'after-delete.json'))).resolves.toBeUndefined();
      expect((await db.books.get(book.id))?.deletedAt).toBeGreaterThan(0);
      expect(await db.progress.get(book.id)).toBeUndefined();
    } finally { await fresh.delete(); }
  });
  it('keeps same-fingerprint account snapshots private and requires fresh per-account upload consent', async () => {
    const book = await consentAndUpload(); const chapter = (await listChapters(book.id))[0];
    await db.books.update(book.id, { title: 'A private title', updatedAt: Date.now() });
    await db.bookmarks.put({ id: 'only-a', bookId: book.id, chapterId: chapter.id, paragraphIndex: 0, label: 'A private note', createdAt: Date.now() });
    transport.currentUser = 'account-b';
    expect(await filterBooksForAccount(await db.books.toArray(), 'account-b')).toEqual([]);
    await expect(setBookCloud(book.id, true)).rejects.toThrow('重新导入');
    const prepared = await prepareLocalBookForAccount(book.id, 'account-b');
    expect(prepared.title).toBe('小雨'); expect(prepared.cloudEnabled).toBe(false);
    expect(await db.bookmarks.count()).toBe(0);
    expect((await filterBooksForAccount(await db.books.toArray(), 'account-b')).length).toBe(1);
    await syncLibrary(); expect(transport.rows('account-b').size).toBe(0);
    await setBookCloud(book.id, true); await syncLibrary();
    expect(JSON.stringify(transport.rows('account-b').get(book.id))).not.toContain('A private');
    await db.bookmarks.put({ id: 'only-b', bookId: book.id, chapterId: chapter.id, paragraphIndex: 0, label: 'B private note', createdAt: Date.now() });
    transport.currentUser = 'account-a'; await syncLibrary();
    expect((await db.bookmarks.get('only-a'))?.label).toBe('A private note');
    expect(await db.bookmarks.get('only-b')).toBeUndefined();
    expect(JSON.stringify(transport.rows('account-a').get(book.id))).not.toContain('B private');
    transport.currentUser = 'account-b'; await syncLibrary();
    expect((await db.bookmarks.get('only-b'))?.label).toBe('B private note');
    expect(await db.bookmarks.get('only-a')).toBeUndefined();
  });
  it('binds cloud choices to project origin as well as the authenticated user id', async () => {
    const book = await consentAndUpload();
    configureCloud('https://different-project.supabase.co', 'sb_publishable_test_only');
    expect(await filterBooksForAccount(await db.books.toArray(), 'account-a')).toEqual([]);
    await expect(setBookCloud(book.id, true)).rejects.toThrow('重新导入');
    expect((await filterBooksForAccount(await db.books.toArray())).length).toBe(1);
  });
  it('rejects late authentication when granting upload consent after an account change', async () => {
    const book = await importBook(novel());
    transport.beforeNextGetUser = async () => { transport.currentUser = 'account-b'; };
    await expect(setBookCloud(book.id, true)).rejects.toThrow('账号');
    expect((await db.books.get(book.id))?.cloudEnabled).toBe(false);
    expect(await db.settings.get(`cloud-owner:${book.id}`)).toBeUndefined();
  });
  it('rejects a downloaded bundle if the session changes before it can be installed', async () => {
    const book = await consentAndUpload(); state.database = deviceB;
    transport.afterNextDownload = async () => { transport.currentUser = 'account-b'; };
    await expect(syncLibrary()).rejects.toThrow('账号');
    expect(await db.books.get(book.id)).toBeUndefined(); expect(await db.files.get(book.id)).toBeUndefined();
  });
  it('stops further data writes after upload consent is revoked while a file request is in flight', async () => {
    const book = await importBook(novel()); await setBookCloud(book.id, true);
    transport.afterNextUpload = async () => { await setBookCloud(book.id, false); };
    await expect(syncLibrary()).rejects.toThrow('许可');
    expect(transport.rows().size).toBe(0); expect((await db.books.get(book.id))?.cloudEnabled).toBe(false);
  });
  it('repairs a missing cloud original from an already authorized verified local copy', async () => {
    const book = await consentAndUpload(); transport.files.clear(); const uploads = transport.uploads;
    await syncLibrary(); expect(transport.uploads).toBe(uploads + 1);
    state.database = deviceB; await syncLibrary();
    expect(await (await db.files.get(book.id))!.bytes.text()).toBe(story);
  });
  it('recovers a missing local original without discarding newer local metadata or position', async () => {
    const book = await consentAndUpload(); const chapter = (await listChapters(book.id))[0];
    await db.files.delete(book.id); await db.books.update(book.id, { title: 'Keep this local title', updatedAt: Date.now() + 100 });
    await saveProgress(book.id, chapter.id, 1, 2); await syncLibrary();
    expect((await db.books.get(book.id))?.title).toBe('Keep this local title');
    expect((await db.progress.get(book.id))?.paragraphIndex).toBe(1);
    expect(await (await db.files.get(book.id))!.bytes.text()).toBe(story);
  });
  it('cannot remove a newer restored generation with an older late tombstone cleanup', async () => {
    const book = await consentAndUpload(); const alive = clone(transport.rows().get(book.id)!.payload);
    const bytes = (await db.files.get(book.id))!.bytes;
    await deleteBook(book.id);
    let restoredPath = '';
    transport.beforeNextRemove = async () => {
      const row = transport.rows().get(book.id)!; const restoredAt = row.payload.book.deletedAt! + 1;
      restoredPath = `account-a/${book.id}/restored-${restoredAt}/original.txt`;
      transport.files.set(restoredPath, bytes);
      transport.rows().set(book.id, { id: book.id, revision: row.revision + 1, payload: { ...alive, book: { ...alive.book, restoredAt, updatedAt: restoredAt }, file: { ...alive.file!, path: restoredPath } } });
    };
    await syncLibrary(); expect(transport.files.has(restoredPath)).toBe(true);
    expect(transport.rows().get(book.id)?.payload.book.deletedAt).toBeUndefined();
    await syncLibrary(); expect((await db.books.get(book.id))?.deletedAt).toBeUndefined();
  });
  it('prepares a foreign tombstone before import so account B cannot accidentally restore account A', async () => {
    const book = await consentAndUpload(); await deleteBook(book.id); await syncLibrary();
    const deletedAt = (await db.books.get(book.id))!.deletedAt;
    transport.currentUser = 'account-b';
    const imported = await importBook(novel(), existing => prepareLocalBookForAccount(existing.id, 'account-b'));
    await prepareLocalBookForAccount(imported.id, 'account-b');
    expect(imported.cloudEnabled).toBe(false); expect(imported.restoredAt).toBeUndefined();
    await setBookCloud(imported.id, true); await syncLibrary();
    expect(transport.rows('account-b').get(book.id)?.payload.book.deletedAt).toBeUndefined();
    transport.currentUser = 'account-a'; await syncLibrary();
    expect((await db.books.get(book.id))?.deletedAt).toBe(deletedAt);
    expect(transport.rows('account-a').get(book.id)?.payload.book.deletedAt).toBe(deletedAt);
  });
  it('prepares account-local import snapshots without creating an auth or network client', async () => {
    const book = await consentAndUpload();
    transport.currentUser = 'account-b';
    const client = vi.spyOn(transport, 'client');
    await prepareLocalBookForAccount(book.id, 'account-b');
    expect(client).not.toHaveBeenCalled();
    expect((await db.books.get(book.id))?.cloudEnabled).toBe(false);
    client.mockRestore();
  });
  it('rejects a late local import callback carrying the previous signed-in identity', async () => {
    const book = await consentAndUpload(); transport.currentUser = 'account-b';
    await expect(prepareLocalBookForAccount(book.id, 'account-a')).rejects.toThrow('账号');
    expect((await filterBooksForAccount(await db.books.toArray(), 'account-a')).length).toBe(1);
  });
  it('switches categories and preferences entirely locally while retaining both account snapshots', async () => {
    await prepareLocalProfileForAccount('account-a');
    await db.shelves.put({ id: 'private-a', name: 'A only category', updatedAt: 1 });
    await db.settings.put({ id: 'preferences', value: { ...defaultPreferences, theme: 'dark' } });
    const client = vi.spyOn(transport, 'client');
    await prepareLocalProfileForAccount('account-b');
    expect(await db.shelves.count()).toBe(0);
    expect((await db.settings.get('preferences'))?.value).toMatchObject({ theme: 'light' });
    await db.shelves.put({ id: 'private-b', name: 'B only category', updatedAt: 2 });
    await prepareLocalProfileForAccount('account-a');
    expect((await db.shelves.toArray()).map(s => s.id)).toEqual(['private-a']);
    expect((await db.settings.get('preferences'))?.value).toMatchObject({ theme: 'dark' });
    await prepareLocalProfileForAccount('account-b');
    expect((await db.shelves.toArray()).map(s => s.id)).toEqual(['private-b']);
    expect(client).not.toHaveBeenCalled(); client.mockRestore();
  });
});
