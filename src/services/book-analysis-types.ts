import type { AnalysisJob } from '../types';
import type { AIModel } from './ai';

export type BookAnalysisMode = 'reading-progress' | 'deep';
export interface BookAnalysisBoundary { chapterId: string; chapterIndex: number; paragraphIndex: number; offset: number }
export interface BookChapterTask {
  id: string; chapterId: string; index: number; title: string; jobId: string;
  candidateIds: string[]; completedChunks: number; totalChunks: number;
  status: AnalysisJob['status']; error?: string; signature: string;
  scopeEnd: BookAnalysisBoundary; reviewCandidateIds: string[]; reviewCompleted: boolean;
}
export interface BookAnalysisEstimate {
  chapterCount: number; totalChapters: number; dialogueCount: number; totalChunks: number;
  reviewRequests: number; maxRequests: number; estimatedMinUsd: number; estimatedMaxUsd: number;
  scopeEnd: BookAnalysisBoundary | null;
}
export interface BookAnalysisJob {
  version: 1; id: string; bookId: string; model: AIModel; mode: BookAnalysisMode;
  status: 'queued' | 'running' | 'paused' | 'waiting' | 'failed' | 'cancelled' | 'done';
  stage: 'preparing' | 'analyzing' | 'reviewing' | 'done';
  chapters: BookChapterTask[]; completedChapters: number; completedChunks: number; totalChunks: number;
  reviewRequests: number; completedReviews: number; dialogueCount: number; unknownCount: number;
  characterCount: number; reservedUsd: number; budgetUsd: number; estimatedMaxUsd: number;
  error?: string; updatedAt: number; createdAt: number; scopeEnd: BookAnalysisBoundary | null;
  bookSignature: string; principal: { projectUrl: string; userId: string };
}
export interface BookAnalysisOptions {
  bookId: string; model: AIModel; mode: BookAnalysisMode; budgetUsd: number;
  authorized: true; jobId?: string; onProgress?: (job: BookAnalysisJob) => void;
}
export interface BookAnalysisController { pause(): void; resume(): void; cancel(): void; done: Promise<BookAnalysisJob> }
