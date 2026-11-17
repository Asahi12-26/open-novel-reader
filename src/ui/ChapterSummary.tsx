import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BookOpenText, Flag, Pencil, RefreshCw } from 'lucide-react';
import { db } from '../core/db';
import type { PlotEventRecord, PlotKind } from '../core/plot-types';
import { MAX_MANUAL_SUMMARY, MAX_PLOT_DESCRIPTION } from '../core/plot-records';
import type { Chapter, Character, IdentityLocation } from '../types';
import { chapterPlotEnd, comparePlotLocations, plotOwner, projectChapterSummary, projectPlotEvent, reviseChapterSummary, revisePlotEvent } from '../services/plot-memory';
import { Modal, run, useQuery } from './common';
import './chapter-summary.css';

interface Props {
  chapter: Chapter;
  scope: IdentityLocation;
  resolveCharacter: (id: string | null) => Character | undefined;
  onCharacter: (id: string) => void;
  onRegenerate?: (chapter: Chapter) => void;
  onClose?: () => void;
}

const labels: Record<PlotKind, string> = { fact: '原文陈述', claim: '人物说法', inference: 'AI 推断', user: '人工确认' };

function PlotEventCard({ record, scope, owner, resolveCharacter, onCharacter }: Pick<Props, 'scope' | 'resolveCharacter' | 'onCharacter'> & {
  record: PlotEventRecord;
  owner: { value: unknown } | undefined;
}) {
  const { current, history, conflict } = projectPlotEvent(record, scope);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState('');
  const [relation, setRelation] = useState('');
  const [busy, setBusy] = useState(false);
  if (!current) return null;
  const event = current;
  const names = [...new Map(event.characterIds.flatMap(id => {
    const person = resolveCharacter(id);
    return person ? [[person.id, person] as const] : [];
  })).values()];

  function save(change: { description: string; relation?: string; reject?: boolean }) {
    if (!owner || busy) return;
    setBusy(true);
    void run(async () => {
      await revisePlotEvent(record.id, change, scope, owner.value);
      setEditing(false);
    }, change.reject ? '已标记剧情错误。' : '剧情记录已更新。').finally(() => setBusy(false));
  }

  return <li className="plot-event">
    <div className="plot-event-meta">
      <span className={'plot-kind ' + event.kind}>{event.status === 'rejected' ? '已标记错误' : labels[event.kind]}</span>
      {conflict && <span className="plot-warning">版本冲突，待核对</span>}
      {event.source === 'ai' && <span>AI 置信度 {Math.round(event.confidence * 100)}%</span>}
    </div>
    <p>{event.description}</p>
    {event.relation && <small>关系变化　{event.relation}</small>}
    {names.length > 0 && <div className="plot-persons">{names.map(person => <button type="button" key={person.id} onClick={() => onCharacter(person.id)}>{person.name}</button>)}</div>}
    <details className="plot-evidence">
      <summary>原文依据 · 第 {event.evidence.paragraphIndex + 1} 段</summary>
      <blockquote>{event.evidence.text}</blockquote>
    </details>
    {editing ? <form className="plot-edit" onSubmit={submit => { submit.preventDefault(); save({ description, relation }); }}>
      <label>剧情说明<textarea value={description} aria-label="修改剧情说明" rows={2} maxLength={MAX_PLOT_DESCRIPTION} onChange={change => setDescription(change.target.value)} required/></label>
      <label>关系变化<input value={relation} aria-label="修改人物关系" maxLength={MAX_PLOT_DESCRIPTION} onChange={change => setRelation(change.target.value)}/></label>
      <div className="plot-actions"><button className="secondary" disabled={busy || !description.trim()}>确认剧情修订</button><button type="button" onClick={() => setEditing(false)} className="text-button">取消</button></div>
    </form> : <div className="plot-actions">
      <button type="button" className="text-button" disabled={!owner || busy} onClick={() => { setDescription(event.description); setRelation(event.relation ?? ''); setEditing(true); }}>纠正或确认</button>
      {event.status !== 'rejected' && <button type="button" className="text-button" disabled={!owner || busy} onClick={() => save({ description: event.description, relation: event.relation, reject: true })}>标记剧情错误</button>}
    </div>}
    {history.length > 1 && <details className="plot-evidence">
      <summary>剧情修订记录</summary>
      <ol className="plot-revisions">{history.slice().reverse().map(row => <li key={row.id}>
        <small>{row.status === 'rejected' ? '已标记错误' : labels[row.kind]}</small>
        <span>{row.description}</span>
        {row.relation && <small>{row.relation}</small>}
        {row.id !== event.id && <button type="button" className="text-button" disabled={!owner || busy} onClick={() => save({ description: row.description, relation: row.relation, reject: row.status === 'rejected' })}>采用此版本</button>}
      </li>)}</ol>
    </details>}
  </li>;
}

export default function ChapterSummary({ chapter, scope, resolveCharacter, onCharacter, onRegenerate, onClose }: Props) {
  const [expanded, setExpanded] = useState(!!onClose);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState<{ value: unknown }>();
  useEffect(() => {
    let active = true;
    setOwner(undefined);
    void run(async () => {
      const value = await plotOwner(chapter.bookId);
      if (active) setOwner({ value });
    });
    return () => { active = false; };
  }, [chapter.bookId]);
  const record = useQuery(() => db.chapterSummaries.get(chapter.id), [chapter.id], undefined);
  const events = useQuery(() => expanded ? db.plotEvents.where('chapterId').equals(chapter.id).toArray() : Promise.resolve([]), [chapter.id, expanded], []);
  const dialogues = useQuery(() => expanded ? db.dialogues.where('chapterId').equals(chapter.id).toArray() : Promise.resolve([]), [chapter.id, expanded], []);
  const projected = useMemo(() => record?.chapterId === chapter.id && record.bookId === chapter.bookId ?
    projectChapterSummary(record, chapter, scope) : undefined, [record, chapter, scope]);
  const chapterRead = comparePlotLocations(chapterPlotEnd(chapter), scope) <= 0;
  const opened = onClose || expanded;
  const visibleEvents = opened ? events.filter(row => row.chapterId === chapter.id && row.bookId === chapter.bookId &&
    projectPlotEvent(row, scope).current).sort((a, b) => comparePlotLocations(a.order, b.order) || a.id.localeCompare(b.id)) : [];
  const people = useMemo(() => {
    const visible = new Map<string, Character>();
    const ids = [
      ...(projected?.characterIds ?? []),
      ...dialogues.filter(row => row.chapterId === chapter.id && row.bookId === chapter.bookId && row.verifiedQuote !== false &&
        comparePlotLocations({ chapterIndex: chapter.index, paragraphIndex: row.paragraphIndex, offset: row.end }, scope) <= 0)
        .map(row => row.characterId),
    ];
    for (const id of ids) {
      const person = resolveCharacter(id);
      if (person) visible.set(person.id, person);
    }
    return [...visible.values()].slice(0, 16);
  }, [chapter, dialogues, projected, resolveCharacter, scope]);

  function save(text: string, flag = false) {
    if (busy || !owner || !projected?.text) return;
    setBusy(true);
    void run(async () => {
      await reviseChapterSummary(chapter.id, text, flag, scope, owner.value);
      setEditing(false);
    }, flag ? '已标记简介错误。' : '章节简介已保存。').finally(() => setBusy(false));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.trim()) save(draft);
  }

  const body = <>
    {!projected?.text && visibleEvents.length === 0 ? <p className="plot-note">{chapterRead ? '本章暂无已保存的剧情简介。' : '读到相应位置后可查看本章简介。'}</p> : <>
      {projected?.text && <>
        <div className="plot-overview-meta">
          <span>{projected.source === 'manual' ? '人工修订' : 'AI 生成'}</span>
          {!projected.complete && <span>已读范围</span>}
          {projected.flagged && <span className="plot-warning">已标记简介错误</span>}
        </div>
        <p className="plot-overview-text">{projected.text}</p>
        {projected.evidence.length > 0 && <details className="plot-evidence">
          <summary>查看简介依据</summary>
          <ol className="plot-revisions">{projected.evidence.slice(0, 30).map((item, index) => <li key={`${item.paragraphIndex}:${item.start}:${index}`}>
            <small>第 {item.paragraphIndex + 1} 段</small><span>{item.text}</span>
          </li>)}</ol>
        </details>}
        {editing ? <form className="plot-edit" onSubmit={submit}>
          <label>修改本章简介<textarea value={draft} rows={5} maxLength={MAX_MANUAL_SUMMARY} onChange={event => setDraft(event.target.value)} required/></label>
          <div className="plot-actions"><button className="secondary" disabled={busy || !draft.trim()}>保存简介</button><button className="text-button" type="button" onClick={() => setEditing(false)}>取消</button></div>
        </form> : <div className="plot-actions">
          <button className="text-button" type="button" disabled={!owner || busy} onClick={() => { setDraft(projected.text); setEditing(true); }}><Pencil size={14}/>修改简介</button>
          {!projected.flagged && <button className="text-button" type="button" disabled={!owner || busy} onClick={() => save('', true)}><Flag size={14}/>标记简介错误</button>}
        </div>}
        {projected.revisions.length > 0 && <details className="plot-evidence">
          <summary>简介修订记录</summary>
          <ol className="plot-revisions">{projected.revisions.slice().reverse().map(row => <li key={row.id}>
            <small>{row.status === 'flagged' ? '错误标记' : '人工修订'}</small>
            <span>{row.text}</span>
            <button className="text-button" type="button" disabled={!owner || busy} onClick={() => save(row.text)}>恢复此简介</button>
          </li>)}</ol>
        </details>}
      </>}
      {people.length > 0 && <div className="plot-persons" aria-label="本章已知人物">{people.map(person => <button type="button" key={person.id} onClick={() => onCharacter(person.id)}>{person.name}</button>)}</div>}
      {visibleEvents.length > 0 && <section className="plot-events" aria-label="关键事件与人物关系">
        <h3>关键事件与人物关系</h3>
        <ol>{visibleEvents.map(row => <PlotEventCard key={row.id} record={row} scope={scope} owner={owner} resolveCharacter={resolveCharacter} onCharacter={onCharacter}/>)}</ol>
      </section>}
    </>}
    {onRegenerate && chapterRead && <button type="button" className="secondary plot-regenerate" onClick={() => onRegenerate(chapter)}><RefreshCw size={15}/>{projected?.text ? '重新生成简介…' : '生成本章简介…'}</button>}
  </>;

  if (onClose) return <Modal title={`${chapter.title} · 剧情简介`} onClose={onClose} wide><div className="chapter-summary-content">{body}</div></Modal>;
  return <details className="chapter-summary" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><BookOpenText size={18}/>本章剧情简介</summary>
    {expanded && <div className="chapter-summary-content">{body}</div>}
  </details>;
}
