import type { IdentityLocation } from '../types';

export interface SeriesAccess {
  origin: string;
  userId?: string;
  assertCurrent?: () => void;
}

export interface Series {
  id: string;
  scope: string;
  name: string;
  updatedAt: number;
  deletedAt?: number;
}

export interface SeriesBook {
  id: string;
  scope: string;
  seriesId: string;
  bookId: string;
  position: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface SeriesCharacter {
  id: string;
  scope: string;
  seriesId: string;
  updatedAt: number;
}

export interface SeriesLinkRevision {
  id: string;
  at: IdentityLocation;
  seriesCharacterId: string | null;
  shareAvatar: boolean;
  updatedAt: number;
  operation: 'link' | 'merge' | 'unlink' | 'undo' | 'avatar';
}

export interface SeriesCharacterLink {
  id: string;
  scope: string;
  seriesId: string;
  bookId: string;
  characterId: string;
  at: IdentityLocation;
  seriesCharacterId: string | null;
  shareAvatar: boolean;
  updatedAt: number;
  history: SeriesLinkRevision[];
}
export type ActiveSeriesCharacterLink = SeriesCharacterLink & { seriesCharacterId: string };

export const MAX_SERIES_LINK_REVISIONS = 512;
export const seriesBookId = (seriesId: string, bookId: string) => `${seriesId}:${bookId}`;
export const seriesLinkId = (seriesId: string, bookId: string, characterId: string) => `${seriesId}:${bookId}:${characterId}`;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const validText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !!value.trim() && !/[\u0000-\u001f]/.test(value);
const uuid = (input: unknown): input is string => typeof input === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const location = (value: unknown): value is IdentityLocation => object(value) && keys(value, ['chapterIndex', 'paragraphIndex', 'offset']) &&
  integer(value.chapterIndex) && integer(value.paragraphIndex) && integer(value.offset);
const identity = (value: unknown) => value === null || uuid(value);
const deleted = (value: Record<string, unknown>) => value.deletedAt === undefined || (integer(value.deletedAt) && integer(value.updatedAt) && value.deletedAt <= value.updatedAt);

export function isSeries(value: unknown): value is Series {
  return object(value) && keys(value, ['id', 'scope', 'name', 'updatedAt', 'deletedAt']) &&
    uuid(value.id) && validText(value.scope, 512) && validText(value.name, 100) && integer(value.updatedAt) && deleted(value);
}

export function isSeriesBook(value: unknown): value is SeriesBook {
  return object(value) && keys(value, ['id', 'scope', 'seriesId', 'bookId', 'position', 'updatedAt', 'deletedAt']) &&
    uuid(value.seriesId) && validText(value.scope, 512) && validText(value.bookId, 240) &&
    value.id === seriesBookId(value.seriesId, String(value.bookId)) && integer(value.position) && value.position <= 100000 &&
    integer(value.updatedAt) && deleted(value);
}

export function isSeriesCharacter(value: unknown): value is SeriesCharacter {
  return object(value) && keys(value, ['id', 'scope', 'seriesId', 'updatedAt']) &&
    uuid(value.id) && uuid(value.seriesId) && validText(value.scope, 512) && integer(value.updatedAt);
}

export function isSeriesLinkRevision(value: unknown): value is SeriesLinkRevision {
  return object(value) && keys(value, ['id', 'at', 'seriesCharacterId', 'shareAvatar', 'updatedAt', 'operation']) &&
    uuid(value.id) && identity(value.seriesCharacterId) && location(value.at) && typeof value.shareAvatar === 'boolean' &&
    (value.seriesCharacterId !== null || !value.shareAvatar) && integer(value.updatedAt) &&
    ['link', 'merge', 'unlink', 'undo', 'avatar'].some(operation => operation === value.operation);
}

const revisionOrder = (left: SeriesLinkRevision, right: SeriesLinkRevision) =>
  left.updatedAt - right.updatedAt || left.id.localeCompare(right.id);

export function isSeriesCharacterLink(value: unknown): value is SeriesCharacterLink {
  if (!object(value) || !keys(value, ['id', 'scope', 'seriesId', 'bookId', 'characterId', 'at', 'seriesCharacterId', 'shareAvatar', 'updatedAt', 'history']) ||
      !uuid(value.seriesId) || !validText(value.scope, 512) || !validText(value.bookId, 240) || !validText(value.characterId, 240) ||
      value.id !== seriesLinkId(value.seriesId, String(value.bookId), String(value.characterId)) || !location(value.at) ||
      !Array.isArray(value.history) || !value.history.length || value.history.length > MAX_SERIES_LINK_REVISIONS ||
      !value.history.every(isSeriesLinkRevision) || new Set(value.history.map(event => event.id)).size !== value.history.length) return false;
  const latest = [...value.history].sort(revisionOrder).at(-1)!;
  return latest.updatedAt === value.updatedAt && latest.seriesCharacterId === value.seriesCharacterId && latest.shareAvatar === value.shareAvatar &&
    latest.at.chapterIndex === value.at.chapterIndex && latest.at.paragraphIndex === value.at.paragraphIndex && latest.at.offset === value.at.offset;
}

export function applySeriesLinkRevision(link: SeriesCharacterLink, revision: SeriesLinkRevision): SeriesCharacterLink {
  return {
    ...link,
    at: revision.at,
    seriesCharacterId: revision.seriesCharacterId,
    shareAvatar: revision.shareAvatar,
    updatedAt: revision.updatedAt,
  };
}

/** Union concurrent history by event ID. The newest operation remains authoritative. */
export function mergeSeriesCharacterLink(local: SeriesCharacterLink, remote: SeriesCharacterLink): SeriesCharacterLink {
  if (local.id !== remote.id || local.scope !== remote.scope) throw new Error('系列身份关联范围不同，本机记录已保留。');
  const entries = new Map<string, SeriesLinkRevision>();
  for (const revision of [...local.history, ...remote.history]) {
    const prior = entries.get(revision.id);
    if (prior && (prior.updatedAt !== revision.updatedAt || prior.seriesCharacterId !== revision.seriesCharacterId ||
        prior.shareAvatar !== revision.shareAvatar || prior.operation !== revision.operation || prior.at.chapterIndex !== revision.at.chapterIndex ||
        prior.at.paragraphIndex !== revision.at.paragraphIndex || prior.at.offset !== revision.at.offset)) {
      throw new Error('系列身份历史存在冲突，本机记录已保留。');
    }
    entries.set(revision.id, revision);
  }
  if (entries.size > MAX_SERIES_LINK_REVISIONS) throw new Error('系列身份历史超过本版上限，本机记录已保留。');
  const history = [...entries.values()].sort(revisionOrder);
  return applySeriesLinkRevision({ ...local, history }, history.at(-1)!);
}

export function chooseSeriesRecord<T extends { updatedAt: number; deletedAt?: number }>(local: T, remote: T): T {
  if (local.updatedAt !== remote.updatedAt) return local.updatedAt > remote.updatedAt ? local : remote;
  if ((local.deletedAt ?? -1) !== (remote.deletedAt ?? -1)) return (local.deletedAt ?? -1) > (remote.deletedAt ?? -1) ? local : remote;
  const canonical = (value: T) => JSON.stringify(value, Object.keys(value).sort());
  return canonical(local) >= canonical(remote) ? local : remote;
}
