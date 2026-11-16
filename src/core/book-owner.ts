export const LEGACY_BOOK_ORIGIN_KEY = 'onr.cloud.legacy-owner-origin';
export const bookOwnerKey = (bookId: string) => `cloud-owner:${bookId}`;
export const bookAccountScope = (origin: string, userId: string) => `${origin}|${userId}`;

/** Interpret V0.1 user-only owner settings in their original cloud project. */
export function bookOwnerScope(value: unknown, projectOrigin: string): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.includes('|')) return value;
  const origin = globalThis.localStorage?.getItem(LEGACY_BOOK_ORIGIN_KEY) || projectOrigin;
  return origin ? bookAccountScope(origin, value) : undefined;
}
