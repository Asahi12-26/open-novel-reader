import { db } from '../core/db';
import { bookAccountScope, bookOwnerKey, bookOwnerScope } from '../core/book-owner';
import {
  applySeriesLinkRevision, chooseSeriesRecord, MAX_SERIES_LINK_REVISIONS, seriesBookId, seriesLinkId,
  type ActiveSeriesCharacterLink, type Series, type SeriesAccess, type SeriesBook, type SeriesCharacterLink, type SeriesLinkRevision,
} from '../core/series-types';
import type { Book, Character, IdentityLocation } from '../types';
import { compareIdentityLocations, createIdentityProjector } from './character-identity';

export type { SeriesAccess } from '../core/series-types';

export const scopeForSeries = ({ origin, userId }: SeriesAccess) => userId ? bookAccountScope(origin, userId) : 'local';
const maxSeriesBooks = 2000;
const revisionOrder = (left: SeriesLinkRevision, right: SeriesLinkRevision) =>
  left.updatedAt - right.updatedAt || left.id.localeCompare(right.id);
const atOrBefore = (left: IdentityLocation, right: IdentityLocation) => compareIdentityLocations(left, right) <= 0;
const membershipOrder = (a: SeriesBook, b: SeriesBook) => a.position - b.position || a.id.localeCompare(b.id);

function assertAccess(access: SeriesAccess) {
  access.assertCurrent?.();
  if (access.userId && !access.origin) throw new Error('本机账号缺少云项目地址，请重新打开系列。');
}

async function accessibleBooks(access: SeriesAccess, candidates: Book[], allowClaim = false) {
  assertAccess(access);
  const scope = scopeForSeries(access);
  const rows = await db.settings.bulkGet(candidates.map(book => bookOwnerKey(book.id)));
  assertAccess(access);
  return candidates.filter((book, index) => {
    const owner = bookOwnerScope(rows[index]?.value, access.origin);
    if (book.deletedAt !== undefined) return false;
    if (access.userId) return owner === scope || (allowClaim && !owner);
    return !owner;
  });
}

async function requireBook(bookId: string, access: SeriesAccess, allowClaim = false): Promise<Book> {
  const book = await db.books.get(bookId);
  if (!book || !(await accessibleBooks(access, [book], allowClaim)).length) {
    throw new Error('书籍不可用或属于其他账号。');
  }
  return book;
}

async function requireSeries(seriesId: string, access: SeriesAccess): Promise<Series> {
  assertAccess(access);
  const series = await db.series.get(seriesId);
  if (!series || series.scope !== scopeForSeries(access) || series.deletedAt !== undefined) throw new Error('系列不可用或已移除。');
  return series;
}

export async function listSeries(access: SeriesAccess): Promise<Series[]> {
  assertAccess(access);
  const rows = await db.series.where('scope').equals(scopeForSeries(access)).toArray();
  assertAccess(access);
  return rows.filter(row => row.deletedAt === undefined).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function displayName(name: string): string {
  const clean = name.trim();
  if (!clean || clean.length > 100 || /[\u0000-\u001f]/.test(clean)) throw new Error('请输入 1 至 100 个字的系列名称。');
  return clean;
}

export async function createSeries(name: string, access: SeriesAccess): Promise<Series> {
  assertAccess(access);
  const series: Series = { id: crypto.randomUUID(), scope: scopeForSeries(access), name: displayName(name), updatedAt: Date.now() };
  await db.transaction('rw', db.series, async () => {
    assertAccess(access);
    await db.series.add(series);
    assertAccess(access);
  });
  return series;
}

export async function renameSeries(seriesId: string, name: string, access: SeriesAccess): Promise<void> {
  const clean = displayName(name);
  await db.transaction('rw', db.series, db.syncState, async () => {
    const current = await requireSeries(seriesId, access);
    if (current.name !== clean) {
      await db.series.update(current.id, { name: clean, updatedAt: Math.max(Date.now(), current.updatedAt + 1) });
      await db.syncState.put({ id: 'local', updatedAt: Date.now() });
    }
    assertAccess(access);
  });
}

async function currentMembership(bookId: string, access: SeriesAccess): Promise<SeriesBook | undefined> {
  const scope = scopeForSeries(access);
  const rows = await db.seriesBooks.where('bookId').equals(bookId).filter(row => row.scope === scope && row.deletedAt === undefined).toArray();
  const available = await db.series.bulkGet(rows.map(row => row.seriesId));
  return rows.filter((_, index) => available[index]?.scope === scope && available[index]?.deletedAt === undefined)
    .reduce<SeriesBook | undefined>((result, row) => result ? chooseSeriesRecord(result, row) : row, undefined);
}

export async function getSeriesMembership(bookId: string, access: SeriesAccess): Promise<SeriesBook | undefined> {
  return db.transaction('r', [db.books, db.settings, db.series, db.seriesBooks], async () => {
    const book = await db.books.get(bookId);
    if (!book || !(await accessibleBooks(access, [book])).length) return;
    const result = await currentMembership(bookId, access);
    assertAccess(access);
    return result;
  });
}

async function seriesMembers(seriesId: string, access: SeriesAccess): Promise<Array<{ membership: SeriesBook; book: Book }>> {
  await requireSeries(seriesId, access);
  const scope = scopeForSeries(access);
  const members = await db.seriesBooks.where('seriesId').equals(seriesId).filter(row => row.scope === scope && row.deletedAt === undefined).sortBy('position');
  const rows = await db.books.bulkGet(members.map(member => member.bookId));
  const books = new Map((await accessibleBooks(access, rows.filter((row): row is Book => !!row))).map(book => [book.id, book]));
  const result: Array<{ membership: SeriesBook; book: Book }> = [];
  for (const membership of members.sort(membershipOrder)) {
    const book = books.get(membership.bookId);
    if (book && (await currentMembership(book.id, access))?.id === membership.id) result.push({ membership, book });
  }
  return result;
}

export async function listSeriesBooks(seriesId: string, access: SeriesAccess) {
  return db.transaction('r', [db.books, db.settings, db.series, db.seriesBooks], async () => {
    const result = await seriesMembers(seriesId, access);
    assertAccess(access);
    return result;
  });
}

export async function listSeriesBookChoices(access: SeriesAccess, books: readonly Book[]): Promise<Book[]> {
  const allowed = await accessibleBooks(access, [...books], true);
  const memberships = await db.seriesBooks.where('scope').equals(scopeForSeries(access)).filter(row => row.deletedAt === undefined).toArray();
  const series = new Set((await listSeries(access)).map(row => row.id));
  const used = new Set(memberships.filter(row => series.has(row.seriesId)).map(row => row.bookId));
  assertAccess(access);
  return allowed.filter(book => !used.has(book.id)).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function revisedLink(
  link: SeriesCharacterLink,
  seriesCharacterId: string | null,
  shareAvatar: boolean,
  operation: SeriesLinkRevision['operation'],
  at = link.at,
): SeriesCharacterLink {
  if (link.history.length >= MAX_SERIES_LINK_REVISIONS) throw new Error('此关联的修改历史已达到上限，原记录已保留。');
  const event: SeriesLinkRevision = {
    id: crypto.randomUUID(), seriesCharacterId, shareAvatar: !!seriesCharacterId && shareAvatar, operation, at,
    updatedAt: Math.max(Date.now(), link.updatedAt + 1),
  };
  return applySeriesLinkRevision({ ...link, history: [...link.history, event] }, event);
}

async function detachMembership(member: SeriesBook): Promise<void> {
  const updatedAt = Math.max(Date.now(), member.updatedAt + 1);
  await db.seriesBooks.update(member.id, { updatedAt, deletedAt: updatedAt });
  const links = await db.seriesCharacterLinks.where('bookId').equals(member.bookId)
    .filter(row => row.seriesId === member.seriesId && row.scope === member.scope && row.seriesCharacterId !== null).toArray();
  if (links.length) await db.seriesCharacterLinks.bulkPut(links.map(row => revisedLink(row, null, false, 'unlink')));
}

export async function addBookToSeries(seriesId: string, bookId: string, access: SeriesAccess): Promise<void> {
  await db.transaction('rw', [db.books, db.settings, db.series, db.seriesBooks, db.seriesCharacterLinks, db.syncState], async () => {
    const series = await requireSeries(seriesId, access);
    await requireBook(bookId, access, true);
    const scope = series.scope;
    const current = await currentMembership(bookId, access);
    if (current?.seriesId === seriesId) return;
    if (current) throw new Error('这本书已加入其他系列，请先从原系列移除。');
    const members = await db.seriesBooks.where('seriesId').equals(seriesId).filter(row => row.scope === scope && row.deletedAt === undefined).toArray();
    if (members.length >= maxSeriesBooks) throw new Error('系列书籍已到达上限。');
    const id = seriesBookId(seriesId, bookId);
    const previous = await db.seriesBooks.get(id);
    const position = members.reduce((max, row) => Math.max(max, row.position), -1) + 1;
    if (position > 100000) throw new Error('请先调整系列顺序再添加小说。');
    // Explicit series assignment may claim a guest book. Its guest series links stay in the guest scope.
    if (access.userId && !bookOwnerScope((await db.settings.get(bookOwnerKey(bookId)))?.value, access.origin)) {
      await db.settings.put({ id: bookOwnerKey(bookId), value: scope });
    }
    await db.seriesBooks.put({ id, scope, seriesId, bookId, position, updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? -1) + 1) });
    await db.syncState.put({ id: 'local', updatedAt: Date.now() });
    assertAccess(access);
  });
}

export async function moveSeriesBook(seriesId: string, bookId: string, direction: -1 | 1, access: SeriesAccess): Promise<void> {
  await db.transaction('rw', [db.books, db.settings, db.series, db.seriesBooks, db.syncState], async () => {
    const members = (await seriesMembers(seriesId, access)).map(row => row.membership);
    const from = members.findIndex(row => row.bookId === bookId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= members.length) return;
    [members[from], members[to]] = [members[to], members[from]];
    const now = Date.now();
    await db.seriesBooks.bulkPut(members.flatMap((row, position) =>
      row.position === position ? [] : [{ ...row, position, updatedAt: Math.max(now, row.updatedAt + 1) }]));
    await db.syncState.put({ id: 'local', updatedAt: now });
    assertAccess(access);
  });
}

export async function removeBookFromSeries(seriesId: string, bookId: string, access: SeriesAccess): Promise<void> {
  await db.transaction('rw', [db.books, db.settings, db.series, db.seriesBooks, db.seriesCharacterLinks, db.syncState], async () => {
    await requireSeries(seriesId, access);
    await requireBook(bookId, access);
    const membership = await currentMembership(bookId, access);
    if (membership?.seriesId === seriesId) await detachMembership(membership);
    await db.syncState.put({ id: 'local', updatedAt: Date.now() });
    assertAccess(access);
  });
}

export async function deleteSeries(seriesId: string, access: SeriesAccess): Promise<void> {
  await db.transaction('rw', [db.books, db.settings, db.series, db.seriesBooks, db.seriesCharacterLinks, db.syncState], async () => {
    const series = await requireSeries(seriesId, access);
    const rows = await seriesMembers(seriesId, access);
    for (const { membership } of rows) await detachMembership(membership);
    const updatedAt = Math.max(Date.now(), series.updatedAt + 1);
    await db.series.update(series.id, { updatedAt, deletedAt: updatedAt });
    await db.syncState.put({ id: 'local', updatedAt: Date.now() });
    assertAccess(access);
  });
}

async function readingCutoff(bookId: string) {
  const reading = await db.progress.get(bookId);
  if (!reading || reading.bookId !== bookId) return;
  const chapter = await db.chapters.get(reading.chapterId);
  if (!chapter || chapter.bookId !== bookId) return;
  const paragraph = chapter.paragraphs[reading.paragraphIndex];
  if (paragraph === undefined) return;
  return {
    chapterTitle: chapter.title,
    through: { chapterIndex: chapter.index, paragraphIndex: reading.paragraphIndex, offset: Math.min(reading.offset, paragraph.length) },
  };
}

export async function listSeriesMemorySources(bookId: string, access: SeriesAccess): Promise<Array<{
  bookId: string; title: string; chapterTitle: string; through: IdentityLocation;
}>> {
  return db.transaction('r', [db.books, db.settings, db.series, db.seriesBooks, db.progress, db.chapters], async () => {
    const membership = await getSeriesMembership(bookId, access);
    if (!membership) return [];
    const sources = await seriesMembers(membership.seriesId, access);
    const result = [];
    for (const { book } of sources) {
      if (book.id === bookId) continue;
      const cutoff = await readingCutoff(book.id);
      if (cutoff) result.push({ bookId: book.id, title: book.title, ...cutoff });
    }
    assertAccess(access);
    return result;
  });
}

export function projectSeriesLink(link: SeriesCharacterLink, through: IdentityLocation): ActiveSeriesCharacterLink | undefined {
  // Unlinking revokes sharing immediately, even when reading an earlier chapter.
  if (!link.seriesCharacterId) return;
  const history = link.history.filter(event => atOrBefore(event.at, through)).sort(revisionOrder);
  const event = history.at(-1);
  if (!event?.seriesCharacterId) return;
  return { ...applySeriesLinkRevision({ ...link, history }, { ...event, shareAvatar: link.shareAvatar && event.shareAvatar }), seriesCharacterId: event.seriesCharacterId };
}

async function readProjectedPeople(bookId: string, through: IdentityLocation) {
  const [characters, dialogues, chapters] = await Promise.all([
    db.characters.where('bookId').equals(bookId).toArray(),
    db.dialogues.where('bookId').equals(bookId).toArray(),
    db.chapters.where('bookId').equals(bookId).toArray(),
  ]);
  return createIdentityProjector(characters, dialogues, chapters)(through);
}

async function projectedIdentityLinks(
  bookId: string, membership: SeriesBook, through: IdentityLocation, candidates?: readonly SeriesCharacterLink[],
) {
  const links = candidates ?? await db.seriesCharacterLinks.where('bookId').equals(bookId)
    .filter(row => row.seriesId === membership.seriesId && row.scope === membership.scope && row.seriesCharacterId !== null).toArray();
  const projected = links.flatMap(link => {
    const result = projectSeriesLink(link, through);
    return result ? [result] : [];
  });
  if (!projected.length) return { links: [], people: undefined };
  const people = await readProjectedPeople(bookId, through);
  return { links: projected.filter(row => !!people.character(row.characterId)), people };
}

export async function listSeriesIdentityLinks(bookId: string, through: IdentityLocation, access: SeriesAccess): Promise<ActiveSeriesCharacterLink[]> {
  return db.transaction('r', [db.books, db.settings, db.series, db.seriesBooks, db.seriesCharacterLinks, db.characters, db.chapters, db.dialogues], async () => {
    const membership = await getSeriesMembership(bookId, access);
    const projected = membership ? (await projectedIdentityLinks(bookId, membership, through)).links : [];
    assertAccess(access);
    return projected;
  });
}

export interface SeriesPersonOption {
  character: Character;
  at: IdentityLocation;
  link?: SeriesCharacterLink;
}

export async function listSeriesPeople(seriesId: string, bookId: string, access: SeriesAccess): Promise<SeriesPersonOption[]> {
  return db.transaction('r', [
    db.books, db.settings, db.series, db.seriesBooks, db.seriesCharacterLinks, db.characters, db.chapters, db.dialogues, db.progress,
  ], async () => {
    const membership = await getSeriesMembership(bookId, access);
    if (membership?.seriesId !== seriesId) return [];
    const cutoff = await readingCutoff(bookId);
    if (!cutoff) return [];
    const people = await readProjectedPeople(bookId, cutoff.through);
    const links = await db.seriesCharacterLinks.where('bookId').equals(bookId)
      .filter(row => row.seriesId === seriesId && row.scope === membership.scope && atOrBefore(row.at, cutoff.through)).toArray();
    const byId = new Map(links.map(row => [row.characterId, row]));
    assertAccess(access);
    return people.characters.map(character => ({ character, at: cutoff.through, link: byId.get(character.id) }))
      .sort((a, b) => a.character.name.localeCompare(b.character.name) || a.character.id.localeCompare(b.character.id));
  });
}

export async function listSeriesGroupMembers(seriesId: string, groupId: string, access: SeriesAccess): Promise<Array<{
  bookId: string; bookTitle: string; character: Character;
}>> {
  return db.transaction('r', identityTables(), async () => {
    const members = await seriesMembers(seriesId, access);
    const scope = scopeForSeries(access);
    const group = await db.seriesCharacters.get(groupId);
    if (!group || group.scope !== scope || group.seriesId !== seriesId) return [];
    const result = [];
    const links = await db.seriesCharacterLinks.where('seriesCharacterId').equals(groupId).filter(row => row.scope === scope).toArray();
    for (const { book, membership } of members) {
      const candidates = links.filter(row => row.bookId === book.id && row.seriesId === seriesId);
      if (!candidates.length) continue;
      const cutoff = await readingCutoff(book.id);
      if (!cutoff) continue;
      const projected = await projectedIdentityLinks(book.id, membership, cutoff.through, candidates);
      const seen = new Set<string>();
      for (const link of projected.links) {
        const character = projected.people?.character(link.characterId);
        if (!character || link.seriesCharacterId !== groupId || seen.has(character.id)) continue;
        seen.add(character.id);
        result.push({ bookId: book.id, bookTitle: book.title, character });
      }
    }
    assertAccess(access);
    return result;
  });
}

async function requireSeriesPerson(seriesId: string, bookId: string, characterId: string, access: SeriesAccess) {
  const person = (await listSeriesPeople(seriesId, bookId, access)).find(row => row.character.id === characterId);
  if (!person) throw new Error('请从当前已读范围内选择人物。');
  return person;
}

const identityTables = () => [
  db.books, db.settings, db.series, db.seriesBooks, db.seriesCharacters, db.seriesCharacterLinks, db.characters, db.chapters, db.dialogues, db.progress, db.syncState,
];

/** Associating or joining groups requires an explicit user-selected pair. */
export async function linkSeriesCharacters(
  seriesId: string,
  left: { bookId: string; characterId: string },
  right: { bookId: string; characterId: string },
  shareAvatar: boolean,
  access: SeriesAccess,
): Promise<void> {
  if (left.bookId === right.bookId) throw new Error('请选择两本不同书籍中的人物。');
  await db.transaction('rw', identityTables(), async () => {
    const series = await requireSeries(seriesId, access);
    const [first, second] = await Promise.all([
      requireSeriesPerson(seriesId, left.bookId, left.characterId, access),
      requireSeriesPerson(seriesId, right.bookId, right.characterId, access),
    ]);
    const older = first.link?.seriesCharacterId;
    const newer = second.link?.seriesCharacterId;
    const group = older || newer || crypto.randomUUID();
    const operation = older && newer && older !== newer ? 'merge' : 'link';
    if (!older && !newer) await db.seriesCharacters.add({ id: group, scope: series.scope, seriesId, updatedAt: Date.now() });
    const changes = new Map<string, SeriesCharacterLink>();
    for (const { candidate, person } of [{ candidate: left, person: first }, { candidate: right, person: second }]) {
      const id = seriesLinkId(seriesId, candidate.bookId, candidate.characterId);
      const current = await db.seriesCharacterLinks.get(id);
      if (current && (current.scope !== series.scope || !atOrBefore(current.at, person.at))) {
        throw new Error('此人物已有较晚的关联，请回到该书的关联位置再修改。');
      }
      const row = current ?? { id, ...candidate, scope: series.scope, seriesId, at: person.at, seriesCharacterId: null, shareAvatar: false, updatedAt: 0, history: [] };
      changes.set(id, revisedLink(row, group, shareAvatar, operation, person.at));
    }
    if (operation === 'merge' && newer) {
      const members = new Set((await seriesMembers(seriesId, access)).map(row => row.book.id));
      const others = await db.seriesCharacterLinks.where('seriesCharacterId').equals(newer)
        .filter(row => row.scope === series.scope && row.seriesId === seriesId && members.has(row.bookId)).toArray();
      for (const row of others) if (!changes.has(row.id)) {
        const progress = await readingCutoff(row.bookId);
        const at = progress && atOrBefore(row.at, progress.through) ? progress.through : row.at;
        changes.set(row.id, revisedLink(row, group, row.shareAvatar, 'merge', at));
      }
    }
    await db.seriesCharacterLinks.bulkPut([...changes.values()]);
    await db.syncState.put({ id: 'local', updatedAt: Date.now() });
    assertAccess(access);
  });
}

export async function changeSeriesLink(
  seriesId: string, bookId: string, characterId: string, operation: 'unlink' | 'undo' | 'avatar', access: SeriesAccess,
): Promise<void> {
  await db.transaction('rw', identityTables(), async () => {
    const person = await requireSeriesPerson(seriesId, bookId, characterId, access);
    const link = person.link;
    if (!link) throw new Error('此人物还没有关联记录。');
    const historical = [...link.history].sort(revisionOrder).at(-2);
    if (operation === 'avatar' && !link.seriesCharacterId) throw new Error('请先建立系列人物关联。');
    const group = operation === 'unlink' ? null : operation === 'undo' ? historical?.seriesCharacterId ?? null : link.seriesCharacterId;
    const share = operation === 'undo' ? !!historical?.shareAvatar : operation === 'avatar' && !link.shareAvatar;
    if (group) {
      const target = await db.seriesCharacters.get(group);
      if (!target || target.scope !== link.scope || target.seriesId !== link.seriesId) throw new Error('原关联身份不可用。');
    }
    const at = historical && !atOrBefore(historical.at, person.at) ? historical.at : person.at;
    await db.seriesCharacterLinks.put(revisedLink(link, group, share, operation, at));
    await db.syncState.put({ id: 'local', updatedAt: Date.now() });
    assertAccess(access);
  });
}

/** A shared image is a read-time fallback. It never changes a book's own avatar record or sync payload. */
export async function loadSeriesAvatars(bookId: string, through: IdentityLocation, access: SeriesAccess): Promise<Map<string, Blob>> {
  return db.transaction('r', [
    db.books, db.settings, db.series, db.seriesBooks, db.seriesCharacterLinks, db.characters, db.chapters, db.dialogues, db.progress, db.avatars,
  ], async () => {
    const result = new Map<string, Blob>();
    const membership = await getSeriesMembership(bookId, access);
    if (!membership) return result;
    const target = await projectedIdentityLinks(bookId, membership, through);
    if (!target.links.length || !target.people) return result;
    const groups = new Set(target.links.map(row => row.seriesCharacterId));
    const eligible = new Map<string, { image: Blob; at: number; linkId: string }>();
    const sourcesByBook = new Map<string, SeriesCharacterLink[]>();
    const sharing = await db.seriesCharacterLinks.where('seriesId').equals(membership.seriesId)
      .filter(link => link.scope === membership.scope && link.bookId !== bookId && link.shareAvatar &&
        link.history.some(revision => revision.seriesCharacterId !== null && groups.has(revision.seriesCharacterId))).toArray();
    for (const link of sharing) {
      const rows = sourcesByBook.get(link.bookId);
      if (rows) rows.push(link);
      else sourcesByBook.set(link.bookId, [link]);
    }
    if (!sharing.length) return result;
    const sources = await seriesMembers(membership.seriesId, access);
    for (const { book, membership: other } of sources) {
      const candidates = sourcesByBook.get(book.id);
      if (!candidates) continue;
      const cutoff = await readingCutoff(book.id);
      if (!cutoff) continue;
      for (const link of (await projectedIdentityLinks(book.id, other, cutoff.through, candidates)).links) {
        if (!link.shareAvatar || !groups.has(link.seriesCharacterId)) continue;
        const avatar = await db.avatars.get(link.characterId);
        if (!avatar?.image || avatar.bookId !== book.id) continue;
        const group = link.seriesCharacterId;
        const previous = eligible.get(group);
        if (!previous || previous.at < avatar.updatedAt || (previous.at === avatar.updatedAt && previous.linkId > link.id)) {
          eligible.set(group, { image: avatar.image, at: avatar.updatedAt, linkId: link.id });
        }
      }
    }
    for (const link of target.links) {
      const person = target.people.character(link.characterId);
      const image = eligible.get(link.seriesCharacterId)?.image;
      if (person && image) result.set(person.id, image);
    }
    assertAccess(access);
    return result;
  });
}
