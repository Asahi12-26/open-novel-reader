export type BookFormat = 'txt' | 'epub';
export interface Book {
  id: string; title: string; author: string; format: BookFormat; language: string;
  cover?: string; coverColor: string; fingerprint: string; totalWords: number; chapterCount: number;
  createdAt: number; updatedAt: number; shelfId?: string; cloudEnabled: boolean; deletedAt?: number;
}
export interface BookFile { bookId: string; name: string; mime: string; bytes: Blob }
export interface Chapter { id: string; bookId: string; index: number; title: string; paragraphs: string[]; sourcePath?: string }
export interface ReadingProgress { bookId: string; chapterId: string; paragraphIndex: number; offset: number; updatedAt: number; version: number }
export interface Bookmark { id: string; bookId: string; chapterId: string; paragraphIndex: number; label: string; createdAt: number }
export interface Bookshelf { id: string; name: string; updatedAt: number; deletedAt?: number }
export interface Character { id: string; bookId: string; name: string; aliases: string[] }
export interface Dialogue { id: string; bookId: string; chapterId: string; paragraphIndex: number; start: number; end: number; text: string; characterId: string | null; confidence: number; source: 'ai' | 'manual'; model?: string; updatedAt: number }
export interface CharacterCorrection { id: string; dialogueId: string; bookId: string; characterId: string | null; updatedAt: number }
export interface AnalysisJob { id: string; bookId: string; chapterId: string; status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'; completedChunks: number; totalChunks: number; error?: string; updatedAt: number }
export interface Preferences { theme: 'light' | 'dark' | 'sepia'; fontFamily: 'serif' | 'sans'; fontSize: number; lineHeight: number; readerWidth: number; showCharacters: boolean }
export interface SyncState { id: string; updatedAt: number; lastSyncedAt?: number; error?: string }
export const defaultPreferences: Preferences = { theme: 'light', fontFamily: 'serif', fontSize: 20, lineHeight: 1.95, readerWidth: 720, showCharacters: true };
