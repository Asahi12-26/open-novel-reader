import { useRef, useState } from 'react';
import { Download, HardDrive, LoaderCircle, Upload } from 'lucide-react';
import { exportZipBackup, restoreZipBackup, type BackupAccount } from '../core/library';
import { chooseBackupWriter, matchesBackupFile } from '../services/backup-file';
import './onboarding.css';

type RestoreMode = 'merge' | 'replace';

export default function DataBackupPanel({ backupAccount }: { backupAccount: () => BackupAccount }) {
  const [file, setFile] = useState<File>();
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [verified, setVerified] = useState(false);
  const [verifyDownload, setVerifyDownload] = useState<Blob>();
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const upload = useRef<HTMLInputElement>(null);
  const verifyUpload = useRef<HTMLInputElement>(null);
  const performing = useRef(false);
  const replaceAvailable = file?.name.toLowerCase().endsWith('.zip');

  function resetConfirmation() {
    setVerified(false);
    setVerifyDownload(undefined);
    setConfirmation('');
  }

  async function perform(task: () => Promise<void>) {
    if (performing.current) return;
    performing.current = true;
    setBusy(true);
    setNotice(undefined);
    try { await task(); }
    catch (error) { setNotice({ error: true, message: error instanceof Error ? error.message : '备份操作失败，请重试。' }); }
    finally { performing.current = false; setBusy(false); }
  }

  async function save(safety: boolean) {
    if (safety) resetConfirmation();
    const day = new Date().toISOString().slice(0, 10);
    const filename = `open-novel-reader-${safety ? 'safety-' : ''}backup-${day}.zip`;
    const account = backupAccount();
    const write = await chooseBackupWriter(filename);
    if (!write) return;
    const archive = await exportZipBackup(account);
    const result = await write(archive);
    if (result === 'cancelled') return;
    if (safety) {
      if (result === 'saved') setVerified(true);
      else setVerifyDownload(archive);
    }
    setNotice({ message: result === 'saved' ? '备份已保存。' : '已发起 ZIP 下载。请检查文件是否保存完整。' });
  }

  async function restore() {
    if (!file || (mode === 'replace' && (!replaceAvailable || !verified || confirmation !== '替换'))) return;
    await restoreZipBackup(file, { mode, account: backupAccount() });
    setFile(undefined);
    setMode('merge');
    resetConfirmation();
    setNotice({ message: '备份已恢复' });
  }

  return <div className="settings-content backup-panel">
    <div className="info-note"><HardDrive size={22} aria-hidden="true"/><div><h3>本机书库</h3><p>资料不会自动跨设备迁移。卸载应用、清除浏览器数据或设备损坏可能造成丢失。请定期备份，换设备前带走 ZIP。</p></div></div>
    <section className="backup-section" aria-labelledby="backup-export-title">
      <h3 id="backup-export-title">导出书库</h3>
      <p className="muted">完整备份包含书籍原文、阅读记录、书签、设置、人物和剧情资料。请把 ZIP 存到你信任的位置。</p>
      <button className="primary" type="button" disabled={busy} onClick={() => void perform(() => save(false))}><Download size={16}/>导出完整 ZIP</button>
    </section>
    <section className="backup-section" aria-labelledby="backup-restore-title">
      <h3 id="backup-restore-title">恢复书库</h3>
      <p className="muted">选择 ZIP 备份可合并或替换本机资料。旧版 JSON 备份也可合并。</p>
      <button className="secondary" type="button" disabled={busy} onClick={() => upload.current?.click()}><Upload size={16}/>选择备份文件</button>
      <input ref={upload} className="visually-hidden" type="file" accept=".zip,.json,application/zip,application/json" aria-label="恢复备份文件" disabled={busy} onChange={event => {
        setFile(event.target.files?.[0]); event.target.value = ''; setMode('merge'); resetConfirmation(); setNotice(undefined);
      }}/>
      {file && <div className="backup-restore-options">
        <p className="backup-filename">{file.name}</p>
        <fieldset disabled={busy}>
          <legend>恢复方式</legend>
          <label className="checkbox-row"><input type="radio" name="backup-mode" checked={mode === 'merge'} onChange={() => { setMode('merge'); resetConfirmation(); }}/>合并到本机书库</label>
          <label className="checkbox-row"><input type="radio" name="backup-mode" disabled={!replaceAvailable} checked={mode === 'replace'} onChange={() => { setMode('replace'); resetConfirmation(); }}/>替换本机书库</label>
        </fieldset>
        {mode === 'replace' && <div className="backup-replace">
          <p className="inline-warning">替换会移除本机未绑定账号的书库，再从 ZIP 恢复。请先保存当前书库的安全备份。</p>
          <button className="secondary" type="button" disabled={busy} onClick={() => void perform(() => save(true))}>保存安全备份 ZIP</button>
          {verifyDownload && <>
            <p className="muted">请选中刚下载的安全备份，以确认其内容完整。</p>
            <button className="secondary" type="button" disabled={busy} onClick={() => verifyUpload.current?.click()}>校验刚保存的安全备份</button>
            <input ref={verifyUpload} type="file" className="visually-hidden" accept=".zip,application/zip" aria-label="已保存的安全备份文件" disabled={busy} onChange={event => {
              const copy = event.target.files?.[0]; event.target.value = '';
              if (copy) void perform(async () => {
                if (!(await matchesBackupFile(copy, verifyDownload))) throw new Error('此文件与刚生成的安全备份不一致。请选择正确的 ZIP。');
                setVerified(true); setVerifyDownload(undefined); setNotice({ message: '安全备份已校验。' });
              });
            }}/>
          </>}
          {verified && <label className="form-label">输入「替换」以确认<input value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} autoComplete="off"/></label>}
        </div>}
        <button className={mode === 'replace' ? 'secondary' : 'primary'} type="button" onClick={() => void perform(restore)} disabled={busy || (mode === 'replace' && (!replaceAvailable || !verified || confirmation !== '替换'))}>
          {mode === 'replace' ? '确认替换并恢复' : '合并并恢复'}
        </button>
      </div>}
    </section>
    {busy && <p className="backup-progress" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true"/>正在处理备份…</p>}
    {notice && <p className={`auth-message ${notice.error ? 'is-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.message}</p>}
  </div>;
}
