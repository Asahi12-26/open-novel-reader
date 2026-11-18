import { BookOpen, HardDrive, KeyRound, Upload, X } from 'lucide-react';
import './onboarding.css';

export default function FirstRunGuide({ busy, onImport, onSample, onBackup, onAI, onDismiss }: {
  busy: boolean; onImport: () => void; onSample: () => void;
  onBackup: () => void; onAI: () => void; onDismiss: () => void;
}) {
  return <section className="first-run-guide" aria-labelledby="first-run-title">
    <header className="first-run-heading">
      <BookOpen size={22} aria-hidden="true"/>
      <div><h2 id="first-run-title">开始阅读</h2><p>导入 TXT 或 EPUB，或先读一篇原创短篇。书库保存在本机，断网也能读。</p></div>
      <button className="icon-button" type="button" aria-label="关闭起步引导" onClick={onDismiss}><X size={18}/></button>
    </header>
    <div className="button-row first-run-actions">
      <button className="primary" type="button" onClick={onImport} disabled={busy}><Upload size={16}/>导入小说并开始</button>
      <button className="secondary" type="button" onClick={onSample} disabled={busy}>直接开始离线阅读</button>
    </div>
    <p className="first-run-backup">书库不会自动随设备迁移。卸载、清除浏览器数据或设备损坏可能让本地资料丢失，建议定期导出备份。</p>
    <div className="first-run-options">
      <button className="text-button" type="button" onClick={onBackup}><HardDrive size={16}/>数据备份与恢复</button>
      <button className="text-button" type="button" onClick={onAI}><KeyRound size={16}/>按需配置 AI</button>
    </div>
  </section>;
}
