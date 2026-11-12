// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { exportBackup, importBook, listChapters, restoreBackup } from '../core/library';
import { mergeBundles, validateBundle, type BookBundle } from './cloud';
import type { Chapter, Character, Dialogue, IdentityLocation } from '../types';
import {
  applyIdentityProposal, createIdentityProjector, displayCharacterAt, indexCharacterIntroductions, initializeCharacterIdentity, manualAddAlias,
  manualMergeCharacters, manualRemoveAlias, manualRenameCharacter, mergeCharacterIdentity,
  projectCharactersAt, resolveCharacterIdAt, validIdentityGraph, type IdentityProposal,
} from './character-identity';

vi.stubGlobal('File', NodeFile); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('crypto', webcrypto);
beforeEach(async () => { await db.delete(); await db.open(); });
afterAll(async () => { await db.delete(); });
const at = (chapterIndex = 0, paragraphIndex = 0, offset = 0): IdentityLocation => ({ chapterIndex, paragraphIndex, offset });
const character = (id: string, name: string, chapterIndex = 0): Character => initializeCharacterIdentity({ id, name, bookId: 'book', aliases: [] }, at(chapterIndex));
const chapter = (index: number, paragraph: string): Chapter => ({ id: `book:ch:${index}`, bookId: 'book', index, title: `第${index + 1}章`, paragraphs: [paragraph] });
const dialogue = (id: string, characterId: string, chapterId: string, text = '“走吧。”'): Dialogue => ({ id, characterId, chapterId, bookId: 'book', text, paragraphIndex: 0, start: 4, end: 4 + text.length, source: 'ai', confidence: 0.9, updatedAt: 1 });
const proposal = (id: string, value: string, text: string): IdentityProposal => ({ characterId: id, kind: 'alias', value, confidence: 0.98, evidence: { paragraphIndex: 0, start: 0, end: text.length, text } });

describe('evidence-backed cross chapter identities', () => {
  it('accepts an exact sent alias reveal but hides it on earlier pages', () => {
    const person = character('masked', '蒙面客'); const reveal = chapter(1, '蒙面客的真名是林青。');
    const next = applyIdentityProposal(person, proposal(person.id, '林青', reveal.paragraphs[0]), { chapter: reveal, context: [{ paragraph: 0, text: reveal.paragraphs[0], start: 0 }], characters: [person], knownIds: [person.id] })!;
    expect(next.aliases).toContain('林青');
    expect(displayCharacterAt(person.id, [next], [], [reveal], at(0))?.aliases).toEqual([]);
    expect(displayCharacterAt(person.id, [next], [], [reveal], at(0))?.identity?.events).toEqual([]);
    expect(displayCharacterAt(person.id, [next], [], [reveal], at(1, 0, reveal.paragraphs[0].length))?.aliases).toEqual(['林青']);
  });
  it('rejects forged, outside-window, low confidence and unrelated evidence', () => {
    const person = character('masked', '蒙面客'); const row = chapter(1, '蒙面客的真名是林青。'); const p = proposal(person.id, '林青', row.paragraphs[0]);
    const scope = { chapter: row, context: [{ paragraph: 0, text: row.paragraphs[0] }], characters: [person] };
    expect(applyIdentityProposal(person, { ...p, confidence: 0.7 }, scope)).toBeNull();
    expect(applyIdentityProposal(person, { ...p, evidence: { ...p.evidence, text: '蒙面客的真名是沈河。' } }, scope)).toBeNull();
    expect(applyIdentityProposal(person, p, { ...scope, context: [{ paragraph: 0, text: '蒙面客', start: 0 }] })).toBeNull();
    const unrelated = chapter(1, '林青看向沈河，沈河就是凶手。'); const lin = character('lin', '林青'); const shen = character('shen', '沈河');
    expect(applyIdentityProposal(lin, { ...proposal(lin.id, '', unrelated.paragraphs[0]), kind: 'merge', targetId: shen.id }, { chapter: unrelated, context: [{ paragraph: 0, text: unrelated.paragraphs[0] }], characters: [lin, shen], knownIds: [lin.id, shen.id] })).toBeNull();
  });
  it.each([
    ['蒙面客', '林青', '蒙面客就是林青的父亲。', '蒙面客就是林青'],
    ['蒙面客', '林青', '蒙面客的哥哥其实是林青。', '蒙面客的哥哥其实是林青。'],
    ['Mira', 'Alice', 'Mira was actually not Alice.', 'Mira was actually not Alice.'],
    ['Mira', 'Alice', "Mira was actually Alice's sister.", 'Mira was actually Alice'],
  ])('rejects misleading relationships for %s and %s', (name, alias, paragraph, evidence) => {
    const person = character('speaker', name);
    const row = chapter(1, paragraph);
    expect(applyIdentityProposal(person, proposal(person.id, alias, evidence), {
      chapter: row, context: [{ paragraph: 0, text: paragraph }], characters: [person], knownIds: [person.id],
    })).toBeNull();
  });
  it('keeps equal names distinct and permits a generic role only with unique known-id reveal evidence', () => {
    const first = character('wang-a', '王平'); const second = character('wang-b', '王平'); const target = character('liu', '刘健');
    const row = chapter(1, '王平的真名是刘健。');
    expect(applyIdentityProposal(first, { ...proposal(first.id, '', row.paragraphs[0]), kind: 'merge', targetId: target.id }, { chapter: row, context: [{ paragraph: 0, text: row.paragraphs[0] }], characters: [first, second, target], knownIds: [first.id, second.id, target.id] })).toBeNull();
    const elder = character('elder', '老人'); const text = '老人的本名是沈云。'; const old = chapter(1, text);
    const p = proposal(elder.id, '沈云', text); const scope = { chapter: old, context: [{ paragraph: 0, text }], characters: [elder] };
    expect(applyIdentityProposal(elder, p, scope)).toBeNull();
    expect(applyIdentityProposal(elder, p, { ...scope, knownIds: [elder.id] })?.aliases).toEqual(['沈云']);
    expect(applyIdentityProposal(elder, p, { ...scope, characters: [elder, character('other-elder', '老人')], knownIds: [elder.id] })).toBeNull();
  });
  it('preserves original ids and earlier display across a future explicit identity merge', () => {
    const masked = character('masked', '蒙面客'); const lin = character('lin', '林青', 1); const row = chapter(1, '蒙面客就是林青。');
    const next = applyIdentityProposal(masked, { ...proposal(masked.id, '', row.paragraphs[0]), kind: 'merge', targetId: lin.id }, { chapter: row, context: [{ paragraph: 0, text: row.paragraphs[0] }], characters: [masked, lin], knownIds: [masked.id, lin.id] })!;
    expect(resolveCharacterIdAt(masked.id, [next, lin], at(0))).toBe(masked.id);
    expect(resolveCharacterIdAt(masked.id, [next, lin], at(1, 0, row.paragraphs[0].length))).toBe(lin.id);
    expect(projectCharactersAt([next, lin], [], [row], at(0)).map(person => person.name)).toEqual(['蒙面客']);
    const visible = projectCharactersAt([next, lin], [], [row], at(1, 0, row.paragraphs[0].length));
    expect(visible).toHaveLength(1); expect(visible[0]).toMatchObject({ id: lin.id, name: '林青', aliases: ['蒙面客'] });
  });
  it('supports English reveal evidence and same-paragraph legacy labels without future aliases', () => {
    const traveler = character('traveler', 'traveler'); const row = chapter(1, 'The traveler was called Mira.');
    const next = applyIdentityProposal(traveler, proposal(traveler.id, 'Mira', row.paragraphs[0]), { chapter: row, context: [{ paragraph: 0, text: row.paragraphs[0] }], characters: [traveler], knownIds: [traveler.id] })!;
    expect(next.aliases).toEqual(['Mira']);
    const legacy: Character = { id: 'legacy', bookId: 'book', name: '林青', aliases: ['未来身份'] };
    expect(projectCharactersAt([legacy], [dialogue('d', legacy.id, 'book:ch:0')], [chapter(0, '林青说：“走吧。”')], at(0))).toMatchObject([{ name: '林青', aliases: [] }]);
    expect(projectCharactersAt([legacy], [dialogue('d', legacy.id, 'book:ch:1')], [row], at(0))).toEqual([]);
  });
  it('indexes early legacy appearances without backdating later V0.4 identities', () => {
    const legacy: Character = { id: 'legacy', bookId: 'book', name: '蒙面客', aliases: [] };
    const future = character('future', '林青', 2);
    const reveal = chapter(1, '蒙面客也叫旅人。');
    const chapters = [chapter(0, '蒙面客说：“走吧。”'), reveal];
    const dialogues = [dialogue('legacy-dialogue', legacy.id, chapters[0].id), dialogue('future-link', future.id, chapters[0].id)];
    const introductions = indexCharacterIntroductions([legacy, future], dialogues, chapters);
    const next = applyIdentityProposal(legacy, proposal(legacy.id, '旅人', reveal.paragraphs[0]), {
      chapter: reveal, context: [{ paragraph: 0, text: reveal.paragraphs[0] }], characters: [legacy, future], introductions,
    })!;
    const project = createIdentityProjector([next, future], dialogues, chapters);
    expect(project(at()).characters).toMatchObject([{ id: legacy.id, name: legacy.name, aliases: [] }]);
    expect(project(at()).character(future.id)).toBeUndefined();
    expect(project(at(1, 0, reveal.paragraphs[0].length)).character(legacy.id)?.aliases).toEqual(['旅人']);
    expect(project(at(2)).character(future.id)?.name).toBe('林青');
  });
});

describe('manual history and local persistence', () => {
  it('renames and merges without rewriting original dialogue ids, and rejects cycles', async () => {
    const masked = character('masked', '蒙面客'); const lin = character('lin', '林青', 1);
    await db.characters.bulkPut([masked, lin]); await db.dialogues.put(dialogue('d', masked.id, 'book:ch:0'));
    await manualRenameCharacter(masked.id, '旅人', at(0, 0, 20));
    await manualMergeCharacters(masked.id, lin.id, at(1, 0, 10));
    expect((await db.dialogues.get('d'))?.characterId).toBe(masked.id);
    expect(await db.characters.get(masked.id)).toBeDefined();
    await expect(manualMergeCharacters(lin.id, masked.id, at(1, 0, 20))).rejects.toThrow('循环');
    const rows = await db.characters.toArray();
    expect(displayCharacterAt(masked.id, rows, [], [], at(0, 0, 10))?.name).toBe('蒙面客');
    expect(displayCharacterAt(masked.id, rows, [], [], at(0, 0, 20))?.name).toBe('旅人');
    expect(resolveCharacterIdAt(masked.id, rows, at(1, 0, 10))).toBe(lin.id);
    db.close(); await db.open();
    expect(resolveCharacterIdAt(masked.id, await db.characters.toArray(), at(1, 0, 10))).toBe(lin.id);
  });
  it('rejects a historical cycle even when a later redirect breaks it', async () => {
    const a = character('a', '林青'); const b = character('b', '沈河'); const c = character('c', '旅人');
    b.identity!.events.push(
      { id: 'b-a', kind: 'merge', source: 'manual', targetId: a.id, at: at(1), updatedAt: 10 },
      { id: 'b-c', kind: 'merge', source: 'manual', targetId: c.id, at: at(2), updatedAt: 20 },
    );
    await db.characters.bulkPut([a, b, c]);
    await expect(manualMergeCharacters(a.id, b.id, at())).rejects.toThrow('循环');
    expect(await db.characters.get(a.id)).toEqual(a);
  });
  it('adds/removes only the chosen alias and never advances a future identity reveal', async () => {
    const person = character('masked', '蒙面客'); const row = chapter(2, '蒙面客的真名是林青。');
    const future = applyIdentityProposal(person, proposal(person.id, '林青', row.paragraphs[0]), { chapter: row, context: [{ paragraph: 0, text: row.paragraphs[0] }], characters: [person], knownIds: [person.id] })!;
    await db.characters.put(future);
    await manualAddAlias(person.id, '旅人', at(0));
    const changed = (await db.characters.get(person.id))!;
    expect(displayCharacterAt(person.id, [changed], [], [], at(0))?.aliases).toEqual(['旅人']);
    expect(changed.identity!.events).toHaveLength(2);
    await manualRemoveAlias(person.id, '旅人', at(0, 0, 10));
    const removed = (await db.characters.get(person.id))!;
    expect(displayCharacterAt(person.id, [removed], [], [], at(0, 0, 10))?.aliases).toEqual([]);
    expect(displayCharacterAt(person.id, [removed], [], [], at(2, 0, row.paragraphs[0].length))?.aliases).toEqual(['林青']);
  });
  it('does not let later AI or a concurrent cloud fact overwrite a manual alias removal', async () => {
    const person = character('lin', '林青'); await db.characters.put(person);
    await manualRemoveAlias(person.id, '旅人', at(0));
    const manual = (await db.characters.get(person.id))!;
    const row = chapter(1, '林青也叫旅人。');
    expect(applyIdentityProposal(manual, proposal(person.id, '旅人', row.paragraphs[0]), { chapter: row, context: [{ paragraph: 0, text: row.paragraphs[0] }], characters: [manual] })).toBeNull();
    const remote = applyIdentityProposal(person, proposal(person.id, '旅人', row.paragraphs[0]), { chapter: row, context: [{ paragraph: 0, text: row.paragraphs[0] }], characters: [person] })!;
    remote.identity!.events[0].updatedAt = Date.now() + 100000;
    const merged = mergeCharacterIdentity(manual, remote);
    expect(displayCharacterAt(person.id, [merged], [], [], at(1, 0, row.paragraphs[0].length))?.aliases).toEqual([]);
    expect(merged.identity!.events).toHaveLength(2);
  });
});

describe('backup and cloud identity validation', () => {
  async function fixture() {
    const book = await importBook(new File(['第一章 来客\n蒙面客说：“走吧。”\n第二章 揭示\n蒙面客的真名是林青。'], '身份测试.txt'));
    const chapters = await listChapters(book.id);
    const masked = initializeCharacterIdentity({ id: 'masked', name: '蒙面客', aliases: [], bookId: book.id }, at());
    const row = chapters[1]; const p = proposal(masked.id, '林青', row.paragraphs[0]);
    const withAlias = applyIdentityProposal(masked, p, { chapter: row, context: [{ paragraph: 0, text: row.paragraphs[0] }], characters: [masked], knownIds: [masked.id] })!;
    await db.characters.put(withAlias);
    const bundle: BookBundle = { schema: 1, book, chapters, characters: [withAlias], dialogues: [], corrections: [], jobs: [], bookmarks: [], file: { name: '身份测试.txt', mime: 'text/plain', path: 'account/original.txt' } };
    return { book, chapters, withAlias, bundle };
  }
  it('round-trips evidence/history without exporting secrets or executable authorization', async () => {
    const { book, withAlias, bundle } = await fixture();
    expect(() => validateBundle(bundle, book.id)).not.toThrow();
    await db.settings.put({ id: 'api-key', value: 'DO-NOT-EXPORT' });
    const backup = await exportBackup(); expect(await backup.text()).not.toContain('DO-NOT-EXPORT');
    await db.delete(); await db.open();
    await restoreBackup(new File([backup], 'identity-backup.json'));
    expect(await db.characters.get(withAlias.id)).toEqual(withAlias);
  });
  it('merges legacy cloud and backup names without dropping anchored history or revealing them early', async () => {
    const { book, chapters, withAlias, bundle } = await fixture();
    const legacy = structuredClone(bundle);
    legacy.characters[0] = { id: withAlias.id, bookId: book.id, name: '旅人', aliases: ['蒙面客'] };
    expect(() => validateBundle(legacy, book.id)).not.toThrow();
    const combined = mergeBundles(bundle, legacy, bundle).characters[0];
    expect(combined.identity?.events).toEqual(withAlias.identity?.events);
    expect(combined.aliases).toContain('旅人');
    expect(displayCharacterAt(combined.id, [combined], [], chapters, at())).toMatchObject({ name: '蒙面客', aliases: [] });
    const backup = await exportBackup();
    await db.characters.put(legacy.characters[0]);
    await restoreBackup(new File([backup], 'identity-backup.json'));
    expect(await db.characters.get(withAlias.id)).toEqual(combined);
    expect(() => mergeBundles(bundle, { ...legacy, characters: [] }, bundle)).toThrow('本机记录已保留');
  });
  it('rejects forged evidence, cross-book redirects and cycles before touching an existing library', async () => {
    const { book, withAlias, bundle } = await fixture();
    const forged = structuredClone(bundle); forged.characters[0].identity!.events[0].evidence!.text = '不存在的证据';
    expect(() => validateBundle(forged, book.id)).toThrow('人物');
    const raw = JSON.parse(await (await exportBackup()).text());
    raw.characters[0].identity.events[0].evidence.text = '不存在的证据';
    await expect(restoreBackup(new File([JSON.stringify(raw)], 'invalid.json'))).rejects.toThrow('未被修改');
    expect(await db.characters.get(withAlias.id)).toEqual(withAlias);
    const a = character('a', '林青'); const b = character('b', '沈河');
    a.identity!.events.push({ id: 'ab', kind: 'merge', source: 'manual', at: at(), targetId: b.id, updatedAt: 1 });
    b.identity!.events.push({ id: 'ba', kind: 'merge', source: 'manual', at: at(), targetId: a.id, updatedAt: 2 });
    expect(validIdentityGraph([a, b], [])).toBe(false);
    expect(validIdentityGraph([a, { ...b, bookId: 'another-book' }], [])).toBe(false);
  });
  it('merges independent append-only identity edits and refuses a resulting redirect cycle', async () => {
    const { bundle } = await fixture(); const local = structuredClone(bundle); const remote = structuredClone(bundle);
    const id = local.characters[0].id;
    local.characters[0].identity!.events.push({ id: 'local', kind: 'alias', source: 'manual', value: '旅人', at: at(), updatedAt: 10 });
    remote.characters[0].identity!.events.push({ id: 'remote', kind: 'rename', source: 'manual', value: '林青', at: at(1), updatedAt: 20 });
    expect(mergeBundles(local, remote, bundle).characters.find(row => row.id === id)!.identity!.events).toHaveLength(3);
    const target = { ...character('target', '沈河'), bookId: bundle.book.id };
    local.characters.push(structuredClone(target)); remote.characters.push(structuredClone(target));
    local.characters[0].identity!.events.push({ id: 'a-to-b', kind: 'merge', source: 'manual', targetId: target.id, at: at(1), updatedAt: 100 });
    remote.characters[1].identity!.events.push({ id: 'b-to-a', kind: 'merge', source: 'manual', targetId: id, at: at(1), updatedAt: 100 });
    expect(() => mergeBundles(local, remote, bundle)).toThrow('循环');
  });
});
