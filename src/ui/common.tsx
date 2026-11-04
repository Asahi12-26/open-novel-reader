import { useEffect, useRef, useState } from 'react';
import type { DependencyList, ReactNode } from 'react';
import { liveQuery } from 'dexie';
import { motion } from 'motion/react';
import { X } from 'lucide-react';
import type { Book } from '../types';

// Motion's hook reads the initial setting; the entire transition must also
// respond when the system preference changes while this page is open.
export function useMotionPreference() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(media.matches);
    changed(); media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return reduced;
}

export function notify(message: string) { window.dispatchEvent(new CustomEvent('reader-notice', { detail: message })); }
export function useQuery<T>(query: () => Promise<T>, deps: DependencyList, initial: T): T {
  const [value, setValue] = useState(initial);
  useEffect(() => { const sub = liveQuery(query).subscribe({ next: setValue, error: (e: unknown) => notify(e instanceof Error ? e.message : '本地存储读取失败') }); return () => sub.unsubscribe(); }, deps); // explicit dependencies are supplied by caller
  return value;
}
export async function run(action: () => Promise<unknown>, success?: string) {
  try { await action(); if (success) notify(success); } catch (e) { notify(e instanceof Error ? e.message : '操作失败，请重试'); }
}
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>('button,input,select')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); }
      if (e.key === 'Tab') {
        const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,a[href],[tabindex="0"]') ?? [])].filter(n => n.getClientRects().length);
        if (!items.length) return;
        if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
      }
    };
    document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); before?.focus({ preventScroll: true }); };
  }, []);
  return <div className="modal-backdrop" onClick={onClose}><div ref={root} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={20}/></button></header>{children}</div></div>;
}
export function BookCover({ book, shared = true, className = '', duration = .38 }: { book: Book; shared?: boolean; className?: string; duration?: number }) {
  const reduced = useMotionPreference();
  const id = book.id.replace(/[^a-zA-Z0-9]/g, '');
  return <motion.div layout layoutId={shared ? `cover-${book.id}` : undefined} transition={{ duration: reduced ? 0 : duration, ease: [.22, 1, .36, 1] }} className={`book-cover ${className}`} style={{ background: book.coverColor || '#3d5750' }}>
    {book.cover ? <img src={book.cover} alt={`${book.title}封面`} loading="lazy"/> : <>
      <div className="cover-edition">阅 见 藏 书 · READER'S EDITION</div>
      <h3>{book.title}</h3><span className="cover-author">{book.author || '佚名'}</span>
      <svg className="cover-landscape" viewBox="0 0 200 180" aria-hidden="true"><defs><linearGradient id={`g${id}`} x2="0" y2="1"><stop stopColor="#edd9ae"/><stop offset="1" stopColor="#b4bd9a"/></linearGradient></defs><path d="M27 166V79a73 73 0 01146 0v87Z" fill={`url(#g${id})`} opacity=".95"/><circle cx="129" cy="58" r="19" fill="#fff4d3"/><path d="M27 128l48-43 33 35 26-19 39 25v40H27Z" fill="#7f9685"/><path d="M27 154l56-36 44 26 46-15v37H27Z" fill="#354f48"/><path d="M92 166l24-31-8-16 11-9" stroke="#eddcbb" strokeWidth="3" fill="none" opacity=".75"/></svg>
      <span className="cover-footer">OPEN NOVEL READER</span></>}
    <span className="cover-spine"/>
  </motion.div>;
}
