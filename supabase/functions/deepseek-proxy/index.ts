import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createDeepseekProxy, DEFAULT_AI_ORIGINS, type ProxyAdmission } from './handler.ts';

// The gateway and getUser independently verify the incoming user. The runtime's
// service credential is confined to the two admission RPCs and never reaches DeepSeek.
const origins = (Deno.env.get('ALLOWED_ORIGINS') || DEFAULT_AI_ORIGINS.join(',')).split(',').map(origin => origin.trim()).filter(Boolean);
function readRuntimeKey(dictionary: string, legacyVariable: string): string | undefined {
  try {
    const keys = JSON.parse(Deno.env.get(dictionary) || '{}');
    if (typeof keys.default === 'string' && keys.default) return keys.default;
  } catch { /* Older projects can use their legacy key. */ }
  return Deno.env.get(legacyVariable);
}
function admissionClient(signal: AbortSignal) {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = readRuntimeKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new Error('Admission configuration unavailable');
  return createClient(url, serviceKey, {
    global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
Deno.serve(createDeepseekProxy({
  allowedOrigins: origins,
  fetch,
  authenticate: async (token, signal) => {
    const url = Deno.env.get('SUPABASE_URL');
    const publicKey = readRuntimeKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
    if (!url || !publicKey) throw new Error('Auth configuration unavailable');
    const supabase = createClient(url, publicKey, {
      global: { headers: { Authorization: `Bearer ${token}` }, fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user?.id || !data.user.email_confirmed_at || data.user.is_anonymous || data.user.role !== 'authenticated') return null;
    const access = await supabase.rpc('reader_has_private_cloud');
    if (access.error) throw new Error('Private access check unavailable');
    return access.data === true ? data.user.id : null;
  },
  reserve: async (userId, action, requestId, signal) => {
    const { data, error } = await admissionClient(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      .rpc('reserve_reader_ai_request', { p_user: userId, p_action: action, p_request: requestId });
    if (error) throw new Error('Admission check unavailable');
    return data as ProxyAdmission;
  },
  release: async (userId, requestId) => {
    const { error } = await admissionClient(AbortSignal.timeout(2000))
      .rpc('release_reader_ai_request', { p_user: userId, p_request: requestId });
    if (error) throw new Error('Admission release unavailable');
  },
}));
