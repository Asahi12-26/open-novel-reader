import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, BookOpen, Library, Link2, Plus, RotateCcw, Trash2, Unlink, UserRound } from 'lucide-react';
import type { Series, SeriesAccess } from '../core/series-types';
import {
  addBookToSeries, changeSeriesLink, createSeries, deleteSeries, linkSeriesCharacters, listSeries, listSeriesBookChoices,
  listSeriesBooks, listSeriesGroupMembers, listSeriesPeople, moveSeriesBook, removeBookFromSeries, renameSeries, scopeForSeries,
} from '../services/series';
import type { Book } from '../types';
import { Modal, run, useQuery } from './common';
import './series.css';

interface SeriesPanelProps {
  access: SeriesAccess;
  books: readonly Book[];
  onOpenBook: (book: Book) => void;
  onClose: () => void;
}

interface PersonSelection { bookId: string; characterId: string }
const noPerson: PersonSelection = { bookId: '', characterId: '' };

function SeriesPeople({ series, members, access, busy, change }: {
  series: Series;
  members: readonly Book[];
  access: SeriesAccess;
  busy: boolean;
  change: (operation: () => Promise<void>, message: string) => void;
}) {
  const [left, setLeft] = useState<PersonSelection>(noPerson);
  const [right, setRight] = useState<PersonSelection>(noPerson);
  const [confirmed, setConfirmed] = useState(false);
  const [shareAvatar, setShareAvatar] = useState(false);
  const leftPeople = useQuery(
    () => left.bookId ? listSeriesPeople(series.id, left.bookId, access) : Promise.resolve([]), [series.id, left.bookId, series.scope], [],
  ).filter(row => row.character.bookId === left.bookId);
  const rightPeople = useQuery(
    () => right.bookId ? listSeriesPeople(series.id, right.bookId, access) : Promise.resolve([]), [series.id, right.bookId, series.scope], [],
  ).filter(row => row.character.bookId === right.bookId);
  const leftPerson = leftPeople.find(row => row.character.id === left.characterId);
  const rightPerson = rightPeople.find(row => row.character.id === right.characterId);
  const leftLink = leftPerson?.link;
  const leftGroup = leftLink?.seriesCharacterId;
  const rightGroup = rightPerson?.link?.seriesCharacterId;
  const merge = !!leftGroup && !!rightGroup && leftGroup !== rightGroup;
  const alreadyLinked = !!leftGroup && leftGroup === rightGroup;
  const selectable = !!leftPerson && !!rightPerson && left.bookId !== right.bookId && !alreadyLinked;
  const group = useQuery(async () => ({
    id: leftGroup,
    rows: leftGroup ? await listSeriesGroupMembers(series.id, leftGroup, access) : [],
  }), [series.id, series.scope, leftGroup], undefined);
  const linkedPeople = group?.id === leftGroup ? group?.rows.filter(row => row.bookId !== left.bookId) ?? [] : [];

  function setSelection(set: (selection: PersonSelection) => void, selection: PersonSelection) {
    set(selection);
    setConfirmed(false);
    setShareAvatar(false);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectable || !confirmed || busy) return;
    change(async () => {
      await linkSeriesCharacters(series.id, left, right, shareAvatar, access);
      setConfirmed(false);
      setShareAvatar(false);
    }, merge ? '系列人物已合并，原始身份和头像保留。' : '系列人物关联已保存。');
  }

  function adjust(operation: 'unlink' | 'undo' | 'avatar', message: string) {
    change(() => changeSeriesLink(series.id, left.bookId, left.characterId, operation, access), message);
  }

  return <details className="series-people">
    <summary><UserRound size={17}/>系列人物</summary>
    <p className="muted">只列出各书已读范围内的人物。请确认同一身份后再关联，小说中的名字、对白和人工修改会保留。</p>
    {members.length < 2 && <p className="muted">加入两本书后可以确认跨书人物关系。</p>}
    <form onSubmit={submit}>
      <div className="series-person-pair">
        <fieldset>
          <legend>选择人物</legend>
          <label>书籍<select aria-label="系列人物所属书籍" value={left.bookId} onChange={e => setSelection(setLeft, { bookId: e.target.value, characterId: '' })} disabled={busy}>
            <option value="">选择书籍</option>
            {members.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}
          </select></label>
          <label>人物<select aria-label="系列人物" value={left.characterId} disabled={!leftPeople.length || busy} onChange={e => setSelection(setLeft, { ...left, characterId: e.target.value })}>
            <option value="">选择已读人物</option>
            {leftPeople.map(({ character, link }) => <option key={character.id} value={character.id}>{character.name}{character.aliases.length ? `（${character.aliases.slice(0, 2).join('、')}）` : ''}{link?.seriesCharacterId ? ' · 已关联' : ''}</option>)}
          </select></label>
          {left.bookId && !leftPeople.length && <small>该书当前已读位置没有可选人物。</small>}
        </fieldset>
        <fieldset>
          <legend>匹配另一部作品</legend>
          <label>书籍<select aria-label="关联人物所属书籍" value={right.bookId} onChange={e => setSelection(setRight, { bookId: e.target.value, characterId: '' })} disabled={busy}>
            <option value="">选择另一本书</option>
            {members.filter(book => book.id !== left.bookId).map(book => <option key={book.id} value={book.id}>{book.title}</option>)}
          </select></label>
          <label>人物<select aria-label="关联人物" value={right.characterId} disabled={!rightPeople.length || busy} onChange={e => setSelection(setRight, { ...right, characterId: e.target.value })}>
            <option value="">选择已读人物</option>
            {rightPeople.map(({ character, link }) => <option key={character.id} value={character.id}>{character.name}{character.aliases.length ? `（${character.aliases.slice(0, 2).join('、')}）` : ''}{link?.seriesCharacterId ? ' · 已关联' : ''}</option>)}
          </select></label>
          {right.bookId && !rightPeople.length && <small>该书当前已读位置没有可选人物。</small>}
        </fieldset>
      </div>
      {alreadyLinked && <p role="status">这两个人物已确认为同一系列身份。</p>}
      {selectable && <>
        <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy}/>确认这是同一个人物{merge ? '，并合并两组现有关联' : ''}</label>
        <label className="checkbox-row"><input type="checkbox" checked={shareAvatar} onChange={e => setShareAvatar(e.target.checked)} disabled={busy}/>允许两本书共享各自的本机头像</label>
        <button type="submit" className="primary" disabled={!confirmed || busy}><Link2 size={15}/>{merge ? '确认合并' : '关联为同一人物'}</button>
      </>}
    </form>
    {leftLink && <div className="series-association">
      <span>{leftPerson.character.name} · {leftGroup ? '已关联' : '已解除'}</span>
      {linkedPeople.length > 0 && <ul aria-label="已确认的跨书人物身份">{linkedPeople.map(({ bookTitle, character }) =>
        <li key={character.id}>{bookTitle} · {character.name}{character.aliases.length ? `（${character.aliases.slice(0, 3).join('、')}）` : ''}</li>)}</ul>}
      <div className="series-actions">
        {leftGroup && <button type="button" className="secondary" disabled={busy} onClick={() => adjust('avatar', '系列头像共享设置已保存。')}>{leftLink.shareAvatar ? '停止共享头像' : '共享该书头像'}</button>}
        {leftGroup && <button type="button" className="secondary" disabled={busy} onClick={() => adjust('unlink', '系列关联已解除，原有头像与记录保留。')}><Unlink size={15}/>解除关联</button>}
        {leftLink.history.length > 1 && <button type="button" className="secondary" disabled={busy} onClick={() => adjust('undo', '已恢复上次修改前的关联。')}><RotateCcw size={15}/>撤销上次关联修改</button>}
      </div>
      <details>
        <summary>变更历史 · {leftLink.history.length} 次</summary>
        <ol>{[...leftLink.history].reverse().map(event => <li key={event.id}>{new Date(event.updatedAt).toLocaleString()} · {{
          link: '确认关联', merge: '合并关联', unlink: '解除关联', undo: '撤销修改', avatar: '修改共享头像',
        }[event.operation]}</li>)}</ol>
      </details>
    </div>}
  </details>;
}

function SeriesDetails({ series, access, choices, busy, change, onOpenBook }: {
  series: Series;
  access: SeriesAccess;
  choices: readonly Book[];
  busy: boolean;
  change: (operation: () => Promise<void>, message: string) => void;
  onOpenBook: (book: Book) => void;
}) {
  const [nameDraft, setName] = useState<string>();
  const name = nameDraft ?? series.name;
  const [bookId, setBookId] = useState('');
  const [deleting, setDeleting] = useState(false);
  const entries = useQuery(() => listSeriesBooks(series.id, access), [series.id, series.scope], []);
  return <section className="series-detail">
    <form className="series-inline" onSubmit={event => {
      event.preventDefault();
      if (name.trim() && !busy) change(async () => {
        await renameSeries(series.id, name, access);
        setName(undefined);
      }, '系列名称已保存。');
    }}>
      <label>系列名称<input aria-label="系列名称" maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy}/></label>
      <button type="submit" className="secondary" disabled={busy || !name.trim() || name.trim() === series.name}>保存名称</button>
    </form>
    <div className="series-order">
      <h3>系列书籍</h3>
      <p className="muted">排序用于书架整理。分析时请单独选择可共享的已读内容。</p>
      {entries.length ? <ol className="series-volumes">
        {entries.map(({ book }, index) => <li key={book.id}>
          <button type="button" className="series-book-button" onClick={() => onOpenBook(book)} aria-label={`阅读 ${book.title}`}>
            <BookOpen size={16}/><span>{book.title}</span>
          </button>
          <div className="series-actions">
            <button type="button" className="icon-button" aria-label={`上移 ${book.title}`} disabled={busy || index === 0} onClick={() => change(() => moveSeriesBook(series.id, book.id, -1, access), '系列顺序已保存。')}><ArrowUp size={16}/></button>
            <button type="button" className="icon-button" aria-label={`下移 ${book.title}`} disabled={busy || index === entries.length - 1} onClick={() => change(() => moveSeriesBook(series.id, book.id, 1, access), '系列顺序已保存。')}><ArrowDown size={16}/></button>
            <button type="button" className="icon-button" aria-label={`从系列移除 ${book.title}`} disabled={busy} onClick={() => change(() => removeBookFromSeries(series.id, book.id, access), '已从系列移除，书仍在书架。')}><Unlink size={16}/></button>
          </div>
        </li>)}
      </ol> : <p className="muted">这个系列还没有书籍。</p>}
    </div>
    <form className="series-inline" onSubmit={event => {
      event.preventDefault();
      if (!bookId || busy) return;
      change(async () => { await addBookToSeries(series.id, bookId, access); setBookId(''); }, '已加入系列。');
    }}>
      <label>添加书籍<select aria-label="添加书籍到系列" value={bookId} disabled={busy || !choices.length} onChange={e => setBookId(e.target.value)}>
        <option value="">{choices.length ? '选择书架上的书' : '没有可添加的书'}</option>
        {choices.map(book => <option value={book.id} key={book.id}>{book.title}</option>)}
      </select></label>
      <button type="submit" className="secondary" disabled={!bookId || busy}><Plus size={16}/>加入系列</button>
    </form>
    {access.userId && <small className="muted">将本机书加入系列会把此关联保存在当前账号范围内。云同步仍由你逐书授权。</small>}
    {!!entries.length && <SeriesPeople series={series} members={entries.map(entry => entry.book)} access={access} busy={busy} change={change}/>}
    <div className="series-delete">
      {deleting ? <>
        <p>移除系列和关联？其中的小说、书签和阅读记录会保留。</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => change(() => deleteSeries(series.id, access), '系列已移除，书籍与阅读数据保留。')}>确认移除系列</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => setDeleting(false)}>取消</button>
      </> : <button type="button" className="text-button" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={16}/>移除系列</button>}
    </div>
  </section>;
}

export default function SeriesPanel({ access, books, onOpenBook, onClose }: SeriesPanelProps) {
  const [selectedId, setSelectedId] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const scope = scopeForSeries(access);
  const rows = useQuery(() => listSeries(access), [scope], []).filter(row => row.scope === scope);
  const choices = useQuery(() => listSeriesBookChoices(access, books), [scope, books], []);
  const selected = rows.find(row => row.id === selectedId) || rows[0];

  function change(action: () => Promise<void>, message: string) {
    if (busy) return;
    setBusy(true);
    void run(action, message).finally(() => setBusy(false));
  }

  return <Modal title="书籍系列" wide onClose={onClose}>
    <div className="series-panel">
      <form className="series-inline" onSubmit={event => {
        event.preventDefault();
        if (!newName.trim()) return;
        change(async () => {
          const series = await createSeries(newName, access);
          setNewName('');
          setSelectedId(series.id);
        }, '系列已创建。');
      }}>
        <label>新系列<input aria-label="新系列名称" placeholder="输入系列名称" maxLength={100} value={newName} onChange={e => setNewName(e.target.value)} disabled={busy}/></label>
        <button type="submit" className="primary" disabled={busy || !newName.trim()}><Plus size={16}/>创建系列</button>
      </form>
      {rows.length > 0 ? <>
        <label className="series-picker"><Library size={17}/><select aria-label="选择系列" value={selected?.id ?? ''} disabled={busy} onChange={e => setSelectedId(e.target.value)}>
          {rows.map(series => <option key={series.id} value={series.id}>{series.name}</option>)}
        </select></label>
        {selected && <SeriesDetails key={selected.id} series={selected} access={access} choices={choices} busy={busy} change={change} onOpenBook={onOpenBook}/>}
      </> : <div className="series-empty"><Library size={24}/><p>创建系列后，可整理多部小说并确认跨书人物身份。</p></div>}
    </div>
  </Modal>;
}
