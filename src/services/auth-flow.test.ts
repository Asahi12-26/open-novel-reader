import { describe, expect, it } from 'vitest';
import { authErrorMessage, authRedirectUrl, cleanAuthCallbackUrl, PUBLIC_APP_URL, readAuthCallback, readEmailCallbackProof } from './auth-flow';

describe('email authentication navigation and messages', () => {
  it('keeps GitHub Pages subpaths and uses the same public webpage from native', () => {
    expect(authRedirectUrl('recovery', { native: false, currentUrl: 'https://reader.example/books/?from=shelf#toc' })).toBe('https://reader.example/books/?auth=recovery');
    expect(authRedirectUrl('confirmation', { native: true })).toBe(`${PUBLIC_APP_URL}?auth=confirmation`);
    expect(authRedirectUrl('recovery', { native: true, publicUrl: 'https://reader.example/sub/' })).toBe('https://reader.example/sub/?auth=recovery');
    expect(() => authRedirectUrl('recovery', { publicUrl: 'http://reader.example/' })).toThrow('HTTPS');
  });
  it('recognizes implicit confirmation/recovery and expired mail without returning credentials', () => {
    expect(readAuthCallback('https://reader.example/sub/#access_token=private&refresh_token=secret&type=recovery')).toEqual({ intent: 'recovery' });
    expect(readAuthCallback('https://reader.example/sub/?auth=confirmation#type=signup&access_token=private')).toEqual({ intent: 'confirmation' });
    expect(readAuthCallback('https://reader.example/sub/?auth=recovery#error=access_denied&error_code=otp_expired&error_description=private')).toEqual({ intent: 'recovery', errorCode: 'otp_expired' });
    expect(readAuthCallback('https://reader.example/sub/#chapter-3')).toBeNull();
  });
  it('removes authentication secrets while preserving ordinary page state', () => {
    expect(cleanAuthCallbackUrl('https://reader.example/sub/?auth=recovery&code=secret&view=shelf#access_token=private&refresh_token=secret')).toBe('https://reader.example/sub/?view=shelf');
    expect(cleanAuthCallbackUrl('https://reader.example/sub/?auth=confirmation&view=shelf#chapter-3')).toBe('https://reader.example/sub/?view=shelf#chapter-3');
    expect(cleanAuthCallbackUrl('https://reader.example/sub/?auth=confirmation&sb_flow_id=private#token_hash=private&type=signup')).toBe('https://reader.example/sub/');
  });
  it('requires an actual callback proof and binds email fragment types to their stated intent', () => {
    expect(readEmailCallbackProof('https://reader.example/?auth=recovery', 'recovery')).toBeNull();
    expect(readEmailCallbackProof('https://reader.example/?auth=recovery#access_token=fixture&refresh_token=fixture&type=signup', 'recovery')).toBeNull();
    expect(readEmailCallbackProof('https://reader.example/?auth=recovery#access_token=fixture&type=recovery', 'recovery')).toBeNull();
    expect(readEmailCallbackProof('https://reader.example/?auth=recovery#token_hash=fixture&type=recovery', 'recovery')).toEqual({ kind: 'otp', type: 'recovery', tokenHash: 'fixture' });
    expect(readEmailCallbackProof('https://reader.example/?auth=recovery&code=fixture&sb_flow_id=flow-fixture', 'recovery')).toEqual({ kind: 'pkce', code: 'fixture', flowId: 'flow-fixture' });
  });
  it('explains known errors without displaying arbitrary server text or token-bearing URLs', () => {
    expect(authErrorMessage({ code: 'email_not_confirmed' })).toContain('邮箱尚未验证');
    expect(authErrorMessage({ code: 'over_email_send_rate_limit' })).toContain('频繁');
    expect(authErrorMessage(new Error('Email address not authorized'))).toContain('邮件服务');
    expect(authErrorMessage(new Error('private_cloud_access_denied'))).toContain('访问权限');
    expect(authErrorMessage(new Error('https://private.example/#access_token=secret'))).not.toContain('secret');
  });
});
