import type { IdentityEvidence, IdentityLocation } from '../types';

export type PlotKind = 'fact' | 'claim' | 'inference' | 'user';

export interface PlotEventRevision {
  id: string;
  description: string;
  characterIds: string[];
  relation?: string;
  conflictsWith?: string[];
  kind: PlotKind;
  source: 'ai' | 'manual';
  status: 'active' | 'rejected';
  confidence: number;
  evidence: IdentityEvidence;
  visibleAt: IdentityLocation;
  updatedAt: number;
}

export interface PlotEventRecord {
  id: string;
  bookId: string;
  chapterId: string;
  seriesId?: string;
  order: IdentityLocation;
  revisions: PlotEventRevision[];
}

export interface ChapterSummaryFragment {
  id: string;
  from: IdentityLocation;
  through: IdentityLocation;
  text: string;
  characterIds: string[];
  evidence: IdentityEvidence[];
  model: string;
  updatedAt: number;
}

export interface ChapterSummaryRevision {
  id: string;
  text: string;
  status: 'active' | 'flagged';
  visibleAt: IdentityLocation;
  updatedAt: number;
}

export interface ChapterSummaryRecord {
  chapterId: string;
  bookId: string;
  fragments: ChapterSummaryFragment[];
  revisions: ChapterSummaryRevision[];
}

export interface PlotContext {
  paragraph: number;
  start: number;
  text: string;
}

export interface SeriesMemorySelection {
  bookId: string;
  through: IdentityLocation;
}

export interface PlotMemoryHint {
  bookId: string;
  eventId?: string;
  chapterIndex: number;
  description: string;
  kind: PlotKind;
  confidence: number;
  evidence: Omit<IdentityEvidence, 'chapterId'>;
  relatedCharacters?: string[];
}
