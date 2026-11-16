import { useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, ChevronRight, Search, UserRoundPlus, Users } from 'lucide-react';
import { createCharacter, mergeCharacters, renameCharacter } from '../services/ai';
import { manualAddAlias, manualRemoveAlias } from '../services/character-identity';
import type { Character, CharacterIdentityEvent, Dialogue, IdentityLocation } from '../types';
import { CharacterAvatarView } from './CharacterAvatar';
import CharacterAvatarEditor from './CharacterAvatarEditor';
import { Modal, notify, run } from './common';

export interface CharacterProfile {
  firstAppearance?: IdentityLocation & { chapterTitle: string };
  image?: Blob;
  ownImage?: Blob;
  dialogues: readonly Dialogue[];
  history: readonly CharacterIdentityEvent[];
  retainedAvatars?: readonly { id: string; name: string; image: Blob }[];
}

interface GalleryProps {
  bookId: string;
  people: readonly Character[];
  getProfile: (id: string) => CharacterProfile | undefined;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  scope: IdentityLocation;
  showAll: boolean;
  onShowAll: (enabled: boolean) => void;
  onJump: (dialogue: Dialogue) => void;
  onClose: () => void;
  onBack?: () => void;
  onAssign?: (dialogue: Dialogue) => void;
}

const collator = new Intl.Collator(['zh-CN', 'en']);
const galleryPage = 30;
const dialoguePage = 10;
const historyPage = 15;
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();

function describeIdentity(event: CharacterIdentityEvent) {
  if (event.kind === 'rename') return `改名为 ${event.value}`;
  if (event.kind === 'alias') return `${event.active === false ? '移除' : '添加'}别名 ${event.value}`;
  return '合并人物';
}

function CharacterCard({ person, profile, bookId, scope, people, onBack, onSelect, onJump, onAssign }: {
  person: Character;
  profile?: CharacterProfile;
  bookId: string;
  scope: IdentityLocation;
  people: readonly Character[];
  onBack: () => void;
  onSelect: (id: string) => void;
  onJump: (dialogue: Dialogue) => void;
  onAssign?: (dialogue: Dialogue) => void;
}) {
  const [draftName, setDraftName] = useState<string>();
  const [alias, setAlias] = useState('');
  const [mergeId, setMergeId] = useState('');
  const [shown, setShown] = useState(dialoguePage);
  const [shownEvents, setShownEvents] = useState(historyPage);
  const [saving, setSaving] = useState(false);
  const first = profile?.firstAppearance;
  const records = profile?.dialogues ?? [];
  const history = profile?.history ?? [];
  const retained = profile?.retainedAvatars ?? [];
  const name = draftName ?? person.name;
  const mergeTarget = people.find(other => other.id === mergeId && other.id !== person.id);

  function edit(action: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    void run(action).finally(() => setSaving(false));
  }

  function saveName(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === person.name) return;
    edit(async () => {
      await renameCharacter(person.id, next, scope);
      setDraftName(undefined);
      notify('人物名称已保存。');
    });
  }

  function addAlias(event: FormEvent) {
    event.preventDefault();
    const next = alias.trim();
    if (!next) return;
    if ([person.name, ...person.aliases].some(known => normalize(known) === normalize(next))) {
      notify('该名称已存在。');
      return;
    }
    edit(async () => {
      await manualAddAlias(person.id, next, scope);
      setAlias('');
    });
  }

  return <section className="person-profile">
    <button className="text-button person-profile-back" onClick={onBack}><ArrowLeft size={16}/>返回人物列表</button>
    <div className="person-profile-hero">
      <CharacterAvatarView character={person} image={profile?.image} size="editor"/>
      <div className="person-profile-headline">
        <h3>{person.name}</h3>
        <dl className="person-facts">
          <div><dt>首次出现</dt><dd>{first ? `${first.chapterTitle} · 第 ${first.paragraphIndex + 1} 段` : '未知'}</dd></div>
          <div><dt>已识别对白</dt><dd>{records.length} 句</dd></div>
        </dl>
      </div>
    </div>
    <CharacterAvatarEditor bookId={bookId} characterId={person.id} image={profile?.image}/>
    <div className="person-profile-section">
      <h4>名称与别名</h4>
      <form className="person-action-form" onSubmit={saveName}>
        <input aria-label={`人物 ${person.name} 名称`} value={name} onChange={event => setDraftName(event.target.value)} maxLength={80}/>
        <button className="secondary" type="submit" disabled={saving || !name.trim() || name.trim() === person.name}>保存名称</button>
      </form>
      <div className="person-aliases">
        {person.aliases.length ? person.aliases.map(value => <span key={value}>{value}
          <button type="button" aria-label={`移除 ${person.name} 的别名 ${value}`} disabled={saving} onClick={() => edit(() => manualRemoveAlias(person.id, value, scope))}>×</button>
        </span>) : <small>暂无已知别名</small>}
      </div>
      <form className="person-action-form" onSubmit={addAlias}>
        <input aria-label={`为 ${person.name} 添加别名`} placeholder="添加已知别名" value={alias} onChange={event => setAlias(event.target.value)} maxLength={80}/>
        <button className="secondary" type="submit" disabled={saving || !alias.trim()}>添加别名</button>
      </form>
    </div>
    <details className="person-profile-section person-details">
      <summary>身份变更记录 <span>{history.length}</span></summary>
      {history.length > 0 ? <ul className="person-history">{history.slice(-shownEvents).map(event => <li key={event.id}>
        <strong>第 {event.at.chapterIndex + 1} 章 · {event.source === 'manual' ? '人工' : 'AI'}</strong>
        <span>{describeIdentity(event)}</span>
        {event.evidence && <small>{event.evidence.text}</small>}
      </li>)}</ul> : <p className="portrait-hint">当前范围内暂无身份变更。</p>}
      {shownEvents < history.length && <button type="button" className="secondary" onClick={() => setShownEvents(shownEvents + historyPage)}>显示更早记录</button>}
      {retained.length > 0 && <div className="person-retained">
        <p>合并保留的头像</p>
        <ul>{retained.map(item => <li key={item.id}><CharacterAvatarView character={item} image={item.image}/><span>{item.name}</span></li>)}</ul>
      </div>}
    </details>
    <details className="person-profile-section person-details">
      <summary>相关对白 <span>{records.length}</span></summary>
      {records.length > 0 ? <ol className="person-dialogues">{records.slice(0, shown).map(dialogue => <li key={dialogue.id}>
        <p>{dialogue.text}</p>
        <div className="person-dialogue-actions">
          <button type="button" className="text-button" onClick={() => onJump(dialogue)}>跳转到正文 <ArrowUpRight size={14}/></button>
          {onAssign && <button type="button" className="text-button" onClick={() => onAssign(dialogue)}>更正人物</button>}
        </div>
      </li>)}</ol> : <p className="portrait-hint">当前范围内暂无相关对白。</p>}
      {shown < records.length && <button type="button" className="secondary" onClick={() => setShown(shown + dialoguePage)}>显示更多对白</button>}
    </details>
    {people.length > 1 && <details className="person-profile-section person-details">
      <summary>合并人物</summary>
      <p className="portrait-hint">将此人物合并到同一身份。原对白、头像和身份记录会保留。</p>
      <div className="person-action-form">
        <select aria-label={`合并 ${person.name}`} value={mergeTarget?.id ?? ''} onChange={event => setMergeId(event.target.value)} disabled={saving}>
          <option value="">选择合并目标</option>
          {people.filter(other => other.id !== person.id).map(other => <option value={other.id} key={other.id}>{other.name}</option>)}
        </select>
        <button type="button" className="secondary" disabled={saving || !mergeTarget} onClick={() => {
          if (!mergeTarget) return;
          edit(async () => {
            await mergeCharacters(person.id, mergeTarget.id, scope);
            onSelect(mergeTarget.id);
            notify('人物已合并，原对白、头像和身份记录已保留。');
          });
        }}>确认合并</button>
      </div>
    </details>}
  </section>;
}

export default function CharacterGallery({ bookId, people, getProfile, selectedId, onSelect, scope, showAll, onShowAll, onJump, onClose, onBack, onAssign }: GalleryProps) {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<'appearance' | 'name'>('appearance');
  const [shown, setShown] = useState(galleryPage);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const person = people.find(item => item.id === selectedId);
  const rows = useMemo(() => {
    const keyword = normalize(query);
    const filtered = people.filter(item => !keyword || [item.name, ...item.aliases].some(value => normalize(value).includes(keyword)));
    const entries = filtered.map(item => ({ person: item, profile: getProfile(item.id) }));
    entries.sort((a, b) => {
      if (order === 'appearance') {
        const first = a.profile?.firstAppearance;
        const second = b.profile?.firstAppearance;
        if (first && second) {
          const location = first.chapterIndex - second.chapterIndex || first.paragraphIndex - second.paragraphIndex || first.offset - second.offset;
          if (location) return location;
        } else if (first || second) return first ? -1 : 1;
      }
      return collator.compare(a.person.name, b.person.name) || a.person.id.localeCompare(b.person.id);
    });
    return entries;
  }, [people, getProfile, query, order]);

  function addPerson(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    void run(async () => {
      const created = await createCharacter(bookId, name, scope);
      setNewName('');
      setQuery('');
      onSelect(created.id);
    }).finally(() => setCreating(false));
  }

  return <Modal key={person?.id ?? 'gallery'} title={person ? '人物卡片' : '书中的人物'} onClose={onClose} wide>
    <div className="person-gallery">
      {person ? <CharacterCard key={person.id}
        person={person} profile={getProfile(person.id)} people={people} bookId={bookId} scope={scope}
        onBack={onBack ?? (() => onSelect(null))} onSelect={onSelect} onJump={onJump} onAssign={onAssign}/> : <>
        <div className="person-gallery-tools">
          <label className="person-search"><Search size={17}/><input type="search" aria-label="搜索人物" placeholder="搜索名称或别名" value={query}
            onChange={event => { setQuery(event.target.value); setShown(galleryPage); }}/></label>
          <select aria-label="人物排序" value={order} onChange={event => { setOrder(event.target.value as typeof order); setShown(galleryPage); }}>
            <option value="appearance">按首次出现排序</option><option value="name">按名称排序</option>
          </select>
        </div>
        <label className="checkbox-row person-spoiler"><input aria-label="显示全书人物信息（可能剧透）" type="checkbox" checked={showAll}
          onChange={event => { onShowAll(event.target.checked); setShown(galleryPage); }}/>显示全书人物信息（可能剧透）</label>
        {rows.length ? <ul className="person-card-grid">{rows.slice(0, shown).map(({ person: item, profile }) => <li key={item.id}>
          <button className="person-grid-card" aria-label={`查看人物 ${item.name}`} onClick={() => onSelect(item.id)}>
            <CharacterAvatarView character={item} image={profile?.image}/>
            <span className="person-grid-copy">
              <strong>{item.name}</strong>
              {item.aliases.length > 0 && <small>{item.aliases.join(' · ')}</small>}
              <span className="person-card-location"><BookOpen size={13}/>{profile?.firstAppearance ? `第 ${profile.firstAppearance.chapterIndex + 1} 章` : '首次出现未知'}</span>
            </span>
            <ChevronRight size={16}/>
          </button>
        </li>)}</ul> : <div className="modal-empty person-grid-empty"><Users size={28}/><p>{people.length ? '没有匹配的人物。' : '当前阅读范围内暂无人物，可以手动添加。'}</p></div>}
        {shown < rows.length && <button className="secondary person-show-more" onClick={() => setShown(shown + galleryPage)}>显示更多人物</button>}
        <form className="person-action-form person-add" onSubmit={addPerson}>
          <input aria-label="添加人物名称" placeholder="新人物名称" maxLength={80} value={newName} onChange={event => setNewName(event.target.value)}/>
          <button className="secondary" type="submit" disabled={creating || !newName.trim()}><UserRoundPlus size={16}/>添加人物</button>
        </form>
      </>}
    </div>
  </Modal>;
}
