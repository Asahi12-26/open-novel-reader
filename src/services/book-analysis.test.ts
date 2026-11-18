import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import type { Book, Chapter } from '../types';
import { clearAIKey, correctDialogue, extractStoryDialogues, setAIKey } from './ai';
import { analyzeBook, estimateBookAnalysis, getBookAnalysisJob, listBookAnalysisJobs } from './book-analysis';
import type { BookAnalysisController, BookAnalysisJob, BookAnalysisOptions } from './book-analysis-types';
import { storyAttributions, storySpeechInput } from './book-story';
import { AI_BOOK_SYSTEM_PROMPT, AI_COST_MARGIN, AI_MODELS, AI_TOKEN_OVERHEAD } from '../../supabase/functions/_shared/ai-contract';
import { STORY_IDENTITY_SYSTEM_PROMPT, STORY_PLOT_SYSTEM_PROMPT } from '../../supabase/functions/_shared/story-contract';

const cloud = vi.hoisted(() => ({
  config: { url: 'https://book-runner.example.invalid', anonKey: 'sb_publishable_offline_fixture' },
}));
vi.mock('./cloud', () => ({
  getCloudConfig: () => cloud.config,
}));

const key = 'offline-book-fixture-not-a-credential';
const book: Book = {
  id: 'book-runner-fixture', title: 'Offline runner', author: '', format: 'txt', language: 'zh',
  coverColor: '#123456', fingerprint: 'offline-book-fixture', totalWords: 50, chapterCount: 2,
  createdAt: 1, updatedAt: 1, cloudEnabled: false,
};
const options: BookAnalysisOptions = { bookId: book.id, model: 'deepseek-flash', mode: 'deep', budgetUsd: 0.08, authorized: true, pipeline: 'identity-v1' };
const chapters: Chapter[] = [
  { id: 'book-fixture-ch1', bookId: book.id, index: 0, title: '第一章', paragraphs: ['林青说：“我们走。”'] },
  { id: 'book-fixture-ch2', bookId: book.id, index: 1, title: '第二章', paragraphs: ['林青说：“我们到了。”'] },
];
interface AnalysisRequest {
  protocol: 'identity-v1' | 'plot-v1' | 'story-identity-v1'; maxCostUsd: number;
  input: { chapter: string; context: { paragraph: number; start: number; text: string }[]; known: { id: string; name: string }[]; dialogues: { id: string; text: string }[] };
}
const accountStorageKey = 'onr.auth.book-runner.example.invalid';
function providerRequest<Input>(url: string | URL | Request, init?: RequestInit) {
  expect(url).toBe('https://api.deepseek.com/chat/completions');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${key}` } });
  const body = JSON.parse(String(init?.body));
  expect(init?.body).not.toContain(key);
  expect(body).toMatchObject({ model: 'deepseek-flash', max_tokens: 4096, stream: false });
  const system = body.messages[0].content;
  const protocol: AnalysisRequest['protocol'] = system === STORY_PLOT_SYSTEM_PROMPT ? 'plot-v1'
    : system === STORY_IDENTITY_SYSTEM_PROMPT ? 'story-identity-v1' : 'identity-v1';
  if (protocol === 'identity-v1') expect(system).toBe(AI_BOOK_SYSTEM_PROMPT);
  const messages = system + body.messages[1].content;
  const model = AI_MODELS[0];
  const maxCostUsd = AI_COST_MARGIN * ((new TextEncoder().encode(messages).length + AI_TOKEN_OVERHEAD) * model.inputPerMillion + body.max_tokens * model.outputPerMillion) / 1_000_000;
  return { protocol, maxCostUsd, input: JSON.parse(body.messages[1].content) as Input };
}

const controllers: BookAnalysisController[] = [];
function start(overrides: Partial<BookAnalysisOptions> = {}) {
  const controller = analyzeBook({ ...options, ...overrides });
  controllers.push(controller);
  return controller;
}
async function seed(source = chapters) {
  await db.books.put(book);
  await db.chapters.bulkPut(source);
}
async function readTo(chapter: Chapter, offset: number, version: number) {
  await db.progress.put({ bookId: book.id, chapterId: chapter.id, paragraphIndex: 0, offset, updatedAt: Date.now(), version });
}
function mockProxy(failAt?: number) {
  const calls: AnalysisRequest[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const body = providerRequest<AnalysisRequest['input']>(url, init);
    expect(body.protocol).toBe('identity-v1');
    calls.push(body);
    if (calls.length === failAt) return Response.json({ error: `Untrusted response must not leak ${key}` }, { status: 503 });
    const known = body.input.known.find(person => person.name === '林青');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      dialogues: body.input.dialogues.map(dialogue => ({ id: dialogue.id, speaker: '林青', characterId: known?.id || null, confidence: 0.96 })), identities: [],
    }) } }] });
  });
  return { calls };
}
function assertReservation(job: BookAnalysisJob, calls: AnalysisRequest[]) {
  const sum = calls.reduce((total, call) => total + call.maxCostUsd, 0);
  expect(job.reservedUsd).toBeCloseTo(sum, 10);
  expect(job.reservedUsd).toBeLessThanOrEqual(job.budgetUsd);
}

beforeEach(() => {
  localStorage.setItem(accountStorageKey, JSON.stringify({ user: { id: 'book-fixture-user' } }));
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network access is prohibited.'); }));
  setAIKey(key);
});
afterEach(async () => {
  clearAIKey();
  const tasks = controllers.splice(0);
  for (const task of tasks) task.cancel();
  await Promise.allSettled(tasks.map(task => task.done));
  localStorage.removeItem(accountStorageKey);
  // Clearing only the test process's fake IndexedDB singleton.
  await db.transaction('rw', [db.books, db.chapters, db.progress, db.characters, db.dialogues, db.corrections, db.jobs, db.settings, db.plotEvents, db.chapterSummaries, db.dialogueCorrectionRevisions], async () => {
    await Promise.all([db.books.clear(), db.chapters.clear(), db.progress.clear(), db.characters.clear(), db.dialogues.clear(), db.corrections.clear(), db.jobs.clear(), db.settings.clear(), db.plotEvents.clear(), db.chapterSummaries.clear(), db.dialogueCorrectionRevisions.clear()]);
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('whole-book analysis authorization and checkpointing (offline)', () => {
  it('releases the account binding when a book disappeared before preparation', async () => {
    await expect(start().done).rejects.toThrow('书籍不存在');
    expect(fetch).not.toHaveBeenCalled();
    expect(await listBookAnalysisJobs(book.id)).toEqual([]);
  });

  it('requires a user key before reserving any generation cost', async () => {
    await seed();
    clearAIKey();
    await expect(start().done).rejects.toThrow('API Key');
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.settings.where('id').startsWith('book-analysis-budget:').count()).toBe(0);
    expect(await db.dialogues.count()).toBe(0);
  });

  it('persists a failed charge reservation, requires renewed consent and resumes only unfinished work', async () => {
    await seed();
    const proxy = mockProxy(2);
    const estimate = await estimateBookAnalysis(book.id, options.model, 'deep', { pipeline: 'identity-v1' });
    expect(estimate).toMatchObject({ totalChunks: 2, maxRequests: 4, estimatedMinUsd: 0 });
    expect(fetch).not.toHaveBeenCalled();
    const failed = await start().done;
    expect(failed).toMatchObject({ status: 'failed', completedChunks: 1, totalChunks: 2, budgetUsd: options.budgetUsd });
    expect(failed.error).toContain('503');
    expect(failed.error).not.toContain(key);
    expect(proxy.calls.map(call => call.input.chapter)).toEqual(['第一章', '第二章']);
    assertReservation(failed, proxy.calls);
    expect(await db.dialogues.count()).toBe(1);
    const checkpoint = await getBookAnalysisJob(failed.id);
    expect(checkpoint).toEqual(failed);
    expect(await db.jobs.count()).toBe(0);
    expect(JSON.stringify(await db.settings.toArray())).not.toContain(key);

    clearAIKey();
    expect(await listBookAnalysisJobs(book.id)).toEqual([failed]);
    await expect(start({ jobId: failed.id }).done).rejects.toThrow(/密钥|API Key/);
    setAIKey(key);
    await expect(start({ jobId: failed.id, authorized: false as true }).done).rejects.toThrow('授权');
    await expect(start({ jobId: failed.id, budgetUsd: options.budgetUsd * 2 }).done).rejects.toThrow('预算');
    expect(proxy.calls).toHaveLength(2);

    const completed = await start({ jobId: failed.id }).done;
    expect(completed).toMatchObject({ id: failed.id, status: 'done', completedChunks: 2, totalChunks: 2, completedChapters: 2 });
    expect(proxy.calls.map(call => call.input.chapter)).toEqual(['第一章', '第二章', '第二章']);
    expect(proxy.calls[2].input.dialogues).toEqual(proxy.calls[1].input.dialogues);
    expect(completed.reservedUsd).toBeGreaterThan(failed.reservedUsd);
    assertReservation(completed, proxy.calls);
    const saved = await db.dialogues.toArray();
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map(dialogue => dialogue.characterId)).size).toBe(1);
    expect(saved[0].characterId).toBeTruthy();
  });

  it('stops a retry before the next charge when failed requests used the fixed budget', async () => {
    await seed();
    const proxy = mockProxy(2);
    const budgetUsd = 0.018;
    const failed = await start({ budgetUsd }).done;
    expect(failed).toMatchObject({ status: 'failed', completedChunks: 1, budgetUsd });
    expect(proxy.calls).toHaveLength(2);
    assertReservation(failed, proxy.calls);
    expect(failed.reservedUsd + proxy.calls[1].maxCostUsd).toBeGreaterThan(budgetUsd);

    const stopped = await start({ jobId: failed.id, budgetUsd }).done;
    expect(stopped).toMatchObject({ status: 'failed', completedChunks: 1, reservedUsd: failed.reservedUsd, budgetUsd });
    expect(stopped.error).toContain('总预算');
    expect(proxy.calls).toHaveLength(2);
    expect(await db.dialogues.count()).toBe(1);
  });

  it('rolls back saved dialogue and chapter work if the whole-book checkpoint fails', async () => {
    await seed();
    const proxy = mockProxy();
    const put = db.settings.put.bind(db.settings);
    vi.spyOn(db.settings, 'put').mockImplementation((setting, ...rest) => {
      const value = setting.value as Partial<BookAnalysisJob>;
      if (setting.id.startsWith('book-analysis:') && value.completedChunks === 1) throw new Error('Simulated IndexedDB write failure.');
      return put(setting, ...rest);
    });
    const stopped = await start().done;
    expect(stopped).toMatchObject({ status: 'failed', completedChunks: 0 });
    expect(proxy.calls).toHaveLength(1);
    assertReservation(stopped, proxy.calls);
    expect(await db.dialogues.count()).toBe(0);
    expect(await db.characters.count()).toBe(0);
    expect(await db.jobs.count()).toBe(0);
    expect(await getBookAnalysisJob(stopped.id)).toMatchObject({ status: 'failed', completedChunks: 0, reservedUsd: stopped.reservedUsd });
  });

  it('sends only complete read dialogue and bounded context as reading grows within one authorized session', async () => {
    const firstLine = '林青说：“开门。”';
    const secondLine = '林青说：“尚未读到的对白。”';
    const first = { ...chapters[0], paragraphs: [firstLine + secondLine, '不该提前发送的后续段落。'] };
    const second = { ...chapters[1], paragraphs: [...chapters[1].paragraphs, '故事还没有读完。'] };
    await seed([first, second]);
    await readTo(first, firstLine.length, 1);
    const proxy = mockProxy();
    let latest: BookAnalysisJob | undefined;
    const task = start({ mode: 'reading-progress', onProgress: job => { latest = job; } });
    const waitingAt = async (chapterId: string, offset: number) => vi.waitFor(() => {
      expect(latest).toMatchObject({ status: 'waiting', scopeEnd: { chapterId, offset } });
    }, { timeout: 3500 });
    try {
      await waitingAt(first.id, firstLine.length);
      expect(proxy.calls).toHaveLength(1);
      expect(proxy.calls[0].input.dialogues.map(row => row.text)).toEqual(['“开门。”']);
      expect(proxy.calls[0].input.context).toEqual([{ paragraph: 0, start: 0, text: firstLine }]);
      expect(JSON.stringify(proxy.calls[0].input)).not.toContain('尚未读到');
      expect(JSON.stringify(proxy.calls[0].input)).not.toContain('后续段落');

      task.pause();
      await vi.waitFor(() => expect(latest?.status).toBe('paused'));
      const partial = firstLine.length + secondLine.indexOf('“') + 2;
      await readTo(first, partial, 2);
      expect(proxy.calls).toHaveLength(1);
      task.resume();
      await waitingAt(first.id, partial);
      expect(proxy.calls).toHaveLength(1);

      const full = first.paragraphs[0].length;
      await readTo(first, full, 3);
      await waitingAt(first.id, full);
      expect(proxy.calls).toHaveLength(2);
      expect(proxy.calls[1].input.dialogues.map(row => row.text)).toEqual(['“尚未读到的对白。”']);
      expect(JSON.stringify(proxy.calls[1].input)).not.toContain('后续段落');

      await readTo(second, second.paragraphs[0].length, 4);
      await waitingAt(second.id, second.paragraphs[0].length);
      expect(proxy.calls).toHaveLength(3);
      expect(proxy.calls[2].input.dialogues.map(row => row.text)).toEqual(['“我们到了。”']);
      assertReservation(latest!, proxy.calls);
    } finally { task.cancel(); }
    expect((await task.done).status).toBe('cancelled');
  });
});

describe('story-first book analysis pipeline (offline)', () => {
  function mockStory(failAt?: number) {
    const calls: {
      input: { chapter: string; context: { paragraph: number; start: number; text: string }[];
        known: { id: string; name: string }[]; dialogues?: { id: string; text: string }[];
        memory: { bookId: string; description: string }[]; manual?: { id: string; characterId: string | null }[] };
      protocol: string; maxCostUsd: number;
    }[] = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const request = providerRequest<typeof calls[number]['input']>(url, init);
      calls.push(request);
      if (calls.length === failAt) return Response.json({ error: 'offline interruption' }, { status: 503 });
      const input = request.input as typeof calls[number]['input'];
      const context = input.context[0];
      const evidence = { paragraphIndex: context.paragraph, start: context.start, end: context.start + context.text.length, text: context.text };
      const person = input.known.find(row => row.name === '林青');
      const output = request.protocol === 'plot-v1' ? {
        summary: '林青开口说话。', events: [{ description: '林青开口说话', characters: person ? [person.id] : [], kind: 'claim', confidence: .95, evidence }],
      } : {
        dialogues: input.dialogues?.map(row => ({ id: row.id, speech: true,
          speaker: '林青', characterId: person?.id ?? null, evidence, confidence: .94 })), identities: [],
      };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
    });
    return calls;
  }

  it('records bounded plot before attributing speakers and skips completed plot and speech on resume', async () => {
    localStorage.removeItem(accountStorageKey);
    await seed();
    const calls = mockStory(3);
    const estimate = await estimateBookAnalysis(book.id, options.model, 'deep');
    expect(estimate).toMatchObject({ plotRequests: 2, totalChunks: 2, reviewRequests: 2, maxRequests: 6 });
    expect(fetch).not.toHaveBeenCalled();
    const first = await start({ pipeline: 'story-v1' }).done;
    expect(first).toMatchObject({ status: 'failed', pipeline: 'story-v1', completedChunks: 1, completedPlotRequests: 1 });
    expect(calls.map(call => [call.protocol, call.input.chapter])).toEqual([
      ['plot-v1', '第一章'], ['story-identity-v1', '第一章'], ['plot-v1', '第二章'],
    ]);
    expect(calls[1].input.memory).toEqual(expect.arrayContaining([expect.objectContaining({ bookId: book.id, description: '林青开口说话' })]));
    expect(await db.chapterSummaries.count()).toBe(1);
    expect(await db.plotEvents.count()).toBe(1);
    expect(await db.dialogues.count()).toBe(1);
    await expect(start({ pipeline: 'story-v1', jobId: first.id, seriesMemory: [{ bookId: 'changed-book', through: { chapterIndex: 1, paragraphIndex: 0, offset: 1 } }] }).done).rejects.toThrow(/预算记录/);
    expect(calls).toHaveLength(3);
    const second = await start({ pipeline: 'story-v1', jobId: first.id }).done;
    expect(second).toMatchObject({ status: 'done', completedChunks: 2, completedPlotRequests: 2 });
    expect(calls.slice(3).map(call => [call.protocol, call.input.chapter])).toEqual([['plot-v1', '第二章'], ['story-identity-v1', '第二章']]);
    expect(second.reservedUsd).toBeCloseTo(calls.reduce((total, call) => total + call.maxCostUsd, 0), 10);
    expect(second.reservedUsd).toBeLessThanOrEqual(second.budgetUsd);
    expect(await db.chapterSummaries.count()).toBe(2);
    expect(await db.plotEvents.count()).toBe(2);
    expect(new Set((await db.dialogues.toArray()).map(dialogue => dialogue.characterId)).size).toBe(1);
  });

  it('uses only the explicitly targeted chapter for recap regeneration', async () => {
    await seed();
    const calls = mockStory();
    const target = chapters[1].id;
    await readTo(chapters[1], chapters[1].paragraphs[0].length - 1, 1);
    await expect(estimateBookAnalysis(book.id, options.model, 'deep', { summaryChapterId: target })).rejects.toThrow('读完目标章节');
    await expect(start({ pipeline: 'story-v1', summaryChapterId: target }).done).rejects.toThrow('读完目标章节');
    expect(fetch).not.toHaveBeenCalled();
    await readTo(chapters[1], chapters[1].paragraphs[0].length, 2);
    const estimate = await estimateBookAnalysis(book.id, options.model, 'deep', { summaryChapterId: target });
    expect(estimate).toMatchObject({ chapterCount: 1, plotRequests: 1, totalChunks: 0, maxRequests: 1 });
    const task = await start({ pipeline: 'story-v1', summaryChapterId: target }).done;
    expect(task).toMatchObject({ status: 'done', summaryChapterId: target, completedPlotRequests: 1, completedChunks: 0 });
    expect(calls.map(call => [call.protocol, call.input.chapter])).toEqual([['plot-v1', '第二章']]);
    expect(await db.chapterSummaries.get(target)).toBeTruthy();
    expect(await db.chapterSummaries.get(chapters[0].id)).toBeUndefined();
    expect(await db.dialogues.count()).toBe(0);
  });

  it('uses prior manual evidence and preserves the correction and its history on reanalysis', async () => {
    await seed();
    const calls = mockStory();
    expect((await start({ pipeline: 'story-v1' }).done).status).toBe('done');
    const [line] = await db.dialogues.where('chapterId').equals(chapters[0].id).toArray();
    await correctDialogue(line.id, null);
    expect((await start({ pipeline: 'story-v1' }).done).status).toBe('done');
    expect(calls[5].input.manual).toEqual([{ id: line.id, characterId: null }]);
    expect(await db.dialogues.get(line.id)).toMatchObject({ source: 'manual', characterId: null });
    expect(await db.dialogueCorrectionRevisions.where('dialogueId').equals(line.id).toArray())
      .toEqual([expect.objectContaining({ previousCharacterId: line.characterId, characterId: null })]);
  });

  it('never sends future text or unscoped series memory from a reading-progress job', async () => {
    const read = chapters[0].paragraphs[0];
    const first = { ...chapters[0], paragraphs: [`${read}尚未读到的剧情。`, '未来段落。'] };
    await seed([first, chapters[1]]);
    await readTo(first, read.length, 1);
    const calls = mockStory();
    let latest: BookAnalysisJob | undefined;
    const task = start({ pipeline: 'story-v1', mode: 'reading-progress',
      seriesMemory: [{ bookId: 'foreign-book', through: { chapterIndex: 4, paragraphIndex: 0, offset: 2 } }],
      onProgress: state => { latest = state; } });
    await vi.waitFor(() => expect(latest?.status).toBe('waiting'), { timeout: 3000 });
    expect(calls.map(call => [call.protocol, call.input.context.map(row => row.text)])).toEqual([
      ['plot-v1', [read]], ['story-identity-v1', [read]],
    ]);
    expect(calls.every(call => call.input.memory.every(item => item.bookId === book.id))).toBe(true);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toMatch(/尚未读到|未来段落|foreign-book/);
    task.cancel();
    await task.done;
  });
});

describe('story speaker evidence (offline)', () => {
  it('keeps same-name IDs unresolved without a unique alias in the local evidence', () => {
    const chapter = { ...chapters[0], paragraphs: [
      'Harbor Alex said, “Wait.”', 'Alex said, “Go.”', 'Alex said, “Fine.”',
      'Harbor Alex faced Station Alex as someone said, “Stop.”',
    ] };
    const candidates = extractStoryDialogues(chapter);
    const input = storySpeechInput(chapter, candidates, [
      { id: 'harbor', name: 'Alex', aliases: ['Harbor Alex'], bookId: book.id },
      { id: 'station', name: 'Alex', aliases: ['Station Alex'], bookId: book.id },
    ]);
    const dialogues = candidates.map((line, index) => ({
      id: line.id, speech: true, speaker: 'Alex', characterId: index === 2 ? null : 'harbor', confidence: .98,
      evidence: { paragraphIndex: index, start: 0, end: line.start, text: chapter.paragraphs[index].slice(0, line.start) },
    }));
    expect(storyAttributions({ dialogues }, candidates, input)).toMatchObject([
      { speaker: 'Alex', characterId: 'harbor' },
      { speaker: null, characterId: null, possibleCharacterIds: ['harbor', 'station'] },
      { speaker: null, characterId: null, possibleCharacterIds: ['harbor', 'station'] },
      { speaker: null, characterId: null, possibleCharacterIds: ['harbor', 'station'] },
    ]);
  });

  it('shares a new ID only for the same evidence anchor and rejects mere name substrings', () => {
    const chapter = { ...chapters[0], paragraphs: ['Alex said, “Wait.” “Look.”', 'A different Alex said, “Go.”', 'Alexandra wrote “Note.”'] };
    const candidates = extractStoryDialogues(chapter);
    const [first] = candidates;
    const input = storySpeechInput(chapter, candidates, []);
    const dialogues = candidates.map((line, index) => {
      const end = index <= 1 ? first.start : line.start;
      return {
        id: line.id, speech: true, speaker: index === 1 ? 'ALEX' : 'Alex', characterId: null, confidence: .98,
        evidence: { paragraphIndex: line.paragraphIndex, start: 0, end, text: chapter.paragraphs[line.paragraphIndex].slice(0, end) },
      };
    });
    expect(storyAttributions({ dialogues }, candidates, input).map(row => row.speaker)).toEqual(['Alex', 'Alex', null, null]);
  });
});
