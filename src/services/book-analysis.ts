import { liveQuery } from 'dexie';
import { db } from '../core/db';
import type { Chapter, Character, Dialogue, ReadingProgress } from '../types';
import { getCloudConfig, getSession } from './cloud';
import { AI_BOOK_SYSTEM_PROMPT, AI_OUTPUT_LIMIT, MAX_AI_REQUEST_COST_USD } from '../../supabase/functions/_shared/ai-contract';
import { AIError, AI_MODELS, bookPayloadFor, chunksFor, createBoundAnalysisSession, estimateBookChunk, extractDialogues, registerBookAnalysis, saveAnalysisChunk, validateDeepAttributions, withAnalysisBookLock } from './ai';
import type { AIModel, DialogueCandidate } from './ai';
import { compareIdentityLocations, createIdentityProjector, projectCharactersAt } from './character-identity';
import type { IdentityProposal } from './character-identity';
import type { BookAnalysisBoundary, BookAnalysisController, BookAnalysisEstimate, BookAnalysisJob, BookAnalysisMode, BookAnalysisOptions, BookChapterTask } from './book-analysis-types';
export type * from './book-analysis-types';

export const MAX_BOOK_ANALYSIS_BUDGET_USD = 10;
const prefix = 'book-analysis:';
const budgetPrefix = 'book-analysis-budget:';
const active = new Map<string, BookAnalysisController>();
const clone = <T>(value: T): T => structuredClone(value);
const byteLength = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
class BookAnalysisError extends Error {}

function validJob(value: unknown): value is BookAnalysisJob {
  return object(value) && value.version === 1 && typeof value.id === 'string' && typeof value.bookId === 'string' && Array.isArray(value.chapters) && typeof value.budgetUsd === 'number' && Number.isFinite(value.budgetUsd) && typeof value.reservedUsd === 'number' && Number.isFinite(value.reservedUsd) && value.reservedUsd >= 0 && object(value.principal);
}
async function readBookAnalysisJob(id: string): Promise<BookAnalysisJob | undefined> {
  const value = (await db.settings.get(prefix + id))?.value;
  return validJob(value) ? clone(value) : undefined;
}
async function localTaskPrincipal(): Promise<BookAnalysisJob['principal'] | undefined> {
  const { url: projectUrl } = getCloudConfig();
  if (!projectUrl) return undefined;
  let userId: string | undefined;
  try { userId = (await getSession())?.user.id; }
  catch {
    // Same local-view fallback as the shelf. Model calls still require a validated session.
    try {
      const saved = JSON.parse(localStorage.getItem(`onr.auth.${new URL(projectUrl).host}`) || 'null');
      if (typeof saved?.user?.id === 'string') userId = saved.user.id;
    } catch { /* No usable local account. */ }
  }
  return userId && projectUrl === getCloudConfig().url ? { projectUrl, userId } : undefined;
}
const samePrincipal = (job: BookAnalysisJob, principal?: BookAnalysisJob['principal']) =>
  !!principal && job.principal.projectUrl === principal.projectUrl && job.principal.userId === principal.userId;
export async function getBookAnalysisJob(id: string): Promise<BookAnalysisJob | undefined> {
  const [job, principal] = await Promise.all([readBookAnalysisJob(id), localTaskPrincipal()]);
  return job && samePrincipal(job, principal) ? job : undefined;
}
export async function listBookAnalysisJobs(bookId: string): Promise<BookAnalysisJob[]> {
  const [records, principal] = await Promise.all([db.settings.where('id').startsWith(prefix).toArray(), localTaskPrincipal()]);
  return records.map(record => record.value).filter(validJob).filter(job => job.bookId === bookId && samePrincipal(job, principal)).sort((a, b) => b.updatedAt - a.updatedAt).map(clone);
}
export function getActiveBookController(bookId: string) { return active.get(bookId); }

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function bookSource(bookId: string) {
  const book = await db.books.get(bookId);
  if (!book || book.deletedAt) throw new BookAnalysisError('书籍不存在或已移除。');
  const chapters = await db.chapters.where('bookId').equals(bookId).sortBy('index');
  if (!chapters.length) throw new BookAnalysisError('这本书没有可分析的章节。');
  return { chapters, fingerprint: book.fingerprint };
}
function fullBoundary(chapter: Chapter): BookAnalysisBoundary {
  const paragraphIndex = Math.max(0, chapter.paragraphs.length - 1);
  return { chapterId: chapter.id, chapterIndex: chapter.index, paragraphIndex, offset: chapter.paragraphs[paragraphIndex]?.length || 0 };
}
async function currentBoundary(bookId: string, chapters: Chapter[], mode: BookAnalysisMode): Promise<BookAnalysisBoundary | null> {
  if (mode === 'deep') return fullBoundary(chapters[chapters.length - 1]);
  return boundaryForProgress(chapters, await db.progress.get(bookId));
}
function boundaryForProgress(chapters: Chapter[], progress?: ReadingProgress): BookAnalysisBoundary | null {
  const chapter = chapters.find(item => item.id === progress?.chapterId);
  if (!progress || !chapter) return null;
  const paragraphIndex = Math.max(0, Math.min(chapter.paragraphs.length - 1, Math.floor(progress.paragraphIndex) || 0));
  const offset = Math.max(0, Math.min(chapter.paragraphs[paragraphIndex]?.length || 0, Math.floor(progress.offset) || 0));
  return { chapterId: chapter.id, chapterIndex: chapter.index, paragraphIndex, offset };
}
function chapterAtBoundary(chapter: Chapter, boundary: BookAnalysisBoundary): Chapter | null {
  if (chapter.index > boundary.chapterIndex) return null;
  if (chapter.index < boundary.chapterIndex) return clone(chapter);
  const paragraphs = chapter.paragraphs.slice(0, boundary.paragraphIndex + 1);
  if (paragraphs.length) paragraphs[paragraphs.length - 1] = paragraphs[paragraphs.length - 1].slice(0, boundary.offset);
  return { ...chapter, paragraphs };
}
function plannedChunks(chapter: Chapter, ids?: Set<string>): DialogueCandidate[][] {
  return chunksFor(chapter).map(chunk => ids ? chunk.filter(candidate => ids.has(candidate.id)) : chunk).filter(chunk => chunk.length > 0);
}
function chunkEstimate(chapter: Chapter, candidates: DialogueCandidate[], model: AIModel) {
  const upper = estimateBookChunk(chapter, candidates, model, [], true);
  const lower = 0; // Cache discounts/output length can make any positive advertised floor misleading.
  return { upper: upper.usd, lower };
}
function reviewUpper(chapter: Chapter, model: AIModel): number {
  const largest = extractDialogues(chapter).sort((a, b) => byteLength(b) - byteLength(a)).slice(0, 12);
  if (!largest.length) return 0;
  const payload = bookPayloadFor(chapter, largest, []);
  const cost = estimateBookChunk(chapter, largest, model, [], true);
  const maximumContext = Math.min(24000, chapter.paragraphs.reduce((sum, paragraph) => sum + byteLength(paragraph), 0));
  const actualContext = payload.context.reduce((sum, row) => sum + byteLength(row.text), 0);
  const extraBytes = Math.max(0, maximumContext - actualContext) + Math.max(0, 36 - payload.context.length) * 80;
  const info = AI_MODELS.find(item => item.id === model)!;
  return Math.min(MAX_AI_REQUEST_COST_USD, cost.usd + extraBytes * info.inputPerMillion / 1_000_000 * 1.1);
}
function boundedReview(chapter: Chapter, candidates: DialogueCandidate[], model: AIModel) {
  const result: DialogueCandidate[] = [];
  for (const candidate of candidates) {
    const trial = [...result, candidate]; const cost = estimateBookChunk(chapter, trial, model, [], true);
    if (trial.length > 12 || cost.input > 95000 || cost.usd > MAX_AI_REQUEST_COST_USD) break;
    result.push(candidate);
  }
  return result;
}
export async function estimateBookAnalysis(bookId: string, model: AIModel = 'deepseek-flash', mode: BookAnalysisMode = 'deep'): Promise<BookAnalysisEstimate> {
  if (!AI_MODELS.some(known => known.id === model) || !['deep', 'reading-progress'].includes(mode)) throw new BookAnalysisError('请选择支持的分析范围和模型。');
  const { chapters } = await bookSource(bookId);
  return estimateScope(chapters, await currentBoundary(bookId, chapters, mode), model);
}
function estimateScope(chapters: Chapter[], scopeEnd: BookAnalysisBoundary | null, model: AIModel): BookAnalysisEstimate {
  let chapterCount = 0; let dialogueCount = 0; let totalChunks = 0; let reviewRequests = 0; let estimatedMinUsd = 0; let estimatedMaxUsd = 0;
  for (const source of chapters) {
    const chapter = scopeEnd && chapterAtBoundary(source, scopeEnd);
    if (!chapter) continue;
    const candidates = extractDialogues(chapter); const chunks = plannedChunks(chapter);
    chapterCount++; dialogueCount += candidates.length; totalChunks += chunks.length;
    for (const chunk of chunks) { const cost = chunkEstimate(chapter, chunk, model); estimatedMinUsd += cost.lower; estimatedMaxUsd += cost.upper; }
    if (candidates.length) {
      reviewRequests++;
      estimatedMaxUsd += reviewUpper(chapter, model);
    }
  }
  return { chapterCount, totalChapters: chapters.length, dialogueCount, totalChunks, reviewRequests, maxRequests: totalChunks + reviewRequests, estimatedMinUsd, estimatedMaxUsd, scopeEnd };
}

/** A single explicit, session-bound authorization may advance across the whole planned book. */
export function analyzeBook(options: BookAnalysisOptions): BookAnalysisController {
  let paused = false; let cancelled = false; let wake: (() => void) | undefined; let abort: AbortController | undefined;
  let job: BookAnalysisJob | undefined;
  let processingEntryId: string | undefined;
  const controller: BookAnalysisController = {
    pause() { paused = true; wake?.(); }, resume() { paused = false; wake?.(); },
    cancel() { cancelled = true; paused = false; abort?.abort(); wake?.(); }, done: Promise.resolve(null as unknown as BookAnalysisJob),
  };
  const announce = () => { if (job) { try { options.onProgress?.(clone(job)); } catch { /* UI errors cannot affect paid work. */ } } };
  const run = async (): Promise<BookAnalysisJob> => {
    if (options.authorized !== true) throw new BookAnalysisError('整书分析需要本次明确授权。');
    if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 || options.budgetUsd > MAX_BOOK_ANALYSIS_BUDGET_USD) throw new BookAnalysisError(`整书总预算须在 $0–$${MAX_BOOK_ANALYSIS_BUDGET_USD} 之间。`);
    if (!AI_MODELS.some(model => model.id === options.model) || !['deep', 'reading-progress'].includes(options.mode)) throw new BookAnalysisError('模型或分析模式无效。');
    const id = options.jobId || crypto.randomUUID();
    const session = await createBoundAnalysisSession(() => controller.cancel());
    const assertWork = () => { session.assert(); if (cancelled) throw new BookAnalysisError('任务已停止；已完成结果保留。'); };
    try {
      const source = await bookSource(options.bookId);
      const bookSignature = await digest({ fingerprint: source.fingerprint, chapters: source.chapters.map(({ id, index, title, paragraphs }) => ({ id, index, title, paragraphs })) });
      const signature = await digest({ source: bookSignature, model: options.model, mode: options.mode, principal: session.principal });
      const ledgerId = budgetPrefix + id;
      const persistedLedger = (await db.settings.get(ledgerId))?.value;
      const prior = options.jobId ? await readBookAnalysisJob(id) : undefined;
      assertWork();
      if (options.jobId && !prior) throw new BookAnalysisError('整书任务检查点不存在或损坏，请新建任务；已有识别结果保留。');
      if (prior) {
        if (prior.bookId !== options.bookId || prior.bookSignature !== bookSignature || prior.model !== options.model || prior.mode !== options.mode || prior.budgetUsd !== options.budgetUsd || !samePrincipal(prior, session.principal)) throw new BookAnalysisError('任务的书籍、账号、模型、范围或固定总预算已变化。不能修改旧任务预算，请新建任务。');
        if (!object(persistedLedger) || persistedLedger.signature !== signature || persistedLedger.reservedUsd !== prior.reservedUsd || persistedLedger.budgetUsd !== prior.budgetUsd) throw new BookAnalysisError('缺少匹配的本机预算记录，不能自动恢复收费任务；已有结果保留。');
        job = { ...clone(prior), status: 'queued', error: undefined, updatedAt: Date.now() };
      } else {
        job = { version: 1, id, bookId: options.bookId, model: options.model, mode: options.mode, status: 'queued', stage: 'preparing', chapters: [], completedChapters: 0, completedChunks: 0, totalChunks: 0, reviewRequests: 0, completedReviews: 0, dialogueCount: 0, unknownCount: 0, characterCount: 0, reservedUsd: 0, budgetUsd: options.budgetUsd, estimatedMaxUsd: 0, createdAt: Date.now(), updatedAt: Date.now(), scopeEnd: null, bookSignature, principal: session.principal };
        await db.transaction('rw', db.settings, async () => {
          assertWork(); await db.settings.put({ id: ledgerId, value: { signature, reservedUsd: 0, budgetUsd: options.budgetUsd } });
          await db.settings.put({ id: prefix + id, value: clone(job!) });
        });
      }
      const persist = async (changes: Partial<BookAnalysisJob>, permitStopped = false) => {
        if (!permitStopped) assertWork();
        job = { ...job!, ...changes, updatedAt: Date.now() };
        await db.settings.put({ id: prefix + id, value: clone(job) }); announce();
      };
      const inspectMetrics = async () => {
        const ids = new Set(job!.chapters.flatMap(chapter => chapter.candidateIds));
        const dialogues = (await db.dialogues.where('bookId').equals(options.bookId).toArray()).filter(dialogue => ids.has(dialogue.id));
        const characters = await db.characters.where('bookId').equals(options.bookId).toArray();
        job!.dialogueCount = dialogues.length;
        job!.unknownCount = dialogues.filter(dialogue => !dialogue.characterId || dialogue.confidence < 0.75).length;
        const view = createIdentityProjector(characters, [], [])(job!.scopeEnd || { chapterIndex: 0, paragraphIndex: 0, offset: 0 }, true);
        job!.characterCount = new Set(dialogues.map(dialogue => view.character(dialogue.characterId)?.id).filter(Boolean)).size;
        job!.completedChunks = job!.chapters.reduce((sum, entry) => sum + entry.completedChunks, 0);
        job!.totalChunks = job!.chapters.reduce((sum, entry) => sum + entry.totalChunks, 0);
        job!.completedChapters = new Set(job!.chapters.filter(entry => entry.status === 'done').map(entry => entry.chapterId)).size;
        job!.completedReviews = job!.chapters.filter(entry => entry.reviewCompleted && entry.reviewCandidateIds.length > 0).length;
      };
      const reserve = async (amountUsd: number) => {
        if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_AI_REQUEST_COST_USD) throw new BookAnalysisError('当前分片超过代理单请求费用边界，未发起请求。');
        const reservedJob = await db.transaction('rw', db.settings, async () => {
          assertWork(); const record = (await db.settings.get(ledgerId))?.value;
          if (!object(record) || record.signature !== signature || record.budgetUsd !== job!.budgetUsd || record.reservedUsd !== job!.reservedUsd) throw new BookAnalysisError('本机整书预算记录不匹配，任务安全停止。');
          const reservedUsd = job!.reservedUsd + amountUsd;
          if (reservedUsd > job!.budgetUsd) throw new BookAnalysisError('整书固定总预算已达到，任务停止；不会自动增加预算或返还失败预留。');
          const next = { ...job!, reservedUsd, updatedAt: Date.now() };
          await db.settings.put({ id: ledgerId, value: { signature, reservedUsd, budgetUsd: next.budgetUsd } });
          await db.settings.put({ id: prefix + id, value: clone(next) });
          return next;
        });
        job = reservedJob; announce();
      };
      const waitIfPaused = async () => {
        while (paused && !cancelled) {
          const resumed = new Promise<void>(resolve => { wake = resolve; });
          await persist({ status: 'paused' }); if (!paused || cancelled) wake?.();
          await resumed; wake = undefined;
        }
        assertWork();
      };
      const appendScope = async (boundary: BookAnalysisBoundary | null) => {
        if (!boundary || (job!.scopeEnd && compareIdentityLocations(boundary, job!.scopeEnd) <= 0)) return false;
        const plannedIds = new Set(job!.chapters.flatMap(entry => entry.candidateIds));
        for (const original of source.chapters) {
          const chapter = chapterAtBoundary(original, boundary); if (!chapter) continue;
          const candidates = extractDialogues(chapter).filter(candidate => !plannedIds.has(candidate.id));
          if (!candidates.length) continue;
          const ids = candidates.map(candidate => candidate.id); const chunks = plannedChunks(chapter, new Set(ids));
          const entryId = crypto.randomUUID();
          job!.chapters.push({ id: entryId, chapterId: chapter.id, index: chapter.index, title: chapter.title, jobId: entryId, candidateIds: ids, completedChunks: 0, totalChunks: chunks.length, status: 'queued', signature: await digest({ paragraphs: chapter.paragraphs, ids }), scopeEnd: chapter.index < boundary.chapterIndex ? fullBoundary(chapter) : clone(boundary), reviewCandidateIds: [], reviewCompleted: false });
          for (const candidate of candidates) plannedIds.add(candidate.id);
        }
        job!.scopeEnd = clone(boundary);
        job!.estimatedMaxUsd = job!.reservedUsd + job!.chapters.reduce((sum, entry) => {
          const chapter = chapterAtBoundary(source.chapters.find(item => item.id === entry.chapterId)!, entry.scopeEnd)!;
          const remaining = plannedChunks(chapter, new Set(entry.candidateIds)).slice(entry.completedChunks).reduce((cost, chunk) => cost + estimateBookChunk(chapter, chunk, options.model, [], true).usd, 0);
          return sum + remaining + (entry.reviewCompleted ? 0 : reviewUpper(chapter, options.model));
        }, 0);
        await inspectMetrics(); await persist({ stage: 'analyzing', status: 'running' }); return true;
      };
      let legacyAppearances: Dialogue[] | undefined;
      const knownAtScope = async (chapter: Chapter, boundary: BookAnalysisBoundary) => {
        const characters = await db.characters.where('bookId').equals(options.bookId).toArray();
        if (!legacyAppearances && characters.some(character => !character.identity)) legacyAppearances = await db.dialogues.where('bookId').equals(options.bookId).toArray();
        // Even final review must only see identities revealed by the fragment's boundary.
        const projected = projectCharactersAt(characters, legacyAppearances || [], source.chapters, boundary);
        const context = chapter.paragraphs.join('\n').toLocaleLowerCase();
        const score = (character: Character) => [character.name, ...character.aliases].filter(name => context.includes(name.toLocaleLowerCase())).length;
        return projected.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
      };
      const sendChunk = async (entry: BookChapterTask, candidates: DialogueCandidate[], review: boolean, completedChunks: number) => {
        processingEntryId = entry.id;
        await waitIfPaused(); await session.check(); assertWork();
        const original = source.chapters.find(chapter => chapter.id === entry.chapterId)!;
        const [freshBook, freshChapter] = await Promise.all([db.books.get(options.bookId), db.chapters.get(entry.chapterId)]);
        if (!freshBook || freshBook.deletedAt || !freshChapter || JSON.stringify(freshChapter.paragraphs) !== JSON.stringify(original.paragraphs)) throw new BookAnalysisError('书籍原文已变化，原任务停止；旧识别结果保留。');
        const chapter = chapterAtBoundary(original, entry.scopeEnd)!;
        const known = await knownAtScope(chapter, entry.scopeEnd);
        const input = bookPayloadFor(chapter, candidates, known);
        const reservation = estimateBookChunk(chapter, candidates, options.model, known).usd;
        await reserve(reservation);
        abort = new AbortController();
        const response = await session.request({ action: 'analyze', protocol: 'identity-v1', authorized: true, model: options.model, maxTokens: AI_OUTPUT_LIMIT, system: AI_BOOK_SYSTEM_PROMPT, input, maxCostUsd: reservation }, abort.signal) as { choices?: { finish_reason?: string; message?: { content?: string } }[] };
        assertWork(); const choice = response.choices?.[0];
        if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new BookAnalysisError('模型输出不完整，任务已停止；请重新授权后手动重试。');
        let value: unknown; try { value = JSON.parse(choice.message.content); } catch { throw new BookAnalysisError('模型返回的 JSON 无法解析，任务已停止。'); }
        if (!object(value) || !Array.isArray(value.identities) || value.identities.length > 12) throw new BookAnalysisError('模型人物证据格式不兼容，当前片段未保存。');
        const rows = validateDeepAttributions(value, candidates, input);
        await session.check(); assertWork();
        const nextJob = clone(job!); const nextEntry = nextJob.chapters.find(item => item.id === entry.id)!;
        if (review) nextEntry.reviewCompleted = true; else { nextEntry.completedChunks = completedChunks; nextEntry.status = completedChunks === entry.totalChunks ? 'done' : 'running'; }
        nextJob.completedChunks = nextJob.chapters.reduce((sum, item) => sum + item.completedChunks, 0);
        nextJob.completedChapters = new Set(nextJob.chapters.filter(item => item.status === 'done').map(item => item.chapterId)).size;
        if (!review) nextJob.dialogueCount += candidates.length;
        nextJob.completedReviews = nextJob.chapters.filter(item => item.reviewCompleted && item.reviewCandidateIds.length > 0).length;
        nextJob.updatedAt = Date.now();
        await saveAnalysisChunk(chapter, candidates, rows, options.model, undefined, assertWork, { sourceChapter: original, input, review, identities: value.identities as IdentityProposal[], commit: () => db.settings.put({ id: prefix + id, value: nextJob }).then(() => undefined) });
        job = nextJob; Object.assign(entry, nextEntry); announce();
      };
      announce();
      abort = new AbortController();
      const preflight = await session.request({ action: 'status' }, abort.signal) as { ready?: boolean; protocols?: string[] };
      assertWork();
      if (!preflight?.ready || !Array.isArray(preflight.protocols) || !preflight.protocols.includes('identity-v1')) throw new BookAnalysisError('当前云代理尚未支持整书人物协议，请先更新代理。');
      while (!cancelled) {
        await waitIfPaused();
        await appendScope(await currentBoundary(options.bookId, source.chapters, options.mode));
        for (const entry of [...job.chapters]) {
          if (entry.status === 'done') continue;
          const original = source.chapters.find(chapter => chapter.id === entry.chapterId);
          if (!original) throw new BookAnalysisError('检查点章节已缺失。');
          const chapter = chapterAtBoundary(original, entry.scopeEnd)!;
          if (entry.signature !== await digest({ paragraphs: chapter.paragraphs, ids: entry.candidateIds })) throw new BookAnalysisError('章节检查点与原文不匹配，任务停止。');
          const chunks = plannedChunks(chapter, new Set(entry.candidateIds));
          if (!Number.isInteger(entry.completedChunks) || entry.completedChunks < 0 || entry.completedChunks > chunks.length || entry.totalChunks !== chunks.length) throw new BookAnalysisError('分片检查点损坏，任务停止。');
          await persist({ status: 'running', stage: 'analyzing', error: undefined });
          for (let index = entry.completedChunks; index < chunks.length; index++) await sendChunk(entry, chunks[index], false, index + 1);
        }
        await persist({ status: 'running', stage: 'reviewing' });
        for (const entry of [...job.chapters]) {
          if (entry.reviewCompleted) continue;
          if (!entry.reviewCandidateIds.length) {
            const records = await db.dialogues.bulkGet(entry.candidateIds);
            const chapter = chapterAtBoundary(source.chapters.find(item => item.id === entry.chapterId)!, entry.scopeEnd)!;
            const uncertain = new Set(records.filter(record => record && record.source !== 'manual' && (!record.characterId || record.confidence < 0.85)).map(record => record!.id));
            entry.reviewCandidateIds = boundedReview(chapter, extractDialogues(chapter).filter(candidate => uncertain.has(candidate.id)), options.model).map(candidate => candidate.id);
            const current = job.chapters.find(item => item.id === entry.id)!; current.reviewCandidateIds = [...entry.reviewCandidateIds];
            if (!entry.reviewCandidateIds.length) { current.reviewCompleted = true; entry.reviewCompleted = true; }
            job.reviewRequests = job.chapters.filter(item => item.reviewCandidateIds.length > 0).length;
            await persist({});
          }
          if (entry.reviewCompleted) continue;
          const chapter = chapterAtBoundary(source.chapters.find(item => item.id === entry.chapterId)!, entry.scopeEnd)!;
          const selected = extractDialogues(chapter).filter(candidate => entry.reviewCandidateIds.includes(candidate.id));
          await sendChunk(entry, selected, true, entry.completedChunks);
        }
        await inspectMetrics();
        const end = fullBoundary(source.chapters[source.chapters.length - 1]);
        if (options.mode === 'deep' || (job.scopeEnd && compareIdentityLocations(job.scopeEnd, end) >= 0)) {
          await persist({ status: 'done', stage: 'done', error: undefined }); return job;
        }
        await persist({ status: 'waiting', stage: 'done', error: undefined });
        // This subscription exists only during the explicitly authorized runtime. Reload never recreates it.
        await new Promise<void>((resolve, reject) => {
          let subscription: { unsubscribe(): void } | undefined;
          const finish = () => { subscription?.unsubscribe(); wake = undefined; resolve(); };
          wake = finish;
          subscription = liveQuery(() => db.progress.get(options.bookId)).subscribe({ next: progress => {
            const boundary = boundaryForProgress(source.chapters, progress);
            if (boundary && (!job!.scopeEnd || compareIdentityLocations(boundary, job!.scopeEnd) > 0)) finish();
          }, error: () => { subscription?.unsubscribe(); wake = undefined; reject(new BookAnalysisError('读取阅读进度失败，等待已停止，请检查本机存储后重新授权。')); } });
          if (paused || cancelled) finish();
        });
      }
      await persist({ status: 'cancelled', error: '本次会话已停止；已完成结果和费用预留保留，继续需要重新授权。' }, true); return job;
    } catch (failure) {
      if (!job) throw failure;
      const message = failure instanceof BookAnalysisError || failure instanceof AIError ? failure.message : '分析或本地保存失败；结果与费用预留保留，请手动检查后重新授权。';
      job = { ...job, status: cancelled ? 'cancelled' : 'failed', error: message, updatedAt: Date.now() };
      const entry = job.chapters.find(item => item.id === processingEntryId);
      if (entry) { entry.error = message; if (entry.completedChunks < entry.totalChunks) entry.status = cancelled ? 'cancelled' : 'failed'; }
      await db.settings.put({ id: prefix + id, value: clone(job) }); announce(); return job;
    } finally { session.close(); wake?.(); }
  };
  controller.done = (async () => {
    if (active.has(options.bookId)) throw new BookAnalysisError('这本书已有整书分析正在运行。');
    const release = registerBookAnalysis(options.bookId, controller); active.set(options.bookId, controller);
    try { return await withAnalysisBookLock(options.bookId, run); }
    finally { release(); if (active.get(options.bookId) === controller) active.delete(options.bookId); }
  })();
  return controller;
}
