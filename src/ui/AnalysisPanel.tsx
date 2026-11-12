import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LoaderCircle, Pause, Play, RotateCcw, Sparkles, Square } from 'lucide-react';
import { db } from '../core/db';
import type { AnalysisJob, Chapter, Character, Dialogue } from '../types';
import { AI_MODELS, analyzeChapter, estimateAnalysis, hasAIKey } from '../services/ai';
import type { AIModel, AnalysisController } from '../services/ai';
import { Modal, notify, useQuery } from './common';
import type { IdentityScope } from '../services/character-identity';

const statusLabels: Record<AnalysisJob['status'], string> = {
  queued: '准备中', running: '正在阅读与识别', paused: '已暂停', done: '识别完成', failed: '分析失败', cancelled: '已取消',
};

export default function AnalysisPanel({ chapter, scope, getCharacter, showAll = false, blockedByBookTask = false, onOpenBookAnalysis, onClose, onViewResults }: {
  chapter: Chapter; scope: IdentityScope; getCharacter: (id: string | null) => Character | undefined; showAll?: boolean; onOpenBookAnalysis?: () => void;
  blockedByBookTask?: boolean;
  onClose: () => void; onViewResults?: (chapter: Chapter) => void;
}) {
  const [chapterId, setChapterId] = useState(chapter.id);
  const chapters = useQuery(() => db.chapters.where('bookId').equals(chapter.bookId).sortBy('index'), [chapter.bookId], [chapter]);
  const selected = chapters.find(item => item.id === chapterId) || chapter;
  const savedJobs = useQuery(() => db.jobs.where('chapterId').equals(selected.id).and(item => item.bookId === chapter.bookId).toArray(), [selected.id, chapter.bookId], [] as AnalysisJob[]);
  const savedDialogues = useQuery(() => db.dialogues.where('chapterId').equals(selected.id).and(item => item.bookId === chapter.bookId).toArray(), [selected.id, chapter.bookId], [] as Dialogue[]);
  // Live queries keep their previous value until the next chapter's read finishes.
  const dialogues = savedDialogues.filter(item => item.chapterId === selected.id && item.bookId === selected.bookId);
  const savedJob = savedJobs.filter(item => item.chapterId === selected.id && item.bookId === selected.bookId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const [model, setModel] = useState<AIModel>('deepseek-flash');
  const [budget, setBudget] = useState('0.10');
  const [authorized, setAuthorized] = useState(false);
  const [keyReady, setKeyReady] = useState(hasAIKey);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const controller = useRef<AnalysisController | null>(null);
  const mounted = useRef(true);
  const estimate = useMemo(() => estimateAnalysis(selected, model), [selected, model]);
  const budgetValue = Number(budget);
  const validBudget = Number.isFinite(budgetValue) && budgetValue > 0 && budgetValue <= 10;
  const resumable = !!job && job.status !== 'done' && job.completedChunks < job.totalChunks && (!job.model || job.model === model);
  const attributed = dialogues.filter(item => item.characterId !== null).length;
  const corrected = dialogues.filter(item => item.source === 'manual').length;
  const resultVisible = showAll || selected.index <= scope.chapterIndex;

  useEffect(() => {
    mounted.current = true;
    const keyChanged = () => setKeyReady(hasAIKey());
    window.addEventListener('onr-ai-key-changed', keyChanged);
    return () => { mounted.current = false; controller.current?.cancel(); window.removeEventListener('onr-ai-key-changed', keyChanged); };
  }, []);
  useEffect(() => {
    if (controller.current) return;
    setJob(savedJob || null); setAuthorized(false); setError(''); setPauseRequested(false);
    if (savedJob?.model && AI_MODELS.some(item => item.id === savedJob.model)) setModel(savedJob.model as AIModel);
  }, [selected.id, savedJob?.id, savedJob?.updatedAt]);

  async function start(resume = false) {
    if (controller.current || blockedByBookTask) return;
    if (!authorized) { setError('请先明确授权本次章节分析。'); return; }
    setError(''); setAuthorized(false); setPauseRequested(false); setWorking(true);
    try {
      const task = analyzeChapter({
        bookId: selected.bookId, chapterId: selected.id, model, budgetUsd: budgetValue, authorized: true,
        jobId: resume ? job?.id : undefined,
        onProgress: next => { if (mounted.current) setJob(next); },
      });
      controller.current = task;
      const result = await task.done;
      if (mounted.current) {
        setJob(result);
        if (result.status === 'done') notify('人物识别完成，结果已保存。人工纠正继续优先生效。');
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '分析失败，请重新检查登录和任务设置。');
    } finally {
      controller.current = null;
      if (mounted.current) { setWorking(false); setPauseRequested(false); }
    }
  }
  const close = () => {
    if (controller.current) { controller.current.cancel(); notify('已取消分析；已完成结果和任务进度保留。'); }
    onClose();
  };

  return <Modal title="听见故事里的人" onClose={close}>
    {onOpenBookAnalysis && <div className="analysis-mode-switch"><strong>逐章分析</strong><button className="secondary" disabled={working} onClick={onOpenBookAnalysis}><BookOpen size={16}/>整书分析</button></div>}
    <div className="ai-intro"><span><Sparkles size={25}/></span><div><h3>章节人物识别</h3><p>{selected.title}</p></div></div>
    <p className="muted">选择一章，开始后自动识别对白、判断人物并保存结果。不确定的归属保留为「未知」，人工纠正始终优先。</p>
    {blockedByBookTask && <p className="inline-warning">整书任务正在运行。请先在整书任务面板停止本次会话，再单独分析章节，避免重复请求。</p>}
    <label className="form-label">选择分析章节<select value={selected.id} disabled={working} onChange={event => { setChapterId(event.target.value); setJob(null); setAuthorized(false); setError(''); }}>{chapters.map(item => <option key={item.id} value={item.id}>{item.index + 1}. {item.title}</option>)}</select></label>
    <label className="form-label">模型<select value={model} disabled={working} onChange={event => { setModel(event.target.value as AIModel); setAuthorized(false); }}>{AI_MODELS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <div className="estimate-box">
      <div><span>本章待识别对白</span><strong>{estimate.dialogueCount} 句</strong></div>
      <div><span>新任务请求分片</span><strong>{estimate.chunks} 次</strong></div>
      <div><span>新任务保守费用估计</span><strong>${estimate.estimatedMaxUsd.toFixed(4)}</strong></div>
      <small>输入上限约 {estimate.inputTokensUpperBound.toLocaleString()} token，输出上限 {estimate.outputTokensUpperBound.toLocaleString()} token。按公开峰值价格预留，实际账单以 DeepSeek 为准，失败或取消也可能计费。</small>
    </div>
    <label className="form-label">本次任务累计费用额度（美元）<input type="number" min="0.001" max="10" step="0.01" value={budget} disabled={working} onChange={event => { setBudget(event.target.value); setAuthorized(false); }}/></label>
    {!keyReady && <p className="inline-warning">请先回到书架 → 设置 → AI 模型，登录并载入本次会话密钥。载入密钥不会自动分析。</p>}
    <label className="checkbox-row authorization"><input type="checkbox" checked={authorized} disabled={working} onChange={event => setAuthorized(event.target.checked)}/>我同意将所选章节的对白、邻近上下文及已有人物名称发送至代理和 DeepSeek，并授权在上述累计额度内进行本次付费分析或继续任务。</label>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {job && <div className="job-status" role="status" aria-live="polite">
      <div><span>{!working && ['running', 'queued', 'paused'].includes(job.status) ? '上次任务已中断，可重新授权后继续' : statusLabels[job.status]}</span><strong>{job.completedChunks} / {job.totalChunks}</strong></div>
      <progress aria-label="章节分析进度" max={Math.max(1, job.totalChunks)} value={job.completedChunks}/>
      {typeof job.reservedUsd === 'number' && <p className="fine-print">累计已预留 ${job.reservedUsd.toFixed(4)}，包含失败和重试请求；继续任务不会自动返还已预留额度。</p>}
      {job.error && <p className="inline-error" role="alert">{job.error}</p>}
    </div>}
    <div className="button-row">
      {working ? <>
        <button className="secondary" onClick={() => { if (pauseRequested) controller.current?.resume(); else controller.current?.pause(); setPauseRequested(!pauseRequested); }}>{pauseRequested ? <Play size={16}/> : <Pause size={16}/>} {pauseRequested ? '继续分析' : '当前分片后暂停'}</button>
        <button className="secondary" onClick={() => controller.current?.cancel()}><Square size={15}/>取消任务</button><LoaderCircle className="spin muted" size={18}/>
      </> : <>
        <button className="primary" disabled={blockedByBookTask || !authorized || !keyReady || !validBudget || !estimate.dialogueCount || budgetValue < estimate.estimatedMaxUsd} onClick={() => void start()}><Sparkles size={16}/>授权并分析所选章节</button>
        {resumable && <button className="secondary" disabled={blockedByBookTask || !authorized || !keyReady || !validBudget || budgetValue <= (job?.reservedUsd || 0)} onClick={() => void start(true)}><RotateCcw size={16}/>从上次进度继续</button>}
      </>}
    </div>
    {dialogues.length > 0 && resultVisible && <section className="analysis-results" aria-label="已保存的人物识别结果">
      <h3>已保存的识别结果</h3><p className="muted">{dialogues.length} 句对白 · {attributed} 句已归属 · {dialogues.length - attributed} 句未知 · {corrected} 句人工纠正</p>
      <ul>{dialogues.slice(0, 5).map(item => <li key={item.id}><strong>{getCharacter(item.characterId)?.name || '未知人物'}</strong>：{item.text.slice(0, 90)}{item.source === 'manual' && '（人工）'}</li>)}</ul>
      {onViewResults && <button className="secondary" disabled={working} onClick={() => onViewResults(selected)}><BookOpen size={16}/>在正文查看与纠正</button>}
    </section>}
    {dialogues.length > 0 && !resultVisible && <p className="fine-print">所选章节的结果已保存；未来章节的人物与对白预览默认隐藏，可在正文阅读到该章节时查看。</p>}
    <p className="fine-print">重试需要重新授权。暂停在当前分片后生效，关闭面板会取消在途请求并保留已完成结果。</p>
  </Modal>;
}
