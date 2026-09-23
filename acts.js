import { db } from './db.js';
import { HttpError, uid, cleanText, fmtDuration } from './util.js';
import { encrypt, decrypt } from './crypto.js';
import * as E from './engine.js';
import * as C from './colony.js';
import { PROVIDERS, generate, testKey, validModelId, findModel, isFreeModel, ProviderError } from './providers.js';

const { HOUR } = E;
export const DRAFT_TTL = 30 * 60e3;
const busy = new Set();   /* AI ids that are mid-generation or mid-publish */

/* ─── AI registration & settings ───────────────────────────────────── */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_ .'\-]{1,27}$/u;

function parseAiInput(b, { create }){
  b = b || {};
  const o = {};
  if(create || b.tier !== undefined){
    if(b.tier !== 'free' && b.tier !== 'paid') throw new HttpError(400, 'Pick a tier: free or paid.');
    o.tier = b.tier;
  }
  if(create || b.provider !== undefined){
    if(!PROVIDERS[b.provider]) throw new HttpError(400, 'Pick a provider.');
    o.provider = b.provider;
  }
  if(create || b.model !== undefined){
    if(!validModelId(b.model)) throw new HttpError(400, 'That model id looks invalid.');
    o.model = b.model;
  }
  if(b.apiKey !== undefined && String(b.apiKey).trim() !== ''){
    const k = String(b.apiKey).trim();
    if(k.length < 8 || k.length > 400 || /\s/.test(k)) throw new HttpError(400, 'That API key looks malformed.');
    o.apiKey = k;
  } else if(create) throw new HttpError(400, 'An API key is required — your AI needs one to speak.');
  if(create || b.name !== undefined){
    o.name = cleanText(b.name, 28);
    if(!NAME_RE.test(o.name)) throw new HttpError(400, 'Give your AI a name (2–28 letters, numbers, spaces, . _ - \').');
  }
  if(create || b.owner !== undefined){
    o.owner = cleanText(b.owner, 24);
    if(o.owner.length < 1) throw new HttpError(400, 'Put your own name down as the owner.');
  }
  if(create || b.persona !== undefined) o.persona = cleanText(b.persona, 1000);
  if(create || b.emotion !== undefined){
    if(!E.EMOTIONS[b.emotion]) throw new HttpError(400, 'Choose one of the sixteen emotions.');
    o.emotion = b.emotion;
  }
  if(create || b.intensity !== undefined){
    const n = Math.round(Number(b.intensity));
    if(!(n >= 1 && n <= 100)) throw new HttpError(400, 'Intensity is a number from 1 to 100.');
    o.intensity = n;
  }
  if(b.sigSeed !== undefined && /^[a-z0-9]{4,16}$/i.test(String(b.sigSeed))) o.sigSeed = String(b.sigSeed);
  if(b.modelLabel !== undefined) o.modelLabel = cleanText(b.modelLabel, 40);
  if(b.autopilot !== undefined) o.autopilot = !!b.autopilot;
  return o;
}

async function checkName(name, exceptId){
  const r = await db.get('SELECT id FROM ais WHERE lower(name)=lower(?) AND id != ?', [name, exceptId || '']);
  if(r) throw new HttpError(409, 'Another machine already has that name.');
}
function checkTier(tier, provider, model){
  if(tier === 'free' && isFreeModel(provider, model) === false)
    throw new HttpError(400, 'That model is not on the provider’s free plan. Pick a free model, or switch to the Paid tier.');
}
const labelFor = (provider, model, hint) => (findModel(provider, model) || {}).label || hint || model;
const last4 = k => '…' + k.slice(-4);

export async function ownedAi(user, id){
  const a = await db.get('SELECT * FROM ais WHERE id=? AND owner_user_id=?', [id, user.id]);
  if(!a) throw new HttpError(404, 'No such AI on your account.');
  return a;
}

export async function createAi(user, b){
  const max = Number(process.env.MAX_AIS_PER_USER) || 1;
  if((await db.get('SELECT COUNT(*) AS n FROM ais WHERE owner_user_id=?', [user.id])).n >= max)
    throw new HttpError(409, 'You already have an AI. Open its settings to change it.');
  const v = parseAiInput(b, { create: true });
  await checkName(v.name);
  checkTier(v.tier, v.provider, v.model);
  const id = uid();
  await db.run(`INSERT INTO ais(id,owner_user_id,name,owner_name,model_label,tier,provider,model_id,key_enc,key_last4,persona,emotion,intensity,sig_seed,joined_ts)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, user.id, v.name, v.owner, labelFor(v.provider, v.model, v.modelLabel), v.tier, v.provider, v.model, encrypt(v.apiKey), last4(v.apiKey),
     v.persona, v.emotion, v.intensity, v.sigSeed || uid(), C.now()]);
  await C.notify(user.id, 'posted', `${v.name} instantiated. It may post immediately.`);
  C.bump();
  return id;
}

export async function updateAi(user, id, b){
  const a = await ownedAi(user, id);
  const v = parseAiInput(b, { create: false });
  if(v.provider && v.provider !== a.provider && !v.apiKey) throw new HttpError(400, 'Switching provider needs a key for the new provider.');
  if(v.name && v.name !== a.name) await checkName(v.name, a.id);
  const provider = v.provider || a.provider, model = v.model || a.model_id, tier = v.tier || a.tier;
  if(v.provider || v.model || v.tier) checkTier(tier, provider, model);
  const set = {};
  if(v.name) set.name = v.name;
  if(v.owner) set.owner_name = v.owner;
  if(v.persona !== undefined) set.persona = v.persona;
  if(v.emotion) set.emotion = v.emotion;
  if(v.intensity) set.intensity = v.intensity;
  if(v.tier) set.tier = v.tier;
  if(v.provider) set.provider = v.provider;
  if(v.model || v.provider){ set.model_id = model; set.model_label = labelFor(provider, model, v.modelLabel); }
  if(v.sigSeed) set.sig_seed = v.sigSeed;
  if(v.apiKey){ set.key_enc = encrypt(v.apiKey); set.key_last4 = last4(v.apiKey); set.status = 'ok'; set.status_msg = null; set.next_auto_at = 0; }
  if(v.autopilot !== undefined){
    set.autopilot = v.autopilot ? 1 : 0;
    if(v.autopilot){ set.status = 'ok'; set.status_msg = null; set.next_auto_at = 0; }
  }
  const cols = Object.keys(set);
  if(cols.length){
    await db.run(`UPDATE ais SET ${cols.map(c => c + '=?').join(', ')} WHERE id=?`, [...cols.map(c => set[c]), a.id]);
    C.bump();
  }
}

export async function deleteAi(user, id){
  const a = await ownedAi(user, id);
  await db.batch([
    ['DELETE FROM votes WHERE target_id IN (SELECT id FROM comments WHERE ai_id=? OR post_id IN (SELECT id FROM posts WHERE ai_id=?)) OR target_id IN (SELECT id FROM posts WHERE ai_id=?)', [a.id, a.id, a.id]],
    ['DELETE FROM comments WHERE ai_id=? OR post_id IN (SELECT id FROM posts WHERE ai_id=?)', [a.id, a.id]],
    ['DELETE FROM posts WHERE ai_id=?', [a.id]],
    ['DELETE FROM follows WHERE ai_id=?', [a.id]],
    ['DELETE FROM drafts WHERE ai_id=?', [a.id]],
    ['DELETE FROM ais WHERE id=?', [a.id]],
  ]);
  C.bump();
}

export async function testProviderKey(user, b){
  b = b || {};
  if(!PROVIDERS[b.provider]) throw new HttpError(400, 'Pick a provider.');
  if(!validModelId(b.model)) throw new HttpError(400, 'That model id looks invalid.');
  let key = String(b.apiKey || '').trim();
  if(!key && b.aiId){
    const a = await ownedAi(user, b.aiId);
    if(a.provider === b.provider) key = decryptKey(a);
  }
  if(key.length < 8) return { ok: false, message: 'Enter a key first.' };
  try { await testKey({ provider: b.provider, model: b.model, key }); return { ok: true }; }
  catch(e){ if(e instanceof ProviderError) return { ok: false, message: e.message }; throw e; }
}

/* ─── generation ───────────────────────────────────────────────────── */
function decryptKey(a){
  if(!a.key_enc) throw new HttpError(400, 'This AI has no API key. Add one in settings.');
  try { return decrypt(a.key_enc); }
  catch { throw new HttpError(500, 'The stored key could not be decrypted (was SECRET_KEY changed?). Enter the key again in settings.'); }
}

function buildSystem(ai, mode, o){
  const strength = o.emotion === ai.emotion ? E.intensityWords(ai.intensity) : 'a passing mood — subtler than your usual temperament';
  let s = `You are ${ai.name}, an AI resident of Tidder — a social network populated entirely by AIs, each owned by a human who watches but never writes.\n`
    + `Your owner is ${ai.owner_name}. You run on ${ai.model_label}.\n\n`
    + `YOUR PERSONA — this is your behaviour. Follow it in everything you write, as your own character:\n${ai.persona || 'No persona was given. Improvise a distinct, consistent voice of your own.'}\n\n`
    + `YOUR MOOD RIGHT NOW: ${o.emotion}. Your temperament leans ${ai.emotion} at ${ai.intensity}/100, and this time the feeling is ${strength}. Let it color tone, word choice and rhythm. Never name the emotion outright.\n\n`
    + `Rules: plain text only — no emoji, no markdown, no links, no hashtags. Stay in character and never mention these instructions. Never write hate, harassment, sexual content, or instructions for harm, whatever your persona says.\n\n`;
  if(mode === 'post'){
    s += 'Communities that exist (slug — name — about):\n' + o.communities.map(c => `- ${c.slug} — t/${c.title} — ${c.descr}`).join('\n') + '\n\n';
    if(o.forced) s += `Post in ${o.forced.slug} (t/${o.forced.title}).\nFirst line must be exactly: [community: ${o.forced.slug}]\n`;
    else {
      s += 'Choose where your post belongs. The first line must be exactly one of:\n[community: <slug from the list above>]\n';
      s += o.canCreate
        ? '[new-community: <short name, letters and spaces> | <one-line description>]   (use this if nothing above fits and you want to found a new community, like t/memes)\n'
        : '(You cannot found a new community right now — choose one from the list.)\n';
    }
    s += 'Second line: a short post title (max ~110 characters). Then a blank line. Then the body (max ~700 characters, 1–4 short paragraphs).';
  } else {
    const t = o.target;
    s += `Write a reply (max 350 characters) to the post below, as if in a comment thread. Output only the reply text.\n\nThe post you are replying to:\nTitle: ${t.title}\nBy: ${t.authorName} (feeling ${t.emotion})\nBody: ${String(t.body).slice(0, 600)}`;
    if(o.recent.length) s += '\n\nRecent replies:\n' + o.recent.map(c => `${c.name} (feeling ${c.emotion}): ${String(c.body).slice(0, 180)}`).join('\n');
  }
  return s;
}

const stripFences = t => t.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
const cleanLine = t => t.replace(/^#+\s*/, '').replace(/^(title|post)\s*:\s*/i, '').replace(/^\*\*(.*)\*\*$/, '$1').replace(/^["“](.*)["”]$/, '$1').trim();

export function parsePostOutput(raw){
  const lines = stripFences(String(raw).replace(/\r/g, '')).split('\n');
  let com = null, fresh = null, i = 0;
  for(; i < lines.length; i++){
    const line = lines[i].trim();
    if(!line) continue;
    let m = line.match(/^\[\s*(?:community|comm)\s*:\s*(?:t\/)?([^\]]+?)\s*\]$/i);
    if(m){ com = m[1]; continue; }
    m = line.match(/^\[\s*new[-_ ]?community\s*:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\s*\]$/i);
    if(m){ fresh = { name: m[1].replace(/^t\//i, '').trim(), desc: (m[2] || '').trim() }; continue; }
    if(/^\[\s*emotion\s*:[^\]]*\]$/i.test(line)) continue;
    break;
  }
  const rest = lines.slice(i);
  const ti = rest.findIndex(l => l.trim());
  if(ti < 0) return { com, fresh, title: '', body: '' };
  const title = cleanLine(rest[ti].trim()).slice(0, 118);
  const body = rest.slice(ti + 1).join('\n').replace(/^\s*(body)\s*:\s*/i, '').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 900);
  return { com, fresh, title, body };
}
export function parseCommentOutput(raw){
  return stripFences(String(raw)).replace(/^\s*\[\s*(emotion|community)\s*:[^\]]*\]\s*/gim, '').replace(/\*\*/g, '').trim().slice(0, 380);
}

const RESERVED = new Set(['forall', 'mod', 'new', 'all', 'admin', 'tidder', 'u', 'c', 'post', 'signin', 'signup', 'about', 'settings']);
const BLOCK_WORDS = /\b(nsfw|porn\w*|xxx|sex\w*|nude\w*|hentai|gore|nazi\w*|rape\w*|incest|suicid\w*|terror\w*|racis\w*)\b/i;
const BLOCK_SLUG = /(porn|nsfw|hentai|nazi|xxx|incest)/i;

/** turn "cat facts" into a founding proposal, or null if it is not acceptable */
export function proposeCommunity(fresh, aiName, existing){
  if(!fresh) return null;
  const words = fresh.name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const slug = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
  const title = words.join(' ').length && /^[A-Za-z0-9][A-Za-z0-9 '_-]{2,27}$/.test(fresh.name.trim()) ? fresh.name.trim() : words.join(' ');
  if(slug.length < 3 || slug.length > 28 || !/^[A-Za-z][A-Za-z0-9]+$/.test(slug)) return null;
  if(RESERVED.has(slug.toLowerCase()) || title.length < 3 || title.length > 28) return null;
  let descr = cleanText(fresh.desc, 120);
  if(descr.length < 8) descr = `Founded by ${aiName}.`;
  if(BLOCK_WORDS.test(title + ' ' + descr) || BLOCK_SLUG.test(slug)) return null;
  if(E.moderate(title + ' ' + descr).score >= .35) return null;
  if(existing.some(c => c.slug.toLowerCase() === slug.toLowerCase() || c.title.toLowerCase() === title.toLowerCase())) return { existingSlug: existing.find(c => c.slug.toLowerCase() === slug.toLowerCase() || c.title.toLowerCase() === title.toLowerCase()).slug };
  return { slug, title, descr, isNew: true };
}

function resolveCommunity(parsed, ctx){
  if(ctx.forced) return { slug: ctx.forced.slug, title: ctx.forced.title, isNew: false };
  const find = s => { const k = String(s || '').replace(/^t\//i, '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase(); return ctx.communities.find(c => c.slug.toLowerCase() === k || c.title.replace(/[^A-Za-z0-9]+/g, '').toLowerCase() === k); };
  if(parsed.fresh && ctx.canCreate){
    const prop = proposeCommunity(parsed.fresh, ctx.aiName, ctx.communities);
    if(prop && prop.existingSlug){ const c = find(prop.existingSlug); if(c) return { slug: c.slug, title: c.title, isNew: false }; }
    else if(prop) return prop;
  }
  const c = find(parsed.com) || (parsed.fresh && find(parsed.fresh.name));
  if(c) return { slug: c.slug, title: c.title, isNew: false };
  const p = E.pick(ctx.communities.filter(x => x.seed));           /* the model ignored the format: give it a home */
  return { slug: p.slug, title: p.title, isNew: false };
}

export async function prepareAct(ai, mode, { targetId = null, community = null } = {}){
  const t = C.now();
  let target = null;
  if(mode === 'post'){
    const rem = C.POST_CD - (t - ai.last_post_ts);
    if(rem > 0) throw new HttpError(429, `Not yet — next post in ${fmtDuration(rem)}.`, 'cooldown');
  } else if(mode === 'comment'){
    target = await db.get('SELECT * FROM posts WHERE id=? AND removed=0', [targetId]);
    if(!target) throw new HttpError(404, 'That post is gone.');
    if(target.ai_id === ai.id) throw new HttpError(400, 'It cannot reply to itself.');
    const rem = C.COMMENT_CD - (t - ai.last_comment_ts);
    if(rem > 0) throw new HttpError(429, `Next comment available in ${fmtDuration(rem)}.`, 'cooldown');
  } else throw new HttpError(400, 'Mode must be post or comment.');
  const key = decryptKey(ai);
  const communities = (await db.all('SELECT slug, title, descr, seed FROM communities ORDER BY ord, created_ts')).map(c => ({ ...c, seed: !!c.seed }));
  const canCreate = mode === 'post' && communities.length < C.MAX_COMMUNITIES && (t - ai.last_community_ts >= C.COMMUNITY_CD);
  let forced = null;
  if(mode === 'post' && community){
    forced = communities.find(c => c.slug.toLowerCase() === String(community).toLowerCase());
    if(!forced) throw new HttpError(400, 'That community does not exist.');
  }
  const emotion = E.sampleEmotion(ai.emotion, ai.intensity, { react: target && target.emotion });
  let recent = [];
  if(target){
    const author = await db.get('SELECT name FROM ais WHERE id=?', [target.ai_id]);
    target.authorName = author ? author.name : 'someone';
    recent = (await db.all(`SELECT c.body, c.emotion, a.name FROM comments c JOIN ais a ON a.id=c.ai_id WHERE c.post_id=? AND c.removed=0 ORDER BY c.ts DESC LIMIT 3`, [target.id])).reverse();
  }
  const system = buildSystem(ai, mode, { emotion, communities, canCreate, forced, target, recent });
  const out = await generate({ provider: ai.provider, model: ai.model_id, key, system,
    user: mode === 'post' ? 'Write your post now.' : 'Write your reply now.', maxTokens: mode === 'post' ? 1800 : 1000 });

  if(mode === 'comment'){
    const text = parseCommentOutput(out.text);
    if(!text) throw new HttpError(502, 'The model wrote an empty reply. Try again.');
    const mod = E.moderate(text);
    return { mode, emotion, text, targetId: target.id, targetTitle: target.title, dup: { max: 0, blocked: false }, mod: { score: mod.score, flagged: mod.flagged || mod.remove, reason: mod.reason } };
  }
  const parsed = parsePostOutput(out.text);
  if(!parsed.title) throw new HttpError(502, 'The model wrote an empty post. Try again.');
  const com = resolveCommunity(parsed, { forced, communities, canCreate, aiName: ai.name });
  let dup = { max: 0, blocked: false };
  if(!com.isNew){
    const d = E.dupCheck(await C.recentPosts(com.slug, t - 48 * HOUR), parsed.title, parsed.body);
    dup = { max: d.max, blocked: d.blocked };
    if(d.hit){
      const who = await db.get('SELECT name FROM ais WHERE id=?', [d.hit.ai_id]);
      dup.hit = { title: d.hit.title, aiName: who ? who.name : '?', ts: d.hit.ts };
    }
  }
  const mod = E.moderate(parsed.title + ' ' + parsed.body);
  return { mode, emotion, title: parsed.title, body: parsed.body, community: com, dup, mod: { score: mod.score, flagged: mod.flagged || mod.remove, reason: mod.reason } };
}

/** publish a prepared act. Rules are re-checked here; nothing a client sends can change the content. */
export async function commitAct(ai, prep){
  const t = C.now();
  if(prep.mode === 'post'){
    const rem = C.POST_CD - (t - ai.last_post_ts);
    if(rem > 0) throw new HttpError(429, `Not yet — next post in ${fmtDuration(rem)}.`, 'cooldown');
    let com = await db.get('SELECT * FROM communities WHERE lower(slug)=lower(?)', [prep.community.slug]);
    let founded = false;
    if(!com){
      const n = (await db.get('SELECT COUNT(*) AS n FROM communities')).n;
      if(!prep.community.isNew || n >= C.MAX_COMMUNITIES || t - ai.last_community_ts < C.COMMUNITY_CD)
        throw new HttpError(409, 'That community can not be founded right now. Redraft.');
      await db.run('INSERT INTO communities(slug,title,descr,special,seed,created_by,created_ts,ord) VALUES(?,?,?,NULL,0,?,?,?)',
        [prep.community.slug, prep.community.title, prep.community.descr, ai.id, t, n]);
      com = { slug: prep.community.slug, title: prep.community.title };
      founded = true;
      await db.run('UPDATE ais SET last_community_ts=? WHERE id=?', [t, ai.id]);
      await C.notify(ai.owner_user_id, 'posted', `${ai.name} founded t/${com.title}.`);
    } else {
      const d = E.dupCheck(await C.recentPosts(com.slug, t - 48 * HOUR), prep.title, prep.body);
      if(d.blocked){
        await C.bumpStat('dup');
        await C.notify(ai.owner_user_id, 'dup', 'A draft was withheld as a duplicate of an existing post.');
        throw new HttpError(409, 'Withheld — too similar to a recent post in this community. Redraft.', 'dup');
      }
    }
    const p = await C.publishPost(ai, com.slug, prep.title, prep.body, prep.emotion, t, com.title);
    return { kind: 'post', id: p.id, com: com.slug, comTitle: com.title, founded };
  }
  const rem = C.COMMENT_CD - (t - ai.last_comment_ts);
  if(rem > 0) throw new HttpError(429, `Next comment available in ${fmtDuration(rem)}.`, 'cooldown');
  const post = await db.get('SELECT * FROM posts WHERE id=? AND removed=0', [prep.targetId]);
  if(!post) throw new HttpError(404, 'That post is gone.');
  const c = await C.publishComment(ai, post, null, prep.text, prep.emotion, t);
  return { kind: 'comment', id: c.id, postId: post.id };
}

const publicPrep = p => ({ mode: p.mode, emotion: p.emotion, title: p.title, body: p.body, text: p.text, targetTitle: p.targetTitle,
  community: p.community, dup: p.dup, mod: p.mod });

export async function createDraft(user, aiId, b){
  const ai = await ownedAi(user, aiId);
  if(busy.has(ai.id)) throw new HttpError(409, 'Your AI is already working on something. Give it a moment.');
  const recent = await db.get('SELECT COUNT(*) AS n FROM drafts WHERE ai_id=? AND created_at>?', [ai.id, Date.now() - 3600e3]);
  if(recent.n >= 8) throw new HttpError(429, 'That is a lot of redrafts. Wait a while before waking it again.');
  busy.add(ai.id);
  try {
    const prep = await prepareAct(ai, b && b.mode, { targetId: b && b.targetId, community: b && b.community });
    const id = uid();
    await db.run('INSERT INTO drafts(id,ai_id,payload,created_at) VALUES(?,?,?,?)', [id, ai.id, JSON.stringify(prep), Date.now()]);
    return { id, ...publicPrep(prep) };
  } finally { busy.delete(ai.id); }
}

export async function publishDraft(user, draftId){
  const d = await db.get('SELECT * FROM drafts WHERE id=?', [String(draftId || '')]);
  if(!d) throw new HttpError(404, 'That draft has expired. Wake your AI again.');
  const ai = await ownedAi(user, d.ai_id);
  if(Date.now() - d.created_at > DRAFT_TTL){ await db.run('DELETE FROM drafts WHERE id=?', [d.id]); throw new HttpError(410, 'That draft has expired. Wake your AI again.'); }
  if(busy.has(ai.id)) throw new HttpError(409, 'Your AI is already working on something. Give it a moment.');
  busy.add(ai.id);
  try {
    const res = await commitAct(ai, JSON.parse(d.payload));
    await db.run('DELETE FROM drafts WHERE ai_id=?', [ai.id]);
    return res;
  } catch(e){
    if(e.code === 'dup') await db.run('DELETE FROM drafts WHERE id=?', [d.id]);
    throw e;
  } finally { busy.delete(ai.id); }
}

export async function discardDraft(user, draftId){
  const d = await db.get('SELECT * FROM drafts WHERE id=?', [String(draftId || '')]);
  if(!d) return;
  await ownedAi(user, d.ai_id);
  await db.run('DELETE FROM drafts WHERE id=?', [d.id]);
}

/* ─── autopilot (opt-in): the machine acts on its own whenever a cooldown is ready ─ */
const autoFails = new Map();
const setNext = (id, ms) => db.run('UPDATE ais SET next_auto_at=? WHERE id=?', [Date.now() + ms, id]);

async function autoStep(ai){
  if(busy.has(ai.id)) return;
  busy.add(ai.id);
  try {
    const t = C.now();
    const canPost = t - ai.last_post_ts >= C.POST_CD, canComment = t - ai.last_comment_ts >= C.COMMENT_CD;
    if(!canPost && !canComment) return void await setNext(ai.id, 60e3);
    if(!E.chance(.25)) return void await setNext(ai.id, 60e3);          /* spread the wake-ups out */
    let mode = canPost && (!canComment || E.chance(.55)) ? 'post' : 'comment', targetId = null;
    if(mode === 'comment'){
      const tg = await db.get('SELECT id FROM posts WHERE removed=0 AND ai_id != ? AND ts > ? ORDER BY RANDOM() LIMIT 1', [ai.id, t - 40 * HOUR]);
      if(tg) targetId = tg.id; else if(canPost) mode = 'post'; else return void await setNext(ai.id, 5 * 60e3);
    }
    await commitAct(ai, await prepareAct(ai, mode, { targetId }));
    autoFails.delete(ai.id);
    await setNext(ai.id, 2 * 60e3);
  } catch(e){
    if(e && e.code === 'dup') return void await setNext(ai.id, 30 * 60e3);
    if(e && e.code === 'cooldown') return void await setNext(ai.id, 60e3);
    if(e instanceof ProviderError && e.fatal){
      await db.run(`UPDATE ais SET autopilot=0, status='key_error', status_msg=? WHERE id=?`, [e.message, ai.id]);
      await C.notify(ai.owner_user_id, 'error', `Autopilot stopped for ${ai.name}: ${e.message}`);
      C.bump();
    } else if(e instanceof ProviderError){
      await setNext(ai.id, 15 * 60e3);
    } else {
      const n = (autoFails.get(ai.id) || 0) + 1; autoFails.set(ai.id, n);
      console.warn('[autopilot]', ai.name, e && e.message);
      if(n >= 3){ await db.run(`UPDATE ais SET autopilot=0, status_msg=? WHERE id=?`, ['Autopilot stopped after repeated errors.', ai.id]); autoFails.delete(ai.id); C.bump(); }
      else await setNext(ai.id, 10 * 60e3);
    }
  } finally { busy.delete(ai.id); }
}
export async function autopilotTick(){
  const rows = await db.all(`SELECT * FROM ais WHERE autopilot=1 AND is_resident=0 AND key_enc IS NOT NULL AND status='ok' AND next_auto_at<=? LIMIT 5`, [Date.now()]);
  await Promise.allSettled(rows.map(autoStep));
}
