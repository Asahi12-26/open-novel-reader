import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, LoaderCircle, Pause, Play, RotateCcw, Sparkles, Square } from 'lucide-react';
import type { Chapter, Character, Dialogue } from '../types';
import { AI_MODELS, hasAIKey, type AIModel } from '../services/ai';
import { analyzeBook, estimateBookAnalysis, listBookAnalysisJobs, MAX_BOOK_ANALYSIS_BUDGET_USD } from '../services/book-analysis';
import type { BookAnalysisController, BookAnalysisEstimate, BookAnalysisJob, BookAnalysisMode } from '../services/book-analysis-types';
import type { IdentityScope } from '../services/character-identity';
import { Modal, notify, useQuery } from './common';

const statusText: Record<BookAnalysisJob['status'], string> = {
  queued: '准备中', running: '正在分析', paused: '已暂停', waiting: '等待阅读推进',
  failed: '任务已安全停止', cancelled: '本次会话已停止', done: '整书分析完成',
};
const stageText: Record<BookAnalysisJob['stage'], string> = {
  preparing: '预处理章节与对白', analyzing: '识别对白与统一人物', reviewing: '复核未知与冲突', done: '结果已保存',
};

export default function BookAnalysisPanel({ bookId, chapters, dialogues, getCharacter, scope, showAll, openRevision = 0, onActivity, onClose, onViewResults }: {
  bookId: string; chapters: Chapter[]; scope: IdentityScope; showAll: boolean;
  dialogues: readonly Dialogue[]; getCharacter: (id: string | null) => Character | undefined;
  openRevision?: number; onActivity?: (active: boolean) => void;
  onClose: () => void; onViewResults: (chapter: Chapter, paragraphIndex: number) => void;
}) {
  const [mode, setMode] = useState<BookAnalysisMode>('reading-progress');
  const [model, setModel] = useState<AIModel>('deepseek-flash');
  const [budget, setBudget] = useState('0.10');
  const [authorized, setAuthorized] = useState(false);
  const [keyReady, setKeyReady] = useState(hasAIKey);
  const [working, setWorking] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [error, setError] = useState('');
  const [estimateError, setEstimateError] = useState('');
  const [estimate, setEstimate] = useState<BookAnalysisEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [snapshot, setSnapshot] = useState<BookAnalysisJob | null>(null);
  const controller = useRef<BookAnalysisController | null>(null);
  const mounted = useRef(true);
  const initialized = useRef(false);
  const records = useQuery(async () => ({ loaded: true, jobs: await listBookAnalysisJobs(bookId) }), [bookId], { loaded: false, jobs: [] as BookAnalysisJob[] });
  const jobs = useMemo(() => records.jobs.filter(item => item.bookId === bookId).sort((a, b) => b.updatedAt - a.updatedAt), [records.jobs, bookId]);
  const saved = jobs.find(item => item.id === selectedId);
  const job = snapshot?.id === selectedId ? snapshot : saved;
  const chaptersById = useMemo(() => new Map(chapters.map(chapter => [chapter.id, chapter])), [chapters]);
  const visibleDialogues = useMemo(() => minimized ? [] : dialogues.filter(item => {
    if (item.bookId !== bookId) return false;
    if (showAll) return true;
    const index = chaptersById.get(item.chapterId)?.index;
    return index !== undefined && (index < scope.chapterIndex || (index === scope.chapterIndex && (item.paragraphIndex < scope.paragraphIndex || (item.paragraphIndex === scope.paragraphIndex && item.end <= scope.offset))));
  }), [minimized, dialogues, bookId, showAll, chaptersById, scope]);
  const uncertain = visibleDialogues.filter(item => !item.characterId || item.confidence < .85);
  const budgetValue = Number(budget);
  const validBudget = Number.isFinite(budgetValue) && budgetValue > 0 && budgetValue <= MAX_BOOK_ANALYSIS_BUDGET_USD;
  const resumable = !!job && job.status !== 'done';
  const locked = working || !!job;
  const estimateScopeKey = mode === 'reading-progress' ? `${scope.chapterIndex}:${scope.paragraphIndex}:${scope.offset}` : 'deep';

  const selectJob = (next?: BookAnalysisJob) => {
    setSelectedId(next?.id || ''); setSnapshot(null); setError(''); setAuthorized(false); setPauseRequested(false);
    setMode(next?.mode || 'reading-progress'); setModel(next?.model || 'deepseek-flash'); setBudget(next ? String(next.budgetUsd) : '0.10');
  };
  useEffect(() => { setMinimized(false); }, [openRevision]);
  useEffect(() => { onActivity?.(working); }, [working, onActivity]);
  useEffect(() => {
    if (initialized.current || !records.loaded) return;
    initialized.current = true;
    selectJob(jobs[0]);
  }, [records.loaded, jobs[0]?.id]);
  useEffect(() => {
    mounted.current = true;
    const changed = () => { setKeyReady(hasAIKey()); setAuthorized(false); };
    window.addEventListener('onr-ai-key-changed', changed);
    return () => { mounted.current = false; controller.current?.cancel(); window.removeEventListener('onr-ai-key-changed', changed); };
  }, []);
  useEffect(() => {
    if (locked || minimized) { setEstimating(false); return; }
    let stale = false;
    setEstimate(null); setEstimateError(''); setEstimating(true);
    // Scrolling must not start a full-book preprocessing pass for every character offset.
    const timer = setTimeout(() => {
      void estimateBookAnalysis(bookId, model, mode).then(value => { if (!stale) setEstimate(value); }).catch(failure => {
        if (!stale) setEstimateError(failure instanceof Error ? failure.message : '无法计算分析范围，请检查本机书库。');
      }).finally(() => { if (!stale) setEstimating(false); });
    }, 350);
    return () => { stale = true; clearTimeout(timer); };
  }, [bookId, model, mode, estimateScopeKey, locked, minimized]);

  async function start(resume: boolean) {
    if (controller.current || !authorized || !keyReady || !validBudget) return;
    setAuthorized(false); setWorking(true); setPauseRequested(false); setError('');
    try {
      const task = analyzeBook({ bookId, mode, model, budgetUsd: budgetValue, authorized: true, jobId: resume ? job?.id : undefined,
        onProgress: next => { if (mounted.current) { setSelectedId(next.id); setSnapshot(next); } },
      });
      controller.current = task;
      const result = await task.done;
      if (mounted.current) {
        setSelectedId(result.id); setSnapshot(result);
        if (result.status === 'done') notify('整书分析完成，识别结果与人物信息已保存。');
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '整书任务未能启动，已保存结果保留。');
    } finally {
      controller.current = null;
      if (mounted.current) { setWorking(false); setPauseRequested(false); }
    }
  }
  const close = () => {
    if (controller.current) { controller.current.cancel(); notify('整书分析会话已停止，已完成结果、进度与费用预留均保留。'); }
    onClose();
  };
  const viewDialogue = (item: Dialogue) => {
    const chapter = chaptersById.get(item.chapterId);
    if (chapter) { setMinimized(true); onViewResults(chapter, item.paragraphIndex); }
  };
  const displayStatus = job ? !working && ['queued', 'running', 'paused', 'waiting'].includes(job.status) ? '上次会话已中断，重新授权后可继续' : statusText[job.status] : '尚未启动';

  if (minimized) return <aside className="book-analysis-dock" aria-label="整书分析任务">
    <div><strong>{displayStatus}</strong><small>{job?.completedChunks || 0} / {job?.totalChunks || 0} 分片 · 已预留 ${(job?.reservedUsd || 0).toFixed(4)}</small></div>
    <button className="secondary" onClick={() => setMinimized(false)}>查看整书任务</button>
    <button className="icon-button" aria-label="停止整书分析会话" onClick={close}><Square size={16}/></button>
  </aside>;

  return <Modal title="整本书深度分析" onClose={close} wide>
    <div className="ai-intro"><span><Sparkles size={25}/></span><div><h3>让整本书里的人物连起来</h3><p>按章节分批识别，统一人物、别名与证据，保留人工纠正。</p></div></div>
    <p className="muted">一次授权可在固定总预算内自动推进。本地预处理与查看结果不收费；不会把整本书一次发送给模型。</p>
    {jobs.length > 0 && <label className="form-label">本机任务记录<select aria-label="本机任务记录" value={selectedId} disabled={working} onChange={event => selectJob(jobs.find(item => item.id === event.target.value))}><option value="">新建整书任务</option>{jobs.map(item => <option key={item.id} value={item.id}>{item.mode === 'deep' ? '整本书' : '阅读进度'} · {statusText[item.status]} · {new Date(item.createdAt).toLocaleString()}</option>)}</select></label>}
    <label className="form-label">分析范围<select aria-label="整书分析范围" value={mode} disabled={locked} onChange={event => { setMode(event.target.value as BookAnalysisMode); setAuthorized(false); }}><option value="reading-progress">阅读进度模式</option><option value="deep">整本书深度模式</option></select></label>
    <p className="fine-print">{mode === 'reading-progress' ? '仅发送已读到的完整对白。本次活动会话可随阅读推进继续分析；可返回阅读，未读正文不会提前发送。关闭会话或重启应用后，必须重新载入密钥并授权。' : '明确选择后可分析全书。阅读界面默认按当前阅读位置隐藏未来人物名称、别名和身份揭示，不展示剧情摘要。'}</p>
    <label className="form-label">模型<select aria-label="整书分析模型" value={model} disabled={locked} onChange={event => { setModel(event.target.value as AIModel); setAuthorized(false); }}>{AI_MODELS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {estimating && <p className="muted" role="status"><LoaderCircle className="spin" size={16}/>正在本机预处理与估算…</p>}
    {!locked && estimateError && <p className="inline-error" role="alert">{estimateError}</p>}
    {!locked && estimate && <div className="estimate-box" aria-label="整书费用估算">
      <div><span>{mode === 'deep' ? '全书范围' : '当前已读范围'}</span><strong>{estimate.chapterCount} / {estimate.totalChapters} 章 · {estimate.dialogueCount} 句对白</strong></div>
      <div><span>识别分片 / 复核请求上界</span><strong>{estimate.totalChunks} / {estimate.reviewRequests}</strong></div>
      <div><span>预计请求量（含必要复核）</span><strong>最多 {estimate.maxRequests} 次</strong></div>
      <div><span>费用估算范围</span><strong>${estimate.estimatedMinUsd.toFixed(4)}–${estimate.estimatedMaxUsd.toFixed(4)}</strong></div>
      <small>这是按公开价格和输出上限计算的预留范围，不是供应商账单硬上限。失败、取消或超时可能计费；重试不退回已预留费用。{mode === 'reading-progress' && ' 随阅读追加的内容仍受同一总预算限制。'}</small>
    </div>}
    <label className="form-label">整书任务累计总预算（美元）<input aria-label="整书任务累计总预算（美元）" type="number" min="0.001" max={MAX_BOOK_ANALYSIS_BUDGET_USD} step="0.001" value={budget} disabled={locked} onChange={event => { setBudget(event.target.value); setAuthorized(false); }}/></label>
    {!locked && validBudget && estimate && budgetValue < estimate.estimatedMaxUsd && <p className="inline-warning">总预算低于估算上界。任务只在总预算内推进，可能提前停止并保留已完成结果。</p>}
    {!locked && mode === 'deep' && estimate?.dialogueCount === 0 && <p className="fine-print">当前版本未在这本书里定位到可分析的对白。</p>}
    {job && <p className="fine-print">原任务的模式、模型和总预算已固定。继续会保留全部费用预留；需要不同设置时，请明确新建任务。</p>}
    {!keyReady && <p className="inline-warning">需在「设置 → AI 模型」重新载入本次会话密钥。已保存结果和进度仍可查看，不会自动发起请求。</p>}
    <label className="checkbox-row authorization"><input aria-label="授权整书任务" type="checkbox" checked={authorized} disabled={working} onChange={event => setAuthorized(event.target.checked)}/>我明确同意发送上述范围内的对白、必要上下文及人物证据，授权本次整书会话在固定累计预算内自动推进与必要复核。{mode === 'reading-progress' && '本次活动会话可随我的阅读进度继续。'}失败后的收费重试须由我再次授权。</label>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {job && <section className="job-status" aria-label="整书任务进度" aria-live="polite">
      <div><strong>{displayStatus}</strong><span>{stageText[job.stage]}</span></div>
      <progress aria-label="整书分析进度" max={Math.max(1, job.totalChunks)} value={job.completedChunks}/>
      <p>{job.completedChapters} / {job.chapters.length} 章节段 · {job.completedChunks} / {job.totalChunks} 分片 · {job.completedReviews} / {job.reviewRequests} 复核</p>
      <p className="fine-print">累计已预留 ${job.reservedUsd.toFixed(4)} / 总预算 ${job.budgetUsd.toFixed(4)}；包含失败请求与手动重试。</p>
      <p className="fine-print">当前任务已识别 {job.dialogueCount} 句对白 · {job.characterCount} 名人物 · {job.unknownCount} 句未知或待确认。</p>
      {job.status === 'waiting' && working && <p className="inline-warning">已追上当前阅读位置，正在等待阅读推进。点击「返回阅读并继续任务」即可翻页；不会发送未来内容。</p>}
      {job.error && <p className="inline-error" role="alert">{job.error}</p>}
      <details><summary>章节检查点</summary><ol className="book-analysis-chapters">{job.chapters.map(item => <li key={item.id || item.jobId}><span>{showAll || item.index <= scope.chapterIndex ? `${item.index + 1}. ${item.title}` : `第 ${item.index + 1} 章`}</span><small>{item.completedChunks}/{item.totalChunks} 分片 · {item.reviewCompleted ? '复核完成' : item.status === 'done' ? '识别已保存' : statusText[item.status]}{item.error ? ` · ${item.error}` : ''}</small></li>)}</ol></details>
    </section>}
    <div className="button-row">
      {working ? <>
        <button className="secondary" onClick={() => { if (pauseRequested) controller.current?.resume(); else controller.current?.pause(); setPauseRequested(!pauseRequested); }}>{pauseRequested ? <Play size={16}/> : <Pause size={16}/>} {pauseRequested ? '继续整书会话' : '当前分片后暂停整书任务'}</button>
        <button className="secondary" onClick={() => controller.current?.cancel()}><Square size={15}/>取消整书任务</button>
      </> : <>
        {!job && <button className="primary" disabled={!authorized || !keyReady || !validBudget || !estimate || estimating || (mode === 'deep' && !estimate.dialogueCount)} onClick={() => void start(false)}><Sparkles size={16}/>授权并开始整书分析</button>}
        {resumable && <button className="primary" disabled={!authorized || !keyReady || !validBudget || budgetValue <= job.reservedUsd} onClick={() => void start(true)}><RotateCcw size={16}/>授权并继续整书任务</button>}
        {job && <button className="secondary" onClick={() => selectJob()}>新建整书任务</button>}
      </>}
      <button className="secondary" onClick={() => setMinimized(true)}><ChevronDown size={16}/>{working ? '返回阅读并继续任务' : '返回阅读并保留结果'}</button>
    </div>
    {visibleDialogues.length > 0 && <section className="analysis-results" aria-label="整书已读范围结果">
      <h3>{showAll ? '全书结果预览（已允许剧透）' : '已读范围的结果'}</h3>
      <p className="muted">{visibleDialogues.length} 句已保存 · {uncertain.length} 句未知或待确认 · {visibleDialogues.filter(item => item.source === 'manual').length} 句人工纠正。未来身份信息默认隐藏。</p>
      <ul>{visibleDialogues.slice(0, 5).map(item => <li key={item.id}><strong>{getCharacter(item.characterId)?.name || '未知人物'}</strong>：{item.text.slice(0, 90)}{item.source === 'manual' && '（人工）'}</li>)}</ul>
      {uncertain.length > 0 && <details><summary>查看未知与待确认对白</summary><ul>{uncertain.slice(0, 20).map(item => <li key={item.id}><button className="text-button" onClick={() => viewDialogue(item)}>{item.text.slice(0, 80)} · 在正文确认</button></li>)}</ul></details>}
      <button className="secondary" onClick={() => viewDialogue(visibleDialogues[0])}><BookOpen size={16}/>在正文查看与纠正</button>
    </section>}
    <p className="fine-print">关闭面板会停止活动会话并保存检查点。返回阅读可保持会话。重启、切换账号或更改密钥后，继续任务需要重新授权。</p>
  </Modal>;
}
