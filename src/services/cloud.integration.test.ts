import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
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
import { importBook, listChapters, saveProgress, deleteBook, exportBackup, restoreBackup } from '../core/library';
import { CLOUD_BUNDLE_MAX_BYTES, CLOUD_FILE_MAX_BYTES, configureCloud, setBookCloud, syncLibrary } from './cloud';
import { defaultPreferences } from '../types';

interface TransportRow { id: string; payload: BookBundle; revision: number }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Transport fake only: actual syncLibrary, import/parser, file verification and two Dexie databases run unchanged.
 * This validates client reconciliation; it does not claim to validate hosted Supabase/Postgres RLS. */
class MemoryTransport {
  currentUser = 'account-a';
  records = new Map<string, Map<string, TransportRow>>();
  profiles = new Map<string, { payload: { preferences: typeof defaultPreferences; shelves: { id: string; name: string; updatedAt: number; deletedAt?: number }[] }; revision: number }>();
  files = new Map<string, Blob>();
  uploads = 0;
  afterNextSave?: () => Promise<void>;
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
        getUser: async () => ({ data: { user: { id: this.currentUser } }, error: null }),
        getSession: async () => ({ data: { session: { user: { id: this.currentUser }, access_token: this.currentUser } }, error: null }),
        stopAutoRefresh: () => {}, onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      removeAllChannels: async () => {},
      from: (table: string) => {
        const query = {
          select: () => query, eq: () => query, order: () => query,
          range: async (start: number, end: number) => ({ data: clone([...this.rows(user()).values()].sort((a, b) => a.id.localeCompare(b.id)).slice(start, end + 1)), error: null }),
          maybeSingle: async () => ({ data: this.profiles.has(user()) ? clone(this.profiles.get(user())) : null, error: null }),
        };
        if (!['reader_records', 'reader_profiles'].includes(table)) throw new Error('Unexpected table');
        return query;
      },
      rpc: async (name: string, args: { p_id: string; p_payload: BookBundle; p_expected_revision: number }) => {
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
        const rows = this.rows(user()); const previous = rows.get(args.p_id);
        if ((previous?.revision || 0) !== args.p_expected_revision) return { data: null, error: { message: 'SYNC_CONFLICT' } };
        const revision = (previous?.revision || 0) + 1;
        rows.set(args.p_id, { id: args.p_id, payload: clone(args.p_payload), revision });
        const callback = this.afterNextSave; this.afterNextSave = undefined;
        await callback?.();
        return { data: revision, error: null };
      },
      storage: { from: () => ({
        upload: async (path: string, bytes: Blob) => { this.files.set(path, bytes); this.uploads++; return { error: null }; },
        download: async (path: string) => ({ data: this.files.get(path), error: this.files.has(path) ? null : { message: 'NOT_FOUND' } }),
        remove: async (paths: string[]) => { for (const path of paths) this.files.delete(path); return { error: null }; },
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
});
