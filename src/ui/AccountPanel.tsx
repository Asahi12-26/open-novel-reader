import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Session } from '@supabase/supabase-js';
import { Cloud, LoaderCircle, LogIn, LogOut, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import { configureCloud, getCloudConfig, getSession, requestPasswordReset, resendConfirmation, signIn, signOut, signUp, subscribeAuth, syncLibrary } from '../services/cloud';
import { authErrorMessage, authRedirectUrl } from '../services/auth-flow';
import { db } from '../core/db';
import { notify, useQuery } from './common';
import './auth.css';

type Mode = 'signin' | 'signup' | 'reset';
export default function AccountPanel({ onSignedOut }: { onSignedOut: () => void }) {
  const [config, setConfig] = useState(getCloudConfig);
  const [revision, setRevision] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const pending = useRef(false);
  const configured = !!getCloudConfig().url && !!getCloudConfig().anonKey;
  const sync = useQuery(() => db.syncState.toArray(), [], []);
  useEffect(() => {
    const changed = () => { setConfig(getCloudConfig()); setRevision(n => n + 1); };
    window.addEventListener('onr-cloud-config-changed', changed);
    return () => window.removeEventListener('onr-cloud-config-changed', changed);
  }, []);
  useEffect(() => {
    let alive = true;
    setChecking(true); setSession(null);
    const unsubscribe = subscribeAuth(next => { if (alive) { setSession(next); setChecking(false); } });
    void getSession().then(next => { if (alive) setSession(next); }).catch(e => { if (alive) setError(authErrorMessage(e)); }).finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; unsubscribe(); };
  }, [revision]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(n => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const changeMode = (next: Mode) => { setMode(next); setPassword(''); setRepeat(''); setNotice(''); setError(''); };
  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { if (/email_not_confirmed|email not confirmed/i.test(e instanceof Error ? e.message : '')) setPendingConfirmation(true); setError(authErrorMessage(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  const redirect = (intent: 'confirmation' | 'recovery') => authRedirectUrl(intent);
  const sendReset = async () => {
    if (cooldown) return;
    await requestPasswordReset(email.trim(), redirect('recovery'));
    setCooldown(60);
    setNotice('如果此邮箱已注册，你会收到找回密码邮件。请检查收件箱和垃圾邮件，并打开最新一封邮件中的链接。');
  };
  return <div className="account-panel">
    <div className="info-note"><Cloud size={22}/><p>登录同一账号，在不同设备继续阅读。首次同步前，请在每本书的详情中允许上传；本地阅读始终无需账号。</p></div>
    {import.meta.env.VITE_AUTH_EMAIL_MODE === 'team-test' && <p className="auth-native-note" role="note">当前为内置邮件测试阶段：请使用 Supabase 项目组织成员邮箱注册，查收并确认邮件后再登录，避免反复发送。正式公网注册和完整密码找回暂不开放。</p>}
    {!configured && <div className="auth-message" role="status">当前版本尚未连接账号服务。你仍可离线阅读；服务配置完成后即可注册和同步。</div>}
    <details className="auth-config" open={!configured || undefined}>
      <summary>{configured ? '高级：使用自己的云服务' : '配置云服务'}</summary>
      <p className="muted">自建用户可填入 Supabase 项目地址与 publishable / anon 公开密钥。请勿填写 service_role 或 secret 密钥。不同设备须连接同一个项目，邮件回调网页也须使用该项目。</p>
      <form onSubmit={e => { e.preventDefault(); void perform(async () => { configureCloud(config.url, config.anonKey); setNotice('云服务配置已保存，可以登录或注册。'); }); }}>
        <label className="form-label">Supabase 项目地址<input type="url" required placeholder="https://your-project.supabase.co" value={config.url} onChange={e => setConfig({ ...config, url: e.target.value })} disabled={busy} autoComplete="off"/></label>
        <label className="form-label">Publishable / anon 公开密钥<input required placeholder="sb_publishable_… 或 anon JWT" value={config.anonKey} onChange={e => setConfig({ ...config, anonKey: e.target.value })} disabled={busy} autoComplete="off" spellCheck={false}/></label>
        <button className="secondary" type="submit" disabled={busy}>保存云服务配置</button>
      </form>
      <a className="inline-link" href="https://github.com/Asahi12-26/open-novel-reader/blob/main/docs/SYNC_AI.md" target="_blank" rel="noreferrer">查看自建步骤 ↗</a>
    </details>
    <hr/>
    {checking ? <p className="auth-panel-busy" role="status"><LoaderCircle size={17} className="spin"/>正在恢复登录状态…</p> : session && mode !== 'reset' ? <>
      <div className="account-status"><p>已登录 <strong>{session.user.email}</strong></p><p className="auth-native-note">此设备连接 {new URL(getCloudConfig().url).host}</p></div>
      <div className="button-row"><button className="primary" disabled={busy} onClick={() => void perform(async () => { const result = await syncLibrary(); const message = `同步完成：上传 ${result.uploaded} 本，下载 ${result.downloaded} 本，合并 ${result.conflicts} 处冲突。`; setNotice(message); notify(message); })}>{busy ? <LoaderCircle className="spin" size={17}/> : <RefreshCw size={17}/>}立即同步</button><button className="secondary" disabled={busy} onClick={() => void perform(async () => { await signOut(); onSignedOut(); setSession(null); setPassword(''); setRepeat(''); setNotice('已退出当前设备，书籍仍保存在本机。'); })}><LogOut size={16}/>退出当前设备</button></div>
      <p className="auth-native-note">登录不会自动允许上传本机新书。切换账号也不会自动上传原账号书籍；请在藏书详情管理逐本许可。</p>
      <button className="text-button" disabled={busy || cooldown > 0} onClick={() => { setEmail(session.user.email || ''); changeMode('reset'); }}>通过邮件修改密码</button>
      {sync.filter(s => s.id === `library:${getCloudConfig().url}|${session.user.id}`).map(s => <p key={s.id} className={`sync-detail ${s.error ? 'error' : ''}`}>{s.error || (s.lastSyncedAt ? `上次同步：${new Date(s.lastSyncedAt).toLocaleString()}` : '等待首次同步')}</p>)}
    </> : <form className="auth-form" onSubmit={e => {
      e.preventDefault();
      if (!configured) { setError('请先连接账号服务。'); return; }
      void perform(async () => {
        if (mode === 'reset') { await sendReset(); return; }
        if (mode === 'signup') {
          if (password !== repeat) { setError('两次输入的密码不一致。'); return; }
          const result = await signUp(email.trim(), password, { emailRedirectTo: redirect('confirmation') });
          setSession(result.session); setPassword(''); setRepeat('');
          if (result.session) setNotice('注册成功，已登录。');
          else { setPendingConfirmation(true); setMode('signin'); setCooldown(60); setNotice('请查收确认邮件，打开其中的链接完成邮箱确认，再使用邮箱和密码登录。已有账号可直接登录或找回密码。'); }
          return;
        }
        setSession(await signIn(email.trim(), password)); setPassword(''); setPendingConfirmation(false); setNotice('登录成功。你可以选择书籍并开始同步。');
      });
    }}>
      <h3 className="auth-heading">{mode === 'signup' ? '创建阅见账号' : mode === 'reset' ? '找回或修改密码' : '登录阅见'}</h3>
      <p className="auth-description">{mode === 'signup' ? '注册后请先确认邮箱。密码至少 8 位，建议使用与其他网站不同的长密码。' : mode === 'reset' ? '输入注册邮箱，我们会发送邮件。打开链接后，在网页设置新密码。' : '在电脑、手机和网页使用同一账号，找回你的阅读位置。'}</p>
      <label className="form-label">邮箱<input name="email" required type="email" autoComplete="username" maxLength={254} value={email} disabled={busy} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"/></label>
      {mode !== 'reset' && <label className="form-label">密码<input name="password" required minLength={mode === 'signup' ? 8 : undefined} maxLength={256} type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} disabled={busy} onChange={e => setPassword(e.target.value)}/></label>}
      {mode === 'signup' && <label className="form-label">再次输入密码<input name="confirm-password" required minLength={8} maxLength={256} type="password" autoComplete="new-password" value={repeat} disabled={busy} onChange={e => setRepeat(e.target.value)}/></label>}
      <div className="button-row"><button type="submit" className="primary" disabled={busy || !configured || (mode === 'reset' && cooldown > 0)}>{busy ? <LoaderCircle className="spin" size={16}/> : mode === 'reset' ? <Mail size={16}/> : <LogIn size={16}/>} {mode === 'signup' ? '注册账号' : mode === 'reset' ? cooldown ? `${cooldown} 秒后可重新发送` : '发送找回密码邮件' : '登录'}</button></div>
      <div className="auth-links">{mode !== 'signin' && <button type="button" disabled={busy} onClick={() => changeMode('signin')}>返回登录</button>}{mode === 'signin' && <><button type="button" disabled={busy} onClick={() => changeMode('signup')}>创建新账号</button><button type="button" disabled={busy} onClick={() => changeMode('reset')}>忘记密码？</button></>}{pendingConfirmation && mode === 'signin' && <button type="button" disabled={busy || !configured || !email || cooldown > 0} onClick={() => void perform(async () => { await resendConfirmation(email.trim(), redirect('confirmation')); setCooldown(60); setNotice('如果此邮箱尚待确认，你会收到新的确认邮件。请打开最新一封。'); })}>{cooldown ? `${cooldown} 秒后可重发确认邮件` : '重新发送确认邮件'}</button>}</div>
    </form>}
    {notice && <div className="auth-message" role="status">{notice}</div>}{error && <div className="auth-message is-error" role="alert">{error}</div>}
    {isTauri() && <p className="auth-native-note">确认邮箱和找回密码会在浏览器中的阅见网页完成；完成后回到此应用，使用邮箱和新密码登录。</p>}
    <p className="auth-check"><ShieldCheck size={16}/>密码仅用于账号服务，不会写入书库备份。</p>
  </div>;
}
