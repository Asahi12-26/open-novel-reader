import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookOwnerKey } from '../core/book-owner';
import { db } from '../core/db';
import { isSeriesCharacterLink, mergeSeriesCharacterLink, type SeriesAccess } from '../core/series-types';
import type { Book, Character } from '../types';
import { initializeCharacterIdentity } from './character-identity';
import {
  addBookToSeries, changeSeriesLink, createSeries, deleteSeries, getSeriesMembership, linkSeriesCharacters, listSeries,
  listSeriesBooks, listSeriesIdentityLinks, listSeriesMemorySources, listSeriesPeople, loadSeriesAvatars, moveSeriesBook,
  removeBookFromSeries, renameSeries, scopeForSeries,
} from './series';

vi.stubGlobal('crypto', webcrypto);
vi.stubGlobal('Blob', NodeBlob);

const guest: SeriesAccess = { origin: '' };
const accountA: SeriesAccess = { origin: 'https://reader.example', userId: 'account-a' };
const accountB: SeriesAccess = { origin: 'https://reader.example', userId: 'account-b' };
const start = { chapterIndex: 0, paragraphIndex: 0, offset: 0 };
const read = { chapterIndex: 0, paragraphIndex: 0, offset: 6 };

beforeEach(async () => { await db.delete(); await db.open(); });
afterAll(async () => { await db.delete(); });

async function book(id: string, name: string, readBook = true, owner?: SeriesAccess) {
  const row: Book = {
    id, title: id, author: '', format: 'txt', fingerprint: 'f'.repeat(64), totalWords: 12, chapterCount: 1, language: 'zh',
    coverColor: '#999999', createdAt: 0, updatedAt: 0, cloudEnabled: false,
  };
  const chapter = { id: `${id}:ch:0`, bookId: id, index: 0, title: '第一章 · 记录', paragraphs: ['同一个名字用于不同人物。'] };
  const identity = initializeCharacterIdentity({ id: `${id}:character`, bookId: id, name, aliases: [] }, start);
  await db.books.put(row);
  await db.chapters.put(chapter);
  await db.characters.put(identity);
  if (readBook) await db.progress.put({ bookId: id, chapterId: chapter.id, paragraphIndex: 0, offset: read.offset, updatedAt: 0, version: 1 });
  if (owner) await db.settings.put({ id: bookOwnerKey(id), value: scopeForSeries(owner) });
  return identity;
}

const side = (person: Character) => ({ bookId: person.bookId, characterId: person.id });

describe('reading series and identity links', () => {
  it('keeps chosen volume order separate from read permission and preserves books on series deletion', async () => {
    const main = await book('正传', '青禾');
    const prequel = await book('前传', '青禾', false);
    const sequel = await book('外传', '阮青');
    const series = await createSeries('河岸故事', guest);
    for (const person of [main, prequel, sequel]) await addBookToSeries(series.id, person.bookId, guest);
    await moveSeriesBook(series.id, prequel.bookId, -1, guest);
    await renameSeries(series.id, '纸上同行', guest);
    expect((await listSeries(guest)).map(row => row.name)).toEqual(['纸上同行']);
    expect((await listSeriesBooks(series.id, guest)).map(row => row.book.title)).toEqual(['前传', '正传', '外传']);
    expect(await listSeriesMemorySources(main.bookId, guest)).toEqual([{
      bookId: sequel.bookId, title: sequel.bookId, chapterTitle: '第一章 · 记录', through: read,
    }]);
    expect(await listSeriesPeople(series.id, prequel.bookId, guest)).toEqual([]);
    await removeBookFromSeries(series.id, prequel.bookId, guest);
    expect(await getSeriesMembership(prequel.bookId, guest)).toBeUndefined();
    await deleteSeries(series.id, guest);
    expect(await listSeries(guest)).toEqual([]);
    expect(await db.books.count()).toBe(3);
    expect(await db.characters.count()).toBe(3);
    expect(await db.progress.count()).toBe(2);
  });

  it('leaves same names separate until explicit confirmation and never copies or reveals future avatars', async () => {
    const first = await book('卷一', '青禾');
    const second = await book('卷二', '青禾');
    const series = await createSeries('河岸故事', guest);
    await addBookToSeries(series.id, first.bookId, guest);
    await addBookToSeries(series.id, second.bookId, guest);
    const image = new Blob(['fixture image bytes']);
    await db.avatars.put({ characterId: second.id, bookId: second.bookId, updatedAt: 0, revision: crypto.randomUUID(), image });
    expect(await listSeriesIdentityLinks(first.bookId, read, guest)).toHaveLength(0);
    expect((await loadSeriesAvatars(first.bookId, read, guest)).size).toBe(0);
    await linkSeriesCharacters(series.id, side(first), side(second), true, guest);
    const linked = (await listSeriesIdentityLinks(first.bookId, read, guest))[0];
    expect(isSeriesCharacterLink(linked)).toBe(true);
    expect(linked.seriesCharacterId).toBe((await listSeriesIdentityLinks(second.bookId, read, guest))[0].seriesCharacterId);
    expect((await loadSeriesAvatars(first.bookId, start, guest)).size).toBe(0);
    expect(await (await loadSeriesAvatars(first.bookId, read, guest)).get(first.id)?.text()).toBe('fixture image bytes');
    expect(await db.avatars.get(first.id)).toBeUndefined();
    await db.progress.update(second.bookId, { offset: 0 });
    expect((await loadSeriesAvatars(first.bookId, read, guest)).size).toBe(0);
    await db.progress.update(second.bookId, { offset: read.offset });
    await changeSeriesLink(series.id, second.bookId, second.id, 'avatar', guest);
    expect((await loadSeriesAvatars(first.bookId, read, guest)).size).toBe(0);
    expect(await (await db.avatars.get(second.id))?.image?.text()).toBe('fixture image bytes');
    await changeSeriesLink(series.id, second.bookId, second.id, 'unlink', guest);
    expect(await listSeriesIdentityLinks(second.bookId, read, guest)).toHaveLength(0);
    await changeSeriesLink(series.id, second.bookId, second.id, 'undo', guest);
    expect((await listSeriesIdentityLinks(second.bookId, read, guest))[0].seriesCharacterId).toBe(linked.seriesCharacterId);
  });

  it('merges groups only on confirmation and appends history when splitting or undoing', async () => {
    const a = await book('甲卷', '艾达');
    const b = await book('乙卷', 'Ada');
    const c = await book('丙卷', 'Captain');
    const d = await book('丁卷', 'Captain');
    const series = await createSeries('测试系列', guest);
    for (const person of [a, b, c, d]) await addBookToSeries(series.id, person.bookId, guest);
    await linkSeriesCharacters(series.id, side(a), side(b), false, guest);
    await linkSeriesCharacters(series.id, side(c), side(d), false, guest);
    const originalA = (await listSeriesIdentityLinks(a.bookId, read, guest))[0];
    const originalD = (await listSeriesIdentityLinks(d.bookId, read, guest))[0];
    expect(originalA.seriesCharacterId).not.toBe(originalD.seriesCharacterId);
    await linkSeriesCharacters(series.id, side(a), side(c), false, guest);
    const merged = (await listSeriesIdentityLinks(d.bookId, read, guest))[0];
    expect(merged.seriesCharacterId).toBe(originalA.seriesCharacterId);
    expect(mergeSeriesCharacterLink(originalD, merged).history.map(row => row.operation)).toEqual(['link', 'merge']);
    await changeSeriesLink(series.id, d.bookId, d.id, 'undo', guest);
    expect((await listSeriesIdentityLinks(d.bookId, read, guest))[0].seriesCharacterId).toBe(originalD.seriesCharacterId);
    await removeBookFromSeries(series.id, a.bookId, guest);
    await addBookToSeries(series.id, a.bookId, guest);
    expect(await listSeriesIdentityLinks(a.bookId, read, guest)).toHaveLength(0);
    expect(await db.characters.count()).toBe(4);
  });

  it('keeps accounts separate and claims a guest book only on explicit series assignment', async () => {
    const first = await book('私人书', '青禾', true, accountA);
    const second = await book('本机书', '青禾');
    const privateSeries = await createSeries('私有系列', accountA);
    const publicSeries = await createSeries('测试系列', accountB);
    const guestSeries = await createSeries('未登录系列', guest);
    await addBookToSeries(privateSeries.id, first.bookId, accountA);
    await addBookToSeries(guestSeries.id, second.bookId, guest);
    expect(await getSeriesMembership(first.bookId, accountB)).toBeUndefined();
    await expect(addBookToSeries(publicSeries.id, first.bookId, accountB)).rejects.toThrow('其他账号');
    expect((await listSeries(accountB)).map(row => row.name)).toEqual(['测试系列']);
    expect(await getSeriesMembership(second.bookId, accountB)).toBeUndefined();
    await addBookToSeries(publicSeries.id, second.bookId, accountB);
    expect((await getSeriesMembership(second.bookId, accountB))?.seriesId).toBe(publicSeries.id);
    expect(await getSeriesMembership(second.bookId, guest)).toBeUndefined();
    expect((await db.seriesBooks.where('scope').equals('local').toArray())).toHaveLength(1);
    expect((await db.books.get(second.bookId))?.cloudEnabled).toBe(false);
  });
});
