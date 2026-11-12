import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import type { Book, Chapter } from '../types';
import { clearAIKey, setAIKey } from './ai';
import { analyzeBook, estimateBookAnalysis, getBookAnalysisJob, listBookAnalysisJobs } from './book-analysis';
import type { BookAnalysisController, BookAnalysisJob, BookAnalysisOptions } from './book-analysis-types';

const cloud = vi.hoisted(() => ({
  config: { url: 'https://book-runner.example.invalid', anonKey: 'sb_publishable_offline_fixture' },
  listeners: new Set<(session: { user: { id: string } } | null) => void>(),
}));
vi.mock('./cloud', () => ({
  getCloudConfig: () => cloud.config,
  getSession: async () => ({ user: { id: 'book-fixture-user' }, access_token: 'offline-fixture-session' }),
  subscribeAuth: (callback: (session: { user: { id: string } } | null) => void) => {
    cloud.listeners.add(callback);
    return () => cloud.listeners.delete(callback);
  },
}));

const key = 'offline-book-fixture-not-a-credential';
const book: Book = {
  id: 'book-runner-fixture', title: 'Offline runner', author: '', format: 'txt', language: 'zh',
  coverColor: '#123456', fingerprint: 'offline-book-fixture', totalWords: 50, chapterCount: 2,
  createdAt: 1, updatedAt: 1, cloudEnabled: false,
};
const options: BookAnalysisOptions = { bookId: book.id, model: 'deepseek-flash', mode: 'deep', budgetUsd: 0.08, authorized: true };
const chapters: Chapter[] = [
  { id: 'book-fixture-ch1', bookId: book.id, index: 0, title: '第一章', paragraphs: ['林青说：“我们走。”'] },
  { id: 'book-fixture-ch2', bookId: book.id, index: 1, title: '第二章', paragraphs: ['林青说：“我们到了。”'] },
];
interface AnalysisRequest {
  action: 'analyze'; protocol: 'identity-v1'; authorized: boolean; apiKey: string; maxCostUsd: number;
  input: { chapter: string; context: { paragraph: number; start: number; text: string }[]; known: { id: string; name: string }[]; dialogues: { id: string; text: string }[] };
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
  let preflights = 0;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    expect(url).toBe(`${cloud.config.url}/functions/v1/deepseek-proxy`);
    const request = JSON.parse(String(init?.body));
    if (request.action === 'status') {
      expect(request).toEqual({ action: 'status' });
      preflights++;
      return Response.json({ ready: true, upstreamChecked: false, protocols: ['identity-v1'], models: ['deepseek-flash'], limits: { maxTokens: 4096, maxRequestCostUsd: 0.1 } });
    }
    expect(request).toMatchObject({ action: 'analyze', protocol: 'identity-v1', authorized: true, apiKey: key });
    const body = request as AnalysisRequest;
    calls.push(body);
    if (calls.length === failAt) return Response.json({ error: `Untrusted response must not leak ${key}` }, { status: 503 });
    const known = body.input.known.find(person => person.name === '林青');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      dialogues: body.input.dialogues.map(dialogue => ({ id: dialogue.id, speaker: '林青', characterId: known?.id || null, confidence: 0.96 })), identities: [],
    }) } }] });
  });
  return { calls, get preflights() { return preflights; } };
}
function assertReservation(job: BookAnalysisJob, calls: AnalysisRequest[]) {
  const sum = calls.reduce((total, call) => total + call.maxCostUsd, 0);
  expect(job.reservedUsd).toBeCloseTo(sum, 10);
  expect(job.reservedUsd).toBeLessThanOrEqual(job.budgetUsd);
}

beforeEach(() => {
  cloud.listeners.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network access is prohibited.'); }));
  setAIKey(key);
});
afterEach(async () => {
  clearAIKey();
  const tasks = controllers.splice(0);
  for (const task of tasks) task.cancel();
  await Promise.allSettled(tasks.map(task => task.done));
  // Clearing only the test process's fake IndexedDB singleton.
  await db.transaction('rw', [db.books, db.chapters, db.progress, db.characters, db.dialogues, db.corrections, db.jobs, db.settings], async () => {
    await Promise.all([db.books.clear(), db.chapters.clear(), db.progress.clear(), db.characters.clear(), db.dialogues.clear(), db.corrections.clear(), db.jobs.clear(), db.settings.clear()]);
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('whole-book analysis authorization and checkpointing (offline)', () => {
  it('releases the account binding when a book disappeared before preparation', async () => {
    await expect(start().done).rejects.toThrow('书籍不存在');
    expect(fetch).not.toHaveBeenCalled();
    expect(cloud.listeners.size).toBe(0);
  });

  it('checks old proxy readiness before reserving any generation cost', async () => {
    await seed();
    vi.mocked(fetch).mockResolvedValue(Response.json({ ready: true, upstreamChecked: false, models: ['deepseek-flash'], limits: { maxTokens: 4096, maxRequestCostUsd: 0.1 } }));
    const stopped = await start().done;
    expect(stopped).toMatchObject({ status: 'failed', completedChunks: 0, reservedUsd: 0 });
    expect(stopped.error).toContain('尚未支持');
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ action: 'status' });
    expect(await db.dialogues.count()).toBe(0);
  });

  it('persists a failed charge reservation, requires renewed consent and resumes only unfinished work', async () => {
    await seed();
    const proxy = mockProxy(2);
    const estimate = await estimateBookAnalysis(book.id, options.model, 'deep');
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
    expect(proxy.preflights).toBe(1);
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
    expect(cloud.listeners.size).toBe(0);
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
      expect(proxy.preflights).toBe(1);
      assertReservation(latest!, proxy.calls);
    } finally { task.cancel(); }
    expect((await task.done).status).toBe('cancelled');
    expect(cloud.listeners.size).toBe(0);
  });
});
