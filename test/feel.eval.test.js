import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, corpus, predict, report } from '../scripts/feel-metrics.js';

/**
 * The detector is not trusted on vibes: these tests run it over the
 * hand-labelled corpus (test/feel-corpus.json), print the precision /
 * recall / F1 report, and fail if the numbers regress.
 *
 * Honesty notes, deliberately kept in the suite:
 *  - one annotator (the project owner), no inter-annotator agreement measured;
 *  - the corpus is a DEVELOPMENT set: several idioms were added to the
 *    lexicon because the corpus caught them missing. It is not held out;
 *  - the last three misses (marker-less irony, conditional worry) are a
 *    documented limitation, not a bug to quietly gold-plate away.
 */

test('metrics: precision / recall / F1 over the labelled corpus', () => {
  const r = evaluate();
  console.log('\n' + report(r) + '\n');

  assert.ok(r.cases >= 70, 'corpus is big enough to mean something: ' + r.cases);
  assert.ok(r.micro.p >= .95, `precision ${r.micro.p.toFixed(3)} < .95`);
  assert.ok(r.micro.r >= .93, `recall ${r.micro.r.toFixed(3)} < .93`);
  assert.ok(r.micro.f1 >= .95, `micro F1 ${r.micro.f1.toFixed(3)} < .95`);

  for(const [tag, s] of Object.entries(r.tags))
    assert.ok(s.f1 >= .75, `slice "${tag}" fell to F1 ${s.f1.toFixed(3)} (< .75)`);
});

test('the corpus covers the whole register, hard cases included', () => {
  const gold = new Set(corpus.cases.flatMap(c => c.gold));
  assert.equal(gold.size, 16, 'every one of the sixteen states appears in the gold data');
  assert.ok(corpus.cases.filter(c => c.tag === 'hard').length >= 10, 'the hard slice exists');
  assert.ok(corpus.cases.some(c => c.tag === 'sarcasm'), 'irony is in the data');
  assert.ok(corpus.cases.some(c => c.tag === 'negation'), 'negation is in the data');
});

test('marked irony is read; marker-less irony stays a claimed limitation', () => {
  assert.ok(predict('another meeting at 7am. /s').includes('deadpan'), 'the /s tag is understood');
  assert.ok(!predict('oh good, another outage. just what this stack needed').includes('deadpan'),
    'no marker → not caught (documented limit — do not silently claim it)');
});
