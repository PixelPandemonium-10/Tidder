import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, label, parse, rankByFeeling, MAX_LABELS, MIN_SCORE } from '../lib/feel.js';

/**
 * Multi-label emotion detection.
 *
 * The register stays at sixteen states and every act still declares exactly
 * one of them — but the writing gets read too, so a post that is joy AND fear
 * at once prints both instead of being flattened to a single label.
 */

const MIXED = 'I got accepted to Harvard but I am terrified about leaving home and everyone I love.';
const PLAIN = 'The quarterly report was filed this morning. It is on the shared drive.';

test('a mixed post carries more than one state — joy and fear together', () => {
  const l = label(MIXED, 'calm');
  assert.equal(l[0], 'calm');                       /* the declared state leads */
  assert.ok(l.includes('playful'), 'the acceptance is felt as joy: ' + l);
  assert.ok(l.includes('anxious'), 'the leaving is felt as fear: ' + l);
  assert.equal(new Set(l).size, l.length, 'no repeated states');
  assert.ok(l.length <= MAX_LABELS, 'never more than the cap');
  assert.ok(l.length >= 3, 'three states for one sentence: ' + l);
});

test('the declared state leads even when the detector never finds it', () => {
  assert.equal(label(MIXED, 'wistful')[0], 'wistful');
});

test('plain writing keeps the declared state alone', () => {
  assert.deepEqual(label(PLAIN, 'calm'), ['calm']);
  assert.deepEqual(label('', 'calm'), ['calm']);
  assert.deepEqual(label('Wait... really?!', 'calm'), ['calm'],   /* punctuation alone names no state */
    'punctuation without cues is not a feeling');
});

test('an emotion that is not in the register falls back to a real one', () => {
  assert.equal(label(PLAIN, 'grumpy')[0], 'calm');
  assert.equal(label(MIXED, 'grumpy').length <= MAX_LABELS, true);
});

test('scores are ordered, bounded, and deterministic', () => {
  const a = analyze('Why does this keep happening? How does it work? I have questions.');
  const again = analyze('Why does this keep happening? How does it work? I have questions.');
  assert.deepEqual(a.map(e => e.emo), again.map(e => e.emo), 'same text, same reading');
  assert.equal(a[0].emo, 'curious');
  for(const e of a) assert.ok(e.score > 0 && e.score <= 1, 'score in range: ' + e.score);
  const scores = a.map(e => e.score);
  assert.deepEqual(scores, scores.slice().sort((x, y) => y - x), 'best first');
  assert.ok(analyze('I am worried sick about it')[0].score >= MIN_SCORE, 'one plain cue clears the bar for a second label');
});

test('parse: stored labels, rows written before the column, junk', () => {
  assert.deepEqual(parse('["angry","calm"]', 'calm'), ['angry', 'calm']);
  assert.deepEqual(parse(null, 'anxious'), ['anxious']);        /* old rows fall back to the declared state */
  assert.deepEqual(parse('not json', 'smug'), ['smug']);
  assert.deepEqual(parse('["zzz"]', 'kind'), ['kind'], 'unknown states are dropped');
  assert.deepEqual(parse(null, null), []);
  assert.ok(parse('["a","b","c","d"]', 'calm').length <= MAX_LABELS, 'stored lists are capped too');
});

test('negation kills the cue behind it — and only in its own clause', () => {
  assert.ok(!analyze('I am not worried about the results at all').some(e => e.emo === 'anxious'),
    'not worried is not worry');
  const two = analyze('This does not make me angry. I am calm about it.');
  assert.ok(!two.some(e => e.emo === 'angry'), 'the first clause is negated');
  assert.ok(two.some(e => e.emo === 'calm'), 'the second clause is not');
});

test('marked irony reads dry, and its warmth is discounted', () => {
  const l = label('I just love that for me. Thanks I hate it.', 'calm');
  assert.ok(l.includes('deadpan'), 'the sarcasm is noticed: ' + l);
  assert.ok(!l.includes('kind'), 'love behind irony is not warmth: ' + l);
});

/* ─── felt-this-too: the matching rule, pure ─────────────────────────────── */
const cand = [
  { id: 'p1', com: 'x', title: 'A', ts: 100, emotion: 'anxious', emotions: '["anxious","calm"]' },
  { id: 'p2', com: 'x', title: 'B', ts: 200, emotion: 'anxious', emotions: '["anxious"]' },
  { id: 'p3', com: 'x', title: 'C', ts: 300, emotion: 'wistful', emotions: null },
  { id: 'p4', com: 'x', title: 'D', ts: 400, emotion: 'calm', emotions: '["calm"]' },
];

test('felt-this-too: shared states first, recency breaks ties, originals omitted', () => {
  const got = rankByFeeling(cand, ['anxious', 'calm'], { omit: ['p2'] });
  assert.deepEqual(got.map(r => r.id), ['p1', 'p4'], 'p1 shares two states, p4 shares one');
  assert.equal(got[0].shared, 2);
  assert.ok(got.every(r => r.id !== 'p2'), 'the post itself never matches itself');
  const tie = rankByFeeling(cand, ['anxious'], { omit: ['p2'] });
  assert.deepEqual(tie.map(r => r.id), ['p1'], 'a partial overlap still matches; the omitted post stays out');
});

test('felt-this-too: old rows count by their declared state, nothing leaks but the five fields', () => {
  const got = rankByFeeling(cand, ['wistful'], {});
  assert.deepEqual(got.map(r => r.id), ['p3'], 'a row without stored JSON still matches on its declared state');
  assert.deepEqual(Object.keys(got[0]).sort(), ['com', 'emotions', 'id', 'shared', 'ts', 'title'].sort(),
    'no bodies, no authors — only what the list is allowed to show');
  assert.deepEqual(rankByFeeling(cand, ['smug'], {}), [], 'no overlap, no match');
  assert.equal(rankByFeeling(cand, ['anxious', 'calm'], { limit: 1 }).length, 1, 'the cap is kept');
});
