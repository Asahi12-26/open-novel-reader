import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({
  getCloudConfig: vi.fn(), getSession: vi.fn(), getUser: vi.fn(),
  subscribeAuth: vi.fn(() => () => {}), exchangeCodeForSession: vi.fn(),
  requestPasswordReset: vi.fn(), updatePassword: vi.fn(),
}));
vi.mock('../services/cloud', () => auth);
import AuthCallback from './AuthCallback';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  auth.getCloudConfig.mockReturnValue({ url: 'https://test.supabase.co', anonKey: 'sb_publishable_test' });
  auth.getSession.mockResolvedValue({ access_token: 'incoming-token', user: { id: 'verified-user' } });
  auth.getUser.mockResolvedValue({ id: 'verified-user', email: 'reader@example.com' });
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
    expect(auth.getUser).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('reader@example.com');
    expect(container.querySelectorAll('input[type=password]')).toHaveLength(2);
    expect(window.location.hash).toBe(''); expect(window.location.search).toBe('');
    expect(container.innerHTML).not.toContain('incoming-token');
  });
  it('does not offer a password form to an anonymous callback', async () => {
    auth.getSession.mockResolvedValue(null);
    await mount();
    expect(container.querySelector('input[type=password]')).toBeNull();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('链接已失效');
    expect(auth.getUser).not.toHaveBeenCalled(); expect(auth.updatePassword).not.toHaveBeenCalled();
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
    expect(auth.updatePassword).toHaveBeenCalledExactlyOnceWith('independent-password');
    expect(container.textContent).toContain('密码已更新');
    expect(container.querySelector('input[type=password]')).toBeNull();
  });
  it('rejects an invalid link even when another valid account is already signed in', async () => {
    auth.getSession.mockResolvedValue({ access_token: 'other-account-token', user: { id: 'other-user' } });
    await act(async () => root.render(createElement(StrictMode, null, createElement(AuthCallback))));
    expect(container.querySelector('input[type=password]')).toBeNull();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('链接已失效');
    expect(auth.getUser).not.toHaveBeenCalled();
  });
  it('surfaces expired mail before using an existing session and provides a fresh-mail path', async () => {
    window.history.replaceState(null, '', '/?auth=recovery#error=access_denied&error_code=otp_expired');
    await mount();
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain('重新发送找回密码邮件');
    expect(container.querySelector('input[type=password]')).toBeNull();
  });
  it('explains missing service configuration without submitting credentials', async () => {
    auth.getCloudConfig.mockReturnValue({ url: '', anonKey: '' });
    const onOpenSettings = vi.fn(); await mount({ onOpenSettings });
    expect(container.textContent).toContain('此网页尚未连接账号服务');
    const open = [...container.querySelectorAll('button')].find(b => b.textContent === '打开账号设置')!;
    await act(async () => open.click());
    expect(onOpenSettings).toHaveBeenCalledOnce(); expect(auth.getSession).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });
});
