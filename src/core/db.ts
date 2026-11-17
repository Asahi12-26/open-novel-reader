import Dexie, { type Table } from 'dexie';
import type { AnalysisJob, Book, BookFile, Bookmark, Bookshelf, Chapter, Character, CharacterAvatar, CharacterCorrection, Dialogue, ReadingProgress, SyncState } from '../types';
import type { Series, SeriesBook, SeriesCharacter, SeriesCharacterLink } from './series-types';
import type { ChapterSummaryRecord, PlotEventRecord } from './plot-types';
import type { DialogueCorrectionRevision } from '../types';

export interface Setting { id: string; value: unknown }

/** Versioned local-first storage. An upgrade never clears existing user tables. */
export class ReaderDatabase extends Dexie {
  books!: Table<Book, string>;
  files!: Table<BookFile, string>;
  chapters!: Table<Chapter, string>;
  progress!: Table<ReadingProgress, string>;
  bookmarks!: Table<Bookmark, string>;
  shelves!: Table<Bookshelf, string>;
  characters!: Table<Character, string>;
  avatars!: Table<CharacterAvatar, string>;
  dialogues!: Table<Dialogue, string>;
  corrections!: Table<CharacterCorrection, string>;
  jobs!: Table<AnalysisJob, string>;
  settings!: Table<Setting, string>;
  syncState!: Table<SyncState, string>;
  series!: Table<Series, string>;
  seriesBooks!: Table<SeriesBook, string>;
  seriesCharacters!: Table<SeriesCharacter, string>;
  seriesCharacterLinks!: Table<SeriesCharacterLink, string>;
  plotEvents!: Table<PlotEventRecord, string>;
  chapterSummaries!: Table<ChapterSummaryRecord, string>;
  dialogueCorrectionRevisions!: Table<DialogueCorrectionRevision, string>;

  constructor(name = 'open-novel-reader') {
    super(name);
    this.version(1).stores({
      books: 'id, fingerprint, updatedAt, shelfId',
      files: 'bookId',
      chapters: 'id, bookId, [bookId+index]',
      progress: 'bookId, updatedAt',
      bookmarks: 'id, bookId, chapterId',
      shelves: 'id, updatedAt',
      characters: 'id, bookId',
      dialogues: 'id, bookId, chapterId',
      corrections: 'id, bookId, dialogueId',
      jobs: 'id, bookId, chapterId, status',
      settings: 'id',
      syncState: 'id, updatedAt',
    });
    this.version(2).stores({ avatars: 'characterId, bookId' });
    this.version(3).stores({
      series: 'id, scope',
      seriesBooks: 'id, scope, bookId, seriesId',
      seriesCharacters: 'id, scope, seriesId',
      seriesCharacterLinks: 'id, scope, bookId, seriesId, seriesCharacterId',
      plotEvents: 'id, bookId, chapterId',
      chapterSummaries: 'chapterId, bookId',
      dialogueCorrectionRevisions: 'id, bookId, chapterId, dialogueId',
    });
  }
}

export const db = new ReaderDatabase();
