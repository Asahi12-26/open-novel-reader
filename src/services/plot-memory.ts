import Dexie from 'dexie';
import { db } from '../core/db';
import { bookAccountScope, bookOwnerKey, bookOwnerScope } from '../core/book-owner';
import type { ChapterSummaryFragment, PlotContext, PlotEventRecord, PlotEventRevision, PlotKind, PlotMemoryHint, SeriesMemorySelection } from '../core/plot-types';
import {
  comparePlotLocations, MAX_MANUAL_SUMMARY, MAX_PLOT_CONFLICT_LINKS, MAX_PLOT_DESCRIPTION, MAX_PLOT_EVIDENCE_TEXT, MAX_PLOT_EVENTS_PER_WINDOW,
  MAX_SUMMARY_FRAGMENT_TEXT, mergeChapterSummaries, mergePlotEvents, plotInteger, plotObject, plotText,
  projectChapterSummary, projectPlotEvent, validateChapterSummary, validatePlotEvent, validPlotEvidence,
} from '../core/plot-records';
import type { Chapter, IdentityEvidence, IdentityLocation } from '../types';
import { createIdentityProjector } from './character-identity';
import { getSeriesMembership, listSeriesIdentityLinks } from './series';

export { chapterPlotEnd, comparePlotLocations, mergeChapterSummaries, mergePlotEvents, projectChapterSummary, projectPlotEvent, validateChapterSummary, validatePlotEvent } from '../core/plot-records';
export type { PlotMemoryHint, SeriesMemorySelection } from '../core/plot-types';

interface ValidatedEvent {
  description: string;
  characterIds: string[];
  relation?: string;
  conflictsWith?: string[];
  kind: Exclude<PlotKind, 'user'>;
  confidence: number;
  evidence: IdentityEvidence;
}
export interface ValidatedPlotOutput { summary: string; events: ValidatedEvent[] }

const position = ({ chapterIndex, paragraphIndex, offset }: IdentityLocation) => ({ chapterIndex, paragraphIndex, offset });
const byPosition = (chapter: Chapter, paragraphIndex: number, offset: number) => ({ chapterIndex: chapter.index, paragraphIndex, offset });
const short = (value: string, max: number) => value.normalize('NFC').trim().slice(0, max);
const claimLanguage = /[“”「」『』"]|‘[^’]+’|(?:声称|说过|他说|她说|据说|传言)|\b(?:said|claims?|alleg(?:es|ed)|rumou?r(?:ed)?)\b/i;

/** Only evidence from the precise text sent with this request can enter memory. */
export function validatePlotOutput(value: unknown, chapter: Chapter, context: readonly PlotContext[], knownIds: readonly string[], allowedConflictIds: readonly string[] = []): ValidatedPlotOutput {
  if (!plotObject(value) || !plotText(value.summary, MAX_SUMMARY_FRAGMENT_TEXT, 0) ||
      !Array.isArray(value.events) || value.events.length > MAX_PLOT_EVENTS_PER_WINDOW) {
    throw new Error('剧情理解响应格式无效，未写入本次结果。');
  }
  const allowed = new Set(knownIds);
  const knownConflicts = new Set(allowedConflictIds);
  const events: ValidatedEvent[] = [];
  const seen = new Set<string>();
  for (const candidate of value.events) {
    if (!plotObject(candidate) || !plotText(candidate.description, MAX_PLOT_DESCRIPTION) ||
        !Array.isArray(candidate.characters) || candidate.characters.length > 8 ||
        candidate.characters.some(character => typeof character !== 'string' || !allowed.has(character)) ||
        (candidate.relation !== undefined && !plotText(candidate.relation, MAX_PLOT_DESCRIPTION)) ||
        (candidate.conflictsWith !== undefined && (!Array.isArray(candidate.conflictsWith) || candidate.conflictsWith.length > MAX_PLOT_CONFLICT_LINKS ||
          new Set(candidate.conflictsWith).size !== candidate.conflictsWith.length ||
          candidate.conflictsWith.some(ref => typeof ref !== 'string' || !knownConflicts.has(ref)))) ||
        (candidate.kind !== 'fact' && candidate.kind !== 'claim' && candidate.kind !== 'inference') ||
        typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 ||
        !plotObject(candidate.evidence)) continue;
    const { paragraphIndex, start, end, text } = candidate.evidence;
    const evidence = { chapterId: chapter.id, paragraphIndex, start, end, text };
    if (!validPlotEvidence(evidence, chapter) || !context.some(part => part.paragraph === evidence.paragraphIndex &&
        part.start <= evidence.start && part.text.slice(evidence.start - part.start, evidence.end - part.start) === evidence.text)) continue;
    const key = [evidence.paragraphIndex, evidence.start, evidence.end, candidate.description.trim()].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      description: candidate.description.trim(), characterIds: [...new Set(candidate.characters as string[])],
      ...(candidate.relation ? { relation: candidate.relation.trim() } : {}),
      ...(Array.isArray(candidate.conflictsWith) && candidate.conflictsWith.length ? { conflictsWith: candidate.conflictsWith as string[] } : {}),
      kind: candidate.kind === 'fact' && claimLanguage.test(evidence.text) ? 'claim' : candidate.kind,
      confidence: candidate.confidence, evidence,
    });
  }
  // A free-text response alone cannot establish provenance. A valid blank
  // window can still advance the analysis checkpoint.
  return { summary: events.length && events.length === value.events.length ? value.summary.trim() : '', events };
}

interface PlotWindow {
  chapter: Chapter;
  output: ValidatedPlotOutput;
  windowId: string;
  from: IdentityLocation;
  through: IdentityLocation;
  complete: boolean;
  model: string;
  seriesId?: string;
}

/** Run inside the analysis transaction with its checkpoint, or atomically on its own. */
export async function commitPlotWindow({ chapter, output, windowId, from, through, model, seriesId }: PlotWindow): Promise<void> {
  const write = async () => {
    const [currentBook, currentChapter, people, savedSummary] = await Promise.all([
      db.books.get(chapter.bookId), db.chapters.get(chapter.id), db.characters.where('bookId').equals(chapter.bookId).toArray(),
      db.chapterSummaries.get(chapter.id),
    ]);
    if (!currentBook || currentBook.deletedAt !== undefined || currentChapter?.bookId !== chapter.bookId ||
        currentChapter.index !== chapter.index || JSON.stringify(currentChapter.paragraphs) !== JSON.stringify(chapter.paragraphs)) {
      throw new Error('书籍已变化，剧情窗口未保存。');
    }
    const known = new Set(people.map(person => person.id));
    const now = Date.now();
    const slots = new Map<string, number>();
    const allChapters = await db.chapters.where('bookId').equals(chapter.bookId).toArray();
    const records: PlotEventRecord[] = [];
    for (const event of output.events) {
      if (comparePlotLocations(byPosition(chapter, event.evidence.paragraphIndex, event.evidence.start), from) < 0 ||
          comparePlotLocations(byPosition(chapter, event.evidence.paragraphIndex, event.evidence.end), through) > 0) {
        throw new Error('剧情证据超出当前处理范围。');
      }
      const anchor = [event.evidence.paragraphIndex, event.evidence.start, event.evidence.end].join(':');
      const slot = slots.get(anchor) ?? 0;
      slots.set(anchor, slot + 1);
      const id = `${chapter.id}:event:${anchor}:${slot}`;
      if (event.conflictsWith?.length) {
        const earlier = await db.plotEvents.bulkGet(event.conflictsWith);
        if (earlier.some(row => !row || row.id === id || row.bookId !== chapter.bookId || !projectPlotEvent(row, from).current)) {
          throw new Error('冲突引用缺少同一本书的已知事件，剧情窗口未保存。');
        }
      }
      const revision: PlotEventRevision = {
        ...event, id: `${windowId}:event:${records.length}`, source: 'ai', status: 'active',
        visibleAt: position(through), updatedAt: now,
      };
      const existing = await db.plotEvents.get(id);
      if (existing?.revisions.some(item => item.id === revision.id)) continue;
      const [next] = mergePlotEvents(existing && [existing], [{
        id, bookId: chapter.bookId, chapterId: chapter.id, order: byPosition(chapter, event.evidence.paragraphIndex, event.evidence.start),
        ...(seriesId ? { seriesId } : {}), revisions: [revision],
      }]);
      if (!validatePlotEvent(next, allChapters, known)) throw new Error('剧情事件证据或人物编号无效，未保存。');
      records.push(next);
    }
    const evidence = output.events.map(event => event.evidence);
    const fragment: ChapterSummaryFragment = {
      id: windowId, from: position(from), through: position(through), text: output.summary, model, updatedAt: now,
      evidence, characterIds: [...new Set(output.events.flatMap(event => event.characterIds))].slice(0, 8),
    };
    const summary = savedSummary?.fragments.some(item => item.id === windowId) ? savedSummary : mergeChapterSummaries(
      savedSummary && [savedSummary], [{ chapterId: chapter.id, bookId: chapter.bookId, fragments: [fragment], revisions: [] }],
    )[0];
    if (!validateChapterSummary(summary, allChapters, known)) throw new Error('本章简介证据或范围无效，未保存。');
    if (records.length) await db.plotEvents.bulkPut(records);
    await db.chapterSummaries.put(summary);
  };
  if (Dexie.currentTransaction) await write();
  else await db.transaction('rw', [db.books, db.chapters, db.characters, db.plotEvents, db.chapterSummaries], write);
}

export async function plotOwner(bookId: string): Promise<unknown> {
  return (await db.settings.get(bookOwnerKey(bookId)))?.value;
}

async function guardedPlotBook(bookId: string, expectedOwner: unknown) {
  const book = await db.books.get(bookId);
  if (!book || book.deletedAt !== undefined || await plotOwner(bookId) !== expectedOwner) {
    throw new Error('当前书籍所属账号或书籍已变化，请重新打开简介。');
  }
}

export async function revisePlotEvent(recordId: string, change: { description: string; relation?: string; reject?: boolean }, cutoff: IdentityLocation, owner: unknown) {
  const description = change.description.trim();
  const relation = change.relation?.trim();
  if (!plotText(description, MAX_PLOT_DESCRIPTION) || (relation && !plotText(relation, MAX_PLOT_DESCRIPTION))) throw new Error('请填写简短的剧情记录。');
  await db.transaction('rw', [db.books, db.chapters, db.characters, db.plotEvents, db.settings, db.syncState], async () => {
    const record = await db.plotEvents.get(recordId);
    if (!record) throw new Error('当前剧情记录已变化。');
    await guardedPlotBook(record.bookId, owner);
    const current = projectPlotEvent(record, cutoff).current;
    if (!current) throw new Error('这条剧情超出当前阅读范围。');
    const now = Date.now();
    const revision: PlotEventRevision = {
      id: crypto.randomUUID(), description, ...(relation ? { relation } : {}), characterIds: [...current.characterIds],
      kind: 'user', source: 'manual', status: change.reject ? 'rejected' : 'active', confidence: 1,
      visibleAt: position(cutoff), evidence: current.evidence, updatedAt: Math.max(now, ...record.revisions.map(item => item.updatedAt + 1)),
    };
    const [next] = mergePlotEvents([record], [{ ...record, revisions: [revision] }]);
    const chapters = await db.chapters.where('bookId').equals(record.bookId).toArray();
    const ids = new Set(await db.characters.where('bookId').equals(record.bookId).primaryKeys());
    if (!validatePlotEvent(next, chapters, ids)) throw new Error('剧情记录位置或人物已变化，请重新打开。');
    await db.plotEvents.put(next);
    await db.syncState.put({ id: 'local', updatedAt: now });
  });
}

export async function reviseChapterSummary(chapterId: string, text: string, flag: boolean, cutoff: IdentityLocation, owner: unknown) {
  await db.transaction('rw', [db.books, db.chapters, db.characters, db.chapterSummaries, db.settings, db.syncState], async () => {
    const summary = await db.chapterSummaries.get(chapterId);
    const chapter = await db.chapters.get(chapterId);
    if (!summary || !chapter || chapter.bookId !== summary.bookId) throw new Error('当前章节简介已变化。');
    await guardedPlotBook(chapter.bookId, owner);
    const visible = projectChapterSummary(summary, chapter, cutoff);
    const replacement = flag ? visible.text : text.trim();
    if (!visible.text || !plotText(replacement, MAX_MANUAL_SUMMARY)) throw new Error('请填写有效简介，最多 4000 个字符。');
    const now = Date.now();
    const [next] = mergeChapterSummaries([summary], [{
      chapterId, bookId: chapter.bookId, fragments: [], revisions: [{
        id: crypto.randomUUID(), text: replacement, visibleAt: position(cutoff), status: flag ? 'flagged' : 'active',
        updatedAt: Math.max(now, ...summary.revisions.map(item => item.updatedAt + 1)),
      }],
    }]);
    const chapters = await db.chapters.where('bookId').equals(chapter.bookId).toArray();
    const ids = new Set(await db.characters.where('bookId').equals(chapter.bookId).primaryKeys());
    if (!validateChapterSummary(next, chapters, ids)) throw new Error('简介范围或人物已变化，请重新打开。');
    await db.chapterSummaries.put(next);
    await db.syncState.put({ id: 'local', updatedAt: now });
  });
}

export const MAX_PLOT_MEMORY_HINTS = 12;
export const MAX_PLOT_MEMORY_BYTES = 8192;
export const MAX_SHARED_MEMORY_BOOKS = 8;
const tokens = (input: string) => {
  const words = input.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      for (let index = 0; index + 1 < word.length; index++) result.add(word.slice(index, index + 2));
    } else result.add(word);
  }
  return result;
};

interface RetrieveOptions {
  bookId: string;
  scope: IdentityLocation;
  selections?: readonly SeriesMemorySelection[];
  query: string;
  principal?: { projectUrl: string; userId: string };
  nearbyCharacterIds?: readonly string[];
}

export async function retrievePlotMemory({ bookId, scope, selections = [], query, principal, nearbyCharacterIds = [] }: RetrieveOptions): Promise<PlotMemoryHint[]> {
  const access = { origin: principal?.projectUrl ?? '', userId: principal?.userId };
  const accountScope = principal && bookAccountScope(principal.projectUrl, principal.userId);
  const currentBook = await db.books.get(bookId);
  const currentOwner = bookOwnerScope(await plotOwner(bookId), access.origin);
  if (!currentBook || currentBook.deletedAt !== undefined || (currentOwner && currentOwner !== accountScope)) return [];
  const membership = selections.length && accountScope ? await getSeriesMembership(bookId, access) : undefined;
  const currentLinks = membership && await listSeriesIdentityLinks(bookId, scope, access);
  const sources = [{ bookId, through: scope, expectedOwner: currentOwner }];
  const seen = new Set([bookId]);
  for (const pick of membership ? selections.slice(0, MAX_SHARED_MEMORY_BOOKS) : []) {
    if (seen.has(pick.bookId) || ![pick.through.chapterIndex, pick.through.paragraphIndex, pick.through.offset].every(plotInteger)) continue;
    const [book, ownerValue, other, progress] = await Promise.all([
      db.books.get(pick.bookId), plotOwner(pick.bookId), getSeriesMembership(pick.bookId, access), db.progress.get(pick.bookId),
    ]);
    const owner = bookOwnerScope(ownerValue, access.origin);
    if (!book || book.deletedAt !== undefined || !owner || owner !== accountScope || other?.seriesId !== membership?.seriesId || !progress) continue;
    const latest = await db.chapters.get(progress.chapterId);
    if (!latest || latest.bookId !== pick.bookId ||
        comparePlotLocations(pick.through, byPosition(latest, progress.paragraphIndex, progress.offset)) > 0) continue;
    sources.push({ ...pick, expectedOwner: owner });
    seen.add(pick.bookId);
  }
  const keywords = tokens(query.slice(0, 32_000));
  const scored: { score: number; key: string; item: PlotMemoryHint }[] = [];
  const targetPeople = currentLinks && await db.characters.bulkGet(currentLinks.map(link => link.characterId));
  const linkedTargets = new Map<string, string>();
  const nearby = new Set(nearbyCharacterIds);
  const nearbyGroups = new Set<string>();
  for (const [index, link] of (currentLinks || []).entries()) {
    const target = targetPeople?.[index];
    if (target?.identity && comparePlotLocations(target.identity.introducedAt, scope) <= 0) {
      const visible = createIdentityProjector([target], [], [])(scope).character(target.id);
      if (visible) {
        linkedTargets.set(link.seriesCharacterId, visible.name);
        if (nearby.has(target.id)) nearbyGroups.add(link.seriesCharacterId);
      }
    }
  }
  for (const source of sources) {
    const [chapters, events, characters, corrections] = await Promise.all([
      db.chapters.where('bookId').equals(source.bookId).toArray(), db.plotEvents.where('bookId').equals(source.bookId).toArray(),
      db.characters.where('bookId').equals(source.bookId).toArray(), db.corrections.where('bookId').equals(source.bookId).toArray(),
    ]);
    const byChapter = new Map(chapters.map(chapter => [chapter.id, chapter]));
    const correctionDialogues = await db.dialogues.bulkGet(corrections.map(row => row.dialogueId));
    const introductionDialogues = characters.some(row => !row.identity) ? await db.dialogues.where('bookId').equals(source.bookId).toArray() : [];
    const projected = createIdentityProjector(characters, introductionDialogues, chapters)(source.through);
    const links = source.bookId === bookId || !linkedTargets.size ? [] : await listSeriesIdentityLinks(source.bookId, source.through, access);
    const mappedNames = new Map(links.map(link => [link.characterId, linkedTargets.get(link.seriesCharacterId)]));
    const nearbySourceIds = source.bookId === bookId ? nearby : new Set(links.filter(link => nearbyGroups.has(link.seriesCharacterId)).map(link => link.characterId));
    const hints: { key: string; item: PlotMemoryHint; linked: boolean }[] = [];
    const visible = events.flatMap(record => {
      const chapter = byChapter.get(record.chapterId);
      if (!chapter || record.bookId !== source.bookId) return [];
      const { current, conflict } = projectPlotEvent(record, source.through);
      return current && current.status !== 'rejected' && current.confidence >= 0.55 && validPlotEvidence(current.evidence, chapter) ? [{ record, current, conflict }] : [];
    });
    const disputed = new Set(visible.flatMap(({ current }) => current.conflictsWith ?? []));
    for (const { record, current, conflict } of visible) {
      if (conflict || (current.source !== 'manual' && disputed.has(record.id))) continue;
      const { paragraphIndex, start, end, text } = current.evidence;
      const related = current.characterIds.flatMap(id => {
        const person = projected.character(id);
        return [person?.name, mappedNames.get(id), ...(person?.aliases ?? [])]
          .flatMap(name => name?.trim() ? [short(name, 80)] : []);
      });
      hints.push({ key: record.id, linked: current.characterIds.some(id => nearbySourceIds.has(id)), item: {
        bookId: source.bookId, chapterIndex: record.order.chapterIndex, kind: current.kind, confidence: current.confidence,
        ...(source.bookId === bookId ? { eventId: record.id } : {}),
        description: short([current.description, current.relation].filter(Boolean).join(' · '), MAX_PLOT_DESCRIPTION),
        evidence: { paragraphIndex, start, end, text },
        ...(related.length ? { relatedCharacters: [...new Set(related)].slice(0, 8) } : {}),
      } });
    }
    for (const [index, correction] of corrections.entries()) {
      const dialogue = correctionDialogues[index];
      const chapter = dialogue && byChapter.get(dialogue.chapterId);
      const character = correction.characterId && projected.character(correction.characterId);
      if (!dialogue || !chapter || (correction.characterId && !character) || dialogue.source !== 'manual' || dialogue.characterId !== correction.characterId ||
          comparePlotLocations(byPosition(chapter, dialogue.paragraphIndex, dialogue.end), source.through) > 0) continue;
      const text = dialogue.text.slice(0, MAX_PLOT_EVIDENCE_TEXT);
      const evidence = { chapterId: chapter.id, paragraphIndex: dialogue.paragraphIndex, start: dialogue.start, end: dialogue.start + text.length, text };
      if (!validPlotEvidence(evidence, chapter)) continue;
      hints.push({ key: correction.id, linked: !!correction.characterId && nearbySourceIds.has(correction.characterId), item: {
        bookId: source.bookId, chapterIndex: chapter.index, description: character ? `人工确认说话人：${short(character.name, 80)}` : '人工标记为未知说话人',
        kind: 'user', confidence: 1, evidence: { paragraphIndex: evidence.paragraphIndex, start: evidence.start, end: evidence.end, text },
        ...(character ? { relatedCharacters: [short(character.name, 80)] } : {}),
      } });
    }
    if (bookOwnerScope(await plotOwner(source.bookId), access.origin) !== source.expectedOwner) continue;
    if (source.bookId !== bookId && (await getSeriesMembership(source.bookId, access))?.seriesId !== membership?.seriesId) continue;
    for (const { key, item, linked } of hints) {
      const overlap = [...tokens(`${item.description} ${item.evidence.text} ${item.relatedCharacters?.join(' ') ?? ''}`)].filter(word => keywords.has(word)).length;
      if (source.bookId !== bookId && !overlap && !linked) continue;
      const distance = source.through.chapterIndex - item.chapterIndex;
      scored.push({ key, item, score: overlap * 4 + (linked ? 12 : 0) + (item.kind === 'user' ? 6 : 0) + (source.bookId === bookId ? 2 : 0) + 2 / (distance + 1) });
    }
  }
  if (bookOwnerScope(await plotOwner(bookId), access.origin) !== currentOwner) return [];
  if (membership && (await getSeriesMembership(bookId, access))?.seriesId !== membership.seriesId) return [];
  const hints: PlotMemoryHint[] = [];
  for (const { item } of scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))) {
    if (hints.length >= MAX_PLOT_MEMORY_HINTS) break;
    if (new TextEncoder().encode(JSON.stringify([...hints, item])).byteLength <= MAX_PLOT_MEMORY_BYTES) hints.push(item);
  }
  return hints;
}
