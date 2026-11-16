// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { getAvatarOwner, resetCharacterAvatar, validateAvatarImage } from './avatar';
import { AVATAR_SIZE, inspectAvatarSource, MAX_AVATAR_SOURCE_BYTES } from './avatar-image';
import { bookOwnerKey } from './book-owner';
import { ReaderDatabase, db } from './db';
import { exportBackup, importBook, restoreBackup } from './library';
import { manualMergeCharacters, manualRenameCharacter } from '../services/character-identity';

vi.stubGlobal('File', NodeFile);
vi.stubGlobal('Blob', NodeBlob);
vi.stubGlobal('crypto', webcrypto);

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
function png({ width = AVATAR_SIZE, height = AVATAR_SIZE, animation = false, pixelCount = (AVATAR_SIZE * 4 + 1) * AVATAR_SIZE, extra = false } = {}) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const data = [signature, pngChunk('IHDR', header)];
  if (animation) data.push(pngChunk('acTL', Buffer.alloc(8)));
  if (extra) data.push(pngChunk('tEXt', Buffer.from('Comment\0Not saved in avatar')));
  data.push(pngChunk('IDAT', deflateSync(Buffer.alloc(pixelCount))), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(data);
}
const imageOf = (bytes: Buffer) => new Blob([new Uint8Array(bytes)], { type: 'image/png' });
const start = { chapterIndex: 0, paragraphIndex: 0, offset: 0 };

beforeEach(async () => { await db.delete(); await db.open(); });
afterAll(async () => { await db.delete(); });

describe('character avatar input and canonical validation', () => {
  it('checks the bytes instead of the provided MIME and bounds input before decoding', async () => {
    await expect(inspectAvatarSource(new Blob([new Uint8Array(png())], { type: 'application/octet-stream' })))
      .resolves.toEqual({ type: 'image/png', width: 256, height: 256 });
    await expect(inspectAvatarSource(new Blob(['<svg onload="alert(1)"/>'], { type: 'image/png' }))).rejects.toThrow('静态 PNG');
    await expect(inspectAvatarSource(new Blob([new Uint8Array(MAX_AVATAR_SOURCE_BYTES + 1)]))).rejects.toThrow('12 MiB');
    await expect(inspectAvatarSource(imageOf(png({ width: 8192, height: 8192 })))).rejects.toThrow('像素尺寸');
    await expect(inspectAvatarSource(imageOf(png({ animation: true })))).rejects.toThrow('不支持动画');
    await expect(inspectAvatarSource(imageOf(Buffer.concat([png(), Buffer.from('<html>')])))).rejects.toThrow('无法读取图片');
  });

  it('rejects metadata, invalid checksum and out-of-bounds inflated scanlines from storage', async () => {
    const encoded = png();
    await expect(validateAvatarImage(imageOf(encoded))).resolves.toMatch(/^[a-f\d]{64}$/);
    await expect(validateAvatarImage(imageOf(png({ extra: true })))).rejects.toThrow('无法读取图片');
    await expect(validateAvatarImage(imageOf(png({ pixelCount: 1_000_000 })))).rejects.toThrow('无法读取图片');
    const damaged = Buffer.from(encoded);
    damaged[damaged.length - 1] ^= 1;
    await expect(validateAvatarImage(imageOf(damaged))).rejects.toThrow('无法读取图片');
  });
});

describe('avatar upgrade and restoration', () => {
  it('adds an empty avatar store and keeps pre-V0.5 character and book rows', async () => {
    const name = 'onr-avatar-schema-fixture';
    await Dexie.delete(name);
    const old = new Dexie(name);
    old.version(1).stores(Object.fromEntries(db.tables.filter(table => table.name !== 'avatars').map(table => [
      table.name,
      [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(', '),
    ])));
    await old.open();
    await old.table('books').put({ id: 'legacy-book', title: '旧书' });
    await old.table('characters').put({ id: 'legacy-character', bookId: 'legacy-book', name: '阿雨', aliases: [] });
    old.close();
    const upgraded = new ReaderDatabase(name);
    try {
      await upgraded.open();
      expect(await upgraded.books.get('legacy-book')).toMatchObject({ title: '旧书' });
      expect(await upgraded.characters.get('legacy-character')).toMatchObject({ name: '阿雨' });
      expect(await upgraded.avatars.count()).toBe(0);
    } finally {
      await upgraded.delete();
    }
  });

  it('retains independent source and target avatars through rename, merge, and backup', async () => {
    const book = await importBook(new File(['第一章\n“借过一下。”'], '章.txt'));
    await db.characters.bulkPut([
      { id: 'source', bookId: book.id, name: '小雨', aliases: [] },
      { id: 'target', bookId: book.id, name: '林岚', aliases: [] },
    ]);
    const image = imageOf(png());
    const source = { characterId: 'source', bookId: book.id, revision: crypto.randomUUID(), updatedAt: 1, image, digest: await validateAvatarImage(image) };
    await db.avatars.put(source);
    await resetCharacterAvatar(book.id, 'target');
    await manualRenameCharacter('source', '雨城', start);
    await manualMergeCharacters('source', 'target', start);
    expect((await db.avatars.get('source'))?.revision).toBe(source.revision);
    const backup = await exportBackup();
    await db.delete(); await db.open();
    await restoreBackup(new File([backup], '备份.json'));
    const restored = await db.avatars.get('source');
    expect(restored).toMatchObject({ digest: source.digest, revision: source.revision });
    expect(await validateAvatarImage(restored!.image!)).toBe(source.digest);
    expect(await db.avatars.get('target')).toMatchObject({ characterId: 'target' });
    expect((await db.avatars.get('target'))?.image).toBeUndefined();
    expect((await db.characters.get('source'))?.identity?.events.map(event => event.kind)).toEqual(['rename', 'merge']);
    await resetCharacterAvatar(book.id, 'source');
    const reset = await db.avatars.get('source');
    await restoreBackup(new File([backup], '备份.json'));
    expect(await db.avatars.get('source')).toEqual(reset);
    const old = JSON.parse(await backup.text());
    delete old.avatars;
    await restoreBackup(new File([JSON.stringify(old)], '旧版备份.json'));
    expect(await db.avatars.get('source')).toEqual(reset);
    const damaged = JSON.parse(await backup.text());
    damaged.avatars[0].digest = '0'.repeat(64);
    await expect(restoreBackup(new File([JSON.stringify(damaged)], '损坏备份.json'))).rejects.toThrow('现有数据未被修改');
    expect(await db.avatars.get('source')).toEqual(reset);
  });

  it('rejects a stale edit after the local book account view changes', async () => {
    const book = await importBook(new File(['第一章\n“借过一下。”'], '章.txt'));
    await db.characters.put({ id: 'owner-test', bookId: book.id, name: '小雨', aliases: [] });
    await db.settings.put({ id: `cloud-owner:${book.id}`, value: 'old-scope' });
    const expected = await getAvatarOwner(book.id);
    await db.settings.put({ id: `cloud-owner:${book.id}`, value: 'new-scope' });
    await expect(resetCharacterAvatar(book.id, 'owner-test', expected)).rejects.toThrow('账号已变化');
    expect(await db.avatars.count()).toBe(0);
  });

  it('keeps a hidden account’s avatar out of export and rejects a colliding restore', async () => {
    const origin = 'https://example.supabase.co';
    const book = await importBook(new File(['第一章\n“借过一下。”'], '章.txt'));
    await db.settings.put({ id: bookOwnerKey(book.id), value: `${origin}|reader-a` });
    await db.characters.put({ id: 'private-character', bookId: book.id, name: '小雨', aliases: [] });
    const image = imageOf(png());
    await db.avatars.put({ characterId: 'private-character', bookId: book.id, revision: crypto.randomUUID(), updatedAt: 1, image, digest: await validateAvatarImage(image) });
    const exportedByOwner = await exportBackup({ origin, userId: 'reader-a' });
    const exportedByOther = await exportBackup({ origin, userId: 'reader-b' });
    expect(JSON.parse(await exportedByOther.text())).toMatchObject({ books: [], characters: [], avatars: [] });
    const before = await db.avatars.get('private-character');
    await expect(restoreBackup(new File([exportedByOwner], '备份.json'), { origin, userId: 'reader-b' })).rejects.toThrow('另一账号');
    expect(await db.avatars.get('private-character')).toEqual(before);
    expect((await db.settings.get(bookOwnerKey(book.id)))?.value).toBe(`${origin}|reader-a`);
  });
});
