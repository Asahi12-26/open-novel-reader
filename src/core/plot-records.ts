import type { Chapter, IdentityEvidence, IdentityLocation } from '../types';
import type { ChapterSummaryFragment, ChapterSummaryRecord, ChapterSummaryRevision, PlotEventRecord, PlotEventRevision, PlotKind } from './plot-types';

export const MAX_PLOT_RECORDS_PER_BOOK = 20_000;
export const MAX_PLOT_REVISIONS = 160;
export const MAX_SUMMARY_FRAGMENTS = 1600;
export const MAX_PLOT_EVIDENCE_TEXT = 240;
export const MAX_PLOT_DESCRIPTION = 320;
export const MAX_PLOT_EVENTS_PER_WINDOW = 8;
export const MAX_PLOT_CONFLICT_LINKS = 4;
export const MAX_SUMMARY_FRAGMENT_TEXT = 1000;
export const MAX_MANUAL_SUMMARY = 4000;
const kinds = new Set<PlotKind>(['fact', 'claim', 'inference', 'user']);

export const plotObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const plotInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const plotText = (value: unknown, max: number, min = 1): value is string =>
  typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const id = (value: unknown): value is string => plotText(value, 360) && !/\s/.test(value);

export const comparePlotLocations = (left: IdentityLocation, right: IdentityLocation) =>
  left.chapterIndex - right.chapterIndex || left.paragraphIndex - right.paragraphIndex || left.offset - right.offset;

export function chapterPlotEnd(chapter: Chapter): IdentityLocation {
  const paragraphIndex = Math.max(chapter.paragraphs.length - 1, 0);
  return { chapterIndex: chapter.index, paragraphIndex, offset: chapter.paragraphs[paragraphIndex]?.length ?? 0 };
}

function validLocation(value: unknown, chapters: readonly Chapter[]): value is IdentityLocation {
  if (!plotObject(value) || !only(value, ['chapterIndex', 'paragraphIndex', 'offset']) ||
      !plotInteger(value.chapterIndex) || !plotInteger(value.paragraphIndex) || !plotInteger(value.offset)) return false;
  const chapter = chapters.find(item => item.index === value.chapterIndex);
  const paragraph = chapter?.paragraphs[value.paragraphIndex];
  return typeof paragraph === 'string' ? value.offset <= paragraph.length : chapter?.paragraphs.length === 0 && value.paragraphIndex === 0 && value.offset === 0;
}

export function validPlotEvidence(value: unknown, chapter: Chapter): value is IdentityEvidence {
  if (!plotObject(value) || !only(value, ['chapterId', 'paragraphIndex', 'start', 'end', 'text']) ||
      value.chapterId !== chapter.id || !plotInteger(value.paragraphIndex) ||
      !plotInteger(value.start) || !plotInteger(value.end) || !plotText(value.text, MAX_PLOT_EVIDENCE_TEXT)) return false;
  return value.end - value.start === value.text.length &&
    chapter.paragraphs[value.paragraphIndex]?.slice(value.start, value.end) === value.text;
}

const evidenceLocation = (chapter: Chapter, evidence: IdentityEvidence, offset: number): IdentityLocation =>
  ({ chapterIndex: chapter.index, paragraphIndex: evidence.paragraphIndex, offset });
function validIds(value: unknown, characterIds: ReadonlySet<string>) {
  return Array.isArray(value) && value.length <= 8 && value.every(entry => id(entry) && characterIds.has(entry)) && new Set(value).size === value.length;
}
function validHistory<T extends { id: string }>(value: unknown, max: number, validator: (value: unknown) => value is T): value is T[] {
  return Array.isArray(value) && value.length <= max && value.every(validator) && new Set(value.map(row => row.id)).size === value.length;
}

export function validatePlotEvent(value: unknown, chapters: readonly Chapter[], characterIds: ReadonlySet<string>): value is PlotEventRecord {
  if (!plotObject(value) || !only(value, ['id', 'bookId', 'chapterId', 'seriesId', 'order', 'revisions']) ||
      !id(value.id) || !id(value.bookId) || !id(value.chapterId) || (value.seriesId !== undefined && !id(value.seriesId))) return false;
  const chapter = chapters.find(item => item.id === value.chapterId && item.bookId === value.bookId);
  if (!chapter || !validLocation(value.order, [chapter])) return false;
  const order = value.order;
  return validHistory(value.revisions, MAX_PLOT_REVISIONS, (row): row is PlotEventRevision =>
    plotObject(row) && only(row, ['id', 'description', 'characterIds', 'relation', 'conflictsWith', 'kind', 'source', 'status', 'confidence', 'evidence', 'visibleAt', 'updatedAt']) &&
    id(row.id) && plotText(row.description, MAX_PLOT_DESCRIPTION) && validIds(row.characterIds, characterIds) &&
    (row.relation === undefined || plotText(row.relation, MAX_PLOT_DESCRIPTION)) &&
    (row.conflictsWith === undefined || (row.source === 'ai' && Array.isArray(row.conflictsWith) &&
      row.conflictsWith.length <= MAX_PLOT_CONFLICT_LINKS && new Set(row.conflictsWith).size === row.conflictsWith.length &&
      row.conflictsWith.every(ref => id(ref) && ref !== value.id))) &&
    (row.source === 'manual' && row.kind === 'user' || row.source === 'ai' && row.kind !== 'user' && kinds.has(row.kind as PlotKind)) &&
    (row.status === 'active' || row.source === 'manual' && row.status === 'rejected') &&
    typeof row.confidence === 'number' && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1 &&
    validPlotEvidence(row.evidence, chapter) && row.evidence.paragraphIndex === order.paragraphIndex && row.evidence.start === order.offset &&
    validLocation(row.visibleAt, chapters) && comparePlotLocations(evidenceLocation(chapter, row.evidence, row.evidence.end), row.visibleAt) <= 0 &&
    plotInteger(row.updatedAt)) && value.revisions.length > 0;
}

export function validateChapterSummary(value: unknown, chapters: readonly Chapter[], characterIds: ReadonlySet<string>): value is ChapterSummaryRecord {
  if (!plotObject(value) || !only(value, ['bookId', 'chapterId', 'fragments', 'revisions']) || !id(value.bookId) || !id(value.chapterId)) return false;
  const chapter = chapters.find(item => item.id === value.chapterId && item.bookId === value.bookId);
  if (!chapter) return false;
  return validHistory(value.fragments, MAX_SUMMARY_FRAGMENTS, (row): row is ChapterSummaryFragment => {
    if (!plotObject(row) || !only(row, ['id', 'from', 'through', 'text', 'characterIds', 'evidence', 'updatedAt', 'model']) ||
        !id(row.id) || !validLocation(row.from, [chapter]) || !validLocation(row.through, [chapter]) ||
        comparePlotLocations(row.from, row.through) >= 0 || !plotText(row.text, MAX_SUMMARY_FRAGMENT_TEXT, 0) ||
        !validIds(row.characterIds, characterIds) || !plotText(row.model, 100) || !plotInteger(row.updatedAt) ||
        !Array.isArray(row.evidence) || (row.text.trim() && row.evidence.length < 1) || row.evidence.length > MAX_PLOT_EVENTS_PER_WINDOW) return false;
    const { from, through } = row;
    return row.evidence.every(evidence => validPlotEvidence(evidence, chapter) &&
      comparePlotLocations(evidenceLocation(chapter, evidence, evidence.start), from) >= 0 &&
      comparePlotLocations(evidenceLocation(chapter, evidence, evidence.end), through) <= 0);
  }) && validHistory(value.revisions, MAX_PLOT_REVISIONS, (row): row is ChapterSummaryRevision =>
    plotObject(row) && only(row, ['id', 'text', 'status', 'visibleAt', 'updatedAt']) && id(row.id) &&
    plotText(row.text, MAX_MANUAL_SUMMARY) && (row.status === 'active' || row.status === 'flagged') &&
    validLocation(row.visibleAt, chapters) && row.visibleAt.chapterIndex >= chapter.index && plotInteger(row.updatedAt));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (plotObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function mergeRevisions<T extends { id: string; updatedAt: number }>(max: number, ...groups: (readonly T[])[]): T[] {
  const rows = new Map<string, T>();
  for (const entry of groups.flat()) {
    const existing = rows.get(entry.id);
    if (existing && JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(entry))) {
      throw new Error('剧情记录版本存在冲突，本机记录已保留。');
    }
    rows.set(entry.id, entry);
  }
  if (rows.size > max) throw new Error('剧情记录历史达到本版本上限，已保留原记录。');
  return [...rows.values()].sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
}

export function mergePlotEvents(...groups: (readonly PlotEventRecord[] | undefined)[]): PlotEventRecord[] {
  const records = new Map<string, PlotEventRecord>();
  for (const group of groups) for (const row of group ?? []) {
    const previous = records.get(row.id);
    if (previous && (previous.bookId !== row.bookId || previous.chapterId !== row.chapterId ||
        comparePlotLocations(previous.order, row.order) !== 0)) throw new Error('剧情事件与原文位置冲突。');
    const seriesId = [previous?.seriesId, row.seriesId].filter(value => value !== undefined).sort()[0];
    records.set(row.id, previous ? {
      ...row, ...(seriesId ? { seriesId } : {}),
      revisions: mergeRevisions(MAX_PLOT_REVISIONS, previous.revisions, row.revisions),
    } : row);
  }
  if (records.size > MAX_PLOT_RECORDS_PER_BOOK) throw new Error('单本书的剧情记忆已达到本版本上限。');
  return [...records.values()].sort((a, b) => comparePlotLocations(a.order, b.order) || a.id.localeCompare(b.id));
}

export function mergeChapterSummaries(...groups: (readonly ChapterSummaryRecord[] | undefined)[]): ChapterSummaryRecord[] {
  const records = new Map<string, ChapterSummaryRecord>();
  for (const group of groups) for (const row of group ?? []) {
    const previous = records.get(row.chapterId);
    if (previous && previous.bookId !== row.bookId) throw new Error('章节简介与书籍归属冲突。');
    records.set(row.chapterId, previous ? {
      ...row,
      fragments: mergeRevisions(MAX_SUMMARY_FRAGMENTS, previous.fragments, row.fragments),
      revisions: mergeRevisions(MAX_PLOT_REVISIONS, previous.revisions, row.revisions),
    } : row);
  }
  return [...records.values()].sort((a, b) => a.chapterId.localeCompare(b.chapterId));
}

const byRevision = <T extends { updatedAt: number; id: string }>(a: T, b: T) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
export function projectPlotEvent(record: PlotEventRecord, cutoff: IdentityLocation) {
  const history = record.revisions.filter(row => comparePlotLocations(row.visibleAt, cutoff) <= 0).sort(byRevision);
  const manual = history.filter(row => row.source === 'manual').at(-1);
  const current = manual ?? history.at(-1);
  const versions = new Set(history.filter(row => row.source === 'ai').map(row =>
    [row.kind, row.description.normalize('NFKC').trim(), row.relation?.trim(), [...row.characterIds].sort()].join('|')));
  return { current, history, conflict: !manual && (versions.size > 1 || !!current?.conflictsWith?.length) };
}

export function projectChapterSummary(record: ChapterSummaryRecord, chapter: Chapter, cutoff: IdentityLocation) {
  const fragments = record.fragments.filter(row => comparePlotLocations(row.through, cutoff) <= 0);
  const chain: ChapterSummaryFragment[] = [];
  let cursor: IdentityLocation = { chapterIndex: chapter.index, paragraphIndex: 0, offset: 0 };
  let complete = true;
  // Choose the latest result for the same span. When older partial windows overlap
  // regenerated ranges, prefer the closest contiguous start to avoid repetition.
  while (true) {
    const next = fragments.filter(row => comparePlotLocations(row.from, cursor) <= 0 && comparePlotLocations(row.through, cursor) > 0)
      .sort((a, b) => comparePlotLocations(b.from, a.from) || comparePlotLocations(b.through, a.through) || byRevision(b, a))[0];
    if (!next) {
      // A skipped window can leave a gap. Later verified fragments remain useful,
      // but the recap stays partial even if they reach the end of the chapter.
      const later = fragments.reduce<ChapterSummaryFragment | undefined>((earliest, row) =>
        comparePlotLocations(row.from, cursor) > 0 && (!earliest || comparePlotLocations(row.from, earliest.from) < 0) ? row : earliest, undefined);
      if (!later) break;
      complete = false;
      cursor = later.from;
      continue;
    }
    chain.push(next);
    cursor = next.through;
  }
  const revisions = record.revisions.filter(row => comparePlotLocations(row.visibleAt, cutoff) <= 0).sort(byRevision);
  const latest = revisions.at(-1);
  const text = latest?.text ?? chain.map(row => row.text).filter(Boolean).join('\n\n');
  return {
    text, complete: complete && comparePlotLocations(cursor, chapterPlotEnd(chapter)) >= 0,
    source: latest ? 'manual' as const : 'ai' as const, flagged: latest?.status === 'flagged', revisions,
    evidence: chain.flatMap(row => row.evidence),
    characterIds: [...new Set(chain.flatMap(row => row.characterIds))],
  };
}
