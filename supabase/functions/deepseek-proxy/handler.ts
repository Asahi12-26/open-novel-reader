import { readBoundedJSON } from '../_shared/bounded-request.ts';
import { AI_COST_MARGIN, AI_MODELS, AI_OUTPUT_LIMIT, AI_SYSTEM_PROMPT, AI_TOKEN_OVERHEAD, MAX_AI_REQUEST_COST_USD } from '../_shared/ai-contract.ts';

export const DEFAULT_AI_ORIGINS = [
  'https://asahi12-26.github.io', 'https://tauri.localhost', 'http://tauri.localhost', 'tauri://localhost',
  'http://localhost:1420', 'http://127.0.0.1:1420',
] as const;
const encoder = new TextEncoder();
const MAX_BODY_BYTES = 160000;
const MAX_INPUT_BYTES = 100000;
const MAX_RESPONSE_BYTES = 131072;
type JsonObject = Record<string, unknown>;
export interface ProxyDependencies {
  /** Return a verified non-anonymous user id, never decoded-but-unverified JWT claims. */
  authenticate(token: string, signal: AbortSignal): Promise<string | null>;
  fetch: typeof fetch;
  allowedOrigins?: readonly string[];
  timeoutMs?: number;
}
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const only = (value: JsonObject, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));

function validInput(value: unknown): value is JsonObject {
  if (!object(value) || !only(value, ['chapter', 'known', 'context', 'dialogues']) || !cleanText(value.chapter, 500)) return false;
  if (!Array.isArray(value.known) || value.known.length > 100 || !value.known.every(row => object(row) && only(row, ['name', 'aliases']) && cleanText(row.name, 80) && Array.isArray(row.aliases) && row.aliases.length <= 20 && row.aliases.every(alias => cleanText(alias, 80)))) return false;
  if (!Array.isArray(value.context) || !value.context.length || value.context.length > 36) return false;
  const paragraphs = new Set<number>();
  for (const row of value.context) {
    if (!object(row) || !only(row, ['paragraph', 'text']) || !integer(row.paragraph) || paragraphs.has(row.paragraph) || !cleanText(row.text, 7000)) return false;
    paragraphs.add(row.paragraph);
  }
  if (!Array.isArray(value.dialogues) || !value.dialogues.length || value.dialogues.length > 12) return false;
  const ids = new Set<string>();
  for (const row of value.dialogues) {
    if (!object(row) || !only(row, ['id', 'paragraphIndex', 'start', 'end', 'text']) || !cleanText(row.id, 512) || ids.has(row.id) || !integer(row.paragraphIndex) || !paragraphs.has(row.paragraphIndex) || !integer(row.start) || !integer(row.end) || !cleanText(row.text, 1800) || row.end - row.start !== row.text.length) return false;
    ids.add(row.id);
  }
  return true;
}

function analysisResponse(value: unknown): JsonObject | null {
  if (!object(value) || !Array.isArray(value.choices) || value.choices.length !== 1) return null;
  const choice = value.choices[0];
  if (!object(choice) || !['stop', 'length', 'content_filter'].includes(String(choice.finish_reason)) || !object(choice.message) || typeof choice.message.content !== 'string' || choice.message.content.length > 65536) return null;
  if (choice.finish_reason === 'stop') {
    let parsed: unknown;
    try { parsed = JSON.parse(choice.message.content); } catch { return null; }
    if (!object(parsed) || !Array.isArray(parsed.dialogues) || parsed.dialogues.length > 12) return null;
    const ids = new Set<string>();
    for (const row of parsed.dialogues) {
      if (!object(row) || !cleanText(row.id, 512) || ids.has(row.id) || (row.speaker !== null && !cleanText(row.speaker, 80)) || typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) return null;
      ids.add(row.id);
    }
  }
  const result: JsonObject = { choices: [{ finish_reason: choice.finish_reason, message: { content: choice.message.content } }] };
  if (object(value.usage)) {
    const usage: JsonObject = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (integer(value.usage[key])) usage[key] = value.usage[key];
    if (Object.keys(usage).length) result.usage = usage;
  }
  return result;
}

/** No provider calls happen on OPTIONS/status/failed validation. No retries or secret logging. */
export function createDeepseekProxy(deps: ProxyDependencies): (request: Request) => Promise<Response> {
  const allowedOrigins = new Set(deps.allowedOrigins || DEFAULT_AI_ORIGINS);
  // A warm-isolate concurrency fence complements client reservations; it is not a global quota.
  const activeUsers = new Set<string>();
  return async req => {
    const origin = req.headers.get('origin');
    const allowed = !!origin && origin !== 'null' && allowedOrigins.has(origin);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
      ...(allowed ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST,OPTIONS' };
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (!allowed) return reply({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) return reply({ error: 'JSON_REQUIRED' }, 415);
    const auth = req.headers.get('authorization') || '';
    if (!/^Bearer [^\s]+$/i.test(auth) || auth.length > 8192) return reply({ error: 'AUTH_REQUIRED' }, 401);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.signal.addEventListener('abort', cancel, { once: true });
    if (req.signal.aborted) controller.abort();
    const timer = setTimeout(cancel, deps.timeoutMs ?? 110000);
    let body: JsonObject | undefined;
    let activeUser: string | undefined;
    try {
      let userId: string | null;
      try { userId = await deps.authenticate(auth.slice(7), controller.signal); }
      catch { return reply({ error: 'AUTH_UNAVAILABLE' }, 503); }
      if (!userId) return reply({ error: 'AUTH_REQUIRED' }, 401);
      let parsed: unknown;
      try { parsed = await readBoundedJSON(req, MAX_BODY_BYTES, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) return reply({ error: 'REQUEST_ABORTED' }, 499);
        return reply({ error: error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON' }, error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 400);
      }
      if (!object(parsed)) return reply({ error: 'INVALID_JSON_OBJECT' }, 400);
      body = parsed;
      if (!['status', 'models', 'analyze'].includes(String(body.action))) return reply({ error: 'INVALID_ACTION' }, 400);
      if (body.action === 'status') {
        if (!only(body, ['action'])) return reply({ error: 'INVALID_STATUS' }, 400);
        return reply({ ready: true, models: AI_MODELS.map(model => model.id), limits: { maxTokens: AI_OUTPUT_LIMIT, maxRequestCostUsd: MAX_AI_REQUEST_COST_USD }, upstreamChecked: false });
      }
      if (typeof body.apiKey !== 'string' || !/^[A-Za-z0-9._-]{10,256}$/.test(body.apiKey)) return reply({ error: 'INVALID_KEY' }, 400);
      let upstreamBody: string | undefined;
      if (body.action === 'analyze') {
        if (body.authorized !== true) return reply({ error: 'CONSENT_REQUIRED' }, 403);
        if (!only(body, ['action', 'apiKey', 'authorized', 'model', 'maxTokens', 'system', 'input', 'maxCostUsd'])) return reply({ error: 'INVALID_ANALYSIS' }, 400);
        const model = AI_MODELS.find(model => model.id === body!.model);
        if (!model || typeof body.maxTokens !== 'number' || !Number.isInteger(body.maxTokens) || body.maxTokens < 1 || body.maxTokens > AI_OUTPUT_LIMIT || body.system !== AI_SYSTEM_PROMPT || !validInput(body.input)) return reply({ error: 'INVALID_ANALYSIS' }, 400);
        const input = JSON.stringify(body.input);
        const inputBytes = encoder.encode(AI_SYSTEM_PROMPT + input).length + AI_TOKEN_OVERHEAD;
        const upperCost = (inputBytes * model.inputPerMillion + body.maxTokens * model.outputPerMillion) / 1_000_000 * AI_COST_MARGIN;
        if (inputBytes > MAX_INPUT_BYTES || typeof body.maxCostUsd !== 'number' || !Number.isFinite(body.maxCostUsd) || body.maxCostUsd <= 0 || body.maxCostUsd > MAX_AI_REQUEST_COST_USD || upperCost > body.maxCostUsd + 0.0000001) return reply({ error: 'COST_LIMIT' }, 400);
        upstreamBody = JSON.stringify({ model: model.id, messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: input }],
          thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: body.maxTokens, stream: false, temperature: 0.2 });
      } else if (!only(body, ['action', 'apiKey'])) return reply({ error: 'INVALID_MODELS' }, 400);
      if (controller.signal.aborted) return reply({ error: 'REQUEST_ABORTED' }, 499);
      if (activeUsers.has(userId)) return reply({ error: 'REQUEST_IN_PROGRESS' }, 429);
      activeUser = userId; activeUsers.add(userId);
      const response = await deps.fetch(`https://api.deepseek.com/${body.action === 'models' ? 'models' : 'chat/completions'}`, {
        method: body.action === 'models' ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${body.apiKey}`, 'Content-Type': 'application/json' }, body: upstreamBody, signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return reply({ error: 'UPSTREAM_ERROR' }, [401, 402, 429].includes(response.status) ? response.status : 502);
      }
      let value: unknown;
      try { value = await readBoundedJSON(response, MAX_RESPONSE_BYTES, controller.signal); }
      catch { return reply({ error: controller.signal.aborted ? 'UPSTREAM_TIMEOUT_OR_NETWORK_ERROR' : 'INVALID_UPSTREAM_RESPONSE' }, controller.signal.aborted ? 504 : 502); }
      let result: JsonObject | null;
      if (body.action === 'models') {
        if (!object(value) || !Array.isArray(value.data) || value.data.length > 100) return reply({ error: 'INVALID_UPSTREAM_RESPONSE' }, 502);
        result = { data: value.data.filter(model => object(model) && AI_MODELS.some(allowedModel => allowedModel.id === model.id)).map(model => ({ id: (model as JsonObject).id })) };
      } else result = analysisResponse(value);
      if (!result || JSON.stringify(result).includes(body.apiKey)) return reply({ error: 'INVALID_UPSTREAM_RESPONSE' }, 502);
      return reply(result);
    } catch { return reply({ error: controller.signal.aborted ? 'UPSTREAM_TIMEOUT_OR_NETWORK_ERROR' : 'PROXY_UNAVAILABLE' }, 504); }
    finally {
      clearTimeout(timer); req.signal.removeEventListener('abort', cancel);
      if (body) body.apiKey = '';
      if (activeUser) activeUsers.delete(activeUser);
    }
  };
}
