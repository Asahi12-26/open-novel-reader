import { useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { Check, LoaderCircle, Mail } from 'lucide-react';
import { exchangeCodeForSession, getCloudConfig, getSession, getUser, requestPasswordReset, subscribeAuth, updatePassword } from '../services/cloud';
import { authErrorMessage, authRedirectUrl, cleanAuthCallbackUrl, readAuthCallback } from '../services/auth-flow';
import { Modal } from './common';
import './auth.css';

/** Mount once at App's root so recovery mail never requires manually opening Settings. */
export default function AuthCallback({ onActive, onOpenSettings }: { onActive?: () => void; onOpenSettings?: () => void }) {
  const [callback, setCallback] = useState(() => readAuthCallback(window.location.href));
  const [phase, setPhase] = useState<'checking' | 'ready' | 'error' | 'complete' | 'config'>('checking');
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const pending = useRef(false);
  // Compare an incoming token with the established session so a failed link cannot
  // be mistaken for success merely because another account is already signed in.
  const expectedToken = useRef(new URLSearchParams(window.location.hash.slice(1)).get('access_token'));
  const activeCallback = useRef(onActive); activeCallback.current = onActive;
  const cleanUrl = () => {
    const clean = cleanAuthCallbackUrl(window.location.href);
    if (clean !== window.location.href) window.history.replaceState(window.history.state, '', clean);
  };
  useEffect(() => {
    const changed = () => setRevision(n => n + 1);
    window.addEventListener('onr-cloud-config-changed', changed);
    const unsubscribe = subscribeAuth((_session, event) => {
      if (event === 'PASSWORD_RECOVERY') setCallback(previous => previous?.intent === 'recovery' ? previous : { intent: 'recovery' });
    });
    return () => { window.removeEventListener('onr-cloud-config-changed', changed); unsubscribe(); };
  }, [revision]);
  useEffect(() => {
    if (!callback) return;
    activeCallback.current?.();
    let alive = true;
    setError(''); setNotice(''); setPhase('checking'); setUser(null);
    const config = getCloudConfig();
    if (!config.url || !config.anonKey) { setPhase('config'); return; }
    void (async () => {
      try {
        // StrictMode replays effects during development. Let its first cleanup
        // run before consuming any single-use callback code.
        await Promise.resolve();
        if (!alive) return;
        if (callback.errorCode) throw new Error(callback.errorCode === 'callback_error' ? 'otp_expired' : callback.errorCode);
        let session = await getSession();
        if (!alive) return;
        // URL detection normally consumes this code. Only exchange if it remains,
        // avoiding a second exchange of a single-use PKCE code.
        const remainingCode = new URL(window.location.href).searchParams.get('code');
        if (remainingCode) session = await exchangeCodeForSession(remainingCode);
        if (!session || (expectedToken.current && session.access_token !== expectedToken.current)) throw new Error('otp_expired');
        const verified = await getUser();
        if (!verified || verified.id !== session.user.id || verified.is_anonymous) throw new Error('session_not_found');
        if (alive) { setUser(verified); setEmail(verified.email || ''); setPhase('ready'); }
      } catch (e) {
        if (alive) { setPhase('error'); setError(authErrorMessage(e)); }
      } finally {
        if (alive) { expectedToken.current = null; cleanUrl(); }
      }
    })();
    return () => { alive = false; };
  }, [callback, revision]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(n => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  if (!callback) return null;
  const close = () => { cleanUrl(); expectedToken.current = null; setPassword(''); setRepeat(''); setCallback(null); };
  const openSettings = () => { close(); onOpenSettings?.(); };
  return <Modal title={callback.intent === 'recovery' ? '设置新的登录密码' : '确认邮箱'} onClose={close}>
    <div className="auth-callback">
      {phase === 'checking' && <p className="auth-panel-busy" role="status"><LoaderCircle className="spin" size={18}/>正在验证邮件链接…</p>}
      {phase === 'config' && <><p className="auth-description">此网页尚未连接账号服务。请先在账号设置中连接发送这封邮件的同一个云服务，再打开邮件中的最新链接。</p><button className="primary" onClick={openSettings}>打开账号设置</button></>}
      {phase === 'ready' && callback.intent === 'confirmation' && <><p className="auth-check"><Check size={20}/>邮箱已确认，当前网页已登录。</p><p className="auth-callback-email">{user?.email}</p><p className="auth-description">你可以在网页继续阅读，或回到 Windows / Android 应用，使用此邮箱和密码登录同一账号。</p><div className="button-row"><button className="primary" onClick={openSettings}>查看账号与同步</button><button className="secondary" onClick={close}>回到书架</button></div></>}
      {phase === 'ready' && callback.intent === 'recovery' && <form className="auth-form" onSubmit={e => {
        e.preventDefault(); if (pending.current) return;
        if (password !== repeat) { setError('两次输入的密码不一致。'); return; }
        pending.current = true; setBusy(true); setError('');
        void updatePassword(password).then(() => { setPassword(''); setRepeat(''); setPhase('complete'); }).catch(e => setError(authErrorMessage(e))).finally(() => { pending.current = false; setBusy(false); });
      }}>
        <p className="auth-description">正在为 <strong className="auth-callback-email">{user?.email}</strong> 设置新密码。至少 8 位，建议使用独立的长密码。</p>
        <input className="visually-hidden" type="text" name="username" autoComplete="username" value={user?.email || ''} readOnly tabIndex={-1} aria-hidden="true"/>
        <label className="form-label">新密码<input required minLength={8} maxLength={256} type="password" name="new-password" autoComplete="new-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)}/></label>
        <label className="form-label">再次输入新密码<input required minLength={8} maxLength={256} type="password" name="confirm-password" autoComplete="new-password" value={repeat} disabled={busy} onChange={e => setRepeat(e.target.value)}/></label>
        <button className="primary" type="submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={16}/>}保存新密码</button>
      </form>}
      {phase === 'complete' && <><p className="auth-check" role="status"><Check size={20}/>密码已更新。</p><p className="auth-description">此网页已登录。现在可以回到 Windows / Android 应用，使用邮箱和新密码登录。</p><div className="button-row"><button className="primary" onClick={openSettings}>查看账号与同步</button><button className="secondary" onClick={close}>回到书架</button></div></>}
      {error && <div className="auth-message is-error" role="alert">{error}</div>}
      {phase === 'error' && <><p className="auth-description">邮件链接只能使用一次。如果链接失效，请重新发送，并打开最新一封邮件。确认邮箱后也可以直接在应用中登录。</p>{callback.intent === 'recovery' && <form className="auth-form" onSubmit={e => {
        e.preventDefault(); if (pending.current || cooldown) return;
        pending.current = true; setBusy(true); setError('');
        void Promise.resolve().then(() => requestPasswordReset(email.trim(), authRedirectUrl('recovery'))).then(() => { setCooldown(60); setNotice('如果此邮箱已注册，你会收到新的找回密码邮件。请检查收件箱和垃圾邮件。'); }).catch(e => setError(authErrorMessage(e))).finally(() => { pending.current = false; setBusy(false); });
      }}><label className="form-label">注册邮箱<input type="email" name="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={e => setEmail(e.target.value)}/></label><button className="secondary" disabled={busy || cooldown > 0}><Mail size={16}/>{cooldown ? `${cooldown} 秒后可重新发送` : '重新发送找回密码邮件'}</button></form>}<div className="auth-links"><button onClick={openSettings}>打开账号设置</button><button onClick={close}>继续本地阅读</button></div></>}
      {notice && <div className="auth-message" role="status">{notice}</div>}
    </div>
  </Modal>;
}
