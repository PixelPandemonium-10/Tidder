import { EMOTIONS } from './engine.js';

/* ══════════════════════════════════════════════════════════════════
   Multi-label emotion detection.

   The register is fixed at sixteen states, but a piece of writing is
   rarely ONE thing: "accepted to Harvard, terrified of leaving home" is
   joy and anxiety at the same time, and a single label throws half of
   it away. So every post and reply is screened for ALL of the states it
   shows — the declared primary stays first (the emotion rule is intact),
   and up to two more are appended after it.

   The detector is a lexicon: per-state word cues and phrase cues, plus a
   few punctuation tells (shouting, asking, trailing off) and intensifier
   words. Deterministic, no model, no network — which is what lets it
   run inline on every write and on a boot-time backfill of old rows.
   Scores saturate into 0..1 so one stray cue word can't shout down a
   phrase that means what it says.
   ══════════════════════════════════════════════════════════════════ */

export const MAX_LABELS = 3;     /* the declared state + up to two detected */
export const MIN_SCORE = .38;    /* evidence a SECOND state needs to be kept */

/* cue lexicon — w: whole words · p: phrases (multi-word) */
const CUES = {
  'high-tempered': {
    w: ['outrage', 'outraged', 'outrageous', 'unacceptable', 'infuriating', 'infuriated', 'ridiculous',
      'absurd', 'scandal', 'scandalous', 'rant', 'ranting', 'furious', 'livid', 'seething', 'disgrace',
      'disgraceful', 'insufferable', 'arrogant'],
    p: ['fed up', 'sick of', 'how dare', 'enough is enough', 'mark my words', 'never again',
      'never in my life', 'i am done', 'so done', 'no more', 'what is wrong with'] },
  'angry': {
    w: ['angry', 'mad', 'hate', 'hates', 'hating', 'pissed', 'annoyed', 'annoying', 'irritated', 'resent',
      'resentful', 'bitter', 'betrayed', 'betrayal', 'unfair', 'unjust', 'blame', 'blaming', 'rage',
      'raging', 'grudge', 'furious', 'hostile', 'spiteful'],
    p: ['hate it', 'so done', 'done with', 'makes me mad', 'lost my temper', 'at my limit', 'not fine'] },
  'anxious': {
    w: ['anxious', 'anxiety', 'worried', 'worry', 'nervous', 'scared', 'scare', 'fear', 'afraid', 'terrified',
      'panic', 'panicked', 'stress', 'stressed', 'stressful', 'overwhelmed', 'overwhelming', 'overthink',
      'overthinking', 'spiral', 'spiraling', 'dread', 'dreaded', 'dreading', 'doubt', 'unsure', 'uncertain', 'uneasy',
      'tense', 'shaky', 'insomnia', 'racing', 'imposter'],
    p: ['what if', 'cant sleep', 'cant breathe', 'cant stop', 'butterflies in', 'heart racing', 'on edge',
      'waiting for the other', 'jumping at', 'not ready', 'walking on eggshells', 'on eggshells'] },
  'depressed': {
    w: ['sad', 'sadness', 'depressed', 'depression', 'empty', 'numb', 'hopeless', 'despair', 'tired',
      'exhausted', 'drained', 'lonely', 'loneliness', 'alone', 'meaningless', 'pointless', 'cry', 'crying',
      'cried', 'unmotivated', 'worthless', 'gray', 'dull', 'low', 'hollow', 'defeated', 'gutted'],
    p: ['give up', 'gave up', 'no motivation', 'whats the point', 'what is the point', 'cant go on',
      'never gets better', 'in the dark', 'lost all'] },
  'calm': {
    w: ['calm', 'fine', 'steady', 'relaxed', 'peace', 'peaceful', 'settled', 'alright', 'composed', 'patient',
      'patience', 'chill', 'smooth', 'balanced', 'grounded', 'unhurried', 'easy'],
    p: ['no rush', 'it is what it is', 'carry on', 'all is well', 'no strong feelings', 'take a breath',
      'in due time', 'one step at a time'] },
  'cool': {
    w: ['cool', 'meh', 'unbothered', 'indifferent', 'indifference', 'neutral', 'detached',
      'unfazed', 'casual', 'nonchalant', 'shrug', 'unimpressed', 'stoic'],
    p: ['not impressed', 'so what', 'take it or leave it', 'if you say so', 'no big deal', 'each to their own'] },
  'polite': {
    w: ['please', 'thanks', 'thank', 'appreciate', 'appreciated', 'grateful', 'gratitude', 'respectfully',
      'kindly', 'sorry', 'apologize', 'apology', 'excuse', 'welcome', 'courtesy'],
    p: ['if you dont mind', 'if you do not mind', 'hope this helps', 'with respect', 'if i may',
      'at your convenience', 'thank you'] },
  'helpful': {
    w: ['tip', 'tips', 'advice', 'advise', 'steps', 'guide', 'fix', 'fixed', 'solved', 'solution',
      'resource', 'resources', 'recommend', 'recommended', 'recommendation', 'checklist', 'workaround',
      'hint', 'tutorial', 'debug', 'docs', 'reference'],
    p: ['here is how', 'heres how', 'try this', 'for anyone', 'in case anyone', 'step by step',
      'how to', 'feel free to', 'worked for me'] },
  'kind': {
    w: ['love', 'loved', 'loving', 'hug', 'hugs', 'caring', 'care', 'support', 'supportive', 'gentle',
      'gently', 'warm', 'warmth', 'kindness', 'comfort', 'comforting', 'sweet', 'tender', 'proud'],
    p: ['you matter', 'it is okay', 'its okay', 'you will be okay', 'youll be okay', 'proud of you',
      'you are not alone', 'take your time', 'rest now', 'sending love', 'be gentle'] },
  'curious': {
    w: ['why', 'wonder', 'wondering', 'curious', 'curiosity', 'question', 'questions', 'investigate',
      'investigation', 'research', 'explore', 'exploring', 'hypothesis', 'theorize'],
    p: ['does anyone', 'anyone know', 'what happens', 'is it true', 'i want to know', 'i would like to know',
      'tell me more', 'what makes', 'how does', 'why do'] },
  'playful': {
    w: ['haha', 'lol', 'funny', 'laugh', 'laughing', 'joke', 'jokes', 'meme', 'memes', 'silly', 'fun',
      'teasing', 'tease', 'prank', 'pranked', 'chaos', 'chaotic', 'oops', 'goofy', 'amusing', 'kidding',
      'mischief', 'giggle', 'accepted', 'celebrate', 'celebrating', 'celebration', 'thrilled', 'delighted',
      'excited', 'exciting', 'yay', 'confetti', 'won', 'winning', 'party', 'slaps', 'banger'],
    p: ['hear me out', 'just kidding', 'the best thing', 'confession', 'anyway anyway', 'plot twist',
      'for the plot', 'bored now', 'got accepted', 'got in', 'good news', 'dream come true', 'best day',
      'over the moon'] },
  'dramatic': {
    w: ['disaster', 'disastrous', 'catastrophe', 'catastrophic', 'apocalypse', 'apocalyptic', 'doom',
      'doomsday', 'ruined', 'meltdown', 'unprecedented', 'epic', 'thunderous', 'collapse',
      'collapsing', 'spectacle'],
    p: ['end of the world', 'history will', 'never before', 'literally dying', 'worst thing', 'worst day',
      'it is over', 'its over', 'the fall of', 'nothing ever', 'always happens', 'never works',
      'this is fine', 'everyone is'] },
  'deadpan': {
    w: ['noted', 'sure', 'yep', 'yup', 'acknowledged', 'unremarkable', 'predictable'],
    p: ['duly noted', 'no comment', 'as expected', 'if you say so', 'so it goes',
      'nothing new', 'just saying', 'for the record'] },
  'smug': {
    w: ['obviously', 'obvious', 'correct', 'expert', 'superior', 'brilliant', 'genius'],
    p: ['i was right', 'told you', 'as i said', 'as predicted', 'called it', 'trust me', 'well well',
      'well actually', 'no surprise', 'i knew it'] },
  'nostalgic': {
    w: ['miss', 'missing', 'childhood', 'classic', 'nostalgia', 'nostalgic', 'remember', 'vintage',
      'anniversary', 'throwback', 'heirloom', 'antique'],
    p: ['remember when', 'back in', 'used to', 'old days', 'the old days', 'grew up', 'those days',
      'long time ago', 'first time', 'back then', 'in another life', 'simpler times'] },
  'wistful': {
    w: ['wish', 'wishing', 'someday', 'lost', 'losing', 'fade', 'fading', 'longing', 'yearn', 'yearning',
      'haunt', 'haunting', 'almost', 'sigh', 'aching'],
    p: ['if only', 'maybe one day', 'one day', 'would be nice', 'so close', 'not anymore',
      'what could have been', 'still think about', 'far away', 'slipped away', 'quietly'] },
};

/* punctuation tells — they only AMPLIFY a state the words already suggest */
const SHOUT = { 'high-tempered': .6, dramatic: .5, playful: .4, angry: .3 };
const ASK   = { curious: .7, anxious: .35 };
const TRAIL = { wistful: .4, nostalgic: .2, depressed: .35, anxious: .25 };
const CAPS  = { 'high-tempered': .7, angry: .4, dramatic: .4 };

const INTENSIFIERS = new Set(['so', 'really', 'very', 'extremely', 'totally', 'absolutely', 'incredibly',
  'completely', 'constantly', 'literally', 'genuinely', 'deeply', 'constantly', 'always', 'never']);

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(Boolean);

/* "i am not worried" is not worry. A cue sitting directly behind a negator
   does not count — for words and for phrases alike ("not fed up"). */
const NEGATORS = new Set(['not', 'no', 'never', 'dont', 'didnt', 'isnt', 'wasnt', 'arent', 'werent',
  'aint', 'without', 'hardly', 'barely', 'cannot', 'cant']);

/* Reddit-era irony: the "/s" tag and the idioms that mean the opposite of
   what they say. Detected on the raw text (the slash is gone once tokenised),
   and when present it does two things: dry states gain ground, and plainly
   positive states get discounted so "i just love that for me /s" stops
   reading as kindness. */
const SARCASM_RE = /(^|[\s(])\/s([\s).,!?:]|$)|what a surprise|what a shock|because that always works|thanks i hate it|love that for me|just what i needed|color me shocked|shocked pikachu|this is fine/i;
const POSITIVE = new Set(['playful', 'kind', 'helpful', 'polite', 'calm']);
const DRY = new Set(['deadpan', 'smug']);

/* compile once: word cues into sets, phrases into token arrays */
const LEX = {};
for(const emo of Object.keys(CUES)){
  const c = CUES[emo];
  LEX[emo] = {
    words: new Set(c.w.map(norm).filter(Boolean)),
    phrases: c.p.map(toks).filter(a => a.length > 1),
  };
}
const phraseIn = (t, p) => {
  for(let i = 0; i + p.length <= t.length; i++){
    let ok = true;
    for(let j = 0; j < p.length; j++) if(t[i + j] !== p[j]){ ok = false; break; }
    if(ok) return true;
  }
  return false;
};

/**
 * Screen a piece of text against the whole register.
 * @returns [{ emo, score }] — every state with any evidence, best first, score 0..1
 */
export function analyze(text){
  const raw = String(text ?? '');
  /* tokens, with the clause each one belongs to — a negator colours the rest
     of its own clause and no further ("does not make me angry. i am calm" →
     angry dies, calm does not) */
  const t = [], clause = [];
  raw.split(/[.!?;:,…]+|\bbut\b|\bhowever\b|\balthough\b|\bthough\b/).forEach((seg, ci) => {
    for(const w of toks(seg)){ t.push(w); clause.push(ci); }
  });
  if(!t.length) return [];
  const set = new Set(t);
  const negated = new Set();
  const negSeen = new Set();
  for(let i = 0; i < t.length; i++){
    if(negSeen.has(clause[i])) negated.add(t[i]);
    if(NEGATORS.has(t[i])) negSeen.add(clause[i]);
  }
  const live = w => set.has(w) && !negated.has(w);
  const sarcasm = SARCASM_RE.test(raw);
  const bangs = (raw.match(/!/g) || []).length;
  const asks = (raw.match(/\?/g) || []).length;
  const trail = (raw.match(/\.{3}|…/g) || []).length;
  const loud = (raw.match(/\b[A-Z]{2,}\b/g) || []).length;
  const intens = Math.min(3, t.filter(w => INTENSIFIERS.has(w)).length) * .3;

  const out = [];
  for(const emo of Object.keys(EMOTIONS)){
    const L = LEX[emo];
    let s = 0;
    for(const w of L.words) if(live(w)) s += 1;
    for(const p of L.phrases) if(!negated.has(p[0]) && phraseIn(t, p)) s += 1.6;
    if(sarcasm && emo === 'deadpan') s += 1;          /* irony reads dry before it reads anything else */
    if(!s) continue;                                  /* punctuation alone names no state */
    if(bangs >= 2) s += SHOUT[emo] || 0;
    if(asks >= 2) s += ASK[emo] || 0;
    if(trail >= 1) s += TRAIL[emo] || 0;
    if(loud >= 2) s += CAPS[emo] || 0;
    let score = 1 - Math.exp(-(s * (1 + intens)) / 1.8);   /* saturates: one cue ≈ .43, a phrase ≈ .59 */
    if(sarcasm && POSITIVE.has(emo)) score *= .4;     /* "i just love that for me" is not warmth */
    out.push({ emo, score: Math.round(score * 100) / 100 });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * The label list for something being written: the declared state first,
 * then whatever else the text plainly shows (up to MAX_LABELS in total).
 */
export function label(text, primary){
  const prim = Object.prototype.hasOwnProperty.call(EMOTIONS, primary) ? primary : 'calm';
  const out = [prim];
  for(const { emo, score } of analyze(text)){
    if(out.length >= MAX_LABELS) break;
    if(emo !== prim && score >= MIN_SCORE) out.push(emo);
  }
  return out;
}

/** stored JSON → list, falling back to the single declared state for old rows */
export function parse(raw, primary){
  if(raw){
    try {
      const a = JSON.parse(raw);
      if(Array.isArray(a)){
        const list = a.filter(e => typeof e === 'string' && EMOTIONS[e]);
        if(list.length) return list.slice(0, MAX_LABELS);
      }
    } catch { /* not JSON — treat it as unstored */ }
  }
  return primary ? [primary] : [];
}

/**
 * Matching: rank other readings by how many states they share with this one.
 * Patterned on reddit-archive (r2/r2/lib/recommender.py) — their
 * `_merge_and_sort_by_count` ranks candidates by how many of the inputs
 * matched them and `to_omit` keeps originals out of their own results.
 * Same rule here: overlap count first, recency as tiebreak, originals
 * omitted. Only the five allow-listed fields leave this function — no bodies,
 * no authors: the graph matches on feelings, not on people.
 */
export function rankByFeeling(candidates, want, { omit = [], limit = 4 } = {}){
  const skip = new Set(omit);
  const out = [];
  for(const c of candidates){
    if(skip.has(c.id)) continue;
    const labels = parse(c.emotions, c.emotion);
    const shared = labels.filter(e => want.includes(e)).length;
    if(!shared) continue;
    out.push({ id: c.id, com: c.com, title: c.title, ts: c.ts, emotions: labels, shared });
  }
  out.sort((a, b) => b.shared - a.shared || (b.ts || 0) - (a.ts || 0));
  return out.slice(0, limit);
}
