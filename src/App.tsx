import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup } from 'motion/react';
import { ArrowDownToLine, ArrowRight, BookOpen, Bookmark as BookmarkIcon, Check, CloudOff, Folder, Library, LoaderCircle, Moon, Plus, Search, Settings as SettingsIcon, Sparkles, Sun, Upload, X } from 'lucide-react';
import { db } from './core/db';
import { addSampleBook, importBook, listChapters, exportBackup, restoreBackup } from './core/library';
import type { Book, Chapter, Preferences, ReadingProgress } from './types';
import { defaultPreferences } from './types';
import { download, notify, run, useQuery, useMotionPreference as useReducedMotion } from './ui/common';
import Reader from './ui/Reader';
import Settings from './ui/Settings';
import BookDetails from './ui/BookDetails';
import BookOcean from './ui/BookOcean';
import './ui/ocean-shell.css';
import { startAutoSync } from './services/cloud';

type OpenBook = { book: Book; chapters: Chapter[]; progress?: ReadingProgress; fromOcean: boolean };
export default function App() {
  const books = useQuery(() => db.books.filter(b => !b.deletedAt).toArray(), [], []);
  const shelves = useQuery(() => db.shelves.filter(s => !s.deletedAt).toArray(), [], []);
  const progress = useQuery(() => db.progress.toArray(), [], []);
  const bookmarks = useQuery(() => db.bookmarks.toArray(), [], []);
  const percentages = useQuery(async () => {
    const rows = await db.progress.toArray();
    return Promise.all(rows.map(async p => { const c=await db.chapters.get(p.chapterId); const book=await db.books.get(p.bookId);return {bookId:p.bookId,value:c&&book?Math.round((c.index+(p.paragraphIndex+1)/Math.max(1,c.paragraphs.length))/book.chapterCount*100):0}; }));
  }, [], []);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [active, setActive] = useState<OpenBook | null>(null);
  const [transitionBookId, setTransitionBookId] = useState<string | null>(null);
  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null);
  const opening = useRef(false);
  const shelfPosition = useRef(0);
  const shelfTrigger = useRef<HTMLElement | null>(null);
  const activeRef = useRef(false);
  const [settings, setSettings] = useState(false);
  const [details, setDetails] = useState<Book | null>(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [toast, setToast] = useState('');
  const [newShelf, setNewShelf] = useState(false);
  const [shelfName, setShelfName] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const reduced = useReducedMotion();
  const savedPrefs = useQuery(() => db.settings.get('preferences'), [], undefined);
  useEffect(() => { if (savedPrefs?.value) setPreferences({ ...defaultPreferences, ...(savedPrefs.value as Partial<Preferences>) }); }, [savedPrefs]);
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);
  useEffect(() => {
    const notice = (e: Event) => setToast((e as CustomEvent<string>).detail);
    const network = () => setOnline(navigator.onLine);
    const refresh = (e: Event) => setUpdate(() => (e as CustomEvent<() => Promise<void>>).detail);
    window.addEventListener('reader-notice', notice); window.addEventListener('online', network); window.addEventListener('offline', network); window.addEventListener('reader-update', refresh);
    void navigator.storage?.persist?.().catch(() => false);
    void db.settings.get('readerSession').then(async value => {
      if (typeof value?.value === 'string') {
        const book = await db.books.get(value.value); if (book && !book.deletedAt) await openBook(book);
      }
    }).catch(() => notify('未能恢复上次阅读，可从书架重新打开。'));
    return () => { window.removeEventListener('reader-notice', notice); window.removeEventListener('online', network); window.removeEventListener('offline', network); window.removeEventListener('reader-update', refresh); };
  }, []);
  useEffect(() => startAutoSync(), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6000); return () => clearTimeout(timer); }, [toast]);
  const changePreferences = (patch: Partial<Preferences>) => {
    const next = { ...preferences, ...patch }; setPreferences(next); void run(() => db.settings.put({ id: 'preferences', value: next }));
  };
  // Preserve order and geometry: reading progress must not move the source
  // cover to the front before its return flight.
  useEffect(() => { setFrozenOrder(null); }, [filter, query, sort]);
  async function openBook(book: Book) {
    if (opening.current || activeRef.current) return;
    opening.current = true;
    shelfPosition.current = window.scrollY;
    shelfTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const source = document.querySelector<HTMLElement>(`.ocean-book-slot[data-book-id="${CSS.escape(book.id)}"] .book-cover`);
    const sourceRect = source?.getBoundingClientRect();
    const fromOcean = !!sourceRect && sourceRect.bottom > 0 && sourceRect.top < window.innerHeight && sourceRect.right > 0 && sourceRect.left < window.innerWidth;
    setFrozenOrder(visible.map(b => b.id));
    setTransitionBookId(book.id);
    try {
      const [chapters, current] = await Promise.all([listChapters(book.id), db.progress.get(book.id)]);
      if (!chapters.length) throw new Error('这本书没有可阅读的章节，请重新导入原文件。');
      if (!reduced && fromOcean) await new Promise(resolve => setTimeout(resolve, 140));
      activeRef.current = true;
      setActive({ book, chapters, progress: current, fromOcean });
      void db.settings.put({ id: 'readerSession', value: book.id }).catch(() => notify('本次阅读可继续，但未能保存重启后的自动打开状态。'));
    } catch (e) {
      setTransitionBookId(null);
      requestAnimationFrame(() => { if (shelfTrigger.current?.isConnected) shelfTrigger.current.focus({ preventScroll: true }); });
      notify(e instanceof Error ? e.message : '无法打开这本书');
    } finally { opening.current = false; }
  }
  function closeReader() {
    setActive(null);
    void run(() => db.settings.delete('readerSession'));
  }
  function finishReturn() {
    activeRef.current = false;
    setTransitionBookId(null);
    requestAnimationFrame(() => {
      window.scrollTo({ top: shelfPosition.current, behavior: 'instant' });
      if (shelfTrigger.current?.isConnected) shelfTrigger.current.focus({ preventScroll: true });
    });
  }
  async function importFiles(files: FileList | File[]) {
    setBusy(true); let count = 0;
    for (const file of Array.from(files)) {
      try { await importBook(file); count++; } catch (e) { notify(`${file.name}：${e instanceof Error ? e.message : '导入失败'}`); }
    }
    setBusy(false); if (count) notify(`已保存 ${count} 本书到本机，离线也能读。`);
  }
  const pmap = new Map(progress.map(p => [p.bookId, p]));
  const recent = books.filter(b => pmap.has(b.id)).sort((a, b) => (pmap.get(b.id)?.updatedAt ?? 0) - (pmap.get(a.id)?.updatedAt ?? 0));
  const last = recent[0];
  const sorted = books.filter(b => (!query || `${b.title} ${b.author}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (filter === 'all' || (filter === 'recent' ? pmap.has(b.id) : filter === 'bookmarks' ? bookmarks.some(m => m.bookId === b.id) : b.shelfId === filter))).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : sort === 'added' ? b.createdAt - a.createdAt : (pmap.get(b.id)?.updatedAt ?? b.createdAt) - (pmap.get(a.id)?.updatedAt ?? a.createdAt));
  const frozenIndices = new Map(frozenOrder?.map((id, index) => [id, index]));
  const visible = frozenOrder ? [...sorted].sort((a, b) => (frozenIndices.get(a.id) ?? Infinity) - (frozenIndices.get(b.id) ?? Infinity)) : sorted;
  const oceanProgress = Object.fromEntries(percentages.map(p => [p.bookId, p.value]));
  const heading = filter === 'all' ? '我的书海' : filter === 'recent' ? '最近阅读' : filter === 'bookmarks' ? '我的书签' : shelves.find(s => s.id === filter)?.name || '我的书架';
  return <LayoutGroup><div className="app-shell" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }} onDrop={e => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files); }}>
    <div className={`library-shell ocean-library ${active ? 'behind-reader' : ''}`} inert={!!transitionBookId}>
      <aside className="sidebar">
        <a className="brand" href="#" onClick={e => { e.preventDefault(); setFilter('all'); }}><span className="brand-mark"><BookOpen size={26} strokeWidth={1.5}/></span><span>阅见<small>OPEN NOVEL READER</small></span></a>
        <div className="sidebar-label">你的阅读空间</div>
        <nav className="main-nav"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}><Library size={19}/>我的书架<span>{books.length}</span></button><button className={filter === 'recent' ? 'selected' : ''} onClick={() => setFilter('recent')}><BookOpen size={19}/>最近阅读</button><button className={filter === 'bookmarks' ? 'selected' : ''} onClick={() => setFilter('bookmarks')}><BookmarkIcon size={19}/>我的书签<span>{bookmarks.length || ''}</span></button></nav>
        <div className="sidebar-label shelf-label">藏书分类<button className="icon-button" aria-label="添加分类" onClick={() => setNewShelf(!newShelf)}><Plus size={16}/></button></div>
        <nav className="shelf-nav">{shelves.map(s => <button key={s.id} className={filter === s.id ? 'selected' : ''} onClick={() => setFilter(s.id)}><span className="shelf-dot"/>{s.name}<span>{books.filter(b => b.shelfId === s.id).length}</span></button>)}</nav>
        {newShelf && <form className="shelf-form" onSubmit={e => { e.preventDefault(); if (!shelfName.trim()) return; void run(async () => { await db.shelves.put({ id: crypto.randomUUID(), name: shelfName.trim(), updatedAt: Date.now() }); setShelfName(''); setNewShelf(false); }); }}><input aria-label="分类名称" value={shelfName} onChange={e => setShelfName(e.target.value)} placeholder="给新分类起个名字" maxLength={40} autoFocus/><button aria-label="保存分类"><Check size={16}/></button></form>}
        {!shelves.length && !newShelf && <p className="sidebar-hint">给喜欢的故事，<br/>一个专属的位置。</p>}
        <div className="sidebar-bottom"><div className="local-status">{online ? <Check size={14}/> : <CloudOff size={14}/>} {online ? '本地优先 · 随时可读' : '已离线 · 阅读不受影响'}</div><button className="settings-nav" onClick={() => setSettings(true)}><SettingsIcon size={19}/>设置与云同步</button><div className="sidebar-foot">一个人，一本书，一整个世界。<small>FREE & OPEN SOURCE · BETA 0.1</small></div></div>
      </aside>
      <main className="library-main">
        <header className="topbar"><span className="breadcrumb">我的文学馆 <span>/</span> {heading}</span><div className="topbar-actions"><span className="device-badge"><span/>本机书库</span><button className="icon-button" aria-label="切换深浅主题" onClick={() => changePreferences({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>{preferences.theme === 'dark' ? <Sun size={20}/> : <Moon size={20}/>}</button><button className="avatar" aria-label="账号与同步设置" onClick={() => setSettings(true)}>阅</button></div></header>
        <div className="library-content"><section className="welcome ocean-welcome"><div><div className="eyebrow">A SEA OF STORIES, A WORLD WITHIN</div><h1>让故事，汇成一片海<span>。</span></h1><p>随书页起伏，在文字深处停泊。</p><div className="ocean-continue-slot">{last ? <button className="ocean-continue" onClick={() => void openBook(last)}><BookOpen size={15}/><span>继续阅读 · {last.title}</span><ArrowRight size={15}/></button> : <span className="ocean-continue-note">藏书在本机，故事随身行。</span>}</div></div><button className="primary" onClick={() => fileInput.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18}/> : <Plus size={19}/>} {busy ? '正在导入' : '导入书籍'}</button></section>
          <section className="collection"><div className="collection-toolbar"><div className="collection-heading"><h2>{heading}</h2><span>{visible.length} 本藏书</span></div><div className="collection-tools"><label className="search"><Search size={17}/><input aria-label="搜索书名或作者" placeholder="搜索书名、作者…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={14}/></button>}</label><select aria-label="排序方式" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近阅读</option><option value="added">最近添加</option><option value="title">书名排序</option></select></div></div>
            <div className="filter-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部书籍</button><button className={filter === 'recent' ? 'active' : ''} onClick={() => setFilter('recent')}>正在阅读 <span>{recent.length}</span></button>{shelves.map(s => <button key={s.id} className={filter === s.id ? 'active' : ''} onClick={() => setFilter(s.id)}>{s.name}</button>)}</div>
            {visible.length ? <BookOcean books={visible} progress={oceanProgress} readingIds={new Set(pmap.keys())} selectedId={transitionBookId} paused={!!transitionBookId || settings || !!details} onOpen={openBook} onDetails={setDetails} onImport={() => fileInput.current?.click()}/> : <div className="empty-library"><div className="empty-symbol"><BookOpen size={32} strokeWidth={1.2}/><span>✦</span></div><h3>{books.length ? '这里还没有故事' : '好故事，值得被珍藏'}</h3><p>{query ? '换一个书名或作者试试。' : '从电脑或手机导入小说，建立只属于你的书架。'}</p><div className="empty-actions"><button className="secondary" onClick={() => fileInput.current?.click()}><Upload size={16}/>导入 TXT / EPUB</button>{!books.length && <button className="text-button" onClick={() => void run(async () => { const b = await addSampleBook(); await openBook(b); })}>先读一段原创短篇 <ArrowRight size={15}/></button>}</div></div>}
          </section><footer className="library-footer"><span>你的书，留在你的设备里。云同步由你选择。</span><button onClick={() => void run(async () => download(await exportBackup(), `阅见备份-${new Date().toISOString().slice(0,10)}.json`))}><ArrowDownToLine size={14}/>导出备份</button><button onClick={() => restoreInput.current?.click()}>恢复备份</button></footer>
        </div>
      </main><nav className="mobile-nav"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><Library size={20}/>书架</button><button className={filter === 'recent' ? 'active' : ''} onClick={() => setFilter('recent')}><BookOpen size={20}/>最近</button><button onClick={() => fileInput.current?.click()}><Plus size={23}/>导入</button><button onClick={() => { setNewShelf(true); setSettings(true); }}><Folder size={20}/>分类</button><button onClick={() => setSettings(true)}><SettingsIcon size={20}/>设置</button></nav>
    </div>
    <input ref={fileInput} className="visually-hidden" type="file" multiple accept=".txt,.epub,text/plain,application/epub+zip" aria-label="导入小说文件" onChange={e => { if (e.target.files) void importFiles(e.target.files); e.target.value = ''; }}/><input ref={restoreInput} className="visually-hidden" type="file" accept=".json" aria-label="恢复备份文件" onChange={e => { const f = e.target.files?.[0]; if (f) void run(() => restoreBackup(f), '备份已恢复'); e.target.value = ''; }}/>
    <AnimatePresence onExitComplete={finishReturn}>{active && <Reader key={active.book.id} {...active} preferences={preferences} onPreferences={changePreferences} onClose={closeReader}/>}</AnimatePresence>
    {settings && <Settings preferences={preferences} onPreferences={changePreferences} onClose={() => { setSettings(false); setNewShelf(false); }}/>} {details && <BookDetails book={details} onClose={() => setDetails(null)} onRead={() => { void openBook(details); setDetails(null); }}/>} {drag && <div className="drop-overlay"><Upload size={48}/><h2>把故事放进来</h2><p>松开即可导入 TXT / EPUB</p></div>}
    {toast && <div className="toast" role="status"><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={16}/></button></div>}{update && <div className="update-banner"><Sparkles size={18}/>新版本已就绪<button onClick={() => void run(() => update())}>更新应用</button></div>}
  </div></LayoutGroup>;
}
