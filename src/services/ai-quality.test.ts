import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import corpus from '../../evaluation/ai-corpus.json';
import { extractDialogues, extractStoryDialogues } from './ai';

interface Label { paragraph: number; quote: string; speaker: string | null; entity: string | null; manual?: boolean }
interface Sample { id: string; language: string; scene: string; chapters: { paragraphs: string[]; gold: Label[]; knownNonDialogueQuotes?: string[] }[] }
const samples = corpus.cases as Sample[];

describe('bilingual quality corpus and reporting (no provider)', () => {
  it('locates labelled speech exactly and reports quoted prose as a known false positive', () => {
    let labelled = 0; let found = 0; let proseQuotes = 0; const scenes: Record<string, { expected: number; located: number; extra: number }> = {};
    for (const sample of samples) for (const [index, source] of sample.chapters.entries()) {
      const chapter = { id: `${sample.id}:${index}`, bookId: sample.id, index, title: sample.id, paragraphs: source.paragraphs };
      const extracted = extractDialogues(chapter);
      const expected = source.gold.map(row => ({ ...row, start: source.paragraphs[row.paragraph].indexOf(row.quote) }));
      const scene = scenes[sample.scene] ||= { expected: 0, located: 0, extra: 0 };
      for (const row of expected) {
        labelled++; scene.expected++;
        expect(row.start).toBeGreaterThanOrEqual(0);
        const candidate = extracted.find(d => d.paragraphIndex === row.paragraph && d.start === row.start && d.end === row.start + row.quote.length);
        expect(candidate?.text, `${sample.id}: ${row.quote}`).toBe(row.quote);
        if (candidate) { found++; scene.located++; }
      }
      for (const candidate of extracted) {
        expect(source.paragraphs[candidate.paragraphIndex].slice(candidate.start, candidate.end)).toBe(candidate.text);
        if (!expected.some(row => row.paragraph === candidate.paragraphIndex && row.start === candidate.start && row.quote === candidate.text)) {
          expect(source.knownNonDialogueQuotes || [], sample.id).toContain(candidate.text);
          proseQuotes++; scene.extra++;
        }
      }
    }
    expect(found).toBe(labelled); expect(labelled).toBeGreaterThan(20); expect(proseQuotes).toBeLessThanOrEqual(1);
    mkdirSync(resolve('artifacts/qa'), { recursive: true });
    writeFileSync(resolve('artifacts/qa/v04-dialogue-quality.json'), JSON.stringify({ providerCalls: 0, labelledDialogueSpans: labelled, exactLocated: found, quotedProseFalsePositives: proseQuotes, precision: found / (found + proseQuotes), recall: found / labelled, attributionAccuracy: null, note: 'Extraction regression only; no live model quality is claimed.', scenes }, null, 2));
  });

  it('detects omitted dialogue, invented speakers, broken identities and overwritten manual corrections separately', () => {
    const records = samples.flatMap(sample => sample.chapters.flatMap((chapter, chapterIndex) => chapter.gold.map(row => {
      const start = chapter.paragraphs[row.paragraph].indexOf(row.quote);
      return { caseId: sample.id, chapterIndex, paragraph: row.paragraph, start, end: start + row.quote.length, speaker: row.speaker, characterId: row.entity ? `${sample.id}:${row.entity}` : null, source: row.manual ? 'manual' : 'ai' };
    })));
    const missing = records.findIndex(row => row.caseId === 'en-apostrophes'); records.splice(missing, 1);
    const unknown = records.find(row => row.caseId === 'zh-ambiguous')!; unknown.speaker = 'Invented Person'; unknown.characterId = 'invented';
    const reveal = records.find(row => row.caseId === 'zh-reveal' && row.chapterIndex === 1)!; reveal.characterId = 'wrong-new-identity';
    const homonym = records.filter(row => row.caseId === 'zh-homonym'); homonym[1].characterId = homonym[0].characterId;
    records.find(row => row.caseId === 'manual-priority')!.source = 'ai';
    const directory = mkdtempSync(join(tmpdir(), 'onr-quality-'));
    const predictions = join(directory, 'predictions.json');
    try {
      writeFileSync(predictions, JSON.stringify(records));
      const report = JSON.parse(execFileSync(process.execPath, [resolve('scripts/evaluate-ai-quality.mjs'), '--predictions', predictions, '--provenance', 'injected-error-control-not-model-output'], { encoding: 'utf8' }));
      expect(report.networkRequests).toBe(0); expect(report.recordedPredictionsEvaluated).toBe(true);
      expect(report.dialogueLocation.missed).toBe(1);
      expect(report.speakerAttribution.accuracyOnLocated).toBeLessThan(1);
      expect(report.speakerAttribution.retainedUnknown).toBeLessThan(report.speakerAttribution.expectedUnknown);
      expect(report.crossChapterIdentity.contradictoryPairs).toBe(2);
      expect(report.manualCorrections).toEqual({ expected: 1, retained: 0 });
      expect(report.scenes.find((scene: { scene: string }) => scene.scene === 'ambiguous-pronoun').wrongSpeaker).toBe(1);
    } finally { unlinkSync(predictions); rmdirSync(directory); }
  });

  it('does not present gold labels as model accuracy without recorded predictions', () => {
    const result = JSON.parse(execFileSync(process.execPath, [resolve('scripts/evaluate-ai-quality.mjs')], { encoding: 'utf8' }));
    expect(result.recordedPredictionsEvaluated).toBe(false); expect(result.networkRequests).toBe(0);
    expect(result.speakerAttribution).toBeUndefined();
    expect(readFileSync(resolve('evaluation/ai-corpus.json'), 'utf8')).toContain('public domain');
  });

  it('compares V0.5 and V0.6 exact dialogue spans on the same bilingual fixtures', () => {
    const newCases: Sample[] = [
      { id: 'en-alternate-quotes', language: 'en', scene: 'alternate quotation marks', chapters: [{
        paragraphs: ['Ada said, «Come inside.»', '— I will wait here.', '«He quoted “Tomorrow,” then sighed,» Ada added.'],
        gold: [{ paragraph: 0, quote: '«Come inside.»', speaker: 'Ada', entity: 'ada' }, { paragraph: 1, quote: '— I will wait here.', speaker: null, entity: null },
          { paragraph: 2, quote: '«He quoted “Tomorrow,” then sighed,»', speaker: 'Ada', entity: 'ada' }],
      }] },
      { id: 'zh-full-width-quote', language: 'zh', scene: 'alternate quotation marks', chapters: [{
        paragraphs: ['阿兰说：＂到了港口再见。＂', '石碑上的「北渡」字样已经模糊。'],
        gold: [{ paragraph: 0, quote: '＂到了港口再见。＂', speaker: '阿兰', entity: 'lan' }],
      }] },
    ];
    const compare = (extractor: typeof extractDialogues) => {
      const result = { labelled: 0, exact: 0, extra: 0, byScene: {} as Record<string, { labelled: number; exact: number; extra: number }> };
      for (const sample of [...samples, ...newCases]) for (const [index, source] of sample.chapters.entries()) {
        const chapter = { id: `${sample.id}:${index}`, bookId: sample.id, index, title: sample.id, paragraphs: source.paragraphs };
        const original = source.gold.map(row => `${row.paragraph}:${source.paragraphs[row.paragraph].indexOf(row.quote)}:${row.quote}`);
        const scene = result.byScene[sample.scene] ??= { labelled: 0, exact: 0, extra: 0 };
        scene.labelled += original.length;
        result.labelled += original.length;
        for (const candidate of extractor(chapter)) {
          expect(chapter.paragraphs[candidate.paragraphIndex].slice(candidate.start, candidate.end)).toBe(candidate.text);
          const key = original.includes(`${candidate.paragraphIndex}:${candidate.start}:${candidate.text}`) ? 'exact' : 'extra';
          result[key]++;
          scene[key]++;
        }
      }
      return result;
    };
    const baseline = compare(extractDialogues);
    const story = compare(extractStoryDialogues);
    expect(baseline.exact).toBe(24);
    expect(story.exact).toBe(story.labelled);
    expect(story.extra).toBe(0);
    mkdirSync(resolve('artifacts/qa'), { recursive: true });
    writeFileSync(resolve('artifacts/qa/v06-dialogue-comparison.json'), JSON.stringify({ paidCalls: 0, baseline, story, providerAttribution: null }, null, 2));
  });
});
