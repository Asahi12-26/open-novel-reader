import { useEffect, useRef, useState } from 'react';
import { Download, KeyRound, ShieldCheck, Upload } from 'lucide-react';
import type { Preferences } from '../types';
import { db } from '../core/db';
import { exportBackup, restoreBackup } from '../core/library';
import { checkAIProxy, clearAIKey, hasAIKey, setAIKey, testAIConnection } from '../services/ai';
import { download, Modal, notify, run, useQuery } from './common';
import AccountPanel from './AccountPanel';
import { version as appVersion } from '../../package.json';

export default function Settings({ preferences, onPreferences, onClose, initialTab = 'general' }: { preferences: Preferences; onPreferences: (p: Partial<Preferences>) => void; onClose: () => void; initialTab?: 'general' | 'cloud' | 'ai' }) {
  const [tab, setTab] = useState<string>(initialTab);
  const [apiKey, setApiKey] = useState(''); const [keyReady, setKeyReady] = useState(hasAIKey());
  const [working, setWorking] = useState(false); const [shelf, setShelf] = useState('');
  const [proxyNotice, setProxyNotice] = useState('');
  useEffect(() => {
    const changed = () => { setKeyReady(hasAIKey()); setProxyNotice(''); };
    window.addEventListener('onr-ai-key-changed', changed);
    return () => window.removeEventListener('onr-ai-key-changed', changed);
  }, []);
  const restore = useRef<HTMLInputElement>(null);
  const shelves = useQuery(() => db.shelves.filter(s => !s.deletedAt).toArray(), [], []);
  const perform = async (action: () => Promise<unknown>) => { setWorking(true); await run(action); setWorking(false); };
  const checkModels = async () => {
    setProxyNotice('');
    await perform(async () => {
      try {
        const models = await testAIConnection();
        setProxyNotice(`DeepSeek 连接成功：${models.join('、')}。本次仅查询模型，未生成文本。`);
      } catch (failure) {
        setProxyNotice(`DeepSeek 连接测试失败：${failure instanceof Error ? failure.message : '请稍后重试。'}`);
      }
    });
  };
  return <Modal title="你的阅读空间" onClose={onClose} wide><div className="settings-tabs">{[['general','通用与备份'],['cloud','账号与云同步'],['ai','AI 模型']].map(([id,label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    {tab === 'general' && <div className="settings-content"><h3>阅读偏好</h3><label className="form-label">界面主题<select value={preferences.theme} onChange={e => onPreferences({theme:e.target.value as Preferences['theme']})}><option value="light">纸白 · 日间</option><option value="sepia">暖笺 · 护眼</option><option value="dark">夜读 · 深色</option></select></label><h3>藏书分类</h3><div className="shelf-manager">{shelves.map(s => <div key={s.id}><input aria-label={`分类 ${s.name}`} defaultValue={s.name} maxLength={40} onBlur={e => { if (e.target.value.trim() && e.target.value !== s.name) void run(() => db.shelves.update(s.id,{name:e.target.value.trim(),updatedAt:Date.now()})); }}/><button className="text-button" onClick={() => void run(async () => { await db.transaction('rw',db.shelves,db.books,async () => {await db.shelves.update(s.id,{deletedAt:Date.now(),updatedAt:Date.now()});await db.books.where('shelfId').equals(s.id).modify({shelfId:undefined,updatedAt:Date.now()});}); })}>移除分类</button></div>)}</div><form className="inline-form" onSubmit={e => {e.preventDefault(); if (shelf.trim()) void run(async () => {await db.shelves.put({id:crypto.randomUUID(),name:shelf.trim(),updatedAt:Date.now()});setShelf('');});}}><input aria-label="新分类名称" maxLength={40} placeholder="新分类名称" value={shelf} onChange={e => setShelf(e.target.value)}/><button className="secondary">添加</button></form><h3>把故事妥善保管</h3><p className="muted">书籍与位置保存在当前设备。导出的备份包含小说原文和阅读数据，请存放在你信任的位置。浏览器清理网站数据会移除本地书库。</p><div className="button-row"><button className="secondary" onClick={() => void perform(async () => {download(await exportBackup(),`阅见完整备份-${new Date().toISOString().slice(0,10)}.json`);})}><Download size={16}/>导出完整备份</button><button className="secondary" onClick={() => restore.current?.click()}><Upload size={16}/>恢复备份</button></div><input className="visually-hidden" type="file" ref={restore} accept=".json" onChange={e => {const f=e.target.files?.[0];if(f)void perform(async()=>{await restoreBackup(f);notify('备份已恢复。');});e.target.value='';}}/><div className="info-note"><ShieldCheck size={20}/><p>阅见永久免费、开源。本地阅读无需账号；默认不上传小说。<a href="https://github.com/Asahi12-26/open-novel-reader" target="_blank" rel="noreferrer">查看源码与版本更新 ↗</a></p></div><small className="muted">Open Novel Reader {appVersion} · AGPL-3.0</small></div>}
    {tab === 'cloud' && <div className="settings-content"><AccountPanel onSignedOut={() => { clearAIKey(); setKeyReady(false); }}/></div>}
    {tab === 'ai' && <div className="settings-content">
      <div className="info-note"><KeyRound size={22}/><p>使用你自己的 DeepSeek API Key。密钥只留在本次会话内存，刷新、退出或切换账号后需重新输入，不会写入备份或云同步。</p></div>
      <p className="muted">先登录账号，再检查当前 Supabase 云代理。检查代理不会发送小说或访问 DeepSeek；仅载入密钥也不会启动分析。</p>
      <button className="secondary" disabled={working} onClick={() => void perform(async () => { setProxyNotice(''); await checkAIProxy(); setProxyNotice('代理检查通过，登录正常。本次检查未访问 DeepSeek。'); })}>检查代理（不调用模型）</button>
      {proxyNotice && <p className="auth-message" role="status">{proxyNotice}</p>}
      <form onSubmit={event => { event.preventDefault(); void perform(async () => { setAIKey(apiKey); setApiKey(''); setKeyReady(hasAIKey()); notify('API Key 已载入本次会话，不会自动发起分析。'); }); }}>
        <label className="form-label">DeepSeek API Key<input type="password" autoComplete="off" spellCheck={false} maxLength={256} placeholder={keyReady ? '已配置（仅当前会话）' : 'sk-…'} required disabled={working} value={apiKey} onChange={event => setApiKey(event.target.value)}/></label>
        <div className="button-row">
          <button className="secondary" type="submit" disabled={working}>载入密钥</button>
          <button className="secondary" type="button" disabled={!keyReady || working} onClick={() => void checkModels()}>测试连接（仅查询模型）</button>
          <button className="text-button" type="button" disabled={!keyReady || working} onClick={() => { clearAIKey(); setKeyReady(false); notify('会话密钥已清除。'); }}>清除密钥</button>
        </div>
      </form>
      <h3>由你决定每一次分析</h3>
      <p className="muted">阅读时打开「人物识别」，选择章节、查看费用估计、设置累计额度并授权开始。结果自动保存，可在正文纠正人物；中断后可从已完成进度继续，每次继续或重试都需重新授权。</p>
      <p className="muted">只有「授权并分析」会调用收费生成接口。选中对白、邻近上下文和已有名称会经 HTTPS 发送至当前 Supabase 代理，再转发给 DeepSeek。代理不保存密钥，不自动重试。估算按公开峰值价格预留，不能替代供应商账单。</p>
      <a className="inline-link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">在 DeepSeek 管理 API Key ↗</a>
    </div>}
  </Modal>;
}
