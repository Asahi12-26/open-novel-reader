import { db } from './db';
import type { Book, Chapter, Character, Dialogue, DialogueCorrectionRevision } from '../types';
import type { ChapterSummaryRecord, PlotEventRecord } from './plot-types';
import { MAX_PLOT_RECORDS_PER_BOOK, mergeChapterSummaries, mergePlotEvents, validateChapterSummary, validatePlotEvent } from './plot-records';
import type { Series, SeriesBook, SeriesCharacter, SeriesCharacterLink } from './series-types';
import { chooseSeriesRecord, isSeries, isSeriesBook, isSeriesCharacter, isSeriesCharacterLink, mergeSeriesCharacterLink } from './series-types';

export interface BookStoryData {
  version: 1;
  events: PlotEventRecord[];
  summaries: ChapterSummaryRecord[];
  corrections: DialogueCorrectionRevision[];
  series: Series[];
  memberships: SeriesBook[];
  people: SeriesCharacter[];
  links: SeriesCharacterLink[];
}

const emptyBookStory = (): BookStoryData => ({ version: 1, events: [], summaries: [], corrections: [], series: [], memberships: [], people: [], links: [] });
const storyLists = ['events', 'summaries', 'corrections', 'series', 'memberships', 'people', 'links'] as const;

export const storyTables = () => [
  db.plotEvents, db.chapterSummaries, db.dialogueCorrectionRevisions,
  db.series, db.seriesBooks, db.seriesCharacters, db.seriesCharacterLinks,
];

const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
function union<T, K>(groups: (readonly T[] | undefined)[], key: (row: T) => K, choose: (first: T, second: T) => T) {
  const rows = new Map<K, T>();
  for (const group of groups) for (const row of group || []) {
    const previous = rows.get(key(row));
    rows.set(key(row), previous ? choose(previous, row) : row);
  }
  return [...rows.values()];
}

function immutableCorrection(a: DialogueCorrectionRevision, b: DialogueCorrectionRevision) {
  if (a.dialogueId !== b.dialogueId || a.chapterId !== b.chapterId || a.bookId !== b.bookId ||
      a.previousCharacterId !== b.previousCharacterId || a.characterId !== b.characterId || a.updatedAt !== b.updatedAt) {
    throw new Error('对白人工纠错历史有冲突，本机数据已保留。');
  }
  return a;
}

export function mergeBookStory(local?: BookStoryData, remote?: BookStoryData): BookStoryData | undefined {
  if (!local || !remote) return local || remote;
  return {
    version: 1,
    events: mergePlotEvents(local.events, remote.events),
    summaries: mergeChapterSummaries(local.summaries, remote.summaries),
    corrections: byId(union([local.corrections, remote.corrections], row => row.id, immutableCorrection)),
    series: byId(union([local.series, remote.series], row => row.id, chooseSeriesRecord)),
    memberships: byId(union([local.memberships, remote.memberships], row => row.id, chooseSeriesRecord)),
    people: byId(union([local.people, remote.people], row => row.id, chooseSeriesRecord)),
    links: byId(union([local.links, remote.links], row => row.id, mergeSeriesCharacterLink)),
  };
}

function records<K extends string>(value: unknown, key: K, limit: number) {
  return Array.isArray(value) && value.length <= limit && value.every(row => row && typeof row === 'object' && typeof row[key] === 'string') &&
    new Set(value.map(row => row[key])).size === value.length;
}

export function validateBookStory(value: unknown, book: Book, chapters: Chapter[], characters: Character[], dialogues: Dialogue[], scope?: string): value is BookStoryData {
  if (!value || typeof value !== 'object') return false;
  const story = value as BookStoryData;
  if (story.version !== 1 || Object.keys(story).some(key => key !== 'version' && !storyLists.some(list => list === key))) return false;
  if (!records(story.events, 'id', MAX_PLOT_RECORDS_PER_BOOK) || !records(story.summaries, 'chapterId', chapters.length) ||
      !records(story.corrections, 'id', 100_000) || !records(story.series, 'id', 1000) ||
      !records(story.memberships, 'id', 1000) || !records(story.people, 'id', 10_000) || !records(story.links, 'id', 10_000)) return false;
  const identities = new Set(characters.map(row => row.id));
  const eventIds = new Set(story.events.map(row => row.id));
  const dialogueChapters = new Map(dialogues.map(row => [row.id, row.chapterId]));
  const chapterByIndex = new Map(chapters.map(row => [row.index, row]));
  const seriesIds = new Set(story.series.map(row => row.id));
  const seriesPeople = new Map(story.people.map(row => [row.id, row.seriesId]));
  const memberships = new Set(story.memberships.map(row => row.seriesId));
  const oneScope = scope || story.series[0]?.scope;
  return !book.deletedAt &&
    story.events.every(row => row.bookId === book.id && validatePlotEvent(row, chapters, identities) &&
      row.revisions.every(revision => revision.conflictsWith?.every(ref => eventIds.has(ref)) ?? true)) &&
    story.summaries.every(row => row.bookId === book.id && validateChapterSummary(row, chapters, identities)) &&
    story.corrections.every(row => row.bookId === book.id && dialogueChapters.get(row.dialogueId) === row.chapterId &&
      Object.keys(row).every(key => ['id', 'dialogueId', 'chapterId', 'bookId', 'previousCharacterId', 'characterId', 'updatedAt'].includes(key)) &&
      [row.characterId, row.previousCharacterId].every(id => id === null || identities.has(id)) &&
      Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0) &&
    story.series.every(row => isSeries(row) && row.scope === oneScope && memberships.has(row.id)) &&
    story.memberships.every(row => isSeriesBook(row) && row.bookId === book.id && row.scope === oneScope && seriesIds.has(row.seriesId)) &&
    story.people.every(row => isSeriesCharacter(row) && row.scope === oneScope && seriesIds.has(row.seriesId)) &&
    story.links.every(row => isSeriesCharacterLink(row) && row.bookId === book.id && row.scope === oneScope &&
      identities.has(row.characterId) && memberships.has(row.seriesId) && row.history.every(revision => {
        const chapter = chapterByIndex.get(revision.at.chapterIndex);
        const text = chapter?.paragraphs[revision.at.paragraphIndex];
        return text !== undefined && revision.at.offset <= text.length &&
          (revision.seriesCharacterId === null || seriesPeople.get(revision.seriesCharacterId) === row.seriesId);
      }));
}

/** The uploaded slice contains no membership or chapter from another book. */
export async function readBookStory(bookId: string, scope: string, characterIds: ReadonlySet<string>): Promise<BookStoryData | undefined> {
  const [events, summaries, corrections, candidates, availableLinks, availableSeries] = await Promise.all([
    db.plotEvents.where('bookId').equals(bookId).toArray(),
    db.chapterSummaries.where('bookId').equals(bookId).toArray(),
    db.dialogueCorrectionRevisions.where('bookId').equals(bookId).toArray(),
    db.seriesBooks.where('bookId').equals(bookId).and(row => row.scope === scope).toArray(),
    db.seriesCharacterLinks.where('bookId').equals(bookId).and(row => row.scope === scope).toArray(),
    db.series.where('scope').equals(scope).toArray(),
  ]);
  const series = availableSeries.filter(row => candidates.some(membership => membership.seriesId === row.id));
  const seriesIds = new Set(series.map(row => row.id));
  const memberships = candidates.filter(row => seriesIds.has(row.seriesId));
  const links = availableLinks.filter(row => seriesIds.has(row.seriesId) && characterIds.has(row.characterId));
  const personIds = [...new Set(links.flatMap(row => row.history.flatMap(revision => revision.seriesCharacterId ? [revision.seriesCharacterId] : [])))];
  const people = (await db.seriesCharacters.bulkGet(personIds)).filter((row): row is SeriesCharacter => !!row && row.scope === scope);
  const story: BookStoryData = { version: 1, events, summaries, corrections: byId(corrections), series: byId(series), memberships: byId(memberships), people: byId(people), links: byId(links) };
  return storyLists.some(list => story[list].length) ? story : undefined;
}

export function rebindStoryScope(story: BookStoryData, scope: string): BookStoryData {
  const bind = <T extends { scope: string }>(rows: T[]) => rows.map(row => ({ ...row, scope }));
  return { ...story, series: bind(story.series), memberships: bind(story.memberships), people: bind(story.people), links: bind(story.links) };
}

/** Call inside the same transaction as the book restore/sync. */
export async function installBookStory(bookId: string, story?: BookStoryData, replace = false) {
  if (replace) {
    await db.plotEvents.where('bookId').equals(bookId).delete();
    await db.chapterSummaries.where('bookId').equals(bookId).delete();
    await db.dialogueCorrectionRevisions.where('bookId').equals(bookId).delete();
  }
  if (!story) return;
  const current = emptyBookStory();
  current.events = await db.plotEvents.where('bookId').equals(bookId).toArray();
  current.summaries = await db.chapterSummaries.where('bookId').equals(bookId).toArray();
  current.corrections = await db.dialogueCorrectionRevisions.where('bookId').equals(bookId).toArray();
  const merged = mergeBookStory(current, story)!;
  await db.plotEvents.bulkPut(merged.events);
  await db.chapterSummaries.bulkPut(merged.summaries);
  await db.dialogueCorrectionRevisions.bulkPut(merged.corrections);
  const put = async <T extends { id: string; scope: string }>(rows: T[], get: (id: string) => Promise<T | undefined>, save: (row: T) => Promise<unknown>, choose: (first: T, second: T) => T) => {
    for (const row of rows) {
      const old = await get(row.id);
      if (old && old.scope !== row.scope) throw new Error('系列数据归属冲突，本机记录已保留。');
      await save(old ? choose(old, row) : row);
    }
  };
  await put(story.series, id => db.series.get(id), row => db.series.put(row), chooseSeriesRecord);
  await put(story.memberships, id => db.seriesBooks.get(id), row => db.seriesBooks.put(row), chooseSeriesRecord);
  await put(story.people, id => db.seriesCharacters.get(id), row => db.seriesCharacters.put(row), chooseSeriesRecord);
  await put(story.links, id => db.seriesCharacterLinks.get(id), row => db.seriesCharacterLinks.put(row), mergeSeriesCharacterLink);
}
