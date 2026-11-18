export interface CloudConfig { url: string; anonKey: string }

export function readPublicCloudConfig(rawUrl: string, rawKey: string): CloudConfig {
  let url: URL;
  try { url = new URL(rawUrl.trim()); }
  catch { throw new Error('请填写有效的 Supabase 项目地址。'); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('云端地址必须使用 HTTPS。');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请使用 Supabase 项目根地址。');

  const key = rawKey.trim();
  if (/^sb_publishable_[\w-]+$/.test(key)) return { url: url.origin, anonKey: key };
  const parts = key.split('.');
  if (parts.length === 3 && parts.every(part => /^[\w-]+$/.test(part))) {
    try {
      const claims: unknown = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (typeof claims === 'object' && claims && 'role' in claims && claims.role === 'anon') return { url: url.origin, anonKey: key };
    } catch { /* Invalid JWT. Return the same safe validation message. */ }
  }
  throw new Error('请使用 Supabase publishable / anon 公钥。');
}
