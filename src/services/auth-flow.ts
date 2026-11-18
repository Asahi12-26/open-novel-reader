import { isTauri } from '@tauri-apps/api/core';

export type AuthIntent = 'confirmation' | 'recovery';
export const PUBLIC_APP_URL = 'https://asahi12-26.github.io/open-novel-reader/';

/** Email links land on the index document: GitHub Pages does not serve SPA routes. */
export function authRedirectUrl(intent: AuthIntent, options: { native?: boolean; currentUrl?: string; publicUrl?: string } = {}): string {
  const native = options.native ?? isTauri();
  const configured = options.publicUrl ?? import.meta.env.VITE_PUBLIC_APP_URL;
  const url = configured ? new URL(configured) : native ? new URL(PUBLIC_APP_URL) : new URL('.', options.currentUrl ?? window.location.href);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('邮件回调地址必须使用 HTTPS。');
  }
  if (url.username || url.password) throw new Error('邮件回调地址不可包含账号或密码。');
  url.search = ''; url.hash = '';
  url.searchParams.set('auth', intent);
  return url.href;
}

export interface AuthCallbackInfo { intent: AuthIntent; errorCode?: string }
export type EmailCallbackProof =
  | { kind: 'session'; accessToken: string; refreshToken: string }
  | { kind: 'otp'; tokenHash: string; type: 'signup' | 'recovery' }
  | { kind: 'pkce'; code: string; flowId?: string };

const fragmentIntents = { signup: 'confirmation', recovery: 'recovery' } as const;
function fragmentIntent(hash: URLSearchParams): AuthIntent | undefined {
  const type = hash.get('type');
  return type === 'signup' || type === 'recovery' ? fragmentIntents[type] : undefined;
}

/** Return intent only; tokens are never copied into React state, notices, or logs. */
export function readAuthCallback(href: string): AuthCallbackInfo | null {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const auth = url.searchParams.get('auth');
  const expected = auth === 'recovery' || auth === 'confirmation' ? auth : undefined;
  const provider = fragmentIntent(hash);
  const hasCallback = expected || provider || hash.has('access_token') || hash.has('token_hash') || url.searchParams.has('code') || hash.has('error') || hash.has('error_code') || url.searchParams.has('error') || url.searchParams.has('error_code');
  if (!hasCallback) return null;
  const mismatch = provider && expected && provider !== expected;
  const errorCode = mismatch ? 'callback_mismatch' : hash.get('error_code') || url.searchParams.get('error_code') || (hash.has('error') || url.searchParams.has('error') ? 'callback_error' : undefined);
  return { intent: expected || provider || 'confirmation', ...(errorCode ? { errorCode } : {}) };
}

export function readEmailCallbackProof(href: string, intent: AuthIntent): EmailCallbackProof | null {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get('code');
  if (code && !hash.has('access_token') && !hash.has('refresh_token') && !hash.has('token_hash')) {
    return { kind: 'pkce', code, flowId: url.searchParams.get('sb_flow_id') ?? undefined };
  }
  if (code || fragmentIntent(hash) !== intent) return null;
  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  const tokenHash = hash.get('token_hash');
  if (tokenHash && !accessToken && !refreshToken) return { kind: 'otp', tokenHash, type: intent === 'recovery' ? 'recovery' : 'signup' };
  return accessToken && refreshToken && !tokenHash ? { kind: 'session', accessToken, refreshToken } : null;
}

export function cleanAuthCallbackUrl(href: string): string {
  const url = new URL(href);
  for (const name of ['auth', 'code', 'sb_flow_id', 'token_hash', 'access_token', 'refresh_token', 'error', 'error_code', 'error_description']) url.searchParams.delete(name);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (['access_token', 'refresh_token', 'token_hash', 'error', 'error_code'].some(name => hash.has(name)) || fragmentIntent(hash)) url.hash = '';
  return url.href;
}

function authErrorTag(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return `${code} ${message}`.toLowerCase();
}

export const isMissingEmailAccount = (error: unknown) => /user_not_found|email_not_found|user not found/.test(authErrorTag(error));

/** Do not echo arbitrary server responses; they can contain URLs or private details. */
export function authErrorMessage(error: unknown): string {
  const value = authErrorTag(error);
  if (/owner.only|private.cloud.access.denied/.test(value)) return '此账号没有该私有云的访问权限。你仍可在本机阅读。';
  if (/private.cloud.access.unavailable/.test(value)) return '暂时无法核验私有云权限。请检查网络和云项目配置，再请求新的邮件。';
  if (/anonymous_users_disabled|user_banned/.test(value)) return '当前账号无法登录，请联系服务维护者。';
  if (/invalid_credentials|invalid login credentials/.test(value)) return '邮箱或密码不正确，请检查后重试。';
  if (/email_not_confirmed|email not confirmed/.test(value)) return '该账号的邮箱尚未验证。请在 Supabase Auth 中核对验证状态后再登录。';
  if (/user_already_exists|already registered/.test(value)) return '此邮箱已注册，请登录或找回密码。';
  if (/over_email_send_rate_limit|over_request_rate_limit|rate.limit|too many|security purposes/.test(value)) return '操作过于频繁，请稍后再试；邮件服务也可能已达到发送额度。';
  if (/email_address_not_authorized|email address not authorized|not allowed to send/.test(value)) return '当前邮件服务尚未开放此邮箱。请联系服务维护者完成邮件配置。';
  if (/email_send_failed|error sending.*email|error sending.*(confirmation|recovery)|smtp/.test(value)) return '邮件暂时发送失败，请稍后重试；若持续失败，请联系服务维护者检查邮件服务。';
  if (/email_provider_disabled/.test(value)) return '该云项目的邮箱登录尚未配置。';
  if (/weak_password|password.*(short|least|weak)|same_password|different from/.test(value)) return '请换一个更强的新密码，至少 8 位，并满足服务的密码要求。';
  if (/callback_mismatch|otp_expired|flow_state_expired|flow_state_not_found|expired|invalid.*(token|otp)|bad_code_verifier|pkce/.test(value)) return '邮件链接已失效或已使用，请重新发送邮件，并打开最新一封。';
  if (/session_not_found|refresh_token_not_found|refresh_token_already_used|auth session missing|not authenticated|请先登录/.test(value)) return '登录状态已失效，请重新登录或重新发送找回密码邮件。';
  if (/invalid.*email|email_address_invalid|email.*invalid/.test(value)) return '请填写有效的邮箱地址。';
  if (/fetch|network|offline|timeout|timed out|connection/.test(value)) return '暂时无法连接账号服务，请检查网络后重试。';
  if (/captcha/.test(value)) return '当前服务要求额外的人机验证，请联系服务维护者启用支持的登录方式。';
  if (/配置|公开密钥|公钥|supabase|invalid api key|invalid url|https/.test(value)) return '账号服务配置不完整或不可用，请检查云服务配置。';
  return '此次账号操作未完成，请稍后重试；若持续失败，请联系服务维护者。';
}
