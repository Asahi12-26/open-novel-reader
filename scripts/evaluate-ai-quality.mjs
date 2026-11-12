import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const corpus = JSON.parse(readFileSync(resolve(root, 'evaluation/ai-corpus.json'), 'utf8'));
const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const gold = [];
for (const sample of corpus.cases) for (const [chapterIndex, chapter] of sample.chapters.entries()) {
  for (const item of chapter.gold) {
    const start = chapter.paragraphs[item.paragraph].indexOf(item.quote);
    if (start < 0) throw new Error('Gold quote is missing from its source paragraph.');
    gold.push({ ...item, caseId: sample.id, scene: sample.scene, chapterIndex, start, end: start + item.quote.length });
  }
}
const key = row => `${row.caseId}:${row.chapterIndex}:${row.paragraph}:${row.start}:${row.end}`;
const ratio = (a, b) => b ? Math.round(a / b * 10000) / 10000 : null;
const predictionFile = value('--predictions');
let report = {
  format: 'open-novel-reader-ai-quality-v1',
  measuredAt: new Date().toISOString(),
  recordedPredictionsEvaluated: false,
  networkRequests: 0,
  corpus: { cases: corpus.cases.length, dialogueSpans: gold.length, languages: ['zh', 'en'], sources: corpus.sources },
  note: 'No model is called. Pass --predictions <recorded-normalized-results.json> to measure actual saved results; corpus labels alone are not an accuracy result.',
};
if (predictionFile) {
  const raw = readFileSync(resolve(predictionFile), 'utf8');
  if (raw.length > 16 * 1024 * 1024) throw new Error('Prediction file is too large.');
  const predictions = JSON.parse(raw);
  if (!Array.isArray(predictions) || predictions.length > 100000) throw new Error('Expected an array of normalized recorded predictions.');
  const predicted = new Map();
  for (const row of predictions) {
    if (!row || typeof row.caseId !== 'string' || row.caseId.length > 100 || ![row.chapterIndex, row.paragraph, row.start, row.end].every(n => Number.isSafeInteger(n) && n >= 0) || row.end < row.start || !(row.speaker === null || typeof row.speaker === 'string') || !(row.characterId === null || typeof row.characterId === 'string') || !['ai', 'manual'].includes(row.source)) throw new Error('Invalid normalized prediction.');
    if (predicted.has(key(row))) throw new Error('Duplicate predicted dialogue span.');
    predicted.set(key(row), row);
  }
  const goldKeys = new Set(gold.map(key));
  const located = gold.filter(item => predicted.has(key(item)));
  const correct = located.filter(item => predicted.get(key(item)).speaker === item.speaker);
  const unknown = [...predicted.values()].filter(item => item.speaker === null);
  const expectedUnknown = gold.filter(item => item.speaker === null);
  const retainedUnknown = expectedUnknown.filter(item => predicted.get(key(item))?.speaker === null);
  const manual = gold.filter(item => item.manual);
  const retainedManual = manual.filter(item => { const row = predicted.get(key(item)); return row?.source === 'manual' && row.speaker === item.speaker; });
  let eligibleIdentityPairs = 0; let identityPairs = 0; let identityContradictions = 0;
  for (let i = 0; i < gold.length; i++) for (let j = i + 1; j < gold.length; j++) {
    const a = gold[i]; const b = gold[j];
    if (a.caseId !== b.caseId || a.chapterIndex === b.chapterIndex || !a.entity || !b.entity) continue;
    eligibleIdentityPairs++;
    const pa = predicted.get(key(a)); const pb = predicted.get(key(b));
    if (!pa?.characterId || !pb?.characterId) continue;
    identityPairs++;
    if ((a.entity === b.entity) !== (pa.characterId === pb.characterId)) identityContradictions++;
  }
  const scenes = [...new Set(gold.map(item => item.scene))].map(scene => {
    const expected = gold.filter(item => item.scene === scene);
    const matched = expected.filter(item => predicted.has(key(item)));
    return { scene, expected: expected.length, located: matched.length, wrongSpeaker: matched.filter(item => predicted.get(key(item)).speaker !== item.speaker).length, missed: expected.length - matched.length };
  });
  report = { ...report, recordedPredictionsEvaluated: true, predictionProvenance: value('--provenance') || 'unspecified; do not claim model accuracy', note: 'Metrics describe only the supplied records. This tool never runs a provider and does not verify their provenance.',
    dialogueLocation: { expected: gold.length, predicted: predicted.size, located: located.length, missed: gold.length - located.length, spurious: [...predicted.keys()].filter(id => !goldKeys.has(id)).length, precision: ratio(located.length, predicted.size), recall: ratio(located.length, gold.length) },
    speakerAttribution: { correct: correct.length, located: located.length, accuracyOnLocated: ratio(correct.length, located.length), unknownRatio: ratio(unknown.length, predicted.size), expectedUnknown: expectedUnknown.length, retainedUnknown: retainedUnknown.length },
    crossChapterIdentity: { eligiblePairs: eligibleIdentityPairs, evaluatedPairs: identityPairs, coverage: ratio(identityPairs, eligibleIdentityPairs), contradictoryPairs: identityContradictions, consistency: ratio(identityPairs - identityContradictions, identityPairs) },
    manualCorrections: { expected: manual.length, retained: retainedManual.length }, scenes,
  };
}
const output = JSON.stringify(report, null, 2) + '\n';
if (value('--out')) writeFileSync(resolve(value('--out')), output);
else process.stdout.write(output);
