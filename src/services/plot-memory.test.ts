import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import { bookAccountScope, bookOwnerKey } from '../core/book-owner';
import type { PlotEventRecord } from '../core/plot-types';
import type { Book, Chapter } from '../types';
import { initializeCharacterIdentity, manualAddAlias } from './character-identity';
import { addBookToSeries, createSeries, linkSeriesCharacters, removeBookFromSeries } from './series';
import {
  chapterPlotEnd, commitPlotWindow, mergeChapterSummaries, mergePlotEvents, projectChapterSummary, projectPlotEvent,
  retrievePlotMemory, reviseChapterSummary, revisePlotEvent, validateChapterSummary, validatePlotEvent, validatePlotOutput,
} from './plot-memory';

const principal = { projectUrl: 'https://plot-fixture.example.invalid', userId: 'fixture-account-a' };
const access = { origin: principal.projectUrl, userId: principal.userId };
const owner = bookAccountScope(access.origin, access.userId);
const model = 'deepseek-flash';
const start = { chapterIndex: 0, paragraphIndex: 0, offset: 0 };

function book(id: string): Book {
  return { id, title: id, author: '', language: 'zh', format: 'txt', coverColor: '#123456', fingerprint: id,
    chapterCount: 1, totalWords: 100, createdAt: 1, updatedAt: 1, cloudEnabled: false };
}
async function seed(id = 'book-plot', paragraphs = ['河岸到了。', '“林青已经走了。”孟禾声称。']) {
  const chapter: Chapter = { id: `${id}:ch:0`, bookId: id, index: 0, title: '渡河', paragraphs };
  await db.transaction('rw', [db.books, db.chapters, db.settings], async () => {
    await db.books.add(book(id));
    await db.chapters.add(chapter);
    await db.settings.put({ id: bookOwnerKey(id), value: owner });
  });
  return chapter;
}
function evidence(chapter: Chapter, paragraphIndex: number) {
  return { paragraphIndex, start: 0, end: chapter.paragraphs[paragraphIndex].length, text: chapter.paragraphs[paragraphIndex] };
}
function output(chapter: Chapter, paragraph: number, description: string, characters: string[] = []) {
  const affected = evidence(chapter, paragraph);
  return validatePlotOutput({
    summary: description, events: [{ description, kind: 'fact', characters, confidence: 0.95, evidence: affected }],
  }, chapter, [{ paragraph, start: 0, text: affected.text }], characters);
}
async function record(chapter: Chapter, description: string, windowId = 'window-a') {
  await commitPlotWindow({ chapter, output: output(chapter, 0, description), windowId, from: start, through: chapterPlotEnd(chapter), complete: true, model });
  return (await db.plotEvents.where('chapterId').equals(chapter.id).first())!;
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map(table => table.clear()));
  });
});

describe('V0.6 plot evidence and independent reading summaries', () => {
  it('does not store text with fabricated or unsent evidence and retains characters’ claims as claims', async () => {
    const chapter = await seed();
    const proposed = { description: '孟禾说林青走了', kind: 'fact', characters: [], confidence: .9, evidence: evidence(chapter, 1) };
    const envelope = { summary: '孟禾说林青走了。', events: [proposed] };
    expect(validatePlotOutput(envelope, chapter, [{ paragraph: 0, start: 0, text: chapter.paragraphs[0] }], [])).toEqual({ summary: '', events: [] });
    expect(validatePlotOutput({ ...envelope, events: [{ ...proposed, evidence: { ...proposed.evidence, text: '完全不同' } }] }, chapter,
      [{ paragraph: 1, start: 0, text: chapter.paragraphs[1] }], [])).toEqual({ summary: '', events: [] });
    expect(output(chapter, 1, proposed.description).events[0]?.kind).toBe('claim');

    const english = await seed('book-en', ['The ferry’s anchor hit the mud.']);
    expect(output(english, 0, 'The ferry stopped.').events[0]?.kind).toBe('fact');
  });

  it('projects only the authorized chapter window and preserves manual edits over regenerated AI', async () => {
    const chapter = await seed();
    const early = { ...start, offset: chapter.paragraphs[0].length };
    const end = chapterPlotEnd(chapter);
    await commitPlotWindow({ chapter, windowId: 'first', output: output(chapter, 0, '船抵岸了。'), from: start, through: early, complete: false, model });
    await commitPlotWindow({ chapter, windowId: 'second', output: output(chapter, 1, '孟禾说林青离开。'), from: early, through: end, complete: true, model });
    const summary = (await db.chapterSummaries.get(chapter.id))!;
    expect(validateChapterSummary(summary, [chapter], new Set())).toBe(true);
    expect(projectChapterSummary(summary, chapter, start).text).toBe('');
    expect(projectChapterSummary(summary, chapter, early)).toMatchObject({ text: '船抵岸了。', complete: false });
    expect(projectChapterSummary(summary, chapter, end)).toMatchObject({ text: '船抵岸了。\n\n孟禾说林青离开。', complete: true });
    await reviseChapterSummary(chapter.id, '孟禾只是转述。', false, end, owner);
    await commitPlotWindow({ chapter, windowId: 'regenerate', output: output(chapter, 1, '新的 AI 草稿。'), from: start, through: end, complete: true, model });
    const revised = (await db.chapterSummaries.get(chapter.id))!;
    expect(projectChapterSummary(revised, chapter, end)).toMatchObject({ text: '孟禾只是转述。', source: 'manual' });
    expect(projectChapterSummary(revised, chapter, early)).toMatchObject({ text: '船抵岸了。' });
    expect(mergeChapterSummaries([summary], [revised])).toEqual(mergeChapterSummaries([revised], [summary]));
  });

  it('keeps conflicting AI versions and prior evidence while prioritizing a user revision', async () => {
    const chapter = await seed('book-conflict', ['灯塔熄灭了。']);
    const initial = await record(chapter, '灯塔熄灭。');
    await record(chapter, '灯塔被人故意熄灭。', 'window-b');
    const cutoff = chapterPlotEnd(chapter);
    const conflicting = (await db.plotEvents.get(initial.id))!;
    expect(projectPlotEvent(conflicting, cutoff).conflict).toBe(true);
    expect(await retrievePlotMemory({ bookId: chapter.bookId, scope: cutoff, principal, query: '灯塔' })).toEqual([]);
    await revisePlotEvent(initial.id, { description: '灯塔熄灭。原因未知。' }, cutoff, owner);
    await record(chapter, '灯塔自行熄灭。', 'window-c');
    const revised = (await db.plotEvents.get(initial.id))!;
    expect(validatePlotEvent(revised, [chapter], new Set())).toBe(true);
    expect(projectPlotEvent(revised, cutoff)).toMatchObject({ current: { kind: 'user', description: '灯塔熄灭。原因未知。' }, conflict: false });
    expect(revised.revisions).toHaveLength(4);
    expect(mergePlotEvents([revised], [initial])).toEqual(mergePlotEvents([initial], [revised]));
    await expect(revisePlotEvent(initial.id, { description: '不准保存。' }, cutoff, 'other-owner')).rejects.toThrow('账号');
    expect((await db.plotEvents.get(initial.id))?.revisions).toHaveLength(4);
  });

  it('preserves both source passages for reported same-book conflicts and stops reusing unresolved versions', async () => {
    const chapter = await seed('book-contested', ['日志称林青已经离开渡口。', '林青始终未离开渡口。']);
    const firstCutoff = { ...start, offset: chapter.paragraphs[0].length };
    const cutoff = chapterPlotEnd(chapter);
    await commitPlotWindow({ chapter, output: output(chapter, 0, '日志称林青离开渡口。'), windowId: 'earlier', from: start, through: firstCutoff, complete: false, model });
    const earlier = (await db.plotEvents.where('chapterId').equals(chapter.id).first())!;
    const hints = await retrievePlotMemory({ bookId: chapter.bookId, scope: firstCutoff, query: '渡口', principal });
    expect(hints).toMatchObject([{ eventId: earlier.id }]);
    const context = [{ paragraph: 1, start: 0, text: chapter.paragraphs[1] }];
    const proposed = { summary: '林青从未离开渡口。', events: [{
      description: '林青从未离开渡口。', kind: 'fact', characters: [], confidence: .95, evidence: evidence(chapter, 1), conflictsWith: [earlier.id],
    }] };
    expect(validatePlotOutput(proposed, chapter, context, [])).toEqual({ events: [], summary: '' });
    const valid = validatePlotOutput(proposed, chapter, context, [], [earlier.id]);
    await commitPlotWindow({ chapter, output: valid, windowId: 'later', from: firstCutoff, through: cutoff, complete: true, model });
    const later = (await db.plotEvents.where('chapterId').equals(chapter.id).toArray()).find(row => row.id !== earlier.id)!;
    expect(projectPlotEvent(later, firstCutoff).current).toBeUndefined();
    expect(projectPlotEvent(later, cutoff)).toMatchObject({ conflict: true, current: { conflictsWith: [earlier.id], evidence: { text: chapter.paragraphs[1] } } });
    expect((await db.plotEvents.get(earlier.id))?.revisions[0].evidence.text).toBe(chapter.paragraphs[0]);
    expect(await retrievePlotMemory({ bookId: chapter.bookId, scope: cutoff, query: '渡口', principal })).toEqual([]);
    await revisePlotEvent(later.id, { description: '报告有误。', reject: true }, cutoff, owner);
    expect(await retrievePlotMemory({ bookId: chapter.bookId, scope: cutoff, query: '渡口', principal })).toMatchObject([{ eventId: earlier.id }]);
    const foreign = await seed('book-foreign-anchor', ['说法冲突。']);
    await expect(commitPlotWindow({ chapter: foreign, output: validatePlotOutput({ events: [{ ...proposed.events[0], evidence: evidence(foreign, 0) }], summary: '' },
      foreign, [{ paragraph: 0, start: 0, text: foreign.paragraphs[0] }], [], [earlier.id]), windowId: 'foreign', from: start, through: chapterPlotEnd(foreign), complete: true, model }))
      .rejects.toThrow('同一本书');
  });

  it('retrieves only explicitly selected same-account series memory within each source reading cutoff', async () => {
    const later = await seed('book-sequel', ['林青回到灯塔。']);
    const prequel = await seed('book-prequel', ['林青修好灯塔。', '林青在灯塔发现密信。']);
    const series = await createSeries('任意叙事顺序', access);
    // User order is deliberately opposite to the story chronology.
    await addBookToSeries(series.id, later.bookId, access);
    await addBookToSeries(series.id, prequel.bookId, access);
    const read = { ...start, offset: prequel.paragraphs[0].length };
    const end = chapterPlotEnd(prequel);
    await commitPlotWindow({ chapter: prequel, windowId: 'historic', from: start, through: read, complete: false, output: output(prequel, 0, '林青修好灯塔。'), model });
    await commitPlotWindow({ chapter: prequel, windowId: 'hidden', from: read, through: end, complete: true, output: output(prequel, 1, '林青在灯塔发现密信。'), model });
    await db.progress.put({ bookId: prequel.bookId, chapterId: prequel.id, paragraphIndex: 0, offset: read.offset, version: 1, updatedAt: 3 });
    const request = { bookId: later.bookId, scope: chapterPlotEnd(later), query: '林青又看到了灯塔。', principal };
    expect(await retrievePlotMemory(request)).toEqual([]);
    expect(await retrievePlotMemory({ ...request, selections: [{ bookId: prequel.bookId, through: end }] })).toEqual([]);
    const selections = [{ bookId: prequel.bookId, through: read }];
    const hints = await retrievePlotMemory({ ...request, selections });
    expect(hints).toMatchObject([{ bookId: prequel.bookId, kind: 'fact', description: '林青修好灯塔。' }]);
    expect(JSON.stringify(hints)).not.toContain('密信');
    expect(await retrievePlotMemory({ ...request, selections, principal: { ...principal, userId: 'fixture-account-b' } })).toEqual([]);
    await removeBookFromSeries(series.id, prequel.bookId, access);
    expect(await retrievePlotMemory({ ...request, selections })).toEqual([]);
  });

  it('rejects tampered historic evidence and saves nothing when a plot checkpoint aborts', async () => {
    const chapter = await seed('book-abort', ['红船到了。']);
    const existing = await record(chapter, '红船靠岸。');
    const invalid: PlotEventRecord = { ...existing, revisions: existing.revisions.map(row => ({
      ...row, evidence: { ...row.evidence, text: '原文里从未写过。' },
    })) };
    expect(validatePlotEvent(invalid, [chapter], new Set())).toBe(false);
    await expect(db.transaction('rw', [db.books, db.chapters, db.characters, db.plotEvents, db.chapterSummaries], async () => {
      await commitPlotWindow({ chapter, windowId: 'rolled-back', from: start, through: chapterPlotEnd(chapter), complete: true, output: output(chapter, 0, '新输出'), model });
      throw new Error('检查点失败');
    })).rejects.toThrow('检查点失败');
    expect(await db.plotEvents.get(existing.id)).toEqual(existing);
    expect((await db.chapterSummaries.get(chapter.id))?.fragments).toHaveLength(1);
  });

  it('ranks a user-confirmed cross-book counterpart and includes only aliases visible at the authorized position', async () => {
    const first = await seed('book-first', ['林青修好灯塔。', '密使身份揭晓。']);
    const next = await seed('book-next', ['白舟沿着空街前进。']);
    const firstRead = { ...start, offset: first.paragraphs[0].length };
    const nextRead = chapterPlotEnd(next);
    const firstPerson = initializeCharacterIdentity({ id: 'first-person', bookId: first.bookId, name: '林青', aliases: [] }, start);
    const nextPerson = initializeCharacterIdentity({ id: 'next-person', bookId: next.bookId, name: '白舟', aliases: [] }, start);
    await db.characters.bulkPut([firstPerson, nextPerson]);
    for (const [chapter, through] of [[first, firstRead], [next, nextRead]] as const) {
      await db.progress.put({ bookId: chapter.bookId, chapterId: chapter.id, paragraphIndex: through.paragraphIndex, offset: through.offset, version: 1, updatedAt: 3 });
    }
    const series = await createSeries('跨书身份试读', access);
    for (const chapter of [next, first]) await addBookToSeries(series.id, chapter.bookId, access);
    await manualAddAlias(firstPerson.id, '引航人', firstRead);
    await manualAddAlias(firstPerson.id, '密使', chapterPlotEnd(first));
    await linkSeriesCharacters(series.id,
      { bookId: first.bookId, characterId: firstPerson.id }, { bookId: next.bookId, characterId: nextPerson.id }, false, access);
    await commitPlotWindow({ chapter: first, windowId: 'opening', from: start, through: firstRead, complete: false,
      output: output(first, 0, '林青修好灯塔。', [firstPerson.id]), model, seriesId: series.id });
    const request = { bookId: next.bookId, scope: nextRead, query: '空街', principal, nearbyCharacterIds: [nextPerson.id] };
    expect(await retrievePlotMemory(request)).toEqual([]);
    const hints = await retrievePlotMemory({ ...request, selections: [{ bookId: first.bookId, through: firstRead }] });
    expect(hints).toMatchObject([{ relatedCharacters: ['林青', '白舟', '引航人'], evidence: { text: first.paragraphs[0] } }]);
    expect(JSON.stringify(hints)).not.toContain('密使');
  });
});
