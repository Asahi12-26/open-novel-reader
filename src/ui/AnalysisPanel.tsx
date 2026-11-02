import { useRef, useState } from 'react';
import { LoaderCircle, Pause, Play, RotateCcw, Sparkles, Square } from 'lucide-react';
import type { AnalysisJob, Chapter } from '../types';
import { AI_MODELS, analyzeChapter, estimateAnalysis, hasAIKey } from '../services/ai';
import type { AIModel, AnalysisController } from '../services/ai';
import { Modal, notify } from './common';

export default function AnalysisPanel({chapter,onClose}:{chapter:Chapter;onClose:()=>void}) {
  const [model,setModel]=useState<AIModel>('deepseek-flash');
  const [budget,setBudget]=useState('0.10');const [authorized,setAuthorized]=useState(false);
  const [job,setJob]=useState<AnalysisJob|null>(null);const [error,setError]=useState('');
  const controller=useRef<AnalysisController|null>(null);const [paused,setPaused]=useState(false);
  const estimate=estimateAnalysis(chapter,model);const running=job?.status==='running'||job?.status==='queued'||job?.status==='paused';
  async function start(retry=false) {
    if(!authorized){setError('请先明确授权本次章节分析。');return;}
    setError('');setAuthorized(false);setPaused(false);
    try { controller.current=analyzeChapter({bookId:chapter.bookId,chapterId:chapter.id,model,budgetUsd:Number(budget),authorized:true,jobId:retry?job?.id:undefined,onProgress:setJob}); const result=await controller.current.done;setJob(result);if(result.status==='done')notify('人物识别完成。点击正文人物标签可查看并纠正。'); }
    catch(e){setError(e instanceof Error?e.message:'分析失败');}
  }
  const close=()=>{if(running){controller.current?.cancel();notify('已取消分析；已完成结果保留。');}onClose();};
  return <Modal title="听见故事里的人" onClose={close}><div className="ai-intro"><span><Sparkles size={25}/></span><div><h3>章节人物识别</h3><p>{chapter.title}</p></div></div><p className="muted">使用 DeepSeek，根据上下文为对白标注说话人物。不确定时保留「未知」，你可以随时纠正。</p><label className="form-label">分析范围<input value={`仅当前章节 · ${chapter.paragraphs.length} 个段落`} readOnly/></label><label className="form-label">模型<select value={model} disabled={!!running} onChange={e=>{setModel(e.target.value as AIModel);setAuthorized(false);}}>{AI_MODELS.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><div className="estimate-box"><div><span>待识别对白</span><strong>{estimate.dialogueCount} 句</strong></div><div><span>请求分片</span><strong>{estimate.chunks} 次</strong></div><div><span>保守预计费用上限</span><strong>${estimate.estimatedMaxUsd.toFixed(4)}</strong></div><small>输入上限约 {estimate.inputTokensUpperBound.toLocaleString()} token，输出上限 {estimate.outputTokensUpperBound.toLocaleString()} token。按公开峰值价格估计；失败请求可能计费。</small></div><label className="form-label">本次任务费用上限（美元）<input type="number" min="0.001" max="10" step="0.01" value={budget} disabled={!!running} onChange={e=>{setBudget(e.target.value);setAuthorized(false);}}/></label>{!hasAIKey()&&<p className="inline-warning">请先回到书架 → 设置 → AI 模型，载入会话密钥并配置自己的云代理。</p>}<label className="checkbox-row authorization"><input type="checkbox" checked={authorized} disabled={!!running} onChange={e=>setAuthorized(e.target.checked)}/>我同意将本章节与已有人物名称发送至我配置的代理和 DeepSeek，并授权在上述预算内进行本次付费分析。</label>{error&&<p className="inline-error" role="alert">{error}</p>}{job&&<div className="job-status"><div><span>{({queued:'准备中',running:'正在阅读与识别',paused:'已暂停',done:'识别完成',failed:'分析失败',cancelled:'已取消'})[job.status]}</span><strong>{job.completedChunks} / {job.totalChunks}</strong></div><progress max={Math.max(1,job.totalChunks)} value={job.completedChunks}/>{job.error&&<p className="inline-error">{job.error}</p>}</div>}<div className="button-row">{running?<><button className="secondary" onClick={()=>{if(paused)controller.current?.resume();else controller.current?.pause();setPaused(!paused);}}>{paused?<Play size={16}/>:<Pause size={16}/>} {paused?'继续':'当前分片后暂停'}</button><button className="secondary" onClick={()=>controller.current?.cancel()}><Square size={15}/>取消任务</button><LoaderCircle className="spin muted" size={18}/></>:<><button className="primary" disabled={!authorized||!hasAIKey()||!estimate.dialogueCount||Number(budget)<estimate.estimatedMaxUsd} onClick={()=>void start()}><Sparkles size={16}/>授权并分析本章</button>{job?.status==='failed'&&<button className="secondary" disabled={!authorized} onClick={()=>void start(true)}><RotateCcw size={16}/>重试剩余片段</button>}</>}</div><p className="fine-print">暂停在当前请求完成后生效。取消不会撤销已发生的费用。关闭此面板会取消任务；人工纠正始终优先保留。</p></Modal>;
}
