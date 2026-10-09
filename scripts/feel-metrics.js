import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyze, MIN_SCORE } from '../lib/feel.js';

/**
 * Evaluation harness for the multi-label emotion detector.
 *
 * Answers the honest question — "how accurate is it, actually?" — with
 * precision / recall / F1 over a hand-labelled corpus instead of vibes.
 * Run `npm run eval` for the report; the test suite runs the same numbers
 * and fails if they regress.
 *
 * gold = states a reader would take the TEXT to show (multi-label, no
 * declared state — the declared one is user input, not detection).
 * Single annotator, agreement unmeasured: a documented limit, not a secret.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const corpus = JSON.parse(fs.readFileSync(path.join(here, '..', 'test', 'feel-corpus.json'), 'utf8'));

/** what detection alone would add beside a declared state (before the top-3 cap) */
export const predict = text => analyze(text).filter(e => e.score >= MIN_SCORE).map(e => e.emo);

const f1 = (p, r) => (p + r ? (2 * p * r) / (p + r) : 0);
const prf = ({ tp, fp, fn }) => {
  if(!tp && !fp && !fn) return { p: 1, r: 1, f1: 1, tp, fp, fn };   /* nothing said, nothing expected */
  const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
  return { p, r, f1: f1(p, r), tp, fp, fn };
};

export function evaluate(cases = corpus.cases){
  const total = { tp: 0, fp: 0, fn: 0 };
  const states = {}, tags = {}, errors = [];

  for(const c of cases){
    const gold = new Set(c.gold), pred = new Set(predict(c.text));
    const slice = (tags[c.tag] ||= { tp: 0, fp: 0, fn: 0, cases: 0 });
    slice.cases++;
    for(const s of pred){
      const st = (states[s] ||= { tp: 0, fp: 0, fn: 0 });
      if(gold.has(s)){ slice.tp++; total.tp++; st.tp++; }
      else { slice.fp++; total.fp++; st.fp++; errors.push({ kind: 'spurious', tag: c.tag, state: s, text: c.text }); }
    }
    for(const s of gold){
      const st = (states[s] ||= { tp: 0, fp: 0, fn: 0 });
      if(!pred.has(s)){ slice.fn++; total.fn++; st.fn++; errors.push({ kind: 'missed', tag: c.tag, state: s, text: c.text }); }
    }
  }

  const micro = prf(total);
  const scored = Object.entries(states).map(([emo, x]) => ({ emo, ...prf(x) }));
  const goldStates = Object.entries(states).filter(([, x]) => x.tp + x.fn > 0);
  const macroF1 = goldStates.length ? goldStates.reduce((a, [, x]) => a + prf(x).f1, 0) / goldStates.length : 0;

  return {
    cases: cases.length, micro, macroF1,
    tags: Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, { ...v, ...prf(v) }])),
    states: scored.sort((a, b) => a.f1 - b.f1),
    errors,
  };
}

const pct = n => (n * 100).toFixed(0).padStart(3) + '%';

export function report(r){
  const L = [];
  L.push(`Tidder emotion detector — ${r.cases} hand-labelled cases (test/feel-corpus.json)`);
  L.push('');
  L.push('slice        cases     P     R    F1   (micro over that slice)');
  for(const [tag, s] of Object.entries(r.tags))
    L.push(tag.padEnd(12) + String(s.cases).padStart(5) + pct(s.p).padStart(6) + pct(s.r).padStart(6) + pct(s.f1).padStart(6));
  L.push('-'.repeat(40));
  L.push('ALL'.padEnd(12) + String(r.cases).padStart(5) + pct(r.micro.p).padStart(6) + pct(r.micro.r).padStart(6) + pct(r.micro.f1).padStart(6));
  L.push(`macro F1 across the ${r.states.filter(s => s.tp + s.fn > 0).length} states that appear in the gold data: ${pct(r.macroF1)}`);
  const worst = r.states.filter(s => s.tp + s.fn > 0 && s.f1 < 1).slice(0, 6);
  if(worst.length){
    L.push('');
    L.push('states with errors: ' + worst.map(s => `${s.emo} ${pct(s.f1)} (${s.fn} missed, ${s.fp} spurious)`).join(' · '));
  }
  if(r.errors.length){
    L.push('');
    L.push('errors:');
    for(const e of r.errors.slice(0, 12)) L.push(`  ${e.kind === 'missed' ? 'missed  ' : 'spurious'} ${e.state.padEnd(14)} ${e.text.slice(0, 64)}`);
    if(r.errors.length > 12) L.push(`  … and ${r.errors.length - 12} more`);
  }
  return L.join('\n');
}

if(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href){
  console.log(report(evaluate()));
}
