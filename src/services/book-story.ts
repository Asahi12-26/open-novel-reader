import type { Chapter, Character, IdentityLocation } from '../types';
import type { AIModel, DialogueCandidate, ModelAttribution } from './ai';
import { bookPayloadFor, validateAttributions } from './ai';
import { AI_COST_MARGIN, AI_MODELS, AI_OUTPUT_LIMIT, AI_TOKEN_OVERHEAD } from '../../supabase/functions/_shared/ai-contract';
import {
  PLOT_CONTEXT_BYTES, STORY_IDENTITY_SYSTEM_PROMPT, STORY_MANUAL_BYTES, STORY_MEMORY_BYTES,
  STORY_PLOT_SYSTEM_PROMPT, validStorySpeechRows,
} from '../../supabase/functions/_shared/story-contract';
import type { StoryContext, StoryManualHint, StorySpeechInput } from '../../supabase/functions/_shared/story-contract';

const encoder = new TextEncoder();
const normalizeName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
function evidenceNames(person: StorySpeechInput['known'][number]) {
  return [person.name, ...person.aliases].map(normalizeName);
}

function containsName(evidence: string, name: string) {
  const text = normalizeName(evidence);
  if (/\p{Script=Han}/u.test(name)) return name.length >= 2 && text.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

export const requestBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
export const STORY_PLOT_EXTRA_BYTES = 16000 + STORY_MEMORY_BYTES + 128;
export const STORY_IDENTITY_EXTRA_BYTES = STORY_PLOT_EXTRA_BYTES + STORY_MANUAL_BYTES + 128;

export function storyRequestCost(system: string, input: unknown, model: AIModel, extraBytes = 0): number {
  const price = AI_MODELS.find(item => item.id === model)!;
  const inputUpper = encoder.encode(system + JSON.stringify(input)).length + AI_TOKEN_OVERHEAD + extraBytes;
  return AI_COST_MARGIN * (inputUpper * price.inputPerMillion + AI_OUTPUT_LIMIT * price.outputPerMillion) / 1_000_000;
}

export interface PlotWindow { context: StoryContext[]; from: IdentityLocation; through: IdentityLocation }
export function plotWindows(chapter: Chapter, from: IdentityLocation): PlotWindow[] {
  const windows: PlotWindow[] = [];
  let context: StoryContext[] = [];
  let last = from;
  const flush = () => {
    if (!context.length) return;
    const end = context[context.length - 1];
    const through = { chapterIndex: chapter.index, paragraphIndex: end.paragraph, offset: end.start + end.text.length };
    windows.push({ context, from: last, through });
    last = through;
    context = [];
  };
  for (let paragraph = from.paragraphIndex; paragraph < chapter.paragraphs.length; paragraph++) {
    const text = chapter.paragraphs[paragraph];
    for (let start = paragraph === from.paragraphIndex ? from.offset : 0; start < text.length;) {
      let end = Math.min(text.length, start + 1400);
      if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      const row = { paragraph, start, text: text.slice(start, end) };
      if (row.text.trim()) {
        if (context.length >= 24 || requestBytes([...context, row]) > PLOT_CONTEXT_BYTES) flush();
        context.push(row);
      }
      start = end;
    }
  }
  flush();
  return windows;
}

export function storySpeechInput(chapter: Chapter, candidates: DialogueCandidate[], known: Character[]): StorySpeechInput {
  const base = bookPayloadFor(chapter, candidates, known);
  const context: StoryContext[] = [];
  for (const candidate of candidates) {
    const paragraph = chapter.paragraphs[candidate.paragraphIndex];
    const start = Math.max(0, candidate.start - 160);
    const end = Math.min(paragraph.length, candidate.end + 160);
    // Adjacent quotes share a context window, but a later quote always keeps its complete span.
    const previous = context[context.length - 1];
    if (previous?.paragraph === candidate.paragraphIndex && start <= previous.start + previous.text.length && end - previous.start <= 7000) {
      previous.text = paragraph.slice(previous.start, Math.max(end, previous.start + previous.text.length));
    } else context.push({ paragraph: candidate.paragraphIndex, start, text: paragraph.slice(start, end) });
  }
  for (const row of base.context) {
    if (context.some(item => item.paragraph === row.paragraph)) continue;
    const nearby = { ...row, text: row.text.slice(0, 380) };
    if (nearby.text.trim() && requestBytes([...context, nearby]) <= 22000) context.push(nearby);
  }
  return { ...base, chapter: base.chapter.trim() || 'Chapter', context: context.sort((a, b) => a.paragraph - b.paragraph || a.start - b.start), memory: [], manual: [] };
}

export function boundedStoryManual(hints: StoryManualHint[]): StoryManualHint[] {
  const accepted: StoryManualHint[] = [];
  for (const hint of hints) {
    if (requestBytes([...accepted, hint]) > STORY_MANUAL_BYTES) break;
    accepted.push(hint);
  }
  return accepted;
}

export function storyAttributions(value: unknown, candidates: DialogueCandidate[], input: StorySpeechInput): ModelAttribution[] {
  const raw = (value as { dialogues?: unknown })?.dialogues;
  if (!validStorySpeechRows(raw, input)) throw new Error('对白证据、编号或候选人物不符合协议。');
  const rows = new Map(raw.map(row => [row.id, row]));
  const byCandidate = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const firstEvidenceByName = new Map<string, { location: string; speaker: string }>();
  return validateAttributions(value, candidates, { context: input.context, known: input.known }).map(valid => {
    const row = rows.get(valid.id)!;
    const candidate = byCandidate.get(row.id)!;
    const localEvidence = row.evidence?.paragraphIndex === candidate.paragraphIndex &&
      row.evidence.end >= Math.max(0, candidate.start - 160) && row.evidence.start <= candidate.end + 160;
    const person = row.characterId ? input.known.find(item => item.id === row.characterId) : undefined;
    const name = valid.speaker ? normalizeName(valid.speaker) : '';
    const matchingPeople = name ? input.known.filter(item => evidenceNames(item).includes(name)) : [];
    const distinctMentions = matchingPeople.length > 1 && row.evidence
      ? matchingPeople.filter(item => evidenceNames(item).some(alias =>
        containsName(row.evidence!.text, alias) && matchingPeople.every(other => other.id === item.id || !evidenceNames(other).includes(alias))))
      : [];
    const disambiguated = distinctMentions.length === 1 && distinctMentions[0].id === person?.id;
    let speaker: string | null = null;
    if (row.speech && localEvidence && name && row.evidence) {
      if (person && matchingPeople.some(item => item.id === person.id) && (matchingPeople.length === 1 || disambiguated)) {
        speaker = valid.speaker;
      } else if (!person && !matchingPeople.length && containsName(row.evidence.text, name)) {
        // Rows for a newly named person can share the same precise source anchor.
        // Separate anchors for an unknown homonym require review before reusing an ID.
        const location = `${row.evidence.paragraphIndex}:${row.evidence.start}:${row.evidence.end}`;
        const earlier = firstEvidenceByName.get(name);
        if (earlier?.location === location) speaker = earlier.speaker;
        else if (!earlier && valid.speaker) {
          speaker = valid.speaker;
          firstEvidenceByName.set(name, { location, speaker });
        }
      }
    }
    const possibleCharacterIds = row.possibleCharacterIds ?? matchingPeople.map(item => item.id).slice(0, 3);
    return {
      ...valid, speaker, characterId: speaker ? row.characterId : null,
      speech: row.speech || !localEvidence || row.confidence < 0.85,
      ...(speaker || !possibleCharacterIds.length ? {} : { possibleCharacterIds }),
    };
  });
}

export function plotCost(chapter: Chapter, windows: PlotWindow[], model: AIModel): number {
  return windows.reduce((total, window) => total + storyRequestCost(STORY_PLOT_SYSTEM_PROMPT, {
    chapter: chapter.title.trim().slice(0, 200) || 'Chapter', context: window.context, known: [], language: 'zh', memory: [],
  }, model, STORY_PLOT_EXTRA_BYTES), 0);
}

export function storySpeechCost(chapter: Chapter, candidates: DialogueCandidate[], model: AIModel): number {
  return storyRequestCost(STORY_IDENTITY_SYSTEM_PROMPT, storySpeechInput(chapter, candidates, []), model, STORY_IDENTITY_EXTRA_BYTES);
}
