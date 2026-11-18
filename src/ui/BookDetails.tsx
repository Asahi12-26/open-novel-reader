import { useEffect, useRef, useState } from 'react';
import { BookOpen, Cloud, ImagePlus, Trash2 } from 'lucide-react';
import type { Book } from '../types';
import { db } from '../core/db';
import { deleteBook } from '../core/library';
import { setBookCloud } from '../services/cloud';
import { BookCover, Modal, notify, run, useQuery } from './common';

const editableFields = [
  ['title', '书名'], ['author', '作者'], ['cover', '封面'], ['shelfId', '藏书分类'],
] as const;

export default function BookDetails({ book, onClose, onRead }: { book: Book; onClose: () => void; onRead: () => void }) {
  const [draft, setDraft] = useState(book);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [changingConsent, setChangingConsent] = useState(false);
  const initial = useRef(book);
  const active = useRef(false);
  const cover = useRef<HTMLInputElement>(null);
  const shelves = useQuery(() => db.shelves.filter(shelf => !shelf.deletedAt).toArray(), [], []);
  const uploadEnabled = useQuery(async () => (await db.books.get(book.id))?.cloudEnabled ?? false, [book.id], book.cloudEnabled);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  function save() {
    return run(async () => {
      await db.transaction('rw', db.books, async () => {
        const current = await db.books.get(book.id);
        if (!active.current || !current || current.deletedAt || current.createdAt !== initial.current.createdAt ||
            current.restoredAt !== initial.current.restoredAt) throw new Error('书籍状态已变化，请关闭详情后重试。');
        const patch: Partial<Pick<Book, 'title' | 'author' | 'cover' | 'shelfId'>> = {};
        for (const [field, label] of editableFields) {
          if (draft[field] === initial.current[field] || draft[field] === current[field]) continue;
          if (current[field] !== initial.current[field]) throw new Error(`${label}刚刚更新，本机与同步版本均已保留。请重新打开详情后核对。`);
          Object.assign(patch, { [field]: draft[field] });
        }
        if (Object.keys(patch).length) await db.books.update(book.id, { ...patch, updatedAt: Math.max(Date.now(), current.updatedAt + 1) });
      });
      onClose();
    }, '书籍信息已保存');
  }

  async function changeConsent(enabled: boolean) {
    setChangingConsent(true);
    await run(() => setBookCloud(book.id, enabled), enabled ? '上传选择已保存，请在设置中同步。' : '已停止后续同步。');
    setChangingConsent(false);
  }

  return <Modal title="藏书详情" onClose={onClose}>
    <div className="book-details-top">
      <BookCover book={draft} shared={false}/>
      <div>
        <span className="eyebrow">YOUR READER'S EDITION</span>
        <h2>{draft.title}</h2>
        <p>{book.chapterCount} 章 · {book.totalWords.toLocaleString()} 字 / 词</p>
        <small>{book.format.toUpperCase()} · 本地保存</small>
        <button className="text-button" onClick={() => cover.current?.click()}><ImagePlus size={16}/>更换封面</button>
      </div>
    </div>
    <input className="visually-hidden" ref={cover} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 3 * 1024 * 1024) {
        notify('请选择不超过 3 MiB 的 PNG、JPG 或 WebP 图片。');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => setDraft(current => ({ ...current, cover: String(reader.result) }));
      reader.readAsDataURL(file);
    }}/>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="form-label">书名<input required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
      <label className="form-label">作者<input maxLength={120} value={draft.author} onChange={event => setDraft({ ...draft, author: event.target.value })}/></label>
      <label className="form-label">藏书分类<select value={draft.shelfId || ''} onChange={event => setDraft({ ...draft, shelfId: event.target.value || undefined })}>
        <option value="">未分类</option>{shelves.map(shelf => <option key={shelf.id} value={shelf.id}>{shelf.name}</option>)}
      </select></label>
      <div className="cloud-consent">
        <Cloud size={20}/>
        <label className="checkbox-row">
          <input type="checkbox" checked={uploadEnabled} disabled={changingConsent} onChange={event => void changeConsent(event.currentTarget.checked)}/>
          允许上传这本书的原文和阅读数据
        </label>
        <p>开启需要联网并登录获准账号。原文件上限为 50 MiB，完整云端资料上限为 30 MiB。本机阅读随时可用。</p>
        <p>取消后停止后续同步，已上传的副本仍留在私有云。如需同步删除，请保持勾选后移除本书。</p>
      </div>
      <div className="button-row">
        <button className="primary" type="button" onClick={onRead}><BookOpen size={16}/>开始阅读</button>
        <button className="secondary" type="submit">保存修改</button>
      </div>
    </form>
    <div className="danger-zone">{confirmDelete ? <>
      <p>将从书架移除本书。已选择同步的书会在下次同步时传播删除标记。原文件仍可重新导入。</p>
      <button className="danger-button" onClick={() => void run(async () => { await deleteBook(book.id); onClose(); }, '已从书架移除')}>确认移除</button>
      <button className="text-button" onClick={() => setConfirmDelete(false)}>取消</button>
    </> : <button className="text-button danger" onClick={() => setConfirmDelete(true)}><Trash2 size={15}/>从书架移除</button>}</div>
  </Modal>;
}
