import { createClient } from 'npm:@supabase/supabase-js@2';
import { readBoundedJSON } from '../_shared/bounded-request.ts';

// No service-role key. Requests are authenticated independently of CORS/platform JWT checks.
// API keys live only in this invocation, are never stored, and must never be logged.
const rates: Record<string, { input: number; output: number }> = {
  'deepseek-flash': { input: 0.30, output: 1.20 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96 },
};
const origins = (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:1420,http://127.0.0.1:1420,https://tauri.localhost,http://tauri.localhost,tauri://localhost').split(',').map(s => s.trim()).filter(Boolean);
const encoder = new TextEncoder();
Deno.serve(async req => {
  const origin = req.headers.get('origin');
  const allowed = !origin || origins.includes(origin);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    ...(origin && allowed ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST,OPTIONS' };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (!allowed) return reply({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return reply({ error: 'AUTH_REQUIRED' }, 401);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !data.user) return reply({ error: 'AUTH_REQUIRED' }, 401);
  let parsed;
  try {
    parsed = await readBoundedJSON(req, 160000);
  } catch (error) { return error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? reply({ error: 'REQUEST_TOO_LARGE' }, 413) : reply({ error: 'INVALID_JSON' }, 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply({ error: 'INVALID_JSON_OBJECT' }, 400);
  const body = parsed as Record<string, unknown>;
  if (typeof body.apiKey !== 'string' || body.apiKey.length < 10 || body.apiKey.length > 256 || /[\r\n]/.test(body.apiKey)) return reply({ error: 'INVALID_KEY' }, 400);
  if (body.action !== 'models' && body.action !== 'analyze') return reply({ error: 'INVALID_ACTION' }, 400);
  let upstreamBody: string | undefined;
  if (body.action === 'analyze') {
    if (body.authorized !== true) return reply({ error: 'CONSENT_REQUIRED' }, 403);
    const rate = typeof body.model === 'string' && Object.hasOwn(rates, body.model) ? rates[body.model] : undefined;
    if (!rate || typeof body.maxTokens !== 'number' || !Number.isInteger(body.maxTokens) || body.maxTokens < 1 || body.maxTokens > 4096 || typeof body.system !== 'string' || body.system.length > 4000 || !body.input || typeof body.input !== 'object') return reply({ error: 'INVALID_ANALYSIS' }, 400);
    const input = JSON.stringify(body.input);
    const inputBytes = encoder.encode(body.system + input).length + 2048;
    const upperCost = (inputBytes * rate.input + body.maxTokens * rate.output) / 1_000_000 * 1.1;
    if (inputBytes > 100000 || typeof body.maxCostUsd !== 'number' || !Number.isFinite(body.maxCostUsd) || body.maxCostUsd <= 0 || body.maxCostUsd > 10 || upperCost > body.maxCostUsd + 0.0000001) return reply({ error: 'COST_LIMIT' }, 400);
    upstreamBody = JSON.stringify({ model: body.model, messages: [{ role: 'system', content: body.system }, { role: 'user', content: input }],
      thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: body.maxTokens, stream: false, temperature: 0.2 });
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  req.signal.addEventListener('abort', cancel, { once: true });
  if (req.signal.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 110000);
  try {
    // Fixed upstream; caller cannot turn this service into an arbitrary credential-bearing HTTP proxy.
    const response = await fetch(`https://api.deepseek.com/${body.action === 'models' ? 'models' : 'chat/completions'}`, {
      method: body.action === 'models' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${body.apiKey}`, 'Content-Type': 'application/json' },
      body: upstreamBody, signal: controller.signal,
    });
    if (!response.ok) return reply({ error: 'UPSTREAM_ERROR' }, [401, 402, 429].includes(response.status) ? response.status : 502);
    const result = await response.json();
    if (body.action === 'models') return reply({ data: Array.isArray(result.data) ? result.data.map((m: { id: string }) => ({ id: m.id })) : [] });
    return reply({ choices: result.choices, usage: result.usage });
  } catch { return reply({ error: 'UPSTREAM_TIMEOUT_OR_NETWORK_ERROR' }, 504); }
  finally { clearTimeout(timer); req.signal.removeEventListener('abort', cancel); body.apiKey = ''; }
});
