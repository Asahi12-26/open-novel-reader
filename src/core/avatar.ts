import type { AvatarRevision } from '../types';
import { db } from './db';
import { bookOwnerKey } from './book-owner';
import { cropAvatarImage, validateAvatarImage, type AvatarCrop, type PreparedAvatarImage } from './avatar-image';

export { AVATAR_SIZE, MAX_AVATAR_BYTES, prepareAvatarImage, validateAvatarImage } from './avatar-image';
export type { AvatarCrop, PreparedAvatarImage } from './avatar-image';

export function validAvatarRevision(value: unknown): value is AvatarRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<AvatarRevision>;
  return typeof row.characterId === 'string' && row.characterId.length > 0 && row.characterId.length <= 240 &&
    typeof row.bookId === 'string' && row.bookId.length > 0 && row.bookId.length <= 240 &&
    Number.isSafeInteger(row.updatedAt) && row.updatedAt! >= 0 &&
    typeof row.revision === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(row.revision) &&
    (row.digest === undefined || (typeof row.digest === 'string' && /^[\da-f]{64}$/.test(row.digest)));
}

export function compareAvatarRevisions(a: AvatarRevision, b: AvatarRevision) {
  return a.updatedAt - b.updatedAt || (a.revision < b.revision ? -1 : Number(a.revision > b.revision));
}

export interface AvatarOwnerGuard { scope?: string }

export async function getAvatarOwner(bookId: string): Promise<AvatarOwnerGuard> {
  const value = (await db.settings.get(bookOwnerKey(bookId)))?.value;
  return { scope: typeof value === 'string' ? value : undefined };
}

async function setAvatar(bookId: string, characterId: string, owner: AvatarOwnerGuard, image?: Blob, digest?: string) {
  await db.transaction('rw', [db.books, db.characters, db.avatars, db.settings, db.syncState], async () => {
    const [book, character, current, active] = await Promise.all([
      db.books.get(bookId), db.characters.get(characterId), db.avatars.get(characterId), getAvatarOwner(bookId),
    ]);
    if (active.scope !== owner.scope) throw new Error('书籍所属的账号已变化，请重新打开人物卡片。');
    if (!book || book.deletedAt !== undefined || character?.bookId !== bookId || (current && current.bookId !== bookId)) {
      throw new Error('人物或书籍已变化，请重新打开人物卡片。');
    }
    const updatedAt = Math.max(Date.now(), (current?.updatedAt ?? 0) + 1);
    await db.avatars.put({ characterId, bookId, updatedAt, revision: crypto.randomUUID(), ...(image && digest ? { image, digest } : {}) });
    await db.syncState.put({ id: 'local', updatedAt: Date.now() });
  });
}

export async function saveCharacterAvatar(
  bookId: string,
  characterId: string,
  source: PreparedAvatarImage,
  crop: AvatarCrop,
  owner?: AvatarOwnerGuard,
): Promise<void> {
  const expected = owner ?? await getAvatarOwner(bookId);
  const image = await cropAvatarImage(source, crop);
  const digest = await validateAvatarImage(image);
  await setAvatar(bookId, characterId, expected, image, digest);
}

export async function resetCharacterAvatar(bookId: string, characterId: string, owner?: AvatarOwnerGuard): Promise<void> {
  await setAvatar(bookId, characterId, owner ?? await getAvatarOwner(bookId));
}
