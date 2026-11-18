import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Session } from '@supabase/supabase-js';
import { Cloud, LoaderCircle, LogIn, LogOut, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import { configureCloud, getCloudConfig, getPrivateCloudAccess, getSession, requestPasswordReset, signIn, signOut, subscribeAuth, syncLibrary, SyncUserError, type PrivateCloudAccess } from '../services/cloud';
import { authErrorMessage, authRedirectUrl } from '../services/auth-flow';
import { db } from '../core/db';
import { notify, useQuery } from './common';
import './auth.css';

type Mode = 'signin' | 'reset';
export default function AccountPanel({ onSignedOut }: { onSignedOut: () => void }) {
  const [config, setConfig] = useState(getCloudConfig);
  const [revision, setRevision] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accessResult, setAccessResult] = useState<{ userId: string; url: string; access: PrivateCloudAccess }>();
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const pending = useRef(false);
  const activeConfig = getCloudConfig();
  const configured = !!activeConfig.url && !!activeConfig.anonKey;
  const userId = session?.user.id;
  const access = accessResult && accessResult.userId === userId && accessResult.url === activeConfig.url ? accessResult.access : 'checking';
  const sync = useQuery(() => db.syncState.toArray(), [], []);
  useEffect(() => {
    const changed = () => { setConfig(getCloudConfig()); setRevision(n => n + 1); };
    window.addEventListener('onr-cloud-config-changed', changed);
    return () => window.removeEventListener('onr-cloud-config-changed', changed);
  }, []);
  useEffect(() => {
    let alive = true;
    let subscriptionUpdated = false;
    setChecking(true); setSession(null);
    const unsubscribe = subscribeAuth(next => { if (alive) { subscriptionUpdated = true; setSession(next); setChecking(false); } });
    void getSession().then(next => { if (alive && !subscriptionUpdated) setSession(next); }).catch(e => { if (alive && !subscriptionUpdated) setError(authErrorMessage(e)); }).finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; unsubscribe(); };
  }, [revision]);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setAccessResult(undefined);
    void getPrivateCloudAccess(userId).then(next => { if (alive) setAccessResult({ userId, url: activeConfig.url, access: next }); });
    const retry = () => setAccessAttempt(attempt => attempt + 1);
    window.addEventListener('online', retry);
    return () => { alive = false; window.removeEventListener('online', retry); };
  }, [userId, activeConfig.url, activeConfig.anonKey, accessAttempt]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(n => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const changeMode = (next: Mode) => { setMode(next); setPassword(''); setNotice(''); setError(''); };
  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e instanceof SyncUserError ? e.message : authErrorMessage(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  const sendReset = async () => {
    if (cooldown) return;
    await requestPasswordReset(email.trim(), authRedirectUrl('recovery'));
    setCooldown(60);
    setNotice('如果此邮箱可以接收账号邮件，你会收到找回密码链接。请检查收件箱和垃圾邮件，并打开最新一封。');
  };
  const syncNow = () => perform(async () => {
    const result = await syncLibrary();
    const message = `已上传 ${result.uploaded} 本，下载 ${result.downloaded} 本，合并 ${result.conflicts} 处更新。`;
    setNotice(message); notify(message);
  });
  const leaveAccount = () => perform(async () => {
    await signOut(); onSignedOut(); setSession(null); setAccessResult(undefined); setEmail(''); changeMode('signin');
    setNotice('已退出当前设备。本机小说、阅读位置和标注仍可离线使用。与账号绑定的系列可在重新登录后查看。');
  });
  return <div className="account-panel">
    <div className="info-note"><Cloud size={22}/><p>私有云仅供项目所有者使用。本地阅读无需账号。</p></div>
    {!configured && <div className="auth-message" role="status">此应用可直接离线阅读。使用自建私有云时，请连接已完成所有者权限配置的项目。</div>}
    <details className="auth-config" open={!configured || undefined}>
      <summary>{configured ? '高级：使用自己的云服务' : '配置云服务'}</summary>
      <p className="muted">自建用户可填入 Supabase 项目地址与 publishable / anon 公开密钥。请勿填写 service_role 或 secret 密钥。不同设备须连接同一个项目，邮件回调网页也须使用该项目。</p>
      <form onSubmit={e => { e.preventDefault(); void perform(async () => { configureCloud(config.url, config.anonKey); setEmail(''); changeMode('signin'); setNotice('已保存私有云配置。'); }); }}>
        <label className="form-label">Supabase 项目地址<input type="url" required placeholder="https://your-project.supabase.co" value={config.url} onChange={e => setConfig({ ...config, url: e.target.value })} disabled={busy} autoComplete="off"/></label>
        <label className="form-label">Publishable / anon 公开密钥<input required placeholder="sb_publishable_… 或 anon JWT" value={config.anonKey} onChange={e => setConfig({ ...config, anonKey: e.target.value })} disabled={busy} autoComplete="off" spellCheck={false}/></label>
        <button className="secondary" type="submit" disabled={busy}>保存云服务配置</button>
      </form>
      <a className="inline-link" href="https://github.com/Asahi12-26/open-novel-reader/blob/main/docs/SYNC_AI.md" target="_blank" rel="noreferrer">查看自建步骤 ↗</a>
    </details>
    <hr/>
    {checking ? <p className="auth-panel-busy" role="status"><LoaderCircle size={17} className="spin"/>正在恢复登录状态…</p> : session && mode !== 'reset' ? <>
      <div className="account-status">
        {access === 'checking' && <p className="auth-panel-busy" role="status"><LoaderCircle size={17} className="spin"/>正在核验私有云访问权限…</p>}
        {access === 'allowed' && <p role="status"><strong>已连接私有云</strong></p>}
        {access === 'denied' && <p role="alert">此账号没有该私有云的访问权限。本地书架仍可使用。</p>}
        {access === 'unavailable' && <p role="status">暂时无法核验私有云权限。请检查网络和云项目配置后重试。本地书籍仍可阅读。</p>}
      </div>
      <div className="button-row">
        {access === 'allowed' && <button className="primary" disabled={busy} onClick={() => void syncNow()}>{busy ? <LoaderCircle className="spin" size={17}/> : <RefreshCw size={17}/>}立即同步</button>}
        {access === 'unavailable' && <button className="secondary" onClick={() => setAccessAttempt(attempt => attempt + 1)}>重试权限核验</button>}
        <button className="secondary" disabled={busy} onClick={() => void leaveAccount()}><LogOut size={16}/>退出当前设备</button>
      </div>
      <p className="auth-native-note">退出后，本机小说、阅读位置和标注会保留。与账号绑定的系列可在重新登录后查看。</p>
      {access === 'allowed' && <>
        <p className="auth-native-note">需要同步的书籍，可在各自详情中允许上传。</p>
        <button className="text-button" disabled={busy || cooldown > 0} onClick={() => { changeMode('reset'); setEmail(session.user.email || ''); }}>通过邮件修改密码</button>
        {sync.filter(s => s.id === `library:${activeConfig.url}|${session.user.id}`).map(s => <p key={s.id} className={`sync-detail ${s.error ? 'error' : ''}`}>{s.error || (s.lastSyncedAt ? `上次同步 ${new Date(s.lastSyncedAt).toLocaleString()}` : '等待首次同步')}</p>)}
      </>}
    </> : <form className="auth-form" onSubmit={e => {
      e.preventDefault();
      if (!configured) { setError('请先连接账号服务。'); return; }
      void perform(async () => {
        if (mode === 'reset') { await sendReset(); return; }
        const signedIn = await signIn(email.trim(), password);
        if (!signedIn) throw new Error('session_not_found');
        setSession(signedIn); setEmail(''); setPassword('');
      });
    }}>
      <h3 className="auth-heading">{mode === 'reset' ? '找回或修改密码' : '登录私有云'}</h3>
      <p className="auth-description">{mode === 'reset' ? '输入私有云账号绑定的邮箱。打开邮件中的链接，在网页设置新密码。' : '使用现有的私有云账号，在不同设备继续阅读。'}</p>
      <label className="form-label">邮箱<input name="email" required type="email" autoComplete="username" maxLength={254} value={email} disabled={busy} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"/></label>
      {mode !== 'reset' && <label className="form-label">密码<input name="password" required maxLength={256} type="password" autoComplete="current-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)}/></label>}
      <div className="button-row"><button type="submit" className="primary" disabled={busy || !configured || (mode === 'reset' && cooldown > 0)}>{busy ? <LoaderCircle className="spin" size={16}/> : mode === 'reset' ? <Mail size={16}/> : <LogIn size={16}/>} {mode === 'reset' ? cooldown ? `${cooldown} 秒后可重新发送` : '发送找回密码邮件' : '登录'}</button></div>
      <div className="auth-links">{mode === 'reset' ? <button type="button" disabled={busy} onClick={() => changeMode('signin')}>返回登录</button> : <button type="button" disabled={busy || !configured} onClick={() => changeMode('reset')}>忘记密码？</button>}</div>
    </form>}
    {notice && <div className="auth-message" role="status">{notice}</div>}{error && <div className="auth-message is-error" role="alert">{error}</div>}
    {isTauri() && <p className="auth-native-note">找回密码在浏览器中完成。设置新密码后，回到此应用重新登录。</p>}
    <p className="auth-check"><ShieldCheck size={16}/>密码仅用于账号服务，不会写入书库备份。</p>
  </div>;
}
