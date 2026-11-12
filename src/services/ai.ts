import { db } from '../core/db';
import { getCloudConfig, getSession, subscribeAuth } from './cloud';
import type { AnalysisJob, Chapter, Character, Dialogue, IdentityLocation } from '../types';
import { AI_MODELS, AI_SYSTEM_PROMPT as SYSTEM_PROMPT, AI_BOOK_SYSTEM_PROMPT, AI_OUTPUT_LIMIT as OUTPUT_LIMIT, AI_COST_MARGIN, AI_TOKEN_OVERHEAD, MAX_AI_REQUEST_COST_USD } from '../../supabase/functions/_shared/ai-contract';
import { applyIdentityProposal, indexCharacterIntroductions, initializeCharacterIdentity, manualMergeCharacters, manualRenameCharacter } from './character-identity';
import type { IdentityProposal } from './character-identity';

export { AI_MODELS };
export type AIModel = typeof AI_MODELS[number]['id'];
export interface DialogueCandidate { id: string; paragraphIndex: number; start: number; end: number; text: string }
export interface AnalysisEstimate { dialogueCount: number; chunks: number; inputTokensUpperBound: number; outputTokensUpperBound: number; estimatedMaxUsd: number }
export interface AnalysisOptions {
  bookId: string; chapterId: string; model: AIModel; budgetUsd: number;
  authorized: true; jobId?: string; onProgress?: (job: AnalysisJob) => void;
}
export interface AnalysisController { pause(): void; resume(): void; cancel(): void; done: Promise<AnalysisJob> }
const encoder = new TextEncoder();
const KNOWN_BYTES = 8000;
const CONTEXT_BYTES = 24000;
export class AIError extends Error {}
let apiKey = '';
let keyEpoch = 0;
const active = new Map<string, AnalysisController>();
const bookActive = new Map<string, { cancel(): void }>();
export function registerBookAnalysis(bookId: string, controller: { cancel(): void }): () => void {
  if (bookActive.has(bookId) || [...active.keys()].some(slot => JSON.parse(slot)[0] === bookId)) throw new AIError('这本书已有分析任务，请先结束原任务。');
  bookActive.set(bookId, controller);
  return () => { if (bookActive.get(bookId) === controller) bookActive.delete(bookId); };
}
export async function withAnalysisBookLock<T>(bookId: string, run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(`onr-ai-book:${bookId}`, { ifAvailable: true }, lock => {
    if (!lock) throw new AIError('另一个窗口正在分析这本书，请先结束原任务。');
    return run();
  });
  return run();
}
/** Deliberately RAM-only on every platform. Reload/sign out should clear this; never backed up. */
export function setAIKey(key: string) {
  const clean = key.trim();
  if (clean.length < 10 || clean.length > 256 || /[^\x21-\x7e]/.test(clean)) throw new AIError('请输入有效的 API Key，不能包含空格或换行。');
  clearAIKey(); apiKey = clean;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('onr-ai-key-changed'));
}
export function hasAIKey() { return apiKey.length > 0; }
export function clearAIKey() {
  apiKey = ''; keyEpoch++;
  for (const controller of active.values()) controller.cancel();
  for (const controller of bookActive.values()) controller.cancel();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('onr-ai-key-changed'));
}
function modelInfo(model: AIModel) {
  const info = AI_MODELS.find(m => m.id === model);
  if (!info) throw new AIError('请选择支持的 DeepSeek 模型。');
  return info;
}
export function extractDialogues(chapter: Chapter): DialogueCandidate[] {
  const candidates: DialogueCandidate[] = [];
  chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
    const pairs: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"', "'": "'", '‘': '’' };
    const word = (value: string) => /[\p{L}\p{N}]/u.test(value);
    for (let start = 0; start < paragraph.length; start++) {
      const opening = paragraph[start]; const closing = pairs[opening];
      if (!closing || paragraph[start - 1] === '\\' || ((opening === "'" || opening === '‘') && word(paragraph[start - 1] || '') && word(paragraph[start + 1] || ''))) continue;
      let depth = 1;
      for (let at = start + 1; at < paragraph.length && paragraph[at] !== '\n'; at++) {
        if (paragraph[at - 1] === '\\') continue;
        if (opening !== closing && paragraph[at] === opening) { depth++; continue; }
        if (paragraph[at] !== closing) continue;
        if ((closing === "'" || closing === '’') && word(paragraph[at - 1] || '') && word(paragraph[at + 1] || '')) continue;
        if (--depth) continue;
        const end = at + 1; const text = paragraph.slice(start, end);
        if (text.length > 2 && text.length <= 1800) candidates.push({ id: `${chapter.id}:${paragraphIndex}:${start}:${end}`, paragraphIndex, start, end, text });
        start = at; break;
      }
    }
  });
  return candidates;
}
export function chunksFor(chapter: Chapter) {
  const candidates = extractDialogues(chapter);
  const chunks: DialogueCandidate[][] = [];
  let chunk: DialogueCandidate[] = [];
  for (const candidate of candidates) {
    const trial = [...chunk, candidate];
    // Preserve the V0.2 partition so its completed chunk indexes remain resumable.
    if (chunk.length && (trial.length > 12 || encoder.encode(JSON.stringify(payloadFor(chapter, trial, [], true))).length > 18000)) {
      chunks.push(chunk); chunk = [];
    }
    chunk.push(candidate);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
function boundedUTF8(text: string, bytes: number) {
  return new TextDecoder().decode(encoder.encode(text).subarray(0, Math.max(0, bytes)), { stream: true });
}
export function payloadFor(chapter: Chapter, candidates: DialogueCandidate[], known: Character[] = [], legacyPlan = false) {
  const indices = new Set<number>();
  for (const c of candidates) for (let i = Math.max(0, c.paragraphIndex - 1); i <= Math.min(chapter.paragraphs.length - 1, c.paragraphIndex + 1); i++) indices.add(i);
  const boundedKnown: { name: string; aliases: string[] }[] = [];
  for (const character of known.slice(0, 100)) {
    const next = { name: character.name.slice(0, 80), aliases: character.aliases.slice(0, 20).map(a => a.slice(0, 80)) };
    if (encoder.encode(JSON.stringify([...boundedKnown, next])).length > KNOWN_BYTES) break;
    boundedKnown.push(next);
  }
  const bytesPerParagraph = Math.floor(CONTEXT_BYTES / Math.max(1, indices.size));
  return { chapter: legacyPlan ? chapter.title : chapter.title.slice(0, 200), known: boundedKnown,
    context: [...indices].sort((a, b) => a - b).map(i => {
      const candidate = candidates.find(c => c.paragraphIndex === i);
      const start = Math.max(0, (candidate?.start || 0) - 350);
      const text = legacyPlan ? chapter.paragraphs[i].slice(0, 7000) : boundedUTF8(chapter.paragraphs[i].slice(start, start + 7000), bytesPerParagraph);
      return { paragraph: i, text };
    }), dialogues: candidates };
}
export function bookPayloadFor(chapter: Chapter, candidates: DialogueCandidate[], known: Character[]) {
  const base = payloadFor(chapter, candidates);
  const bounded: { id: string; name: string; aliases: string[] }[] = [];
  for (const person of known.slice(0, 100)) {
    const name = person.name.trim().slice(0, 80);
    if (!name || !person.id || person.id.length > 512) continue;
    const aliases = person.aliases.map(alias => alias.trim().slice(0, 80)).filter(Boolean).slice(0, 20);
    const next = { id: person.id, name, aliases };
    if (encoder.encode(JSON.stringify([...bounded, next])).length > 16000) break;
    bounded.push(next);
  }
  return { ...base, known: bounded,
    context: base.context.filter(row => row.text.trim()).map(row => {
      const candidate = candidates.find(c => c.paragraphIndex === row.paragraph);
      return { ...row, start: Math.max(0, (candidate?.start || 0) - 350) };
    }) };
}
export function estimateBookChunk(chapter: Chapter, candidates: DialogueCandidate[], model: AIModel, known: Character[] = [], upper = false) {
  const info = modelInfo(model);
  const input = encoder.encode(AI_BOOK_SYSTEM_PROMPT + JSON.stringify(bookPayloadFor(chapter, candidates, known))).length + AI_TOKEN_OVERHEAD + (upper ? 18000 : 0);
  return { input, usd: (input * info.inputPerMillion + OUTPUT_LIMIT * info.outputPerMillion) / 1_000_000 * AI_COST_MARGIN };
}
function chunkCost(chapter: Chapter, chunk: DialogueCandidate[], model: AIModel, known: Character[] = []) {
  const info = modelInfo(model);
  // UTF-8 bytes overestimate token count for supported text tokenizers. Reserve overhead and a price margin.
  const input = encoder.encode(SYSTEM_PROMPT + JSON.stringify(payloadFor(chapter, chunk, known))).length + AI_TOKEN_OVERHEAD;
  return { input, usd: (input * info.inputPerMillion + OUTPUT_LIMIT * info.outputPerMillion) / 1_000_000 * AI_COST_MARGIN };
}
function estimatedChunkCost(chapter: Chapter, chunk: DialogueCandidate[], model: AIModel) {
  const cost = chunkCost(chapter, chunk, model);
  // Characters discovered in earlier chunks can add at most this bounded context.
  return { input: cost.input + KNOWN_BYTES, usd: cost.usd + KNOWN_BYTES * modelInfo(model).inputPerMillion / 1_000_000 * AI_COST_MARGIN };
}
export function estimateAnalysis(chapter: Chapter, model: AIModel = 'deepseek-flash'): AnalysisEstimate {
  const chunks = chunksFor(chapter);
  const costs = chunks.map(chunk => estimatedChunkCost(chapter, chunk, model));
  return { dialogueCount: extractDialogues(chapter).length, chunks: chunks.length,
    inputTokensUpperBound: costs.reduce((sum, c) => sum + c.input, 0), outputTokensUpperBound: chunks.length * OUTPUT_LIMIT,
    estimatedMaxUsd: costs.reduce((sum, c) => sum + c.usd, 0) };
}
interface RequestContext { key: string; epoch: number; config: ReturnType<typeof getCloudConfig>; userId: string; invalid?: boolean }
function assertContext(context: RequestContext) {
  const current = getCloudConfig();
  if (context.invalid || context.epoch !== keyEpoch || current.url !== context.config.url || current.anonKey !== context.config.anonKey) { context.invalid = true; throw new AIError('账号、代理或会话密钥已变化，原任务已停止。'); }
}
async function currentSession(context: RequestContext) {
  assertContext(context);
  let session;
  try { session = await getSession(); } catch { throw new AIError('无法恢复登录状态，请重新登录后重试。'); }
  assertContext(context);
  if (!session || session.user.id !== context.userId) { context.invalid = true; throw new AIError('登录账号已变化，原任务已停止。'); }
  return session;
}
async function requestContext(requireKey: boolean): Promise<RequestContext> {
  const key = apiKey; const epoch = keyEpoch; const config = getCloudConfig();
  if (requireKey && !key) throw new AIError('请先输入本次会话使用的 DeepSeek API Key。');
  let session;
  try { session = await getSession(); } catch { throw new AIError('无法恢复登录状态，请重新登录后重试。'); }
  if (!session) throw new AIError('AI 代理需要登录账号。请先配置云端并登录。');
  const context = { key, epoch, config, userId: session.user.id };
  assertContext(context); return context;
}
async function callProxy(body: { action: string; [key: string]: unknown }, signal?: AbortSignal, bound?: RequestContext): Promise<unknown> {
  const context = bound || await requestContext(body.action !== 'status');
  const session = await currentSession(context);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    if (controller.signal.aborted) throw new AIError('请求已取消，已发生的费用不能撤销。');
    const response = await fetch(`${context.config.url}/functions/v1/deepseek-proxy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: context.config.anonKey },
      body: JSON.stringify({ ...body, ...(body.action === 'status' ? {} : { apiKey: context.key }) }), signal: controller.signal,
    });
    await currentSession(context);
    if (!response.ok) {
      // Never include upstream response bodies, request headers, or API keys in errors/logs.
      const message = response.status === 401 ? '登录或 API Key 无效。' : response.status === 402 ? 'DeepSeek 余额不足。' : response.status === 429 ? '请求过于频繁，请稍后手动重试。' : `AI 代理请求失败 (${response.status})。`;
      throw new AIError(message);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError('代理网络请求失败或超时。已完成结果保留；分析请求可能已计费，请手动决定是否重试。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
/** A task holds this binding across every chapter, including a reading-progress wait. */
export async function createBoundAnalysisSession(invalidate: () => void) {
  const context = await requestContext(true);
  const changed = () => { context.invalid = true; invalidate(); };
  const stop = subscribeAuth(session => { if (session?.user.id !== context.userId) changed(); });
  const keyChanged = () => { if (context.epoch !== keyEpoch) changed(); };
  if (typeof window !== 'undefined') {
    window.addEventListener('onr-cloud-config-changed', changed);
    window.addEventListener('onr-ai-key-changed', keyChanged);
  }
  return {
    principal: { projectUrl: context.config.url, userId: context.userId },
    assert: () => assertContext(context), check: () => currentSession(context),
    request: (body: { action: string; [key: string]: unknown }, signal?: AbortSignal) => callProxy(body, signal, context),
    close: () => { stop(); if (typeof window !== 'undefined') { window.removeEventListener('onr-cloud-config-changed', changed); window.removeEventListener('onr-ai-key-changed', keyChanged); } },
  };
}
export interface AIProxyStatus { ready: true; upstreamChecked: false; models: string[]; limits: { maxTokens: number; maxRequestCostUsd: number } }
/** Authenticated deployment check: no key is sent and DeepSeek is not contacted. */
export async function checkAIProxy(): Promise<AIProxyStatus> {
  const value = await callProxy({ action: 'status' }) as Partial<AIProxyStatus>;
  if (value?.ready !== true || value.upstreamChecked !== false || !Array.isArray(value.models) || !value.models.length || value.models.some(m => !AI_MODELS.some(known => known.id === m)) || value.limits?.maxTokens !== OUTPUT_LIMIT || value.limits.maxRequestCostUsd !== MAX_AI_REQUEST_COST_USD) throw new AIError('代理状态响应无效或版本不兼容，请检查部署。');
  return value as AIProxyStatus;
}
/** Uses GET /models through the fixed proxy; does not generate tokens. Call only on user click. */
export async function testAIConnection(): Promise<string[]> {
  const response = await callProxy({ action: 'models' }) as { data?: { id: string }[] };
  if (!Array.isArray(response.data)) throw new AIError('模型列表响应无效。');
  return response.data.map(m => m.id).filter(id => typeof id === 'string');
}
function normalizedName(name: string) { return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase(); }
async function stableCharacterId(bookId: string, name: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(bookId + ':' + normalizedName(name)));
  return bookId + ':character:' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
export async function createCharacter(bookId: string, name: string, scope?: IdentityLocation): Promise<Character> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new AIError('请输入人物名称。');
  const id = await stableCharacterId(bookId, clean);
  return db.transaction('rw', db.characters, async () => {
    const known = await db.characters.where('bookId').equals(bookId).toArray();
    const existing = known.find(c => [c.name, ...c.aliases].some(n => normalizedName(n) === normalizedName(clean)));
    if (existing) return existing;
    let character: Character = { id, bookId, name: clean, aliases: [] };
    if (scope) character = initializeCharacterIdentity(character, scope);
    await db.characters.put(character); return character;
  });
}
export async function renameCharacter(characterId: string, name: string, scope?: IdentityLocation): Promise<void> {
  await manualRenameCharacter(characterId, name, scope);
}
export async function correctDialogue(dialogueId: string, characterId: string | null): Promise<void> {
  const dialogue = await db.dialogues.get(dialogueId);
  if (!dialogue) throw new AIError('未找到对白。');
  if (characterId && (await db.characters.get(characterId))?.bookId !== dialogue.bookId) throw new AIError('人物不属于当前书籍。');
  await db.transaction('rw', db.corrections, db.dialogues, async () => {
    await db.corrections.put({ id: `manual:${dialogueId}`, dialogueId, bookId: dialogue.bookId, characterId, updatedAt: Date.now() });
    await db.dialogues.update(dialogueId, { characterId, source: 'manual', confidence: 1, updatedAt: Date.now() });
  });
}
export async function mergeCharacters(sourceId: string, targetId: string, scope?: IdentityLocation): Promise<void> {
  await manualMergeCharacters(sourceId, targetId, scope);
}
export interface ModelAttribution { id: string; speaker: string | null; confidence: number; characterId?: string | null }
type AttributionEvidence = Pick<ReturnType<typeof payloadFor>, 'known' | 'context'>;
function hasSpeakerEvidence(speaker: string, evidence: AttributionEvidence) {
  const name = normalizedName(speaker);
  if (evidence.known.some(c => [c.name, ...c.aliases].some(n => normalizedName(n) === name))) return true;
  const context = normalizedName(evidence.context.map(p => p.text).join('\n'));
  if (/\p{Script=Han}/u.test(name)) return name.length >= 2 && context.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(context);
}
export function validateAttributions(value: unknown, candidates: DialogueCandidate[], evidence?: AttributionEvidence): ModelAttribution[] {
  const rows = (value as { dialogues?: unknown })?.dialogues;
  if (!Array.isArray(rows)) throw new AIError('AI 返回的 JSON 格式无效，请手动重试。');
  const valid = new Map<string, ModelAttribution>();
  const ids = new Set(candidates.map(c => c.id));
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !ids.has(row.id)) continue;
    const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence) ? Math.max(0, Math.min(1, row.confidence)) : 0;
    if (valid.has(row.id)) throw new AIError('AI 返回了重复的对白编号，未保存当前片段；请手动重试。');
    const clean = typeof row.speaker === 'string' ? row.speaker.trim() : '';
    const speaker = clean && clean.length <= 80 && !/[\r\n\x00-\x1f]/.test(clean) && confidence >= 0.75 && !/^(unknown|未知|不确定|narrator|旁白|我|你|他|她|它|某人|说话者|speaker|none|null)$/i.test(clean) && (!evidence || hasSpeakerEvidence(clean, evidence)) ? clean : null;
    valid.set(row.id, { id: row.id, speaker, confidence });
  }
  return candidates.map(c => valid.get(c.id) || { id: c.id, speaker: null, confidence: 0 });
}
export interface DeepChunkOptions {
  sourceChapter: Chapter; input: ReturnType<typeof bookPayloadFor>; identities: IdentityProposal[];
  review?: boolean;
  commit?: () => Promise<void>;
}
export async function saveAnalysisChunk(chapter: Chapter, candidates: DialogueCandidate[], rows: ModelAttribution[], model: AIModel, checkpoint: AnalysisJob, assertLive: () => void, deep?: DeepChunkOptions) {
  // WebCrypto is completed before the IndexedDB transaction to keep it active.
  const ids = new Map(await Promise.all([...new Set(rows.flatMap(r => r.speaker ? [r.speaker] : []))].map(async name => {
    const first = candidates.find(c => rows.find(row => row.id === c.id)?.speaker === name)!;
    return [name, await stableCharacterId(chapter.bookId, deep ? `${name}:${chapter.id}:${first.paragraphIndex}:${first.start}` : name)] as const;
  })));
  await db.transaction('rw', [db.books, db.chapters, db.characters, db.dialogues, db.corrections, db.jobs, db.settings], async () => {
    assertLive();
    const book = await db.books.get(chapter.bookId);
    const currentChapter = await db.chapters.get(chapter.id);
    if (!book || book.deletedAt || !currentChapter || JSON.stringify(currentChapter.paragraphs) !== JSON.stringify((deep?.sourceChapter || chapter).paragraphs)) throw new AIError('书籍或章节已变化，当前片段未保存。');
    const characters = await db.characters.where('bookId').equals(chapter.bookId).toArray();
    const legacy = deep?.identities.some(proposal => characters.some(character => !character.identity && (character.id === proposal.characterId || character.id === proposal.targetId)));
    const introductions = legacy ? indexCharacterIntroductions(
      characters,
      await db.dialogues.where('bookId').equals(chapter.bookId).toArray(),
      await db.chapters.where('bookId').equals(chapter.bookId).toArray(),
    ) : undefined;
    if (deep) for (const proposal of deep.identities) {
      const index = characters.findIndex(person => person.id === proposal.characterId);
      if (index < 0) continue;
      const updated = applyIdentityProposal(characters[index], proposal, { chapter, context: deep.input.context, characters, knownIds: deep.input.known.map(person => person.id), introductions });
      if (updated) { characters[index] = updated; await db.characters.put(updated); }
    }
    for (const candidate of candidates) {
      const correction = await db.corrections.get(`manual:${candidate.id}`);
      const previous = await db.dialogues.get(candidate.id);
      const row = rows.find(r => r.id === candidate.id)!;
      const manual = !!correction || previous?.source === 'manual';
      // An inconclusive review cannot erase an already attributed line.
      if (deep?.review && previous && !manual && previous.characterId && (!row.speaker || row.confidence < previous.confidence)) continue;
      let character: Character | undefined;
      if (row.speaker && !manual) {
        if (deep) {
          const named = characters.filter(c => [c.name, ...c.aliases].some(n => normalizedName(n) === normalizedName(row.speaker!)));
          if (row.characterId && deep.input.known.some(person => person.id === row.characterId)) character = characters.find(c => c.id === row.characterId && [c.name, ...c.aliases].some(n => normalizedName(n) === normalizedName(row.speaker!)));
          if (!character) character = named.find(person => person.id === ids.get(row.speaker!));
          // Existing names alone are not sufficient to identify a person in another chapter.
        } else character = characters.find(c => [c.name, ...c.aliases].some(n => normalizedName(n) === normalizedName(row.speaker!)));
        if (!character) {
          const blocked = deep && row.characterId !== null && characters.some(c => [c.name, ...c.aliases].some(n => normalizedName(n) === normalizedName(row.speaker!)));
          if (!blocked) {
            character = { id: ids.get(row.speaker)!, bookId: chapter.bookId, name: row.speaker, aliases: [] };
            if (deep) character = initializeCharacterIdentity(character, { chapterIndex: chapter.index, paragraphIndex: candidate.paragraphIndex, offset: candidate.start });
            await db.characters.put(character); characters.push(character);
          }
        }
      }
      // Persist the source identity. The reader resolves redirects only after their reveal position.
      if (deep?.review && previous?.characterId && !manual && !character) continue;
      const dialogue: Dialogue = { ...candidate, bookId: chapter.bookId, chapterId: chapter.id,
        characterId: correction ? correction.characterId : manual ? previous!.characterId : character?.id || null,
        confidence: manual ? 1 : row.confidence, source: manual ? 'manual' : 'ai', model, updatedAt: Date.now(),
        ...(manual && previous?.speakerLabel ? { speakerLabel: previous.speakerLabel } : deep && !manual && character && row.speaker ? { speakerLabel: row.speaker } : {}) };
      await db.dialogues.put(dialogue);
    }
    assertLive();
    // A chunk and its paid-work checkpoint commit together, including manual overrides.
    await db.jobs.put(checkpoint);
    if (deep?.commit) await deep.commit();
  });
}
export function validateDeepAttributions(value: unknown, candidates: DialogueCandidate[], input: ReturnType<typeof bookPayloadFor>): ModelAttribution[] {
  const rows = (value as { dialogues?: unknown })?.dialogues;
  const ids = new Set(candidates.map(candidate => candidate.id));
  if (!Array.isArray(rows) || rows.length !== candidates.length || rows.some(row => !row || typeof row.id !== 'string' || !ids.delete(row.id) || (row.characterId !== null && (typeof row.characterId !== 'string' || !input.known.some(person => person.id === row.characterId))))) {
    throw new AIError('整书分析返回的对白编号或人物 ID 不完整，当前片段未保存。');
  }
  const validated = validateAttributions(value, candidates, { known: [], context: input.context });
  return validated.map(row => {
    const id = rows.find(item => item.id === row.id).characterId as string | null;
    return { ...row, characterId: id };
  });
}
/** Atomic across tabs: simultaneous retries cannot each spend the same remaining task allowance. */
export async function reserveAnalysisBudget(jobId: string, signature: string, amountUsd: number, budgetUsd: number): Promise<number> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 10) throw new AIError('费用额度无效。');
  return db.transaction('rw', db.settings, async () => {
    const id = `analysis-reservation:${jobId}`;
    const current = (await db.settings.get(id))?.value as { signature: string; reservedUsd: number } | undefined;
    if (current && (current.signature !== signature || !Number.isFinite(current.reservedUsd) || current.reservedUsd < 0)) throw new AIError('任务预算记录不匹配或损坏。');
    const reservedUsd = (current?.reservedUsd || 0) + amountUsd;
    if (reservedUsd > budgetUsd) throw new AIError('已达到任务预算上限。重试也会计入已保留的费用额度。');
    await db.settings.put({ id, value: { signature, reservedUsd } });
    return reservedUsd;
  });
}
/** Starts only with explicit authorization. Each retry must supply a new authorized:true call. */
export function analyzeChapter(options: AnalysisOptions): AnalysisController {
  let paused = false; let cancelled = false; let wake: (() => void) | undefined;
  let abort: AbortController | undefined;
  const controller: AnalysisController = {
    pause() { paused = true; }, resume() { paused = false; wake?.(); },
    cancel() { cancelled = true; paused = false; abort?.abort(); wake?.(); }, done: Promise.resolve(null as unknown as AnalysisJob),
  };
  const slot = JSON.stringify([options.bookId, options.chapterId]);
  const run = async () => {
    if (options.authorized !== true) throw new AIError('需要明确授权后才可调用收费 AI。');
    if (!hasAIKey()) throw new AIError('请先输入 API Key。');
    if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 || options.budgetUsd > 10) throw new AIError('单次预算必须在 $0–$10 之间。');
    modelInfo(options.model);
    const context = await requestContext(true);
    const stopAuth = subscribeAuth(session => {
      if (session?.user.id !== context.userId) { context.invalid = true; controller.cancel(); }
    });
    const changedConfig = () => { context.invalid = true; controller.cancel(); };
    if (typeof window !== 'undefined') window.addEventListener('onr-cloud-config-changed', changedConfig);
    const assertWork = () => { assertContext(context); if (cancelled) throw new AIError('任务已取消。'); };
    try {
      const chapter = await db.chapters.get(options.chapterId);
      if (!chapter || chapter.bookId !== options.bookId) throw new AIError('章节不存在。');
      const book = await db.books.get(options.bookId);
      if (!book || book.deletedAt) throw new AIError('书籍不存在或已移除。');
      const chunks = chunksFor(chapter);
      const estimate = estimateAnalysis(chapter, options.model);
      const id = options.jobId || crypto.randomUUID();
      const previous = options.jobId ? await db.jobs.get(id) : undefined;
      if (options.jobId && !previous) throw new AIError('未找到原任务检查点，请新建分析任务。');
      const signature = JSON.stringify({ model: options.model, paragraphs: chapter.paragraphs });
      const persisted = (await db.settings.get(`analysis-reservation:${id}`))?.value as { signature: string; reservedUsd: number } | undefined;
      if (persisted && (persisted.signature !== signature || !Number.isFinite(persisted.reservedUsd) || persisted.reservedUsd < 0)) throw new AIError('任务预算检查点不匹配，请新建分析任务。');
      if (previous && (previous.bookId !== chapter.bookId || previous.chapterId !== chapter.id || !Number.isInteger(previous.completedChunks) || previous.completedChunks < 0 || previous.completedChunks > chunks.length || previous.totalChunks !== chunks.length || (previous.model && previous.model !== options.model) || (previous.completedChunks > 0 && !persisted))) throw new AIError('任务与当前章节或本机检查点不匹配，请新建分析任务。');
      const reservedUsd = persisted?.reservedUsd || 0;
      const remainingEstimate = chunks.slice(previous?.completedChunks || 0).reduce((sum, chunk) => sum + estimatedChunkCost(chapter, chunk, options.model).usd, 0);
      if (reservedUsd + remainingEstimate > options.budgetUsd) throw new AIError(`剩余片段和已保留额度合计上限 $${(reservedUsd + remainingEstimate).toFixed(4)} 超过本次预算。`);
      let job: AnalysisJob = { id, bookId: chapter.bookId, chapterId: chapter.id, status: 'queued', completedChunks: previous?.completedChunks || 0, totalChunks: chunks.length, updatedAt: Date.now(), model: options.model, reservedUsd, estimatedMaxUsd: estimate.estimatedMaxUsd };
      const announce = () => { try { options.onProgress?.({ ...job }); } catch { /* A view callback must not change paid-work persistence. */ } };
      const update = async (changes: Partial<AnalysisJob>) => {
        const next = { ...job, ...changes, updatedAt: Date.now() };
        await db.transaction('rw', [db.books, db.chapters, db.jobs], async () => {
          assertContext(context);
          const currentBook = await db.books.get(chapter.bookId);
          const currentChapter = await db.chapters.get(chapter.id);
          if (!currentBook || currentBook.deletedAt || !currentChapter) throw new AIError('书籍已移除，任务已停止。');
          await db.jobs.put(next);
        });
        job = next; announce();
      };
      const waitIfPaused = async () => {
        while (paused && !cancelled) {
          // Install the wake-up before persisting paused state: an immediate resume cannot get lost.
          const resumed = new Promise<void>(resolve => { wake = resolve; });
          await update({ status: 'paused' });
          if (!paused || cancelled) wake?.();
          await resumed; wake = undefined;
        }
      };
      await update({ status: 'running' });
      try {
        for (let i = job.completedChunks; i < chunks.length; i++) {
          if (cancelled) break;
          await waitIfPaused();
          if (cancelled) break;
          const known = await db.characters.where('bookId').equals(chapter.bookId).toArray();
          await waitIfPaused();
          if (cancelled) break;
          assertWork();
          const reservation = chunkCost(chapter, chunks[i], options.model, known).usd;
          if (reservation > MAX_AI_REQUEST_COST_USD) throw new AIError('当前片段超出代理单次费用限制，未发送请求。');
          // Reserve before sending. Even a timeout may be billed, so never reclaim this reservation automatically.
          const totalReserved = await reserveAnalysisBudget(id, signature, reservation, options.budgetUsd);
          abort = new AbortController();
          await update({ status: 'running', reservedUsd: totalReserved });
          assertWork();
          const input = payloadFor(chapter, chunks[i], known);
          const result = await callProxy({ action: 'analyze', authorized: true, model: options.model, maxTokens: OUTPUT_LIMIT,
            system: SYSTEM_PROMPT, input, maxCostUsd: reservation }, abort.signal, context) as { choices?: { finish_reason: string; message: { content: string } }[] };
          assertWork();
          const choice = result.choices?.[0];
          if (!choice || choice.finish_reason !== 'stop') throw new AIError('AI 输出不完整；已完成片段保留，可手动重试剩余内容。');
          let data: unknown;
          try { data = JSON.parse(choice.message.content); } catch { throw new AIError('AI 返回的 JSON 无法解析；本地阅读不受影响。'); }
          await currentSession(context);
          assertWork();
          const next = { ...job, completedChunks: i + 1, updatedAt: Date.now() };
          await saveAnalysisChunk(chapter, chunks[i], validateAttributions(data, chunks[i], input), options.model, next, assertWork);
          job = next; announce();
        }
        await update({ status: cancelled ? 'cancelled' : 'done' });
        return job;
      } catch (error) {
        const safeError = error instanceof AIError ? error.message : '分析或本地保存失败。已完成片段保留；费用可能已产生，请手动决定是否重试。';
        if (context.invalid) { job = { ...job, status: 'cancelled', error: '账号、代理或会话密钥已变化，原任务已停止。' }; announce(); return job; }
        try { await update(cancelled ? { status: 'cancelled' } : { status: 'failed', error: safeError }); }
        catch { job = { ...job, status: cancelled ? 'cancelled' : 'failed', error: safeError }; announce(); }
        return job;
      }
    } finally {
      stopAuth();
      if (typeof window !== 'undefined') window.removeEventListener('onr-cloud-config-changed', changedConfig);
    }
  };
  controller.done = (async () => {
    if (bookActive.has(options.bookId)) throw new AIError('这本书正在进行整书分析，请先结束原任务。');
    if (active.has(slot)) throw new AIError('当前章节已有分析任务，请先暂停或取消原任务。');
    active.set(slot, controller);
    try {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await withAnalysisBookLock(options.bookId, () => navigator.locks.request(`onr-ai:${slot}`, { ifAvailable: true }, lock => {
          if (!lock) throw new AIError('另一个窗口正在分析当前章节，请先结束原任务。');
          return run();
        }));
      }
      return await run();
    } finally { if (active.get(slot) === controller) active.delete(slot); }
  })();
  return controller;
}
