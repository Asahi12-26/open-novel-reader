import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { ArrowLeft, ArrowRight, Bookmark as BookmarkIcon, Check, ChevronLeft, ChevronRight, List, Settings2, Sparkles, Users, X } from 'lucide-react';
import { db } from '../core/db';
import { saveProgress } from '../core/library';
import type { Book, Bookmark, Chapter, Dialogue, Preferences, ReadingProgress } from '../types';
import { BookCover, Modal, notify, run, useQuery, useMotionPreference as useReducedMotion } from './common';
import { correctDialogue, createCharacter } from '../services/ai';
import AnalysisPanel from './AnalysisPanel';
import BookAnalysisPanel from './BookAnalysisPanel';
import { compareIdentityLocations, createIdentityProjector, type IdentityScope } from '../services/character-identity';
import { CharacterAvatarView } from './CharacterAvatar';
import CharacterGallery, { type CharacterProfile } from './CharacterGallery';
import ChapterSummary from './ChapterSummary';
import { loadSeriesAvatars } from '../services/series';
import type { SeriesAccess } from '../core/series-types';

interface Props { book: Book; chapters: Chapter[]; progress?: ReadingProgress; fromOcean?: boolean; preferences: Preferences; seriesAccess: SeriesAccess; onPreferences: (patch: Partial<Preferences>) => void; onConfigureAI: () => void; onClose: () => void }
function characterRect(element: HTMLElement, offset: number): DOMRect {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('[data-reading-decoration]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
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
export default function Reader({ book, chapters, progress, fromOcean = true, preferences, seriesAccess, onPreferences, onConfigureAI, onClose }: Props) {
  const first = Math.max(0, chapters.findIndex(c => c.id === progress?.chapterId));
  const [index, setIndex] = useState(first);
  const [toc, setToc] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [bookAnalysis, setBookAnalysis] = useState(false);
  const [bookAnalysisRevision, setBookAnalysisRevision] = useState(0);
  const [bookTaskActive, setBookTaskActive] = useState(false);
  const [summaryChapterId, setSummaryChapterId] = useState<string | null>(null);
  const [regenerateChapterId, setRegenerateChapterId] = useState<string | undefined>();
  const [showAllCharacters, setShowAllCharacters] = useState(false);
  const [bookmarkList, setBookmarkList] = useState(false);
  const [characterPanel, setCharacterPanel] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [selectedDialogue, setSelectedDialogue] = useState<Dialogue | null>(null);
  const [newName, setNewName] = useState('');
  const [position, setPosition] = useState(progress?.paragraphIndex ?? 0);
  const [positionOffset, setPositionOffset] = useState(progress?.offset ?? 0);
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
  const dialogueRevisions = useQuery(() => selectedDialogue
    ? db.dialogueCorrectionRevisions.where('dialogueId').equals(selectedDialogue.id).and(row => row.bookId === book.id).toArray()
    : Promise.resolve([]), [book.id, selectedDialogue?.id], []);
  const allDialogues = useQuery(() => db.dialogues.where('bookId').equals(book.id).toArray(), [book.id], []);
  const chapterSummaries = useQuery(() => db.chapterSummaries.where('bookId').equals(book.id).toArray(), [book.id], []);
  const avatars = useQuery(() => db.avatars.where('bookId').equals(book.id).toArray(), [book.id], []);
  const identityScope = useMemo<IdentityScope>(() => ({ chapterIndex: chapter.index, paragraphIndex: position, offset: positionOffset }), [chapter.index, position, positionOffset]);
  const seriesAvatars = useQuery(async () => ({
    chapterIndex: identityScope.chapterIndex, paragraphIndex: identityScope.paragraphIndex, offset: identityScope.offset,
    images: await loadSeriesAvatars(book.id, identityScope, seriesAccess),
  }), [book.id, seriesAccess.origin, seriesAccess.userId, identityScope.chapterIndex, identityScope.paragraphIndex, identityScope.offset], null);
  const projectIdentities = useMemo(() => createIdentityProjector(characters, allDialogues.filter(row => row.verifiedQuote !== false), chapters), [characters, allDialogues, chapters]);
  const identities = useMemo(() => projectIdentities(identityScope, showAllCharacters), [projectIdentities, identityScope, showAllCharacters]);
  const avatarById = useMemo(() => new Map(avatars.filter(avatar => avatar.bookId === book.id).map(avatar => [avatar.characterId, avatar])), [avatars, book.id]);
  const visibleAvatarById = useMemo(() => {
    const images = new Map<string, Blob>();
    for (const person of identities.characters) {
      const own = avatarById.get(person.id);
      const image = own ? own.image : identities.members(person.id)
        .map(member => avatarById.get(member.id))
        .filter(avatar => avatar?.image)
        .sort((left, right) => right!.updatedAt - left!.updatedAt || left!.characterId.localeCompare(right!.characterId))[0]?.image;
      const shared = seriesAvatars && compareIdentityLocations(seriesAvatars, identityScope) <= 0
        ? seriesAvatars.images.get(person.id) : undefined;
      if (image || (!own && shared)) images.set(person.id, image || shared!);
    }
    return images;
  }, [identities, avatarById, seriesAvatars, identityScope]);
  const profiles = useMemo(() => {
    const result = new Map<string, CharacterProfile>();
    if (!characterPanel) return result;
    const byId = new Map(chapters.map(item => [item.id, item]));
    const byIndex = new Map(chapters.map(item => [item.index, item]));
    const relevant = new Map<string, Dialogue[]>();
    for (const dialogue of allDialogues) {
      const source = byId.get(dialogue.chapterId);
      if (!source || source.bookId !== book.id || dialogue.bookId !== book.id || dialogue.verifiedQuote === false) continue;
      if (!showAllCharacters && compareIdentityLocations({ chapterIndex: source.index, paragraphIndex: dialogue.paragraphIndex, offset: dialogue.end }, identityScope) > 0) continue;
      const person = identities.character(dialogue.characterId);
      if (!person) continue;
      const rows = relevant.get(person.id);
      if (rows) rows.push(dialogue);
      else relevant.set(person.id, [dialogue]);
    }
    for (const person of identities.characters) {
      const members = identities.members(person.id);
      const first = members.map(member => identities.introduction(member.id)).filter(at => at !== undefined).sort(compareIdentityLocations)[0];
      const firstChapter = first && byIndex.get(first.chapterIndex);
      const history = members.flatMap(member => member.identity?.events || []).sort((left, right) => compareIdentityLocations(left.at, right.at) || left.updatedAt - right.updatedAt);
      const retainedAvatars = members.flatMap(member => {
        const image = avatarById.get(member.id)?.image;
        return member.id === person.id || !image ? [] : [{ id: member.id, name: member.name, image }];
      });
      const entries = relevant.get(person.id) ?? [];
      entries.sort((a, b) => byId.get(a.chapterId)!.index - byId.get(b.chapterId)!.index || a.paragraphIndex - b.paragraphIndex || a.start - b.start);
      result.set(person.id, {
        firstAppearance: first && firstChapter ? { ...first, chapterTitle: firstChapter.title } : undefined,
        image: visibleAvatarById.get(person.id), ownImage: avatarById.get(person.id)?.image, dialogues: entries, history, retainedAvatars,
      });
    }
    return result;
  }, [characterPanel, chapters, allDialogues, book.id, identities, identityScope, showAllCharacters, avatarById, visibleAvatarById]);
  const dialoguesByParagraph = useMemo(() => {
    const rows = new Map<number, Dialogue[]>();
    for (const dialogue of dialogues) {
      if (dialogue.chapterId !== chapter.id || dialogue.bookId !== book.id || dialogue.verifiedQuote === false) continue;
      const paragraph = rows.get(dialogue.paragraphIndex);
      if (paragraph) paragraph.push(dialogue);
      else rows.set(dialogue.paragraphIndex, [dialogue]);
    }
    for (const paragraph of rows.values()) paragraph.sort((a, b) => a.start - b.start);
    return rows;
  }, [dialogues, chapter.id, book.id]);
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
      setPositionOffset(location.offset);
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
      latest.current = { chapterId: chapter.id, paragraphIndex: visible, offset }; setPosition(visible); setPositionOffset(offset);
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
  }, [preferences.fontSize, preferences.lineHeight, preferences.readerWidth, preferences.fontFamily, preferences.showCharacters, preferences.showAvatars]);
  async function goChapter(next: number, paragraphIndex = 0, offset = 0) {
    if (!chapters[next]) return;
    const ticket = ++navigation.current;
    target.current = { chapterId: chapters[next].id, paragraphIndex, offset };
    latest.current = target.current;
    restored.current = false;
    // Commit the destination before showing it, including a reload immediately after navigation.
    try { await saveProgress(book.id,chapters[next].id,paragraphIndex,offset); }
    catch { notify('阅读位置保存失败，请检查设备存储空间。'); }
    if (ticket !== navigation.current) return;
    setPosition(paragraphIndex); setPositionOffset(offset);
    if (next === index) { const root = scroller.current; const p = root?.querySelector<HTMLElement>(`[data-paragraph="${paragraphIndex}"]`); if (root && p) { if(paragraphIndex || offset)scrollToAnchor(root,p,offset);else root.scrollTop=0; } }
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
  const openPerson = (id: string) => {
    if (!identities.character(id)) return;
    setSummaryChapterId(null);
    setSelectedCharacterId(id);
    setCharacterPanel(true);
  };
  const regenerateSummary = (id: string) => {
    if (bookTaskActive) { notify('请先结束当前分析任务。'); return; }
    setSummaryChapterId(null);
    setRegenerateChapterId(id);
    setBookAnalysis(true);
    setBookAnalysisRevision(value => value + 1);
  };
  function configureAI() {
    setAnalysis(false);
    setBookAnalysis(false);
    setBookTaskActive(false);
    setRegenerateChapterId(undefined);
    onConfigureAI();
  }
  const lastParagraph = Math.max(0, chapter.paragraphs.length - 1);
  const lastOffset = chapter.paragraphs[lastParagraph]?.length || 0;
  const recapChapter = chapters.find(item => item.id === summaryChapterId);
  const summaryIdentity = showAllCharacters ? projectIdentities(identityScope) : identities;
  const knownSummaries = chapterSummaries.filter(item => (chapters.find(c => c.id === item.chapterId)?.index ?? Infinity) <= identityScope.chapterIndex);
  const chapterRead = identityScope.paragraphIndex === lastParagraph && identityScope.offset >= lastOffset;
  const markChapterRead = () => {
    const end = { chapterId: chapter.id, paragraphIndex: lastParagraph, offset: lastOffset };
    latest.current = end;
    setPosition(lastParagraph);
    setPositionOffset(lastOffset);
    void run(() => saveProgress(book.id, chapter.id, lastParagraph, lastOffset));
  };
  function renderParagraph(text: string, p: number): ReactNode {
    const showAvatars = preferences.showAvatars !== false;
    if (!preferences.showCharacters && !showAvatars) return text;
    const rows = dialoguesByParagraph.get(p);
    if (!rows?.length) return text;
    const parts: ReactNode[] = []; let end = 0;
    for (const d of rows) {
      if (d.start < end || text.slice(d.start,d.end) !== d.text) continue;
      parts.push(text.slice(end,d.start));
      const person = identities.character(d.characterId);
      const name = person?.name || '未知';
      parts.push(<span className="dialogue-text" key={d.id}>
        {text.slice(d.start,d.end)}
        {showAvatars && <button type="button" data-reading-decoration className="dialogue-avatar-trigger" aria-label={person ? `查看人物 ${name} 的头像与资料` : '未知人物头像，点击纠正'} onClick={() => {
          if (person) openPerson(person.id);
          else setSelectedDialogue(d);
        }}><CharacterAvatarView character={person} image={person && visibleAvatarById.get(person.id)} size="inline"/></button>}
        {preferences.showCharacters && <button type="button" data-reading-decoration className={`character-tag ${d.source === 'manual' ? 'manual' : ''}`} aria-label={`说话人物：${name}，点击纠正`} onClick={() => setSelectedDialogue(d)}>{name}{d.source === 'manual' && <Check size={9}/>}</button>}
      </span>); end = d.end;
    }
    parts.push(text.slice(end)); return parts;
  }
  const close = () => { const p = latest.current; void run(() => saveProgress(book.id,p.chapterId,p.paragraphIndex,p.offset)); onClose(); };
  return <motion.section layoutRoot className="reader ocean-reader" data-cover-phase={coverPhase} role="dialog" aria-modal="true" aria-label={`阅读 ${book.title}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : present ? .22 : .48 }}>
    {centralCover && <div className="reader-cover-flight" aria-hidden="true"><motion.div className="reader-cover-tilt" animate={{ opacity: !mobileCover || coverPhase === 'expand' || coverPhase === 'open' || !present ? 1 : 0 }} transition={{ duration: .18 }}><span className="reader-cover-pages"/><motion.div className="reader-cover-front" initial={{ rotateY: 0 }} animate={{ rotateY: present && coverPhase === 'open' ? -28 : 0 }} transition={{ duration: .22 }}><BookCover book={book} duration={present ? mobileCover ? .26 : .36 : .46}/></motion.div></motion.div></div>}
    <aside className={`reader-sidebar ${toc ? 'is-open' : ''}`}><button className="reader-back" onClick={close}><ArrowLeft size={18}/>回到书架</button><div className="reader-book"><BookCover key={centralCover ? 'static-cover' : 'shared-cover'} book={book} shared={fromOcean && !centralCover} className={coverPhase === 'expand' || coverPhase === 'open' ? 'reader-cover-placeholder' : ''} duration={coverPhase === 'settle' ? .18 : .46}/><h2>{book.title}</h2><p>{book.author || '佚名'}</p></div><div className="toc-heading"><h3>目录</h3><span>{chapters.length} 章</span><button className="icon-button mobile-only" aria-label="关闭目录" onClick={() => setToc(false)}><X size={18}/></button></div><nav className="toc-list">{chapters.map((c,i) => <button key={c.id} className={i === index ? 'active' : ''} onClick={() => goChapter(i)}><span>{String(i+1).padStart(2,'0')}</span>{c.title}{i === index && <i/>}</button>)}{knownSummaries.length > 0 && <div className="chapter-recap-index"><strong>已保存的章节简介</strong>{knownSummaries.map(item => { const source = chapters.find(c => c.id === item.chapterId)!; if (source.index === index && !chapterRead) return null; return <button key={source.id} aria-label={`打开第 ${source.index + 1} 章简介`} onClick={() => { setToc(false); setSummaryChapterId(source.id); }}>第 {source.index + 1} 章简介</button>; })}</div>}</nav><div className="reader-sidebar-note"><span className="status-dot"/>离线可用 · 位置自动保存</div></aside>
    {toc && <button className="toc-scrim" aria-label="收起目录" onClick={() => setToc(false)}/>}
    <div className="reader-main"><header className="reader-toolbar"><div className="reader-toolbar-left"><button className="icon-button mobile-only" aria-label="返回书架" onClick={close}><ArrowLeft size={20}/></button><button className="icon-button mobile-only" aria-label="展开目录" onClick={() => setToc(true)}><List size={20}/></button><span>{book.title}</span></div><div className="reader-tools"><button className="icon-button" title="添加书签" aria-label="添加当前段落书签" onClick={() => void addBookmark()}><BookmarkIcon size={18}/></button><button className="icon-button" title="全部书签" aria-label="查看全部书签" onClick={() => setBookmarkList(true)}><List size={18}/></button><button className="icon-button" title="人物管理" aria-label="人物管理" onClick={() => { setSelectedCharacterId(null); setCharacterPanel(true); }}><Users size={18}/></button><button className="ai-toolbar" aria-label="章节人物识别" title="章节人物识别" onClick={() => setAnalysis(true)}><Sparkles size={16}/><span>人物识别</span></button><button className={`icon-button ${appearance ? 'active' : ''}`} aria-label="阅读排版设置" onClick={() => setAppearance(!appearance)}><Settings2 size={20}/></button></div></header>
      {appearance && <div className="appearance-panel"><div className="panel-title">让文字，适合你的眼睛<button className="icon-button" aria-label="关闭排版设置" onClick={() => setAppearance(false)}><X size={17}/></button></div><label>字号 <span>{preferences.fontSize}px</span><input aria-label="字号" type="range" min="14" max="36" value={preferences.fontSize} onChange={e => onPreferences({fontSize:Number(e.target.value)})}/></label><label>行距 <span>{preferences.lineHeight.toFixed(1)}</span><input aria-label="行距" type="range" min="1.3" max="2.6" step="0.1" value={preferences.lineHeight} onChange={e => onPreferences({lineHeight:Number(e.target.value)})}/></label><label>页宽 <span>{preferences.readerWidth}px</span><input aria-label="页宽" type="range" min="420" max="1000" step="20" value={preferences.readerWidth} onChange={e => onPreferences({readerWidth:Number(e.target.value)})}/></label><label>字体<select aria-label="字体" value={preferences.fontFamily} onChange={e => onPreferences({fontFamily:e.target.value as Preferences['fontFamily']})}><option value="serif">宋体 / Georgia</option><option value="sans">黑体 / Sans serif</option></select></label><div className="theme-choices">{(['light','sepia','dark'] as const).map((t,i) => <button key={t} className={`theme-chip ${t} ${preferences.theme === t ? 'chosen' : ''}`} onClick={() => onPreferences({theme:t})}>{['纸白','暖笺','夜读'][i]}{preferences.theme === t && <Check size={13}/>}</button>)}</div><label className="checkbox-row"><input type="checkbox" checked={preferences.showCharacters} onChange={e => onPreferences({showCharacters:e.target.checked})}/>显示对白人物标签</label><label className="checkbox-row"><input type="checkbox" checked={preferences.showAvatars !== false} onChange={e => onPreferences({showAvatars:e.target.checked})}/>显示对白人物头像</label></div>}
      <div ref={scroller} className="reader-scroller" tabIndex={0} aria-label="小说正文"><article className={`reader-article ${preferences.fontFamily}`} style={{'--reader-font-size':`${preferences.fontSize}px`,'--reader-line-height':preferences.lineHeight,'--reader-width':`${preferences.readerWidth}px`} as CSSProperties} lang={book.language || 'zh'}><div className="chapter-eyebrow">CHAPTER {String(index+1).padStart(2,'0')} <span/> {book.format.toUpperCase()}</div><h1>{chapter.title}</h1><div className="chapter-ornament">✦</div>{chapter.paragraphs.map((p,i) => <p key={`${chapter.id}:${i}`} data-paragraph={i} id={`para-${i}`}>{renderParagraph(p,i)}</p>)}<div className="chapter-end"><span>· · ·</span>{!chapterRead && <button className="text-button" onClick={markChapterRead}>标记本章读完</button>}<ChapterSummary chapter={chapter} scope={identityScope} resolveCharacter={summaryIdentity.character} onCharacter={openPerson} onRegenerate={() => regenerateSummary(chapter.id)}/><p>{index === chapters.length-1 ? '故事暂告一段落，生活仍在继续。' : '下一页，还有新的故事。'}</p><button className="secondary" onClick={() => index < chapters.length-1 ? goChapter(index+1) : close()}>{index < chapters.length-1 ? '阅读下一章' : '回到书架'}<ArrowRight size={16}/></button></div></article></div>
      <footer className="reader-footer"><button disabled={index === 0} onClick={() => goChapter(index-1)} aria-label="上一章"><ChevronLeft size={17}/><span>上一章</span></button><span className="reader-position">{chapter.title}<small>{index+1} / {chapters.length} 章 · {percentage}%</small></span><button disabled={index === chapters.length-1} onClick={() => goChapter(index+1)} aria-label="下一章"><span>下一章</span><ChevronRight size={17}/></button></footer><div className="reader-progress"><i style={{width:`${percentage}%`}}/></div>
    </div>
    {bookmarkList && <Modal title="故事里的停靠点" onClose={() => setBookmarkList(false)}>{marks.length ? <div className="bookmark-list">{marks.map(m => <div key={m.id}><button onClick={() => goChapter(chapters.findIndex(c => c.id === m.chapterId),m.paragraphIndex)}><small>{chapters.find(c => c.id === m.chapterId)?.title}</small>{m.label}</button><button className="icon-button" aria-label="删除书签" onClick={() => void run(() => db.bookmarks.delete(m.id))}><X size={17}/></button></div>)}</div> : <div className="modal-empty"><BookmarkIcon size={30}/><p>读到喜欢的段落，就为它留一个书签。</p></div>}</Modal>}
    {analysis && <AnalysisPanel chapter={chapter} scope={identityScope} getCharacter={identities.character} showAll={showAllCharacters} blockedByBookTask={bookTaskActive} onConfigureAI={configureAI} onOpenBookAnalysis={() => { setAnalysis(false); setRegenerateChapterId(undefined); setBookAnalysis(true); setBookAnalysisRevision(value => value + 1); }} onClose={() => setAnalysis(false)} onViewResults={target => { setAnalysis(false); void goChapter(chapters.findIndex(item => item.id === target.id)); }}/>}
    {bookAnalysis && <BookAnalysisPanel key={regenerateChapterId ?? "whole-book"} summaryChapterId={regenerateChapterId} seriesAccess={seriesAccess} bookId={book.id} chapters={chapters} dialogues={allDialogues} scope={identityScope} getCharacter={identities.character} showAll={showAllCharacters} openRevision={bookAnalysisRevision} onActivity={setBookTaskActive} onConfigureAI={configureAI} onClose={() => { setBookAnalysis(false); setBookTaskActive(false); setRegenerateChapterId(undefined); }} onViewResults={(target, paragraphIndex) => void goChapter(chapters.findIndex(item => item.id === target.id), paragraphIndex)}/>}
    {recapChapter && <ChapterSummary chapter={recapChapter} scope={identityScope} resolveCharacter={summaryIdentity.character} onCharacter={openPerson} onRegenerate={() => regenerateSummary(recapChapter.id)} onClose={() => setSummaryChapterId(null)}/>}
    {selectedDialogue && <Modal title="这一句，是谁说的？" onClose={() => setSelectedDialogue(null)}>
      <blockquote className="dialogue-quote">{selectedDialogue.text}</blockquote>
      <p className="muted">人工纠正会优先保留，不会被后续 AI 分析覆盖。人物选项默认只显示当前阅读范围内的身份。</p>
      {!!selectedDialogue.possibleCharacterIds?.length && <p className="muted">可供复核的人物 {selectedDialogue.possibleCharacterIds.map(id => identities.character(id)?.name).filter(Boolean).join("、") || "未知"}</p>}
      <div className="character-choices"><button onClick={() => void run(async () => { await correctDialogue(selectedDialogue.id, null); setSelectedDialogue(null); })}>未知人物</button>{identities.characters.map(person => <button key={person.id} onClick={() => void run(async () => { await correctDialogue(selectedDialogue.id, person.id); setSelectedDialogue(null); })}><CharacterAvatarView character={person} image={visibleAvatarById.get(person.id)} size="inline"/>{person.name}</button>)}</div>
      <form className="inline-form" onSubmit={event => { event.preventDefault(); if (!newName.trim()) return; void run(async () => { const person = await createCharacter(book.id, newName, identityScope); await correctDialogue(selectedDialogue.id, person.id); setNewName(''); setSelectedDialogue(null); }); }}><input aria-label="新人物名称" value={newName} onChange={event => setNewName(event.target.value)} maxLength={80} placeholder="或新建人物"/><button className="secondary" type="submit">新建并指定</button></form>
      {dialogueRevisions.some(row => row.dialogueId === selectedDialogue.id) && <details className="dialogue-revisions"><summary>人工纠正记录</summary><ol>{dialogueRevisions.filter(row => row.dialogueId === selectedDialogue.id).sort((a, b) => b.updatedAt - a.updatedAt).map(row => <li key={row.id}>
        <span>{identities.character(row.previousCharacterId)?.name ?? '未知人物'} → {identities.character(row.characterId)?.name ?? '未知人物'}</span>
        <time dateTime={new Date(row.updatedAt).toISOString()}>{new Date(row.updatedAt).toLocaleString()}</time>
      </li>)}</ol></details>}
    </Modal>}
    {characterPanel && <CharacterGallery bookId={book.id} people={identities.characters} getProfile={id => profiles.get(id)}
      selectedId={selectedCharacterId ? identities.character(selectedCharacterId)?.id ?? null : null} onSelect={setSelectedCharacterId}
      scope={identityScope} showAll={showAllCharacters} onShowAll={setShowAllCharacters}
      onJump={dialogue => { setCharacterPanel(false); setSelectedCharacterId(null); void goChapter(chapters.findIndex(item => item.id === dialogue.chapterId), dialogue.paragraphIndex, dialogue.start); }}
      onAssign={dialogue => { setCharacterPanel(false); setSelectedCharacterId(null); setSelectedDialogue(dialogue); }}
      onClose={() => { setCharacterPanel(false); setSelectedCharacterId(null); }}/>}
  </motion.section>;
}
