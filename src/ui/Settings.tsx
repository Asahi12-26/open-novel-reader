import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Preferences } from '../types';
import { db } from '../core/db';
import type { BackupAccount } from '../core/library';
import { clearAIKey } from '../services/ai';
import { Modal, run, useQuery } from './common';
import AccountPanel from './AccountPanel';
import AICredentialsPanel from './AICredentialsPanel';
import DataBackupPanel from './DataBackupPanel';
import { version as appVersion } from '../../package.json';

const tabs = [['general', '通用'], ['backup', '数据备份与恢复'], ['ai', 'AI 配置']] as const;
type SettingsTab = typeof tabs[number][0] | 'cloud';

export default function Settings({ preferences, onPreferences, onClose, backupAccount, online, readerOpen = false, initialTab = 'general' }: {
  preferences: Preferences; onPreferences: (p: Partial<Preferences>) => void; onClose: () => void;
  backupAccount: () => BackupAccount; online: boolean; readerOpen?: boolean; initialTab?: SettingsTab;
}) {
  const [selectedTab, setTab] = useState<SettingsTab>(initialTab);
  const tab = readerOpen ? 'ai' : selectedTab;
  const [shelfName, setShelfName] = useState('');
  const shelves = useQuery(() => db.shelves.filter(shelf => !shelf.deletedAt).toArray(), [], []);

  return <Modal title="你的阅读空间" onClose={onClose} wide>
    {!readerOpen && <nav className="settings-tabs" aria-label="设置分类">
      {tabs.map(([id, label]) => <button key={id} type="button" className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>}
    {tab === 'general' && <div className="settings-content">
      <h3>阅读偏好</h3>
      <label className="form-label">界面主题<select value={preferences.theme} onChange={event => onPreferences({ theme: event.target.value as Preferences['theme'] })}>
        <option value="light">纸白 · 日间</option><option value="sepia">暖笺 · 护眼</option><option value="dark">夜读 · 深色</option>
      </select></label>
      <h3>藏书分类</h3>
      <div className="shelf-manager">{shelves.map(shelf => <div key={shelf.id}>
        <input aria-label={`分类 ${shelf.name}`} defaultValue={shelf.name} maxLength={40} onBlur={event => {
          const name = event.target.value.trim();
          if (name && name !== shelf.name) void run(() => db.shelves.update(shelf.id, { name, updatedAt: Date.now() }));
        }}/>
        <button className="text-button" type="button" onClick={() => void run(async () => {
          await db.transaction('rw', db.shelves, db.books, async () => {
            await db.shelves.update(shelf.id, { deletedAt: Date.now(), updatedAt: Date.now() });
            await db.books.where('shelfId').equals(shelf.id).modify({ shelfId: undefined, updatedAt: Date.now() });
          });
        })}>移除分类</button>
      </div>)}</div>
      <form className="inline-form" onSubmit={event => {
        event.preventDefault();
        const name = shelfName.trim();
        if (name) void run(async () => { await db.shelves.put({ id: crypto.randomUUID(), name, updatedAt: Date.now() }); setShelfName(''); });
      }}>
        <input aria-label="新分类名称" maxLength={40} placeholder="新分类名称" value={shelfName} onChange={event => setShelfName(event.target.value)}/><button className="secondary" type="submit">添加</button>
      </form>
      <div className="info-note"><ShieldCheck size={20} aria-hidden="true"/><p>本机书库不会自动迁移到其他设备。请在「数据备份与恢复」定期导出 ZIP。 <a href="https://github.com/Asahi12-26/open-novel-reader" target="_blank" rel="noreferrer">源码与版本更新 ↗</a></p></div>
      <details className="settings-advanced">
        <summary>高级设置</summary>
        <button className="secondary" type="button" onClick={() => setTab('cloud')}>私有云同步</button>
      </details>
      <small className="muted">Open Novel Reader {appVersion} · AGPL-3.0</small>
    </div>}
    {tab === 'backup' && <DataBackupPanel backupAccount={backupAccount}/>}
    {tab === 'cloud' && <div className="settings-content"><AccountPanel onSignedOut={clearAIKey}/></div>}
    {tab === 'ai' && <AICredentialsPanel online={online}/>}
  </Modal>;
}
