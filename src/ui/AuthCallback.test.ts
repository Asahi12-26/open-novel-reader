import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({
  getCloudConfig: vi.fn(), finishEmailCallback: vi.fn(), requestPasswordReset: vi.fn(), updatePassword: vi.fn(),
}));
vi.mock('../services/cloud', () => auth);
import AuthCallback from './AuthCallback';

let root: Root;
let container: HTMLDivElement;
const project = { url: 'https://test.supabase.co', anonKey: 'sb_publishable_test' };
const recovery = { project, userId: 'verified-user', accessToken: 'incoming-token' };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  auth.getCloudConfig.mockReturnValue(project);
  auth.finishEmailCallback.mockResolvedValue({ user: { id: 'verified-user', email: 'reader@example.com' }, recovery });
  auth.requestPasswordReset.mockResolvedValue(undefined); auth.updatePassword.mockResolvedValue(undefined);
  window.history.replaceState(null, '', '/?auth=recovery#access_token=incoming-token&refresh_token=test&type=recovery');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
const mount = async (props = {}) => { await act(async () => root.render(createElement(AuthCallback, props))); };
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('email callback access and recovery UI', () => {
  it('automatically opens a verified recovery form and clears credentials from the address', async () => {
    const onActive = vi.fn();
    await mount({ onActive });
    expect(onActive).toHaveBeenCalledOnce();
    expect(auth.finishEmailCallback).toHaveBeenCalledExactlyOnceWith('recovery', { kind: 'session', accessToken: 'incoming-token', refreshToken: 'test' });
    expect(container.textContent).not.toContain('reader@example.com');
    expect(container.querySelectorAll('input[type=password]')).toHaveLength(2);
    expect(window.location.hash).toBe(''); expect(window.location.search).toBe('');
    expect(container.innerHTML).not.toContain('incoming-token');
  });
  it('does not offer a password form to an anonymous callback', async () => {
    auth.finishEmailCallback.mockRejectedValueOnce(new Error('otp_expired'));
    await mount();
    expect(container.querySelector('input[type=password]')).toBeNull();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('链接已失效');
    expect(auth.updatePassword).not.toHaveBeenCalled();
  });
  it('keeps mismatched passwords local and submits matching passwords only after verification', async () => {
    await mount();
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type=password]')];
    await type(inputs[0], 'independent-password'); await type(inputs[1], 'different-password');
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role=alert]')?.textContent).toContain('不一致');
    expect(auth.updatePassword).not.toHaveBeenCalled();
    await type(inputs[1], 'independent-password');
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(auth.updatePassword).toHaveBeenCalledExactlyOnceWith('independent-password', recovery);
    expect(container.textContent).toContain('密码已更新');
    expect(container.querySelector('input[type=password]')).toBeNull();
  });
  it('never treats a bare recovery marker or a mismatched confirmation as password recovery proof', async () => {
    window.history.replaceState(null, '', '/?auth=recovery#access_token=other&refresh_token=test&type=signup');
    await act(async () => root.render(createElement(StrictMode, null, createElement(AuthCallback))));
    expect(container.querySelector('input[type=password]')).toBeNull();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('链接已失效');
    expect(auth.finishEmailCallback).not.toHaveBeenCalled();
  });
  it('does not fall back to any stored sign-in when a link contains only a recovery marker', async () => {
    window.history.replaceState(null, '', '/?auth=recovery');
    await mount();
    expect(container.querySelector('input[type=password]')).toBeNull();
    expect(auth.finishEmailCallback).not.toHaveBeenCalled();
  });
  it('surfaces expired mail before using an existing session and provides a fresh-mail path', async () => {
    window.history.replaceState(null, '', '/?auth=recovery#error=access_denied&error_code=otp_expired');
    await mount();
    expect(auth.finishEmailCallback).not.toHaveBeenCalled();
    expect(container.textContent).toContain('重新发送找回密码邮件');
    expect(container.querySelector('input[type=password]')).toBeNull();
  });
  it('explains missing service configuration without submitting credentials', async () => {
    auth.getCloudConfig.mockReturnValue({ url: '', anonKey: '' });
    const onOpenSettings = vi.fn(); await mount({ onOpenSettings });
    expect(container.textContent).toContain('此网页尚未连接账号服务');
    const open = [...container.querySelectorAll('button')].find(b => b.textContent === '打开账号设置')!;
    await act(async () => open.click());
    expect(onOpenSettings).toHaveBeenCalledOnce(); expect(auth.finishEmailCallback).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });
});
