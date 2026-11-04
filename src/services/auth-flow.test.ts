import { describe, expect, it } from 'vitest';
import { authErrorMessage, authRedirectUrl, cleanAuthCallbackUrl, PUBLIC_APP_URL, readAuthCallback } from './auth-flow';

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
  });
  it('explains known errors without displaying arbitrary server text or token-bearing URLs', () => {
    expect(authErrorMessage({ code: 'email_not_confirmed' })).toContain('确认邮件');
    expect(authErrorMessage({ code: 'over_email_send_rate_limit' })).toContain('频繁');
    expect(authErrorMessage(new Error('Email address not authorized'))).toContain('邮件服务');
    expect(authErrorMessage(new Error('https://private.example/#access_token=secret'))).not.toContain('secret');
  });
});
