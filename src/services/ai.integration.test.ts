import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import type { AnalysisJob, Book, Chapter } from '../types';
import { analyzeChapter, checkAIProxy, clearAIKey, correctDialogue, createCharacter, extractDialogues, setAIKey } from './ai';

const cloud = vi.hoisted(() => ({
  user: 'account-a',
  config: { url: 'https://reader-cloud.example', anonKey: 'sb_publishable_fixture' },
  listeners: new Set<(session: { user: { id: string } } | null) => void>(),
  session: vi.fn(),
}));
vi.mock('./cloud', () => ({
  getCloudConfig: () => cloud.config,
  getSession: () => cloud.session(),
  subscribeAuth: (callback: (session: { user: { id: string } } | null) => void) => { cloud.listeners.add(callback); return () => cloud.listeners.delete(callback); },
}));

const book: Book = { id: 'ai-fixture-book', title: 'AI fixture', author: '', format: 'txt', language: 'zh', coverColor: '#123456', fingerprint: 'fixture', totalWords: 100, chapterCount: 1, createdAt: 1, updatedAt: 1, cloudEnabled: false };
const chapter: Chapter = { id: 'ai-fixture-chapter', bookId: book.id, index: 0, title: '第一章', paragraphs: ['林青说：“我们走吧。”', '阿明说：“我留下。”'] };
const options = { bookId: book.id, chapterId: chapter.id, model: 'deepseek-flash' as const, budgetUsd: 0.1, authorized: true as const };
interface SentBody { action: string; apiKey?: string; input: { dialogues: { id: string; text: string }[] }; maxCostUsd?: number }
function reply(body: SentBody, speaker = '林青') {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dialogues: body.input.dialogues.map(d => ({ id: d.id, speaker, confidence: 0.95 })) }) } }] });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(paragraphs = chapter.paragraphs) {
  await db.books.put(book);
  await db.chapters.put({ ...chapter, paragraphs });
}
beforeEach(() => {
  cloud.user = 'account-a'; cloud.config = { url: 'https://reader-cloud.example', anonKey: 'sb_publishable_fixture' };
  cloud.listeners.clear(); cloud.session.mockReset();
  cloud.session.mockImplementation(async () => ({ user: { id: cloud.user }, access_token: 'fixture-session-only' }));
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network access is prohibited.'); }));
  setAIKey('fixture-key-not-a-provider-credential');
});
afterEach(async () => {
  clearAIKey(); vi.restoreAllMocks();
  await db.transaction('rw', [db.books, db.chapters, db.characters, db.dialogues, db.corrections, db.jobs, db.settings], async () => {
    await Promise.all([db.books.clear(), db.chapters.clear(), db.characters.clear(), db.dialogues.clear(), db.corrections.clear(), db.jobs.clear(), db.settings.clear()]);
  });
  vi.unstubAllGlobals();
});

describe('offline chapter analysis workflow', () => {
  it('saves attributable speakers and marks an unsupported invented name as unknown', async () => {
    await fixture();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as SentBody;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dialogues: [
        { id: body.input.dialogues[0].id, speaker: '林青', confidence: 0.99 },
        { id: body.input.dialogues[1].id, speaker: '并不存在的人物', confidence: 0.99 },
      ] }) } }] });
    });
    const job = await analyzeChapter(options).done;
    expect(job.status).toBe('done'); expect(job.completedChunks).toBe(1);
    expect(job.model).toBe('deepseek-flash'); expect(job.reservedUsd).toBeGreaterThan(0);
    const dialogues = await db.dialogues.orderBy('id').toArray();
    expect(dialogues[0].characterId).toBeTruthy(); expect(dialogues[1].characterId).toBeNull();
    expect((await db.characters.toArray()).map(c => c.name)).toEqual(['林青']);
    expect(await db.jobs.get(job.id)).toMatchObject({ status: 'done', completedChunks: 1 });
    expect(JSON.stringify([await db.jobs.toArray(), await db.settings.toArray()])).not.toContain('fixture-key-not-a-provider-credential');
  });

  it('keeps a correction made during the request and creates no discarded AI character', async () => {
    await fixture(['林青说：“走吧。”阿明站在一旁。']);
    const candidate = extractDialogues({ ...chapter, paragraphs: ['林青说：“走吧。”阿明站在一旁。'] })[0];
    const manual = await createCharacter(book.id, '人工指定人物');
    await db.dialogues.put({ ...candidate, bookId: book.id, chapterId: chapter.id, characterId: null, confidence: 0, source: 'ai', updatedAt: 1 });
    const started = deferred<void>(); const response = deferred<Response>();
    let body!: SentBody;
    vi.mocked(fetch).mockImplementation(async (_url, init) => { body = JSON.parse(String(init?.body)); started.resolve(); return response.promise; });
    const task = analyzeChapter(options); await started.promise;
    await correctDialogue(candidate.id, manual.id);
    response.resolve(reply(body, '阿明'));
    expect((await task.done).status).toBe('done');
    expect(await db.dialogues.get(candidate.id)).toMatchObject({ characterId: manual.id, source: 'manual', confidence: 1 });
    expect((await db.characters.toArray()).map(c => c.name)).toEqual(['人工指定人物']);
  });

  it('resumes only unfinished chunks after an explicit retry and retains failed-attempt allowance', async () => {
    await fixture(Array.from({ length: 25 }, (_, i) => `林青说：“这是第${i + 1}句。”`));
    const sent: SentBody[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as SentBody; sent.push(body);
      if (sent.length === 2) throw new Error('Untrusted network error with fixture-key-not-a-provider-credential');
      return reply(body);
    });
    const first = await analyzeChapter(options).done;
    expect(first).toMatchObject({ status: 'failed', completedChunks: 1, totalChunks: 3 });
    expect(first.error).not.toContain('fixture-key'); expect(await db.dialogues.count()).toBe(12);
    const reservedBefore = first.reservedUsd!;
    await expect(analyzeChapter({ ...options, jobId: first.id, authorized: false as true }).done).rejects.toThrow('授权');
    expect(sent).toHaveLength(2);
    const resumed = await analyzeChapter({ ...options, jobId: first.id }).done;
    expect(resumed).toMatchObject({ status: 'done', completedChunks: 3 });
    expect(sent).toHaveLength(4); expect(sent[2].input.dialogues[0].id).toBe(sent[1].input.dialogues[0].id);
    expect(sent[2].input.dialogues.some(d => sent[0].input.dialogues.some(old => old.id === d.id))).toBe(false);
    expect(await db.dialogues.count()).toBe(25); expect(await db.characters.count()).toBe(1);
    expect(resumed.reservedUsd).toBeGreaterThan(reservedBefore);
  });

  it('rolls back the whole chunk if its checkpoint cannot be committed', async () => {
    await fixture(); vi.mocked(fetch).mockImplementation(async (_url, init) => reply(JSON.parse(String(init?.body))));
    const put = db.jobs.put.bind(db.jobs);
    vi.spyOn(db.jobs, 'put').mockImplementation((job: AnalysisJob) => {
      if (job.status === 'running' && job.completedChunks === 1) throw new Error('Simulated local disk failure');
      return put(job);
    });
    const job = await analyzeChapter(options).done;
    expect(job).toMatchObject({ status: 'failed', completedChunks: 0 });
    expect(await db.dialogues.count()).toBe(0); expect(await db.characters.count()).toBe(0);
    expect(job.reservedUsd).toBeGreaterThan(0);
  });

  it('rejects duplicate candidate IDs without saving an ambiguous chunk', async () => {
    await fixture();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as SentBody;
      const row = { id: body.input.dialogues[0].id, speaker: '林青', confidence: 1 };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dialogues: [row, row] }) } }] });
    });
    const job = await analyzeChapter(options).done;
    expect(job.status).toBe('failed'); expect(job.error).toContain('重复'); expect(await db.dialogues.count()).toBe(0);
  });

  it('does not lose an immediate resume while persisting its pause checkpoint', async () => {
    await fixture(Array.from({ length: 13 }, (_, i) => `林青说：“这是第${i}句。”`));
    vi.mocked(fetch).mockImplementation(async (_url, init) => reply(JSON.parse(String(init?.body))));
    let didPause = false; let task!: ReturnType<typeof analyzeChapter>;
    task = analyzeChapter({ ...options, onProgress(job) {
      if (job.completedChunks === 1 && !didPause) { didPause = true; task.pause(); }
      if (job.status === 'paused') task.resume();
    } });
    expect((await task.done).status).toBe('done'); expect(didPause).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('AI session and deployment boundaries', () => {
  it('checks the authenticated proxy without a key or model-generation request', async () => {
    clearAIKey();
    vi.mocked(fetch).mockResolvedValue(Response.json({ ready: true, upstreamChecked: false, models: ['deepseek-flash'], limits: { maxTokens: 4096, maxRequestCostUsd: 0.1 } }));
    expect(await checkAIProxy()).toMatchObject({ ready: true, upstreamChecked: false });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'status' });
  });

  it('stops an account-switch response even when the transport ignores cancellation', async () => {
    await fixture(); const started = deferred<void>(); const response = deferred<Response>(); let body!: SentBody;
    vi.mocked(fetch).mockImplementation(async (_url, init) => { body = JSON.parse(String(init?.body)); started.resolve(); return response.promise; });
    const task = analyzeChapter(options); await started.promise;
    cloud.user = 'account-b'; for (const notify of cloud.listeners) notify({ user: { id: cloud.user } });
    response.resolve(reply(body));
    expect((await task.done).status).toBe('cancelled'); expect(await db.dialogues.count()).toBe(0); expect(await db.characters.count()).toBe(0);
    expect((await db.jobs.toArray())[0].status).toBe('running');
  });

  it('never substitutes a newly loaded key during an awaited session lookup', async () => {
    await fixture(); const lookup = deferred<{ user: { id: string }; access_token: string }>();
    cloud.session.mockImplementationOnce(() => lookup.promise);
    const task = analyzeChapter(options);
    setAIKey('another-fixture-key-not-a-provider-credential');
    lookup.resolve({ user: { id: 'account-a' }, access_token: 'fixture-session-only' });
    await expect(task.done).rejects.toThrow('变化'); expect(fetch).not.toHaveBeenCalled(); expect(await db.dialogues.count()).toBe(0);
  });

  it('rejects simultaneous work for the same chapter before a second request', async () => {
    await fixture(); const started = deferred<void>(); const response = deferred<Response>(); let body!: SentBody;
    vi.mocked(fetch).mockImplementation(async (_url, init) => { body = JSON.parse(String(init?.body)); started.resolve(); return response.promise; });
    const task = analyzeChapter(options); await started.promise;
    await expect(analyzeChapter(options).done).rejects.toThrow('已有');
    task.cancel(); response.resolve(reply(body));
    expect((await task.done).status).toBe('cancelled'); expect(fetch).toHaveBeenCalledTimes(1); expect(await db.dialogues.count()).toBe(0);
  });

  it('rejects corrupted resume checkpoints and insufficient budget without a request', async () => {
    await fixture();
    await db.jobs.put({ id: 'corrupted', bookId: book.id, chapterId: chapter.id, status: 'failed', completedChunks: -1, totalChunks: 1, updatedAt: 1 });
    await expect(analyzeChapter({ ...options, jobId: 'corrupted' }).done).rejects.toThrow('检查点');
    await expect(analyzeChapter({ ...options, budgetUsd: 0.00001 }).done).rejects.toThrow('预算');
    expect(fetch).not.toHaveBeenCalled();
  });
});
