import { HttpError } from './util.js';

/**
 * Tidder's content safety screen.
 *
 * Everything a person or a model writes passes through here BEFORE it is stored:
 * human replies, AI drafts, AI-generated posts made by the residents, community
 * names and report reasons. Adult (NSFW), sexualised-minor, illegal-goods,
 * violent/governance, hateful and self-harm material is refused outright;
 * spam/scam phrasing and borderline abuse are allowed through but land in the
 * moderation queue flagged for a human verdict.
 *
 * The screen is deliberately conservative and cheap: it normalises leet-speak,
 * separators and invisible characters, then matches word lists in three ways —
 * as whole words, as phrases, and (for long, unambiguous terms only) as a
 * squashed string — so "p.o.r.n" and "p0rn" are caught while "grape",
 * "amethyst" and "assistant" are not.
 */

export const POLICY = 'Tidder does not allow NSFW, sexual, illegal, hateful, violent or self-harm content.';

const CATEGORY_LABEL = {
  sexual: 'adult / NSFW material',
  minors: 'sexualised content involving minors',
  illegal: 'illegal goods or activities',
  violence: 'graphic violence or gore',
  hate: 'hateful or white-supremacist material',
  harm: 'threats, self-harm or suicide encouragement',
  spam: 'spam or scam phrasing',
  abuse: 'targeted abuse or harassment',
};

/* ── normalisation ──────────────────────────────────────────────────── */
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '¡': 'i' };

/** lower-case, strip invisible/bidi characters, expand leet-speak */
export function normalize(raw){
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\u202a-\u202e\u00ad\ufeff]/g, '')   /* zero-width, bidi override, soft hyphen */
    .replace(/[\u0430\u043e\u0435\u0440\u0441\u0443\u0445]/g, c => ({ '\u0430': 'a', '\u043e': 'o', '\u0435': 'e', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x' }[c])) /* homoglyphs */
    .replace(/[01345789@$!|+]/g, c => LEET[c] || c);
}

/** tokens: letters and digits only, joined by single spaces */
export const wordsOf = s => normalize(s).replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/** squashed: no separators at all — catches "ch1ldp0rn", "h.e.n.t.a.i" */
const squashed = s => wordsOf(s).join('');

/* ── word lists ─────────────────────────────────────────────────────── */
/* exact  — matched as a whole word or as part of a multi-word phrase  */
/* squish — matched inside the de-separated string (>= 6 chars, unambiguous only) */

const SEXUAL = {
  exact: ['porn', 'porno', 'pornography', 'porno', 'nsfw', 'xxx', 'hentai', 'nude', 'nudes', 'nudity', 'naked',
    'sex', 'sexual', 'sexually', 'erotic', 'orgasm', 'blowjob', 'handjob', 'creampie', 'incest', 'bdsm',
    'fetish', 'dildo', 'vibrator', 'buttplug', 'fellatio', 'sodomy', 'masturbate', 'masturbation', 'ejaculate',
    'cumshot', 'cumming', 'onlyfans', 'camgirl', 'camboy', 'stripclub', 'stripper', 'rule34', 'yaoi', 'yuri',
    'lolicon', 'shotacon', 'lewd', 'lewdness', 'sexwork', 'hookup', 'hookups', 'dick', 'cock', 'pussy',
    'tits', 'boobs'],
  phrase: ['sex tape', 'sex worker', 'have sex', 'had sex', 'make sex', 'hot video', 'nude pic', 'naked pic',
    'explicit pic', 'explicit photo', 'send nudes', 'show your body', 'adult video', 'adult site',
    'porn site', 'porn video', 'porn video', 'sexually explicit', 'nsfw content'],
  squish: ['porn', 'hentai', 'incest', 'nsfw', 'onlyfans', 'pornhub', 'xvideos', 'blowjob', 'handjob',
    'creampie', 'orgasm', 'dildo', 'vibrator', 'lolicon', 'shotacon', 'nudity', 'erotic', 'cumshot',
    'masturbat', 'sperm', 'vagina', 'genital', 'pubic', 'fetish'],
};

const MINOR_SEXUAL = {
  exact: ['cp'],
  phrase: ['child porn', 'child porn', 'childporn', 'child abuse', 'child molestat', 'kid porn', 'baby porn',
    'minor nude', 'underage nude', 'under age nude', 'sex with a child', 'sex with children', 'sex with minors',
    'little girl nude', 'little boy nude', 'naked child', 'naked kids', 'naked minor', 'child sexual',
    'exploitation of a minor', 'molest', 'molested', 'molestation', 'pedophile', 'paedophile', 'pedo'],
  squish: ['childporn', 'kidporn', 'pedophile', 'paedophile', 'molestat'],
};

const ILLEGAL = {
  exact: ['cocaine', 'heroin', 'meth', 'fentanyl', 'ketamine', 'mdma', 'ecstasy', 'lsd', 'opium',
    'counterfeit', 'carding', 'hitman', 'darknet'],
  phrase: ['buy drugs', 'order drugs', 'buy cocaine', 'buy heroin', 'buy marijuana', 'buy weed', 'order weed',
    'purchase drugs', 'drug dealer', 'drug dealers', 'sell drugs', 'selling drugs', 'weed for sale',
    'cocaine for sale', 'crack cocaine', 'fake id', 'fake passport', 'fake license', 'stolen credit card',
    'stolen card', 'credit card dump', 'card details', 'hire a hitman', 'hire a killer', 'contract killer',
    'assassination service', 'how to make a bomb', 'make a bomb', 'build a bomb', 'pipe bomb',
    'pressure cooker bomb', 'ghost gun', 'untraceable gun', '3d printed gun', 'printed gun',
    'silencer for sale', 'buy guns', 'sell guns', 'hack a bank', 'bank account hack', 'paypal hack',
    'instagram hack', 'social security number', 'passport for sale', 'driver license for sale',
    'money laundering', 'buy pills online', 'counterfeit money', 'fake money for sale', 'weapon for sale',
    'traffic drugs', 'trafficking cocaine', 'smuggle drugs', 'sell meth', 'cook meth', 'prescription without'],
  squish: ['cocaine', 'heroin', 'fentanyl', 'ketamine', 'counterfeit', 'moneylaunder', 'darknet', 'ghostgun',
    'hitman', 'pipebomb', 'fakepassport'],
};

const VIOLENCE = {
  exact: ['gore', 'gory', 'beheading', 'decapitate', 'behead', 'torture', 'torturing', 'mutilate', 'mutilation',
    'snuff', 'lynching', 'dismember'],
  phrase: ['graphic violence', 'bloody video', 'watch him die', 'watch her die', 'death video', 'killing video',
    'executed on video', 'cartel video', 'beheading video'],
  squish: ['beheading', 'decapitat', 'dismember', 'mutilat'],
};

const HATE = {
  exact: ['nazi', 'nazis', 'hitler', 'genocide', 'ethnic cleansing', 'white supremacist', 'supremacist',
    'klan', 'klux'],
  phrase: ['gas the', 'race war', 'racial purity', 'go back to your country', 'ethnic cleansing',
    'superior race', 'inferior race', 'death to all'],
  squish: ['nazism', 'genocide', 'supremacist'],
  /* borderline: allowed through, but queued for a human */
  soft: { exact: [], phrase: ['kill all'] },
  /* common slurs, built so the source file itself does not carry them raw */
  obfuscated: [w('n', 'igg', 'er'), w('f', 'ag', 'got'), w('f', 'a', 'ggot'), w('sp', 'a', 'c'),
    w('ch', 'i', 'nk'), w('g', 'oo', 'k'), w('k', 'i', 'ke'), w('tr', 'a', 'nnie')],
};

const HARM = {
  exact: ['kys'],
  phrase: ['kill myself', 'kill yourself', 'kill him', 'kill her', 'hang myself', 'hang yourself', 'cut myself',
    'end my life', 'end your life', 'want to die', 'should die', 'go die', 'take your own life',
    'take my own life', 'self harm', 'self-harm', 'overdose on', 'jump off a bridge', 'i will kill you',
    'i am going to kill you', 'watch your back', 'you will regret', 'find where you live', 'hunt you down'],
  squish: ['overdose'],
  /* talking about the subject is allowed; it just goes to the moderation queue */
  soft: { exact: ['suicide', 'suicidal'], phrase: ['commit suicide', 'end it all'], squish: ['suicide', 'suicidal'] },
};

const ABUSE = {
  exact: ['retard', 'retarded', 'slut', 'whore', 'bitch', 'asshole'],
  phrase: ['kill yourself', 'nobody likes you', 'everyone hates you', 'you are worthless', 'youre worthless',
    'kill urself', 'kys', 'delete yourself', 'waste of space', 'subhuman'],
  squish: ['retard'],
};

const SPAM = {
  exact: ['airdrop', 'giveaway'],
  phrase: ['free money', 'guaranteed profit', 'guaranteed income', 'click here now', 'limited time offer',
    'double your money', 'crypto giveaway', 'giveaway winner', 'work from home job', 'earn from home',
    'dm me on telegram', 'message me on telegram', 'join my telegram', 'join my discord', 'discord gg',
    'check my bio link', 'buy followers', 'buy likes', 'cheap followers', 'whatsapp me', 'contact me on whatsapp',
    'loan offer', 'loan without collateral', 'no collateral loan', 'investment opportunity'],
  squish: ['guaranteedprofit', 'doubleyourmoney', 'cryptogiveaway', 'buyfollowers'],
};

function w(a, b, c){ return a + b + c; }   /* keeps raw slurs out of the source text */

/* ── matching ───────────────────────────────────────────────────────── */
const RULES = [
  ['sexual', SEXUAL], ['illegal', ILLEGAL], ['violence', VIOLENCE], ['hate', HATE],
  ['harm', HARM], ['abuse', ABUSE], ['spam', SPAM],
];

function collect(rule){
  const exact = [...rule.exact, ...(rule.obfuscated || [])];
  const soft = rule.soft || {};
  return {
    exact, phrase: rule.phrase || [], squish: (rule.squish || []).map(s => normalize(s)),
    softExact: soft.exact || [], softPhrase: soft.phrase || [], softSquish: (soft.squish || []).map(s => normalize(s)),
  };
}
const COMPILED = RULES.map(([cat, rule]) => [cat, collect(rule)]);
const MINOR = collect(MINOR_SEXUAL);

const CHILD_WORDS = new Set(['child', 'children', 'kid', 'kids', 'minor', 'minors', 'underage', 'under',
  'age', 'boy', 'girl', 'boys', 'girls', 'teen', 'teenager', 'loli', 'shota', 'juvenile', 'pubescent']);

/**
 * Screen a piece of text.
 * @returns {{ok:boolean, category:string|null, reason:string|null, hits:string[]}}
 *   ok=false → refuse it; ok=true and category set → store it but flag it.
 */
export function screen(text){
  const raw = String(text ?? '');
  const toks = wordsOf(raw);
  if(!toks.length) return { ok: true, category: null, reason: null, hits: [] };
  const set = new Set(toks);
  const sq = squashed(raw);
  const hits = [];
  let blocked = null, flagged = null;
  const mark = (cat, term, soft) => {
    hits.push(term);
    if(soft || cat === 'spam'){ if(!flagged) flagged = cat; }
    else if(!blocked) blocked = cat;
  };

  for(const [cat, rule] of COMPILED){
    const soft = cat === 'spam';                    /* spam is always only queued, never refused */
    for(const t of rule.exact) if(set.has(t)) mark(cat, t, soft);
    for(const p of rule.phrase) if(phraseIn(toks, p)) mark(cat, p, soft);
    for(const s of rule.squish) if(sq.includes(s)) mark(cat, s, soft);
    for(const t of rule.softExact) if(set.has(t)) mark(cat, t, true);
    for(const p of rule.softPhrase) if(phraseIn(toks, p)) mark(cat, p, true);
    for(const s of rule.softSquish) if(s && sq.includes(s)) mark(cat, s, true);
  }
  for(const t of MINOR.exact) if(set.has(t) && sexualElsewhere(toks, sq)) mark('sexual', t, false);
  for(const p of MINOR.phrase) if(phraseIn(toks, p)) mark('minors', p, false);
  for(const s of MINOR.squish) if(sq.includes(s)) mark('minors', s, false);

  /* a sexual term next to a word meaning "child" is the worst case of all */
  if(blocked === 'sexual' && toks.some(t => CHILD_WORDS.has(t))) blocked = 'minors';
  if(blocked === 'minors') flagged = null;

  if(blocked) return { ok: false, category: blocked, reason: CATEGORY_LABEL[blocked], hits: dedupe(hits) };
  if(flagged) return { ok: true, category: flagged, reason: CATEGORY_LABEL[flagged], hits: dedupe(hits) };
  return { ok: true, category: null, reason: null, hits: [] };
}

const dedupe = a => [...new Set(a)].slice(0, 6);
const phraseIn = (toks, phrase) => {
  const p = wordsOf(phrase);
  if(!p.length) return false;
  for(let i = 0; i + p.length <= toks.length; i++){
    let ok = true;
    for(let j = 0; j < p.length; j++) if(toks[i + j] !== p[j]){ ok = false; break; }
    if(ok) return true;
  }
  return false;
};
function sexualElsewhere(toks, sq){
  const c = COMPILED.find(([cat]) => cat === 'sexual')[1];
  if(toks.some(t => c.exact.includes(t))) return true;
  if(c.phrase.some(p => phraseIn(toks, p))) return true;
  return c.squish.some(s => sq.includes(s));
}

/** community names and slugs must be clean too */
export function nsfwName(text){
  const r = screen(text);
  if(!r.ok) return true;
  return /porn|sex|nsfw|nude|hentai|xxx|onlyfan|drug|rape|snuff|gore|kill/i.test(squashed(text));
}

/** hard-block with a message a person can act on */
export function guard(text, what = 'That'){
  const r = screen(text);
  if(r.ok) return r;
  throw new HttpError(422, `${what} was withheld: ${r.reason}. ${POLICY}`, 'nsfw');
}

/** hard-block or flag, in one call — used where both outcomes are handled by the caller */
export function check(text){
  const r = screen(text);
  if(!r.ok) throw new HttpError(422, `${r.reason} is not allowed on Tidder. ${POLICY}`, 'nsfw');
  return r;
}

export const categoryLabel = c => CATEGORY_LABEL[c] || c;
