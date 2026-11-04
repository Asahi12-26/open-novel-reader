import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { ArrowLeft, ArrowRight, Bookmark as BookmarkIcon, Check, ChevronLeft, ChevronRight, List, Settings2, Sparkles, Users, X } from 'lucide-react';
import { db } from '../core/db';
import { saveProgress } from '../core/library';
import type { Book, Bookmark, Chapter, Dialogue, Preferences, ReadingProgress } from '../types';
import { BookCover, Modal, notify, run, useQuery, useMotionPreference as useReducedMotion } from './common';
import { correctDialogue, createCharacter, mergeCharacters, renameCharacter } from '../services/ai';
import AnalysisPanel from './AnalysisPanel';

interface Props { book: Book; chapters: Chapter[]; progress?: ReadingProgress; fromOcean?: boolean; preferences: Preferences; onPreferences: (patch: Partial<Preferences>) => void; onClose: () => void }
function characterRect(element: HTMLElement, offset: number): DOMRect {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('.character-tag') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  let node: Node | null; let left = Math.max(0,offset);
  while ((node = walker.nextNode())) {
    const size = node.textContent?.length || 0;
    if (left < size) { const range=document.createRange();range.setStart(node,left);range.setEnd(node,Math.min(size,left+1));return range.getBoundingClientRect(); }
    left -= size;
  }
  return element.getBoundingClientRect();
}
function scrollToAnchor(root: HTMLElement, paragraph: HTMLElement, offset: number) {
  const rect = offset ? characterRect(paragraph,offset) : paragraph.getBoundingClientRect();
  root.scrollTop += rect.top-root.getBoundingClientRect().top-110;
}
export default function Reader({ book, chapters, progress, fromOcean = true, preferences, onPreferences, onClose }: Props) {
  const first = Math.max(0, chapters.findIndex(c => c.id === progress?.chapterId));
  const [index, setIndex] = useState(first);
  const [toc, setToc] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [bookmarkList, setBookmarkList] = useState(false);
  const [characterPanel, setCharacterPanel] = useState(false);
  const [selectedDialogue, setSelectedDialogue] = useState<Dialogue | null>(null);
  const [newName, setNewName] = useState('');
  const [position, setPosition] = useState(progress?.paragraphIndex ?? 0);
  const scroller = useRef<HTMLDivElement>(null);
  const target = useRef({ chapterId: chapters[first].id, paragraphIndex: progress?.paragraphIndex ?? 0, offset: progress?.offset ?? 0 });
  const latest = useRef(target.current);
  const restored = useRef(false);
  const navigation = useRef(0);
  const chapter = chapters[index];
  const reduced = useReducedMotion();
  const present = useIsPresent();
  const [coverPhase, setCoverPhase] = useState<'expand' | 'open' | 'settle' | 'done'>(reduced || !fromOcean ? 'done' : 'expand');
  const [mobileCover, setMobileCover] = useState(() => window.matchMedia('(max-width: 650px)').matches);
  const introMobile = useRef(mobileCover);
  const introComplete = useRef(!!reduced || !fromOcean);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 650px)');
    const changed = () => setMobileCover(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (reduced || !fromOcean) { introComplete.current = true; setCoverPhase('done'); return; }
    if (!present || introComplete.current) return;
    const open = setTimeout(() => setCoverPhase('open'), introMobile.current ? 260 : 360);
    const settle = setTimeout(() => setCoverPhase('settle'), introMobile.current ? 390 : 540);
    const done = setTimeout(() => { introComplete.current = true; setCoverPhase('done'); }, introMobile.current ? 540 : 720);
    return () => { clearTimeout(open); clearTimeout(settle); clearTimeout(done); };
  }, [reduced, present, fromOcean]);
  // Mobile keeps an invisible, measured central anchor for the shared return to
  // the shelf. The drawer cover stays static and never becomes an offscreen target.
  const centralCover = !reduced && fromOcean && (mobileCover || coverPhase === 'expand' || coverPhase === 'open');
  const marks = useQuery(() => db.bookmarks.where('bookId').equals(book.id).toArray(), [book.id], []);
  const characters = useQuery(() => db.characters.where('bookId').equals(book.id).toArray(), [book.id], []);
  const dialogues = useQuery(() => db.dialogues.where('chapterId').equals(chapter.id).toArray(), [chapter.id], []);
  const percentage = Math.round(((index + Math.min(1, (position + 1) / Math.max(1, chapter.paragraphs.length))) / chapters.length) * 100);
  useEffect(() => {
    const bodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const previous = document.activeElement as HTMLElement | null;
    const back = window.matchMedia('(max-width: 650px)').matches ? '.reader-toolbar [aria-label="返回书架"]' : '.reader-back';
    document.querySelector<HTMLButtonElement>(back)?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = bodyOverflow; previous?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false; let innerFrame = 0;
    const root = scroller.current;
    if (!root) return;
    restored.current = false;
    const restore = () => {
      if (disposed) return;
      const location = target.current.chapterId === chapter.id ? target.current : { paragraphIndex: 0, offset: 0 };
      const para = root.querySelector<HTMLElement>(`[data-paragraph="${Math.min(location.paragraphIndex, chapter.paragraphs.length - 1)}"]`);
      if (location.paragraphIndex === 0 && !location.offset) root.scrollTop = 0;
      else if (para) scrollToAnchor(root,para,location.offset);
      setPosition(location.paragraphIndex);
      latest.current = { chapterId: chapter.id, paragraphIndex: location.paragraphIndex, offset: location.offset };
      restored.current = true;
      void run(() => saveProgress(book.id,chapter.id,location.paragraphIndex,location.offset));
    };
    const frame = requestAnimationFrame(() => { innerFrame = requestAnimationFrame(restore); });
    const persist = () => { const p = latest.current; void run(() => saveProgress(book.id, p.chapterId, p.paragraphIndex, p.offset)); };
    const scroll = () => {
      if (!restored.current) return;
      const top = root.getBoundingClientRect().top + 115;
      const paragraphs = root.querySelectorAll<HTMLElement>('[data-paragraph]');
      let low=0,high=paragraphs.length-1;
      while(low<high){const mid=Math.ceil((low+high)/2);if(paragraphs[mid].getBoundingClientRect().top<=top)low=mid;else high=mid-1;}
      const visible=Math.max(0,low);const paragraph=paragraphs[visible];let offset=0;
      if(paragraph && paragraph.getBoundingClientRect().top<top){
        let start=0,end=Math.max(0,chapter.paragraphs[visible].length-1);
        while(start<end){const mid=Math.floor((start+end)/2);if(characterRect(paragraph,mid).top<top)start=mid+1;else end=mid;}
        offset=start;
      }
      latest.current = { chapterId: chapter.id, paragraphIndex: visible, offset }; setPosition(visible);
      clearTimeout(timer); timer = setTimeout(persist, 300);
    };
    root.addEventListener('scroll', scroll, { passive: true });
    const hide = () => { if (document.visibilityState !== 'visible') persist(); };
    window.addEventListener('pagehide', persist); document.addEventListener('visibilitychange', hide);
    return () => { disposed=true;cancelAnimationFrame(frame);cancelAnimationFrame(innerFrame);clearTimeout(timer);root.removeEventListener('scroll',scroll);window.removeEventListener('pagehide',persist);document.removeEventListener('visibilitychange',hide);if(restored.current)persist(); };
  }, [chapter.id, book.id]);
  // Keep the same paragraph visible after typography changes.
  useEffect(() => {
    if (!restored.current) return;
    const root = scroller.current; const p = root?.querySelector<HTMLElement>(`[data-paragraph="${latest.current.paragraphIndex}"]`);
    if (root && p && (latest.current.paragraphIndex > 0 || latest.current.offset > 0)) scrollToAnchor(root,p,latest.current.offset);
  }, [preferences.fontSize, preferences.lineHeight, preferences.readerWidth, preferences.fontFamily]);
  async function goChapter(next: number, paragraphIndex = 0) {
    if (!chapters[next]) return;
    const ticket = ++navigation.current;
    target.current = { chapterId: chapters[next].id, paragraphIndex, offset: 0 };
    latest.current = target.current;
    restored.current = false;
    // Commit the destination before showing it, including a reload immediately after navigation.
    try { await saveProgress(book.id,chapters[next].id,paragraphIndex,0); }
    catch { notify('阅读位置保存失败，请检查设备存储空间。'); }
    if (ticket !== navigation.current) return;
    if (next === index) { const root = scroller.current; const p = root?.querySelector<HTMLElement>(`[data-paragraph="${paragraphIndex}"]`); if (root && p) { if(paragraphIndex)scrollToAnchor(root,p,0);else root.scrollTop=0; } }
    else setIndex(next);
    if(next === index) restored.current = true;
    setToc(false); setBookmarkList(false);
  }
  const addBookmark = () => run(async () => {
    const p = latest.current.paragraphIndex;
    if (marks.some(m => m.chapterId === chapter.id && m.paragraphIndex === p)) { notify('这一段已经收藏在书签里。'); return; }
    const mark: Bookmark = { id: crypto.randomUUID(), bookId: book.id, chapterId: chapter.id, paragraphIndex: p, label: chapter.paragraphs[p]?.slice(0,70) || chapter.title, createdAt: Date.now() };
    await db.bookmarks.put(mark);
  }, '已为当前段落添加书签');
  function renderParagraph(text: string, p: number): ReactNode {
    if (!preferences.showCharacters) return text;
    const rows = dialogues.filter(d => d.paragraphIndex === p).sort((a,b) => a.start - b.start);
    if (!rows.length) return text;
    const parts: ReactNode[] = []; let end = 0;
    for (const d of rows) {
      if (d.start < end || text.slice(d.start,d.end) !== d.text) continue;
      parts.push(text.slice(end,d.start));
      parts.push(<span className="dialogue-text" key={d.id}>{text.slice(d.start,d.end)}<button className={`character-tag ${d.source === 'manual' ? 'manual' : ''}`} aria-label={`说话人物：${characters.find(c => c.id === d.characterId)?.name || '未知'}，点击纠正`} onClick={() => setSelectedDialogue(d)}>{characters.find(c => c.id === d.characterId)?.name || '未知'}{d.source === 'manual' && <Check size={9}/>}</button></span>); end = d.end;
    }
    parts.push(text.slice(end)); return parts;
  }
  const close = () => { const p = latest.current; void run(() => saveProgress(book.id,p.chapterId,p.paragraphIndex,p.offset)); onClose(); };
  return <motion.section layoutRoot className="reader ocean-reader" data-cover-phase={coverPhase} role="dialog" aria-modal="true" aria-label={`阅读 ${book.title}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : present ? .22 : .48 }}>
    {centralCover && <div className="reader-cover-flight" aria-hidden="true"><motion.div className="reader-cover-tilt" animate={{ opacity: !mobileCover || coverPhase === 'expand' || coverPhase === 'open' || !present ? 1 : 0 }} transition={{ duration: .18 }}><span className="reader-cover-pages"/><motion.div className="reader-cover-front" initial={{ rotateY: 0 }} animate={{ rotateY: present && coverPhase === 'open' ? -28 : 0 }} transition={{ duration: .22 }}><BookCover book={book} duration={present ? mobileCover ? .26 : .36 : .46}/></motion.div></motion.div></div>}
    <aside className={`reader-sidebar ${toc ? 'is-open' : ''}`}><button className="reader-back" onClick={close}><ArrowLeft size={18}/>回到书架</button><div className="reader-book"><BookCover key={centralCover ? 'static-cover' : 'shared-cover'} book={book} shared={fromOcean && !centralCover} className={coverPhase === 'expand' || coverPhase === 'open' ? 'reader-cover-placeholder' : ''} duration={coverPhase === 'settle' ? .18 : .46}/><h2>{book.title}</h2><p>{book.author || '佚名'}</p></div><div className="toc-heading"><h3>目录</h3><span>{chapters.length} 章</span><button className="icon-button mobile-only" aria-label="关闭目录" onClick={() => setToc(false)}><X size={18}/></button></div><nav className="toc-list">{chapters.map((c,i) => <button key={c.id} className={i === index ? 'active' : ''} onClick={() => goChapter(i)}><span>{String(i+1).padStart(2,'0')}</span>{c.title}{i === index && <i/>}</button>)}</nav><div className="reader-sidebar-note"><span className="status-dot"/>离线可用 · 位置自动保存</div></aside>
    {toc && <button className="toc-scrim" aria-label="收起目录" onClick={() => setToc(false)}/>}
    <div className="reader-main"><header className="reader-toolbar"><div className="reader-toolbar-left"><button className="icon-button mobile-only" aria-label="返回书架" onClick={close}><ArrowLeft size={20}/></button><button className="icon-button mobile-only" aria-label="展开目录" onClick={() => setToc(true)}><List size={20}/></button><span>{book.title}</span></div><div className="reader-tools"><button className="icon-button" title="添加书签" aria-label="添加当前段落书签" onClick={() => void addBookmark()}><BookmarkIcon size={18}/></button><button className="icon-button" title="全部书签" aria-label="查看全部书签" onClick={() => setBookmarkList(true)}><List size={18}/></button><button className="icon-button" title="人物管理" aria-label="人物管理" onClick={() => setCharacterPanel(true)}><Users size={18}/></button><button className="ai-toolbar" onClick={() => setAnalysis(true)}><Sparkles size={16}/><span>人物识别</span></button><button className={`icon-button ${appearance ? 'active' : ''}`} aria-label="阅读排版设置" onClick={() => setAppearance(!appearance)}><Settings2 size={20}/></button></div></header>
      {appearance && <div className="appearance-panel"><div className="panel-title">让文字，适合你的眼睛<button className="icon-button" aria-label="关闭排版设置" onClick={() => setAppearance(false)}><X size={17}/></button></div><label>字号 <span>{preferences.fontSize}px</span><input aria-label="字号" type="range" min="14" max="36" value={preferences.fontSize} onChange={e => onPreferences({fontSize:Number(e.target.value)})}/></label><label>行距 <span>{preferences.lineHeight.toFixed(1)}</span><input aria-label="行距" type="range" min="1.3" max="2.6" step="0.1" value={preferences.lineHeight} onChange={e => onPreferences({lineHeight:Number(e.target.value)})}/></label><label>页宽 <span>{preferences.readerWidth}px</span><input aria-label="页宽" type="range" min="420" max="1000" step="20" value={preferences.readerWidth} onChange={e => onPreferences({readerWidth:Number(e.target.value)})}/></label><label>字体<select aria-label="字体" value={preferences.fontFamily} onChange={e => onPreferences({fontFamily:e.target.value as Preferences['fontFamily']})}><option value="serif">宋体 / Georgia</option><option value="sans">黑体 / Sans serif</option></select></label><div className="theme-choices">{(['light','sepia','dark'] as const).map((t,i) => <button key={t} className={`theme-chip ${t} ${preferences.theme === t ? 'chosen' : ''}`} onClick={() => onPreferences({theme:t})}>{['纸白','暖笺','夜读'][i]}{preferences.theme === t && <Check size={13}/>}</button>)}</div><label className="checkbox-row"><input type="checkbox" checked={preferences.showCharacters} onChange={e => onPreferences({showCharacters:e.target.checked})}/>显示对白人物标签</label></div>}
      <div ref={scroller} className="reader-scroller" tabIndex={0} aria-label="小说正文"><article className={`reader-article ${preferences.fontFamily}`} style={{'--reader-font-size':`${preferences.fontSize}px`,'--reader-line-height':preferences.lineHeight,'--reader-width':`${preferences.readerWidth}px`} as CSSProperties} lang={book.language || 'zh'}><div className="chapter-eyebrow">CHAPTER {String(index+1).padStart(2,'0')} <span/> {book.format.toUpperCase()}</div><h1>{chapter.title}</h1><div className="chapter-ornament">✦</div>{chapter.paragraphs.map((p,i) => <p key={`${chapter.id}:${i}`} data-paragraph={i} id={`para-${i}`}>{renderParagraph(p,i)}</p>)}<div className="chapter-end"><span>· · ·</span><p>{index === chapters.length-1 ? '故事暂告一段落，生活仍在继续。' : '下一页，还有新的故事。'}</p><button className="secondary" onClick={() => index < chapters.length-1 ? goChapter(index+1) : close()}>{index < chapters.length-1 ? '阅读下一章' : '回到书架'}<ArrowRight size={16}/></button></div></article></div>
      <footer className="reader-footer"><button disabled={index === 0} onClick={() => goChapter(index-1)} aria-label="上一章"><ChevronLeft size={17}/><span>上一章</span></button><span className="reader-position">{chapter.title}<small>{index+1} / {chapters.length} 章 · {percentage}%</small></span><button disabled={index === chapters.length-1} onClick={() => goChapter(index+1)} aria-label="下一章"><span>下一章</span><ChevronRight size={17}/></button></footer><div className="reader-progress"><i style={{width:`${percentage}%`}}/></div>
    </div>
    {bookmarkList && <Modal title="故事里的停靠点" onClose={() => setBookmarkList(false)}>{marks.length ? <div className="bookmark-list">{marks.map(m => <div key={m.id}><button onClick={() => goChapter(chapters.findIndex(c => c.id === m.chapterId),m.paragraphIndex)}><small>{chapters.find(c => c.id === m.chapterId)?.title}</small>{m.label}</button><button className="icon-button" aria-label="删除书签" onClick={() => void run(() => db.bookmarks.delete(m.id))}><X size={17}/></button></div>)}</div> : <div className="modal-empty"><BookmarkIcon size={30}/><p>读到喜欢的段落，就为它留一个书签。</p></div>}</Modal>}
    {analysis && <AnalysisPanel chapter={chapter} onClose={() => setAnalysis(false)}/>}
    {selectedDialogue && <Modal title="这一句，是谁说的？" onClose={() => setSelectedDialogue(null)}><blockquote className="dialogue-quote">{selectedDialogue.text}</blockquote><p className="muted">人工纠正会优先保留，不会被后续 AI 分析覆盖。</p><div className="character-choices"><button onClick={() => void run(async () => { await correctDialogue(selectedDialogue.id,null); setSelectedDialogue(null); })}>未知人物</button>{characters.map(c => <button key={c.id} onClick={() => void run(async () => { await correctDialogue(selectedDialogue.id,c.id); setSelectedDialogue(null); })}>{c.name}</button>)}</div><form className="inline-form" onSubmit={e => { e.preventDefault(); if (!newName.trim()) return; void run(async () => { const c = await createCharacter(book.id,newName); await correctDialogue(selectedDialogue.id,c.id); setNewName(''); setSelectedDialogue(null); }); }}><input aria-label="新人物名称" value={newName} onChange={e => setNewName(e.target.value)} maxLength={80} placeholder="或新建人物"/><button className="secondary" type="submit">新建并指定</button></form></Modal>}
    {characterPanel && <Modal title="书中的人物" onClose={() => setCharacterPanel(false)}><p className="muted">人物信息仅显示名称与别名，避免提前透露故事。</p>{characters.length ? <div className="character-manager">{characters.map(c => <div key={c.id}><input aria-label={`人物 ${c.name} 名称`} defaultValue={c.name} maxLength={80} onBlur={e => { if (e.target.value.trim() && e.target.value !== c.name) void run(() => renameCharacter(c.id,e.target.value)); }}/><small>{c.aliases.join('、') || '暂无别名'}</small><select aria-label={`合并 ${c.name}`} value="" onChange={e => { if (e.target.value) void run(() => mergeCharacters(c.id,e.target.value), '人物已合并，原名保留为别名'); }}><option value="">合并到…</option>{characters.filter(other => other.id !== c.id).map(other => <option key={other.id} value={other.id}>{other.name}</option>)}</select></div>)}</div> : <div className="modal-empty"><Users size={30}/><p>使用章节人物识别，或手动添加第一位人物。</p></div>}<form className="inline-form" onSubmit={e => {e.preventDefault(); if (newName.trim()) void run(async () => {await createCharacter(book.id,newName);setNewName('');});}}><input aria-label="添加人物名称" placeholder="人物名称" maxLength={80} value={newName} onChange={e => setNewName(e.target.value)}/><button className="secondary">添加人物</button></form></Modal>}
  </motion.section>;
}
