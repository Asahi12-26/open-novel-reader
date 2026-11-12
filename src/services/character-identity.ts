import { db } from '../core/db';
import type { Character, CharacterIdentity, CharacterIdentityEvent, Chapter, Dialogue, IdentityLocation } from '../types';

export type IdentityScope = IdentityLocation;
const beginning: IdentityLocation = { chapterIndex: 0, paragraphIndex: 0, offset: 0 };
const unlimited: IdentityLocation = { chapterIndex: Number.MAX_SAFE_INTEGER, paragraphIndex: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER };
const cleanName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ');
const normalized = (name: string) => cleanName(name).toLocaleLowerCase();
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 300): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
export const validIdentityLocation = (value: unknown): value is IdentityLocation => object(value) && number(value.chapterIndex) && number(value.paragraphIndex) && number(value.offset);
export function compareIdentityLocations(left: IdentityLocation, right: IdentityLocation): number {
  return left.chapterIndex - right.chapterIndex || left.paragraphIndex - right.paragraphIndex || left.offset - right.offset;
}
const visible = (at: IdentityLocation, cutoff: IdentityLocation) => compareIdentityLocations(at, cutoff) <= 0;
const ordered = (events: CharacterIdentityEvent[]) => [...events].sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));

/** Captures the pre-reveal name once. Mutable canonical names are never used for earlier pages. */
export function initializeCharacterIdentity(character: Character, at: IdentityLocation): Character {
  if (character.identity) return structuredClone(character);
  return { ...character, aliases: [...character.aliases], identity: { version: 1, initialName: character.name, initialAliases: [...character.aliases], introducedAt: { ...at }, events: [] } };
}
export const initializeIdentity = initializeCharacterIdentity;

function projected(character: Character, cutoff: IdentityLocation, showAll: boolean): Character {
  const identity = character.identity;
  // Legacy aliases have no reveal anchors. They remain available in explicit full-book view only.
  if (!identity) return { ...character, aliases: showAll ? [...character.aliases] : [] };
  const events = ordered(identity.events.filter(event => showAll || visible(event.at, cutoff)));
  const renames = events.filter(event => event.kind === 'rename');
  const manualNames = renames.filter(event => event.source === 'manual');
  const name = (manualNames.length ? manualNames : renames).at(-1)?.value || identity.initialName;
  const aliases = new Map<string, { value: string; active: boolean; manual: boolean }>();
  if (showAll) for (const value of identity.initialAliases || []) aliases.set(normalized(value), { value, active: true, manual: false });
  for (const value of [identity.initialName, ...renames.map(event => event.value || '')]) if (value && normalized(value) !== normalized(name)) aliases.set(normalized(value), { value, active: true, manual: false });
  for (const event of events.filter(event => event.kind === 'alias' && event.value)) {
    const key = normalized(event.value!); const previous = aliases.get(key);
    if (previous?.manual && event.source !== 'manual') continue;
    aliases.set(key, { value: event.value!, active: event.active !== false, manual: event.source === 'manual' });
  }
  return {
    ...character,
    name,
    aliases: [...aliases.values()].filter(alias => alias.active && normalized(alias.value) !== normalized(name)).map(alias => alias.value),
    identity: showAll ? identity : { ...identity, initialAliases: undefined, events },
  };
}

function mergeTarget(character: Character, at: IdentityLocation, showAll: boolean): string | undefined {
  let selected: CharacterIdentityEvent | undefined;
  for (const event of character.identity?.events || []) {
    if (event.kind !== 'merge' || (!showAll && !visible(event.at, at))) continue;
    if (!selected || (event.source !== selected.source ? event.source === 'manual' :
      event.updatedAt > selected.updatedAt || (event.updatedAt === selected.updatedAt && event.id.localeCompare(selected.id) > 0))) selected = event;
  }
  return selected?.targetId;
}

function identityResolver(byId: ReadonlyMap<string, Character>, at: IdentityLocation, showAll: boolean) {
  const resolved = new Map<string, string | null>();
  return (id: string | null): string | null => {
    if (!id) return null;
    const seen = new Set<string>();
    const bookId = byId.get(id)?.bookId;
    let current: string | undefined = id;
    let canonical: string | null = null;
    while (current && !seen.has(current)) {
      const character = byId.get(current);
      if (!character || character.bookId !== bookId) break;
      const cached = resolved.get(current);
      if (cached !== undefined) { canonical = cached; break; }
      seen.add(current);
      const target = mergeTarget(character, at, showAll);
      if (!target) { canonical = current; break; }
      current = target;
    }
    for (const member of seen) resolved.set(member, canonical);
    return canonical;
  };
}

/** Redirects are an append-only history. Original dialogue character IDs remain valid. */
export function resolveCharacterIdAt(id: string | null, characters: readonly Character[], at: IdentityLocation, showAll = false): string | null {
  return identityResolver(new Map(characters.map(character => [character.id, character])), at, showAll)(id);
}

function introductions(byId: ReadonlyMap<string, Character>, dialogues: readonly Dialogue[], chapters: readonly Chapter[]) {
  const locations = new Map<string, IdentityLocation>();
  const byChapter = new Map(chapters.map(chapter => [chapter.id, chapter]));
  for (const character of byId.values()) {
    if (character.identity) locations.set(character.id, character.identity.introducedAt);
  }
  for (const dialogue of dialogues) {
    if (!dialogue.characterId) continue;
    const character = byId.get(dialogue.characterId);
    const chapter = byChapter.get(dialogue.chapterId);
    // A later identity linked to earlier dialogue must keep its original introduction anchor.
    if (!character || character.identity || character.bookId !== dialogue.bookId || chapter?.bookId !== dialogue.bookId) continue;
    const at = { chapterIndex: chapter.index, paragraphIndex: dialogue.paragraphIndex, offset: 0 };
    const previous = locations.get(character.id);
    if (!previous || compareIdentityLocations(at, previous) < 0) locations.set(character.id, at);
  }
  return locations;
}

export function indexCharacterIntroductions(characters: readonly Character[], dialogues: readonly Dialogue[], chapters: readonly Chapter[]): Map<string, IdentityLocation> {
  return introductions(new Map(characters.map(character => [character.id, character])), dialogues, chapters);
}

/** Index the book once, then project names and history as the reading position changes. */
export function createIdentityProjector(characters: readonly Character[], dialogues: readonly Dialogue[], chapters: readonly Chapter[]) {
  const byId = new Map(characters.map(character => [character.id, character]));
  const locations = introductions(byId, dialogues, chapters);
  return (at: IdentityLocation, showAll = false) => {
    const resolve = identityResolver(byId, at, showAll);
    const eligible = new Map<string, Character>();
    const targetById = new Map<string, string>();
    const selected = new Map<string, Character>();
    const mergedNames = new Map<string, string[]>();
    for (const source of byId.values()) {
      const introduced = locations.get(source.id);
      if (showAll || (introduced && visible(introduced, at))) eligible.set(source.id, projected(source, at, showAll));
    }
    for (const source of eligible.values()) {
      const canonical = resolve(source.id);
      if (!canonical) continue;
      const target = eligible.get(canonical) || source;
      targetById.set(source.id, target.id);
      selected.set(target.id, target);
      if (target.id !== source.id) {
        const names = mergedNames.get(target.id) || [];
        names.push(source.name, ...source.aliases);
        mergedNames.set(target.id, names);
      }
    }
    for (const [id, names] of mergedNames) {
      const target = selected.get(id)!;
      const removed = new Set<string>();
      for (const event of ordered(target.identity?.events || [])) {
        if (event.kind !== 'alias' || event.source !== 'manual' || !event.value) continue;
        const name = normalized(event.value);
        if (event.active === false) removed.add(name);
        else removed.delete(name);
      }
      target.aliases = [...new Set([...target.aliases, ...names])]
        .filter(alias => normalized(alias) !== normalized(target.name) && !removed.has(normalized(alias)));
    }
    return {
      characters: [...selected.values()],
      character: (id: string | null): Character | undefined => id ? selected.get(targetById.get(id) || '') : undefined,
    };
  };
}

export function displayCharacterAt(id: string | null, characters: readonly Character[], dialogues: readonly Dialogue[], chapters: readonly Chapter[], at: IdentityLocation, showAll = false): Character | undefined {
  return createIdentityProjector(characters, dialogues, chapters)(at, showAll).character(id);
}

export function projectCharactersAt(characters: readonly Character[], dialogues: readonly Dialogue[], chapters: readonly Chapter[], at: IdentityLocation, showAll = false): Character[] {
  return createIdentityProjector(characters, dialogues, chapters)(at, showAll).characters;
}

export interface IdentityProposal {
  characterId: string; kind: 'alias' | 'merge'; value?: string; targetId?: string;
  evidence: { paragraphIndex: number; start: number; end: number; text: string }; confidence: number;
}
export interface IdentityProposalScope {
  chapter: Chapter; context: readonly { paragraph: number; text: string; start?: number }[];
  characters: readonly Character[]; knownIds?: readonly string[]; introductions?: ReadonlyMap<string, IdentityLocation>;
}
const generic = /^(?:我|你|他|她|它|他们|她们|老人|男人|女人|少年|少女|先生|小姐|老板|老师|医生|警察|父亲|母亲|哥哥|姐姐|弟弟|妹妹|unknown|narrator|speaker|man|woman|boy|girl|old man|sir|madam|mr\.?|mrs\.?|miss|doctor|teacher|captain|he|she|they|i|you|we)$/i;
const relation = /(?:(?:的\s*)?(?:本名|真名|原名|化名|别名|绰号|曾用名)(?:是|叫|为|[:：])|又名|就是|其实是|叫作|叫做|也叫|称作|唤作|(?:['’]s )?(?:real name|true name|identity) (?:is|was)|(?:is |was )?also known as|a\.?k\.?a\.?|(?:was|is) (?:called|actually|really)|called (?:himself|herself))/i;
function containsName(haystack: string, name: string): boolean {
  const needle = normalized(name); const body = normalized(haystack);
  if (/\p{Script=Han}/u.test(needle)) return needle.length >= 2 && body.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(body);
}
function directIdentityRelation(evidence: string, continuation: string, left: string, right: string): boolean {
  const escape = (name: string) => normalized(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = normalized(evidence + continuation);
  const limit = normalized(evidence).length;
  const connector = '\\s*(?:,\\s*)?(?:' + relation.source + ')\\s*["“‘]?';
  const prefix = '(?:^|[^\\p{L}\\p{N}])';
  const suffix = "(?![\\p{L}\\p{N}]|['’]s\\b)";
  const match = new RegExp(prefix + '(?:' + escape(left) + connector + escape(right) + '|' + escape(right) + connector + escape(left) + ')' + suffix, 'iu').exec(body);
  return !!match && match.index + match[0].length <= limit;
}

/** AI evidence must be an exact substring both of the novel and of the actual bounded request. */
export function applyIdentityProposal(character: Character, proposal: IdentityProposal, scope: IdentityProposalScope): Character | null {
  const evidence = proposal?.evidence;
  if (proposal.characterId !== character.id || (scope.knownIds && !scope.knownIds.includes(character.id)) || character.bookId !== scope.chapter.bookId || !evidence || !number(evidence.paragraphIndex) || !number(evidence.start) || !number(evidence.end) || evidence.end <= evidence.start || !text(evidence.text, 1200) || !Number.isFinite(proposal.confidence) || proposal.confidence < 0.9 || proposal.confidence > 1) return null;
  const paragraph = scope.chapter.paragraphs[evidence.paragraphIndex];
  const sent = scope.context.find(row => row.paragraph === evidence.paragraphIndex && evidence.start >= (row.start || 0) && evidence.end <= (row.start || 0) + row.text.length && row.text.slice(evidence.start - (row.start || 0), evidence.end - (row.start || 0)) === evidence.text);
  if (!paragraph || paragraph.slice(evidence.start, evidence.end) !== evidence.text || !sent || !relation.test(evidence.text)) return null;
  const continuation = paragraph.slice(evidence.end, evidence.end + 8);
  const at = { chapterIndex: scope.chapter.index, paragraphIndex: evidence.paragraphIndex, offset: evidence.end };
  const introduction = character.identity?.introducedAt || scope.introductions?.get(character.id);
  if (introduction && !visible(introduction, at)) return null;
  const sourceNames = [projected(character, at, false).name, ...projected(character, at, false).aliases];
  const usableName = (name: string, id: string) => scope.characters.filter(other => other.bookId === character.bookId && [projected(other, at, false).name, ...projected(other, at, false).aliases].some(alias => normalized(alias) === normalized(name))).length === 1 && (!generic.test(name) || !!scope.knownIds?.includes(id));
  if (!sourceNames.some(name => usableName(name, character.id) && containsName(evidence.text, name))) return null;
  let value: string | undefined; let targetId: string | undefined;
  if (proposal.kind === 'alias') {
    if (!text(proposal.value, 80)) return null;
    value = cleanName(proposal.value);
    if (generic.test(value) || !containsName(evidence.text, value) || sourceNames.some(name => normalized(name) === normalized(value!))) return null;
    if (!sourceNames.some(name => directIdentityRelation(evidence.text, continuation, name, value!))) return null;
    // A shared alias is ambiguous; do not silently unify two people.
    if (scope.characters.some(other => other.id !== character.id && other.bookId === character.bookId && [projected(other, at, false).name, ...projected(other, at, false).aliases].some(name => normalized(name) === normalized(value!)))) return null;
    if (character.identity?.events.some(event => event.kind === 'alias' && event.source === 'manual' && normalized(event.value || '') === normalized(value!))) return null;
  } else if (proposal.kind === 'merge') {
    const target = scope.characters.find(other => other.id === proposal.targetId && other.bookId === character.bookId);
    if (!target || target.id === character.id || (scope.knownIds && !scope.knownIds.includes(target.id))) return null;
    const targetIntroduction = target.identity?.introducedAt || scope.introductions?.get(target.id);
    if (targetIntroduction && !visible(targetIntroduction, at)) return null;
    const targetName = projected(target, at, false).name;
    if (!usableName(targetName, target.id) || !containsName(evidence.text, targetName) || sourceNames.some(name => normalized(name) === normalized(targetName))) return null;
    if (!sourceNames.some(name => directIdentityRelation(evidence.text, continuation, name, targetName))) return null;
    if (character.identity?.events.some(event => event.kind === 'merge' && event.source === 'manual')) return null;
    targetId = target.id;
  } else return null;
  const next = initializeCharacterIdentity(character, introduction || { ...at, offset: 0 });
  const event: CharacterIdentityEvent = { id: `identity:${character.id}:${proposal.kind}:${scope.chapter.id}:${evidence.paragraphIndex}:${evidence.start}:${evidence.end}:${value || targetId}`, kind: proposal.kind, source: 'ai', at, value, targetId, evidence: { chapterId: scope.chapter.id, ...evidence }, confidence: proposal.confidence, updatedAt: Date.now() };
  if (next.identity!.events.some(existing => existing.id === event.id)) return next;
  if (next.identity!.events.length >= 2000) return null;
  next.identity!.events.push(event);
  if (targetId && !validIdentityRedirects(new Map([...scope.characters.filter(row => row.id !== next.id), next].map(row => [row.id, row])))) return null;
  const latest = projected(next, unlimited, true);
  next.name = latest.name; next.aliases = latest.aliases;
  return next;
}

export function validCharacterIdentity(value: unknown): value is CharacterIdentity | undefined {
  if (value === undefined) return true;
  if (!object(value) || value.version !== 1 || !text(value.initialName) || (value.initialAliases !== undefined && (!Array.isArray(value.initialAliases) || value.initialAliases.length > 300 || value.initialAliases.some(alias => !text(alias)))) || !validIdentityLocation(value.introducedAt) || !Array.isArray(value.events) || value.events.length > 2000) return false;
  const ids = new Set<string>();
  return value.events.every(event => {
    if (!object(event) || !text(event.id, 700) || ids.has(event.id) || !['alias', 'rename', 'merge'].includes(String(event.kind)) || !['ai', 'manual'].includes(String(event.source)) || !validIdentityLocation(event.at) || !number(event.updatedAt) || (event.active !== undefined && typeof event.active !== 'boolean') || (event.confidence !== undefined && (typeof event.confidence !== 'number' || !Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1))) return false;
    ids.add(event.id);
    if (event.kind === 'merge' ? !text(event.targetId, 240) : !text(event.value, 300)) return false;
    if (event.evidence !== undefined) {
      const e = event.evidence;
      if (!object(e) || !text(e.chapterId, 240) || !number(e.paragraphIndex) || !number(e.start) || !number(e.end) || e.end <= e.start || !text(e.text, 1200) || e.end - e.start !== e.text.length) return false;
    }
    return event.source !== 'ai' || (event.evidence !== undefined && typeof event.confidence === 'number' && event.confidence >= 0.9);
  });
}

function validIdentityRedirects(byId: ReadonlyMap<string, Character>): boolean {
  const resolveAll = identityResolver(byId, unlimited, true);
  const redirects = [...byId.values()].filter(character => character.identity?.events.some(event => event.kind === 'merge'));
  if (redirects.some(character => !resolveAll(character.id))) return false;
  for (const character of redirects) {
    for (const event of character.identity!.events) {
      // Every change to the redirect graph begins at one of these positions.
      if (event.kind === 'merge' && !identityResolver(byId, event.at, false)(character.id)) return false;
    }
  }
  return true;
}

/** Validates only annotation metadata; it never changes novel text or user data. */
export function validIdentityGraph(characters: readonly Character[], chapters: readonly Chapter[]): boolean {
  const byId = new Map(characters.map(character => [character.id, character]));
  const byChapter = new Map(chapters.map(chapter => [chapter.id, chapter]));
  for (const character of characters) {
    if (!validCharacterIdentity(character.identity)) return false;
    for (const event of character.identity?.events || []) {
      if (event.targetId && byId.get(event.targetId)?.bookId !== character.bookId) return false;
      if (event.evidence) {
        const e = event.evidence; const chapter = byChapter.get(e.chapterId);
        if (!chapter || chapter.bookId !== character.bookId || chapter.index !== event.at.chapterIndex || e.paragraphIndex !== event.at.paragraphIndex || event.at.offset < e.end || chapter.paragraphs[e.paragraphIndex]?.slice(e.start, e.end) !== e.text) return false;
      }
    }
  }
  return validIdentityRedirects(byId);
}

/** Combines concurrent append-only facts without letting remote AI overwrite a manual identity. */
export function mergeCharacterIdentity(left: Character, right: Character): Character {
  if (left.id !== right.id || left.bookId !== right.bookId) return left;
  const histories = [left.identity, right.identity].filter((identity): identity is CharacterIdentity => !!identity);
  if (!histories.length) return left;
  const events = new Map<string, CharacterIdentityEvent>();
  for (const event of [...(right.identity?.events || []), ...(left.identity?.events || [])]) {
    const old = events.get(event.id);
    if (!old || (old.source !== event.source ? event.source === 'manual' : old.updatedAt <= event.updatedAt)) events.set(event.id, event);
  }
  const first = histories.sort((a, b) => compareIdentityLocations(a.introducedAt, b.introducedAt))[0];
  const initialAliases = new Set(histories.flatMap(identity => identity.initialAliases || []));
  for (const row of [left, right]) {
    // Older clients can change the scalar name without storing a reveal position.
    const canonical = row.identity && projected(row, unlimited, true);
    if (row.name !== first.initialName && row.name !== canonical?.name) initialAliases.add(row.name);
    for (const alias of row.aliases) if (!canonical?.aliases.includes(alias)) initialAliases.add(alias);
  }
  const result: Character = { ...left, identity: { version: 1, initialName: first.initialName, initialAliases: [...initialAliases].slice(0, 300), introducedAt: first.introducedAt, events: ordered([...events.values()]) } };
  const canonical = projected(result, unlimited, true);
  result.name = canonical.name; result.aliases = canonical.aliases.slice(0, 300);
  return result;
}

async function editingScope(bookId: string, supplied?: IdentityLocation): Promise<IdentityLocation> {
  if (supplied) { if (!validIdentityLocation(supplied)) throw new Error('人物修改位置无效。'); return supplied; }
  const progress = await db.progress.get(bookId);
  const chapter = progress && await db.chapters.get(progress.chapterId);
  return chapter ? { chapterIndex: chapter.index, paragraphIndex: progress!.paragraphIndex, offset: progress!.offset } : { ...beginning };
}

async function existingIntroduction(character: Character, at: IdentityLocation): Promise<IdentityLocation> {
  if (character.identity) return character.identity.introducedAt;
  const [dialogues, chapters] = await Promise.all([db.dialogues.where('bookId').equals(character.bookId).toArray(), db.chapters.where('bookId').equals(character.bookId).toArray()]);
  return introductions(new Map([[character.id, character]]), dialogues, chapters).get(character.id) || at;
}

export async function manualRenameCharacter(id: string, name: string, scope?: IdentityLocation): Promise<void> {
  const clean = cleanName(name).slice(0, 80);
  const character = await db.characters.get(id);
  if (!character || !clean) throw new Error('人物或名称无效。');
  const at = await editingScope(character.bookId, scope);
  const introducedAt = await existingIntroduction(character, at);
  await db.transaction('rw', db.characters, async () => {
    const current = await db.characters.get(id); if (!current) throw new Error('人物已不存在。');
    const next = initializeCharacterIdentity(current, introducedAt);
    if (next.identity!.events.length >= 2000) throw new Error('人物修改历史已达到本版上限，请先保留备份。');
    next.identity!.events.push({ id: crypto.randomUUID(), kind: 'rename', source: 'manual', value: clean, at, updatedAt: Date.now() });
    const latest = projected(next, unlimited, true); next.name = latest.name; next.aliases = latest.aliases;
    await db.characters.put(next);
  });
}

export async function manualSetAliases(id: string, aliases: string[], scope?: IdentityLocation): Promise<void> {
  const names = [...new Set(aliases.map(alias => cleanName(alias).slice(0, 80)).filter(Boolean))];
  if (names.length > 100) throw new Error('别名数量过多。');
  const character = await db.characters.get(id); if (!character) throw new Error('人物已不存在。');
  const at = await editingScope(character.bookId, scope);
  const introducedAt = await existingIntroduction(character, at);
  await db.transaction('rw', db.characters, async () => {
    const current = await db.characters.get(id); if (!current) throw new Error('人物已不存在。');
    const next = initializeCharacterIdentity(current, introducedAt);
    const all = [...new Set([...projected(next, at, false).aliases, ...names])];
    if (next.identity!.events.length + all.length > 2000) throw new Error('人物修改历史已达到本版上限，请先保留备份。');
    for (const value of all) next.identity!.events.push({ id: crypto.randomUUID(), kind: 'alias', source: 'manual', value, active: names.some(name => normalized(name) === normalized(value)), at, updatedAt: Date.now() });
    next.aliases = projected(next, unlimited, true).aliases;
    await db.characters.put(next);
  });
}
export async function manualAddAlias(id: string, alias: string, scope?: IdentityLocation): Promise<void> {
  await manualAliasEvent(id, alias, true, scope);
}
export async function manualRemoveAlias(id: string, alias: string, scope?: IdentityLocation): Promise<void> {
  await manualAliasEvent(id, alias, false, scope);
}
async function manualAliasEvent(id: string, alias: string, active: boolean, scope?: IdentityLocation): Promise<void> {
  const value = cleanName(alias).slice(0, 80);
  const character = await db.characters.get(id); if (!character || !value) throw new Error('人物或别名无效。');
  const at = await editingScope(character.bookId, scope);
  const introducedAt = await existingIntroduction(character, at);
  await db.transaction('rw', db.characters, async () => {
    const current = await db.characters.get(id); if (!current) throw new Error('人物已不存在。');
    const next = initializeCharacterIdentity(current, introducedAt);
    if (next.identity!.events.length >= 2000) throw new Error('人物修改历史已达到本版上限，请先保留备份。');
    next.identity!.events.push({ id: crypto.randomUUID(), kind: 'alias', source: 'manual', value, active, at, updatedAt: Date.now() });
    next.aliases = projected(next, unlimited, true).aliases;
    await db.characters.put(next);
  });
}

export async function manualMergeCharacters(sourceId: string, targetId: string, scope?: IdentityLocation): Promise<void> {
  const source = await db.characters.get(sourceId); const target = await db.characters.get(targetId);
  if (!source || !target || source.id === target.id || source.bookId !== target.bookId) throw new Error('请选择同一本书中的两个不同人物。');
  const at = await editingScope(source.bookId, scope);
  const introducedAt = await existingIntroduction(source, at);
  await db.transaction('rw', db.characters, async () => {
    const characters = await db.characters.where('bookId').equals(source.bookId).toArray();
    const current = characters.find(character => character.id === sourceId); if (!current || !characters.some(character => character.id === targetId)) throw new Error('人物已不存在。');
    const next = initializeCharacterIdentity(current, introducedAt);
    if (next.identity!.events.length >= 2000) throw new Error('人物修改历史已达到本版上限，请先保留备份。');
    next.identity!.events.push({ id: crypto.randomUUID(), kind: 'merge', source: 'manual', targetId, at, updatedAt: Date.now() });
    const byId = new Map(characters.map(character => [character.id, character]));
    byId.set(sourceId, next);
    if (!validIdentityRedirects(byId)) throw new Error('人物合并会形成循环，未保存。');
    // Do not delete source or rewrite historical dialogue/correction IDs.
    await db.characters.put(next);
  });
}
