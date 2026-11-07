import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createDeepseekProxy, DEFAULT_AI_ORIGINS } from './handler.ts';

// No service-role key or provider key is stored. The gateway and getUser both check user authorization.
const origins = (Deno.env.get('ALLOWED_ORIGINS') || DEFAULT_AI_ORIGINS.join(',')).split(',').map(origin => origin.trim()).filter(Boolean);
function readPublicKey(): string | undefined {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
    if (typeof keys.default === 'string' && keys.default) return keys.default;
  } catch { /* A legacy project can still use its provided anonymous public key. */ }
  return Deno.env.get('SUPABASE_ANON_KEY');
}
Deno.serve(createDeepseekProxy({
  allowedOrigins: origins,
  fetch,
  authenticate: async (token, signal) => {
    const url = Deno.env.get('SUPABASE_URL');
    const publicKey = readPublicKey();
    if (!url || !publicKey) throw new Error('Auth configuration unavailable');
    const supabase = createClient(url, publicKey, {
      global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    return !error && data.user?.id && !data.user.is_anonymous && data.user.role === 'authenticated' ? data.user.id : null;
  },
}));
