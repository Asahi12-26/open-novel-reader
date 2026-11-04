import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { ArrowUpRight, BookOpen, Cloud, MoreHorizontal, Plus } from 'lucide-react';
import type { Book } from '../types';
import { BookCover, notify, useMotionPreference } from './common';
import './book-ocean.css';

export interface BookOceanProps {
  books: Book[];
  progress: Record<string, number>;
  readingIds: Set<string>;
  selectedId?: string | null;
  paused?: boolean;
  onOpen: (book: Book) => Promise<void>;
  onDetails: (book: Book) => void;
  onImport: () => void;
}

type Wave = { x: number; y: number; rx: number; ry: number; rz: number };
type FloatingBook = { node: HTMLElement; index: number; lift: number; velocity: number; retreat: number; wave: Wave; locked: Wave; lockWeight: number; active: boolean; values: Record<string, string> };
const ZERO_WAVE: Wave = { x: 0, y: 0, rx: 0, ry: 0, rz: 0 };
const TAU = Math.PI * 2;
const phaseFor = (row: number, col: number) => row * .74 + col * .58;
function dimensions(width: number) {
  const columns = width >= 1200 ? 7 : width >= 970 ? 6 : width >= 750 ? 5 : width >= 560 ? 4 : width >= 405 ? 3 : 2;
  const inset = width < 560 ? 6 : 18;
  const gap = width < 560 ? 20 : 30;
  const slot = Math.max(80, (width - inset * 2 - gap * (columns - 1)) / columns);
  const cover = Math.min(154, slot * .92);
  return { width, columns, inset, gap, slot, cover, coverHeight: cover * 1.5, rowHeight: cover * 1.5 + 154, restTop: 80 };
}
function write(book: FloatingBook, name: string, value: string) {
  if (book.values[name] !== value) { book.values[name] = value; book.node.style.setProperty(name, value); }
}
function paint(book: FloatingBook, wave: Wave, lift: number, retreat: number, compact: boolean) {
  write(book, '--wave-x', `${wave.x.toFixed(2)}px`);
  write(book, '--wave-y', `${wave.y.toFixed(2)}px`);
  write(book, '--wave-rx', `${wave.rx.toFixed(3)}deg`);
  write(book, '--wave-ry', `${wave.ry.toFixed(3)}deg`);
  write(book, '--wave-rz', `${wave.rz.toFixed(3)}deg`);
  write(book, '--wave-weight', Math.max(0, 1 - lift).toFixed(3));
  write(book, '--lift', `${(lift * (compact ? 66 : 78)).toFixed(2)}px`);
  write(book, '--lift-scale', (1 + lift * .1 - retreat * .035).toFixed(4));
  write(book, '--ocean-depth', `${(lift * 30 - retreat * 12).toFixed(2)}px`);
  write(book, '--ocean-opacity', (1 - retreat * .19).toFixed(3));
  write(book, '--hover-amount', lift.toFixed(3));
}

/** One shared clock drives only mounted, nearby covers. The hit slots never move. */
export default function BookOcean({ books, progress, readingIds, selectedId, paused = false, onOpen, onDetails, onImport }: BookOceanProps) {
  const root = useRef<HTMLElement>(null);
  const reduced = useMotionPreference();
  const [width, setWidth] = useState(900);
  const layout = useMemo(() => dimensions(width), [width]);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const [range, setRange] = useState({ start: 0, end: 2 });
  const [nearby, setNearby] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [loading, setLoading] = useState<'lift' | 'opening' | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const touch = useRef(false);
  const touchWait = useRef<{ timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);
  const floating = useRef(new Map<string, FloatingBook>());
  const callbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const clock = useRef(0);
  const origin = useRef({ left: 0, top: 0 });
  const pointer = useRef({ x: 0, y: 0, energy: 0, movedAt: 0, inside: false });
  const indexById = useMemo(() => new Map(books.map((book, index) => [book.id, index])), [books]);
  const indexRef = useRef(indexById); indexRef.current = indexById;
  const activeId = selectedId || sourceId || focusedId || hoveredId;
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const frozenAmbient = useRef(false); frozenAmbient.current = !!sourceId || !!selectedId;
  const totalRows = Math.ceil((books.length + 1) / layout.columns);
  const running = !reduced && !paused && loading !== 'opening' && visible && nearby && books.length > 0;

  const indexes = useMemo(() => {
    const items = new Set<number>();
    for (let index = range.start * layout.columns; index < Math.min(books.length + 1, (range.end + 1) * layout.columns); index++) items.add(index);
    for (const id of [selectedId, sourceId, focusedId, hoveredId]) {
      const index = id ? indexById.get(id) : undefined;
      if (index !== undefined) items.add(index);
    }
    return [...items].sort((a, b) => a - b);
  }, [range, layout.columns, books.length, selectedId, sourceId, focusedId, hoveredId, indexById]);

  function slotRef(id: string) {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = node => {
        if (!node) { floating.current.delete(id); return; }
        floating.current.set(id, { node, index: indexRef.current.get(id) || 0, lift: 0, velocity: 0, retreat: 0, wave: { ...ZERO_WAVE }, locked: { ...ZERO_WAVE }, lockWeight: 0, active: false, values: {} });
      };
      callbacks.current.set(id, callback);
    }
    return callback;
  }

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const nextWidth = Math.max(200, Math.round(rect.width));
      const current = dimensions(nextWidth);
      origin.current = { left: rect.left, top: rect.top };
      setWidth(previous => previous === nextWidth ? previous : nextWidth);
      const rows = Math.ceil((books.length + 1) / current.columns);
      const start = Math.max(0, Math.floor((-rect.top - current.rowHeight * 1.25) / current.rowHeight));
      const end = Math.max(start, Math.min(rows - 1, Math.ceil((window.innerHeight - rect.top + current.rowHeight * 1.25) / current.rowHeight)));
      setRange(previous => previous.start === start && previous.end === end ? previous : { start, end });
    };
    const schedule = () => { if (scheduled === undefined) scheduled = setTimeout(() => { scheduled = undefined; measure(); }, 24); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => { observer.disconnect(); clearTimeout(scheduled); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [books.length]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => setNearby(entries[0]?.isIntersecting ?? false), { rootMargin: '260px' });
    observer.observe(element);
    const visibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibility);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (touchWait.current) { clearTimeout(touchWait.current.timer); touchWait.current.resolve(); } };
  }, []);
  useEffect(() => {
    if (!paused && !selectedId && !pending.current) setSourceId(null);
  }, [paused, selectedId, loading]);
  useEffect(() => {
    for (const [id, book] of floating.current) book.index = indexById.get(id) ?? book.index;
    for (const id of callbacks.current.keys()) if (!indexById.has(id)) callbacks.current.delete(id);
  }, [indexById]);
  useEffect(() => {
    if (!focusRequest) return;
    const node = floating.current.get(focusRequest)?.node;
    node?.querySelector<HTMLButtonElement>('.book-open')?.focus({ preventScroll: true });
    node?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    if (node) setFocusRequest(null);
  }, [focusRequest, indexes]);

  useEffect(() => {
    if (!reduced) return;
    for (const book of floating.current.values()) {
      book.lift = 0; book.velocity = 0;
      paint(book, ZERO_WAVE, book.lift, 0, layout.width < 560);
    }
  }, [reduced, activeId, layout.width, indexes]);

  useEffect(() => {
    if (!running) return;
    let frame = 0; let previous = 0;
    const tick = (now: number) => {
      const dt = previous ? Math.min((now - previous) / 1000, .035) : 1 / 60;
      previous = now;
      if (!frozenAmbient.current) clock.current += dt;
      const t = clock.current;
      const current = layoutRef.current;
      const activeIndex = activeRef.current ? indexRef.current.get(activeRef.current) : undefined;
      const activeRow = activeIndex === undefined ? -99 : Math.floor(activeIndex / current.columns);
      const activeCol = activeIndex === undefined ? -99 : activeIndex % current.columns;
      const cursor = pointer.current;
      const energyTarget = cursor.inside ? Math.exp(-(now - cursor.movedAt) / 1500) : 0;
      cursor.energy += (energyTarget - cursor.energy) * Math.min(1, dt * 5);
      const sway = Math.sin(t * TAU / 22);
      root.current?.style.setProperty('--ocean-sway', `${(sway * 7).toFixed(2)}px`);
      for (const [id, book] of floating.current) {
        const row = Math.floor(book.index / current.columns); const col = book.index % current.columns;
        const phase = phaseFor(row, col);
        const theta = t * TAU / 10.4 + phase;
        const cx = origin.current.left + current.inset + col * (current.slot + current.gap) + current.slot / 2;
        const cy = origin.current.top + row * current.rowHeight + current.restTop + current.coverHeight / 2;
        const distance = Math.hypot(cx - cursor.x, cy - cursor.y);
        const ripple = cursor.energy * Math.exp(-distance / 190) * Math.sin(distance * .019 - t * 4.2) * 2.6;
        const amplitude = current.width < 560 ? .58 : 1;
        const surface = Math.sin(phase - .8) * 26;
        const facing = (col - (current.columns - 1) / 2) * 1.2;
        const live: Wave = { x: (Math.sin(theta * .8) * 2 + sway * 1.2) * amplitude, y: (surface + Math.sin(theta) * 9.5 + Math.sin(t * TAU / 9.1 + phase * .8) * 2.5 + ripple) * amplitude, rx: Math.cos(theta + .6) * 1.2 * amplitude, ry: (facing + Math.sin(theta * .85) * 2.1 + sway * .4) * amplitude, rz: (Math.cos(phase - .8) + Math.sin(theta + .9) * 1.35 + sway * .25) * amplitude };
        const active = id === activeRef.current;
        if (active && !book.active) { book.locked = { ...book.wave }; book.lockWeight = 1; }
        book.active = active;
        if (!active) book.lockWeight *= Math.exp(-dt * 5.5);
        const weight = active ? 1 : book.lockWeight;
        const wave = Object.fromEntries(Object.keys(live).map(key => [key, live[key as keyof Wave] * (1 - weight) + book.locked[key as keyof Wave] * weight])) as Wave;
        book.wave = wave;
        const target = active ? 1 : 0;
        book.velocity += ((target - book.lift) * 175 - book.velocity * 24) * dt;
        book.lift = Math.max(0, Math.min(1.025, book.lift + book.velocity * dt));
        const neighborDistance = Math.hypot(row - activeRow, col - activeCol);
        const retreat = active ? 0 : Math.max(0, 1 - neighborDistance / 1.8);
        book.retreat += (retreat - book.retreat) * Math.min(1, dt * 7);
        paint(book, wave, book.lift, book.retreat, current.width < 560);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  async function open(book: Book) {
    if (pending.current || paused) return;
    pending.current = true; setSourceId(book.id);
    const prelift = touch.current && !reduced;
    setLoading(prelift ? 'lift' : 'opening');
    try {
      if (prelift) await new Promise<void>(resolve => { touchWait.current = { timer: setTimeout(resolve, 160), resolve }; });
      touchWait.current = null;
      if (!alive.current) return;
      setLoading('opening');
      await onOpen(book);
    } catch (error) { notify(error instanceof Error ? error.message : '未能打开书籍，请重试。'); }
    finally { pending.current = false; if (alive.current) setLoading(null); }
  }
  function keyboard(event: KeyboardEvent<HTMLElement>, index: number) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: layout.columns, ArrowUp: -layout.columns };
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? books.length - 1 : moves[event.key] === undefined ? -1 : index + moves[event.key];
    if (next < 0 || next >= books.length) return;
    event.preventDefault(); setFocusedId(books[next].id); setFocusRequest(books[next].id);
  }
  const slotStyle = (index: number): CSSProperties => ({ left: layout.inset + (index % layout.columns) * (layout.slot + layout.gap), top: Math.floor(index / layout.columns) * layout.rowHeight, width: layout.slot, height: layout.rowHeight, '--ocean-cover-width': `${layout.cover}px`, '--ocean-cover-height': `${layout.coverHeight}px`, '--ocean-rest-top': `${layout.restTop}px` } as CSSProperties);

  return <section ref={root} className={`book-ocean ${activeId ? 'has-active-book' : ''} ${selectedId || loading === 'opening' ? 'is-opening-book' : ''}`} aria-label="流动的封面书架" data-columns={layout.columns} data-row-count={totalRows} data-rendered-count={indexes.filter(index => index < books.length).length} data-motion={reduced ? 'reduced' : running ? 'running' : 'paused'} onPointerMove={event => { if (event.pointerType !== 'mouse') return; pointer.current.x = event.clientX; pointer.current.y = event.clientY; pointer.current.inside = true; pointer.current.movedAt = performance.now(); }} onPointerLeave={() => { pointer.current.inside = false; setHoveredId(null); }}>
    <div className="ocean-atmosphere" aria-hidden="true"><span className="ocean-horizon"/><span className="ocean-mist"/></div>
    {books.length ? <><div className="ocean-caption" aria-hidden="true"><span>STORIES, IN QUIET MOTION</span><i/><span>每本书，都有自己的潮汐</span></div><div className="ocean-book-field" role="list" aria-label="我的藏书" style={{ height: Math.max(440, totalRows * layout.rowHeight + 20) }}>{indexes.map(index => {
      if (index === books.length) return <div className="ocean-import-slot" key="import" style={slotStyle(index)}><button className="ocean-import" onClick={onImport}><span><Plus size={25} strokeWidth={1.2}/></span><strong>让故事继续</strong><small>导入 TXT / EPUB</small></button></div>;
      const book = books[index]; if (!book) return null;
      const row = Math.floor(index / layout.columns); const col = index % layout.columns;
      const active = activeId === book.id;
      const percent = Math.max(0, Math.min(100, Number(progress[book.id]) || 0));
      return <article ref={slotRef(book.id)} key={book.id} className={`ocean-book-slot ${active ? 'is-active' : ''} ${selectedId === book.id || sourceId === book.id ? 'is-selected' : ''}`} role="listitem" aria-posinset={index + 1} aria-setsize={books.length} data-book-id={book.id} data-row={row} data-col={col} data-phase={phaseFor(row, col).toFixed(3)} style={slotStyle(index)} onPointerEnter={event => { if (event.pointerType === 'mouse' && !paused) setHoveredId(book.id); }} onPointerLeave={() => setHoveredId(current => current === book.id ? null : current)} onPointerDownCapture={event => { touch.current = event.pointerType === 'touch'; }} onFocusCapture={() => setFocusedId(book.id)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocusedId(current => current === book.id ? null : current); }} onKeyDown={event => keyboard(event, index)}>
        <span className="ocean-floor-shadow" aria-hidden="true"/>
        <button className="book-open ocean-book-trigger" aria-label={`阅读 ${book.title}`} aria-busy={sourceId === book.id && !!loading} onPointerDown={event => { touch.current = event.pointerType === 'touch'; }} onClick={event => { if (event.detail === 0) touch.current = false; void open(book); }}/>
        <div className="ocean-book-float"><div className="ocean-book-open" aria-hidden="true"><BookCover book={book}/><span className="ocean-open-hint"><BookOpen size={16} strokeWidth={1.4}/>{readingIds.has(book.id) ? '继续阅读' : '翻开故事'}<ArrowUpRight size={14}/></span></div><div className="ocean-book-info"><div className="ocean-title-row"><button className="ocean-book-title" onClick={event => { if (event.detail === 0) touch.current = false; void open(book); }}>{book.title}</button><button className="ocean-details" aria-label={`${book.title} 详情`} onClick={() => onDetails(book)}><MoreHorizontal size={19}/></button></div><p>{book.author || '佚名'}</p><div className="ocean-book-status"><span>{readingIds.has(book.id) ? `已读 ${percent}%` : '等待翻开'}</span><span>{book.format.toUpperCase()}{book.cloudEnabled && <Cloud size={10}/>}</span></div>{readingIds.has(book.id) && <div className="ocean-reading-line" aria-label={`阅读进度 ${percent}%`}><i style={{ width: `${percent}%` }}/></div>}</div></div>
      </article>;
    })}</div></> : <div className="ocean-empty"><span className="ocean-empty-mark"><BookOpen size={39} strokeWidth={.9}/></span><span className="ocean-empty-kicker">A SEA OF UNWRITTEN JOURNEYS</span><h3>把第一本书，放进故事的海。</h3><p>你珍藏的文字，会在这里拥有自己的位置。</p><button className="secondary" onClick={onImport}><Plus size={17}/>导入 TXT / EPUB</button></div>}
  </section>;
}
