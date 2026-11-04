import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({
  getCloudConfig: vi.fn(), getSession: vi.fn(), subscribeAuth: vi.fn(() => () => {}),
  signIn: vi.fn(), signUp: vi.fn(), signOut: vi.fn(), configureCloud: vi.fn(),
  requestPasswordReset: vi.fn(), resendConfirmation: vi.fn(), syncLibrary: vi.fn(),
}));
vi.mock('../services/cloud', () => auth);
vi.mock('./common', () => ({ notify: vi.fn(), useQuery: () => [] }));
import AccountPanel from './AccountPanel';
let root: Root; let container: HTMLDivElement;
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button).toBeTruthy(); await act(async () => button!.click());
};
const type = async (name: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const submit = async () => { await act(async () => container.querySelector('.auth-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks();
  auth.getCloudConfig.mockReturnValue({ url: 'https://test.supabase.co', anonKey: 'sb_publishable_test' });
  auth.getSession.mockResolvedValue(null); auth.signUp.mockResolvedValue({ session: null });
  auth.signIn.mockResolvedValue({ user: { id: 'reader', email: 'reader@example.com' } });
  auth.requestPasswordReset.mockResolvedValue(undefined);
  window.history.replaceState(null, '', '/open-novel-reader/');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(AccountPanel, { onSignedOut: vi.fn() })));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('account forms without a live account service', () => {
  it('registers only matching passwords with a subpath confirmation callback and clears password inputs', async () => {
    await click('创建新账号'); await type('email', 'reader@example.com'); await type('password', 'unique-password'); await type('confirm-password', 'wrong-password');
    await submit(); expect(auth.signUp).not.toHaveBeenCalled(); expect(container.textContent).toContain('不一致');
    await type('confirm-password', 'unique-password'); await submit();
    expect(auth.signUp).toHaveBeenCalledExactlyOnceWith('reader@example.com', 'unique-password', { emailRedirectTo: 'http://localhost:3000/open-novel-reader/?auth=confirmation' });
    expect(container.textContent).toContain('请查收确认邮件');
    expect(container.querySelector<HTMLInputElement>('input[name=password]')?.value).toBe('');
  });
  it('sends an enumeration-safe reset and prevents immediate repeated mail requests', async () => {
    await click('忘记密码？'); await type('email', 'reader@example.com'); await submit();
    expect(auth.requestPasswordReset).toHaveBeenCalledExactlyOnceWith('reader@example.com', 'http://localhost:3000/open-novel-reader/?auth=recovery');
    expect(container.textContent).toContain('如果此邮箱已注册');
    await submit(); expect(auth.requestPasswordReset).toHaveBeenCalledTimes(1);
  });
  it('offers confirmation resend after an unconfirmed login instead of claiming login success', async () => {
    auth.signIn.mockRejectedValueOnce(new Error('Email not confirmed'));
    await type('email', 'reader@example.com'); await type('password', 'unique-password'); await submit();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('确认邮件');
    expect(container.textContent).toContain('重新发送确认邮件');
    expect(container.textContent).not.toContain('已登录');
  });
});
