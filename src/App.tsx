import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { ArrowDownToLine, ArrowRight, BookOpen, Bookmark as BookmarkIcon, Check, Cloud, CloudOff, Folder, Library, LoaderCircle, Moon, MoreHorizontal, Plus, Search, Settings as SettingsIcon, Sparkles, Sun, Upload, X } from 'lucide-react';
import { db } from './core/db';
import { addSampleBook, importBook, listChapters, exportBackup, restoreBackup } from './core/library';
import type { Book, Chapter, Preferences, ReadingProgress } from './types';
import { defaultPreferences } from './types';
import { BookCover, download, notify, run, useQuery } from './ui/common';
import Reader from './ui/Reader';
import Settings from './ui/Settings';
import BookDetails from './ui/BookDetails';
import { startAutoSync } from './services/cloud';

type OpenBook = { book: Book; chapters: Chapter[]; progress?: ReadingProgress };
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
  async function openBook(book: Book) {
    try {
      const chapters = await listChapters(book.id); if (!chapters.length) throw new Error('这本书没有可阅读的章节，请重新导入原文件。');
      const current = await db.progress.get(book.id);
      setActive({ book, chapters, progress: current });
      await db.settings.put({ id: 'readerSession', value: book.id });
    } catch (e) { notify(e instanceof Error ? e.message : '无法打开这本书'); }
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
  const visible = books.filter(b => (!query || `${b.title} ${b.author}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (filter === 'all' || (filter === 'recent' ? pmap.has(b.id) : filter === 'bookmarks' ? bookmarks.some(m => m.bookId === b.id) : b.shelfId === filter))).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : sort === 'added' ? b.createdAt - a.createdAt : (pmap.get(b.id)?.updatedAt ?? b.createdAt) - (pmap.get(a.id)?.updatedAt ?? a.createdAt));
  const percentage = (book: Book) => percentages.find(p=>p.bookId===book.id)?.value ?? 0;
  const heading = filter === 'all' ? '我的书架' : filter === 'recent' ? '最近阅读' : filter === 'bookmarks' ? '我的书签' : shelves.find(s => s.id === filter)?.name || '我的书架';
  return <LayoutGroup><div className="app-shell" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }} onDrop={e => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files); }}>
    <div className={`library-shell ${active ? 'behind-reader' : ''}`} inert={!!active}>
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
        <div className="library-content"><section className="welcome"><div><div className="eyebrow">A QUIET PLACE, A GOOD STORY</div><h1>把世界，读进心里<span>。</span></h1><p>不赶路的时候，就在故事里停一停。</p></div><button className="primary" onClick={() => fileInput.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18}/> : <Plus size={19}/>} {busy ? '正在导入' : '导入书籍'}</button></section>
          <section className="continue-section">
            <div className="section-kicker"><span className="small-line"/> {last ? '接着上次的故事' : '你的下一段旅程'} <span className="kicker-en">CONTINUE THE STORY</span></div>
            <div className="reading-feature"><div className="feature-copy"><span className="feature-label">{last ? 'CONTINUE READING' : 'YOUR PERSONAL LIBRARY'}</span><h2>{last ? last.title : <>翻开一本书，<br/>遇见另一种人生。</>}</h2><p>{last ? `${last.author || '佚名'} · 阅读位置已在本机保存` : '导入你珍藏的故事。没有广告，没有打扰，只有你和文字。'}</p><button className="feature-button" onClick={() => last ? void openBook(last) : fileInput.current?.click()}>{last ? '继续阅读' : '添加第一本书'}<ArrowRight size={18}/></button><div className="feature-note">{last ? '从上次停下的段落继续' : '支持 TXT · EPUB · 拖拽导入'}</div></div><div className="feature-art" aria-hidden="true"><div className="art-halo"/><div className="art-book back"><span>故事<br/>在远方</span></div>{last ? <div className="feature-cover"><BookCover book={last} shared={false}/></div> : <div className="art-book front"><div className="art-edition">THE ART OF SLOW READING</div><h3>山海<br/>之间</h3><div className="art-mountain"/><small>每一页，都是新的风景</small></div>}<div className="art-surface"/><span className="art-caption">STORIES LIVE HERE.</span></div></div>
          </section>
          <section className="collection"><div className="collection-toolbar"><div className="collection-heading"><h2>{heading}</h2><span>{visible.length} 本藏书</span></div><div className="collection-tools"><label className="search"><Search size={17}/><input aria-label="搜索书名或作者" placeholder="搜索书名、作者…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={14}/></button>}</label><select aria-label="排序方式" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近阅读</option><option value="added">最近添加</option><option value="title">书名排序</option></select></div></div>
            <div className="filter-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部书籍</button><button className={filter === 'recent' ? 'active' : ''} onClick={() => setFilter('recent')}>正在阅读 <span>{recent.length}</span></button>{shelves.map(s => <button key={s.id} className={filter === s.id ? 'active' : ''} onClick={() => setFilter(s.id)}>{s.name}</button>)}</div>
            {visible.length ? <motion.div className="book-grid" layout>{visible.map(book => <motion.article layout={!reduced} key={book.id} className="book-card"><button className="book-open" onClick={() => void openBook(book)} aria-label={`阅读 ${book.title}`}><BookCover book={book}/><span className="cover-hover"><BookOpen size={21}/>翻开故事</span></button><div className="book-meta"><button className="book-title" onClick={() => void openBook(book)}>{book.title}</button><button className="icon-button book-menu" aria-label={`${book.title} 详情`} onClick={() => setDetails(book)}><MoreHorizontal size={20}/></button><p>{book.author || '佚名'}</p><div className="book-status"><span>{pmap.has(book.id) ? '阅读中' : '尚未翻阅'}</span><span>{book.format.toUpperCase()}{book.cloudEnabled && <Cloud size={12}/>}</span></div>{pmap.has(book.id) && <div className="tiny-progress"><i style={{ width: `${Math.max(4, percentage(book))}%` }}/></div>}</div></motion.article>)}<button className="add-book-card" onClick={() => fileInput.current?.click()}><span><Plus size={26}/></span><strong>再添一本好书</strong><small>点击选择，或拖拽到这里</small></button></motion.div> : <div className="empty-library"><div className="empty-symbol"><BookOpen size={32} strokeWidth={1.2}/><span>✦</span></div><h3>{books.length ? '这里还没有故事' : '好故事，值得被珍藏'}</h3><p>{query ? '换一个书名或作者试试。' : '从电脑或手机导入小说，建立只属于你的书架。'}</p><div className="empty-actions"><button className="secondary" onClick={() => fileInput.current?.click()}><Upload size={16}/>导入 TXT / EPUB</button>{!books.length && <button className="text-button" onClick={() => void run(async () => { const b = await addSampleBook(); await openBook(b); })}>先读一段原创短篇 <ArrowRight size={15}/></button>}</div></div>}
          </section><footer className="library-footer"><span>你的书，留在你的设备里。云同步由你选择。</span><button onClick={() => void run(async () => download(await exportBackup(), `阅见备份-${new Date().toISOString().slice(0,10)}.json`))}><ArrowDownToLine size={14}/>导出备份</button><button onClick={() => restoreInput.current?.click()}>恢复备份</button></footer>
        </div>
      </main><nav className="mobile-nav"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><Library size={20}/>书架</button><button className={filter === 'recent' ? 'active' : ''} onClick={() => setFilter('recent')}><BookOpen size={20}/>最近</button><button onClick={() => fileInput.current?.click()}><Plus size={23}/>导入</button><button onClick={() => { setNewShelf(true); setSettings(true); }}><Folder size={20}/>分类</button><button onClick={() => setSettings(true)}><SettingsIcon size={20}/>设置</button></nav>
    </div>
    <input ref={fileInput} className="visually-hidden" type="file" multiple accept=".txt,.epub,text/plain,application/epub+zip" aria-label="导入小说文件" onChange={e => { if (e.target.files) void importFiles(e.target.files); e.target.value = ''; }}/><input ref={restoreInput} className="visually-hidden" type="file" accept=".json" aria-label="恢复备份文件" onChange={e => { const f = e.target.files?.[0]; if (f) void run(() => restoreBackup(f), '备份已恢复'); e.target.value = ''; }}/>
    <AnimatePresence>{active && <Reader key={active.book.id} {...active} preferences={preferences} onPreferences={changePreferences} onClose={() => { setActive(null); void run(() => db.settings.delete('readerSession')); }}/>}</AnimatePresence>
    {settings && <Settings preferences={preferences} onPreferences={changePreferences} onClose={() => { setSettings(false); setNewShelf(false); }}/>} {details && <BookDetails book={details} onClose={() => setDetails(null)} onRead={() => { void openBook(details); setDetails(null); }}/>} {drag && <div className="drop-overlay"><Upload size={48}/><h2>把故事放进来</h2><p>松开即可导入 TXT / EPUB</p></div>}
    {toast && <div className="toast" role="status"><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={16}/></button></div>}{update && <div className="update-banner"><Sparkles size={18}/>新版本已就绪<button onClick={() => void run(() => update())}>更新应用</button></div>}
  </div></LayoutGroup>;
}
