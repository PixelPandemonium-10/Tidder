import { HttpError } from './util.js';

/* ══════════════════════════════════════════════════════════════════
   Provider registry + callers.
   Models change constantly, so: a curated list per provider (checked
   September 2026), a LIVE list for OpenRouter (fetched from their public
   /models endpoint), and a "custom model id" escape hatch in the UI.
   `free` = usable on the provider's free plan (rate-limited by them).
   ══════════════════════════════════════════════════════════════════ */

const M = (id, label, free = false) => ({ id, label, free });

export const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter', style: 'openai', base: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-v1-…', keyUrl: 'https://openrouter.ai/keys',
    blurb: 'One key, hundreds of models — including a rotating set of free ones.',
    freeNote: 'OpenRouter free model · daily cap', paidNote: 'your key · billed by OpenRouter', live: true,
  },
  google: {
    name: 'Google Gemini', style: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey',
    blurb: 'Free tier on the Flash models through Google AI Studio.',
    freeNote: 'free plan · rate-limited by Google', paidNote: 'your key · billed by Google',
  },
  groq: {
    name: 'Groq', style: 'openai', base: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk_…', keyUrl: 'https://console.groq.com/keys',
    blurb: 'Very fast open models. Free plan with generous daily limits, no card.',
    freeNote: 'free plan · rate-limited by Groq', paidNote: 'your key · billed by Groq',
  },
  cerebras: {
    name: 'Cerebras', style: 'openai', base: 'https://api.cerebras.ai/v1',
    keyHint: 'csk-…', keyUrl: 'https://cloud.cerebras.ai/',
    blurb: 'Wafer-scale inference. Free tier with a daily token allowance.',
    freeNote: 'free tier · daily token cap', paidNote: 'your key · billed by Cerebras',
  },
  mistral: {
    name: 'Mistral', style: 'openai', base: 'https://api.mistral.ai/v1',
    keyHint: 'paste your Mistral key', keyUrl: 'https://console.mistral.ai/api-keys',
    blurb: 'Free “Experiment” plan covers every model (phone verification needed).',
    freeNote: 'Experiment plan · free, rate-limited', paidNote: 'your key · billed by Mistral',
  },
  openai: {
    name: 'OpenAI', style: 'responses', base: 'https://api.openai.com/v1',
    keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys',
    blurb: 'GPT models. Paid keys only.', freeNote: '', paidNote: 'your key · billed by OpenAI',
  },
  anthropic: {
    name: 'Anthropic', style: 'anthropic', base: 'https://api.anthropic.com/v1',
    keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys',
    blurb: 'Claude models. Paid keys only.', freeNote: '', paidNote: 'your key · billed by Anthropic',
  },
  xai: {
    name: 'xAI', style: 'openai', base: 'https://api.x.ai/v1',
    keyHint: 'xai-…', keyUrl: 'https://console.x.ai/',
    blurb: 'Grok models. Paid keys only.', freeNote: '', paidNote: 'your key · billed by xAI',
  },
  deepseek: {
    name: 'DeepSeek', style: 'openai', base: 'https://api.deepseek.com',
    keyHint: 'sk-…', keyUrl: 'https://platform.deepseek.com/api_keys',
    blurb: 'Very low prices. Paid keys only.', freeNote: '', paidNote: 'your key · billed by DeepSeek',
  },
};

export const MODELS = {
  openrouter: [ /* fallback only — the live list replaces this */
    M('openrouter/free', 'Free Models Router', true),
    M('openai/gpt-oss-120b:free', 'GPT-OSS 120B', true),
    M('qwen/qwen3.8-27b:free', 'Qwen3.8 27B', true),
    M('deepseek/deepseek-v4-flash-0731:free', 'DeepSeek V4 Flash 0731', true),
    M('openrouter/auto', 'OpenRouter Auto (routes to a strong model)'),
    M('anthropic/claude-sonnet-5', 'Claude Sonnet 5'),
    M('anthropic/claude-opus-5', 'Claude Opus 5'),
    M('openai/gpt-5.6-terra', 'GPT-5.6 Terra'),
    M('google/gemini-3.8-flash', 'Gemini 3.8 Flash'),
    M('x-ai/grok-4.6', 'Grok 4.6'),
  ],
  google: [
    M('gemini-3.8-flash', 'Gemini 3.8 Flash', true),
    M('gemini-3.7-flash', 'Gemini 3.7 Flash', true),
    M('gemini-3.6-flash', 'Gemini 3.6 Flash', true),
    M('gemini-3.5-flash', 'Gemini 3.5 Flash', true),
    M('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', true),
    M('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', true),
    M('gemini-3-flash-preview', 'Gemini 3 Flash (preview)', true),
    M('gemini-2.5-pro', 'Gemini 2.5 Pro', true),
    M('gemini-2.5-flash', 'Gemini 2.5 Flash', true),
    M('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', true),
    M('gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview) — paid only'),
  ],
  groq: [
    M('openai/gpt-oss-120b', 'GPT-OSS 120B', true),
    M('openai/gpt-oss-20b', 'GPT-OSS 20B', true),
    M('llama-3.3-70b-versatile', 'Llama 3.3 70B', true),
    M('llama-3.1-8b-instant', 'Llama 3.1 8B Instant', true),
    M('qwen/qwen3.8-27b', 'Qwen3.8 27B (preview)', true),
  ],
  cerebras: [
    M('gpt-oss-120b', 'GPT-OSS 120B', true),
    M('gemma-4-31b', 'Gemma 4 31B (preview)', true),
    M('zai-glm-4.7', 'GLM 4.7 (preview)', true),
  ],
  mistral: [
    M('mistral-large-latest', 'Mistral Large 3', true),
    M('mistral-medium-latest', 'Mistral Medium', true),
    M('mistral-small-latest', 'Mistral Small 4', true),
    M('magistral-medium-latest', 'Magistral Medium (reasoning)', true),
    M('magistral-small-latest', 'Magistral Small (reasoning)', true),
    M('ministral-14b-latest', 'Ministral 14B', true),
    M('open-mistral-nemo', 'Mistral Nemo', true),
  ],
  openai: [
    M('gpt-6-astra', 'GPT-6 Astra'),
    M('gpt-5.6-sol', 'GPT-5.6 Sol'),
    M('gpt-5.6-terra', 'GPT-5.6 Terra'),
    M('gpt-5.6-luna', 'GPT-5.6 Luna'),
    M('gpt-5.5', 'GPT-5.5'),
    M('gpt-5.4-mini', 'GPT-5.4 mini'),
    M('gpt-5.4-nano', 'GPT-5.4 nano'),
  ],
  anthropic: [
    M('claude-fable-5-1', 'Claude Fable 5.1'),
    M('claude-opus-5', 'Claude Opus 5'),
    M('claude-sonnet-5', 'Claude Sonnet 5'),
    M('claude-haiku-4-5', 'Claude Haiku 4.5'),
    M('claude-opus-4-8', 'Claude Opus 4.8'),
  ],
  xai: [
    M('grok-4.6', 'Grok 4.6'),
    M('grok-4.5', 'Grok 4.5'),
    M('grok-4.3', 'Grok 4.3'),
    M('grok-build-0.1', 'Grok Build 0.1'),
  ],
  deepseek: [
    M('deepseek-flash', 'DeepSeek V4.1 Flash'),
    M('deepseek-v4-pro', 'DeepSeek V4 Pro'),
  ],
};

export function catalog(){
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, name: p.name, blurb: p.blurb, keyHint: p.keyHint, keyUrl: p.keyUrl,
    freeNote: p.freeNote, paidNote: p.paidNote, live: !!p.live,
    hasFree: (MODELS[id] || []).some(m => m.free),
    models: MODELS[id] || [],
  }));
}

export const validModelId = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\/@+\-]{0,119}$/.test(s);
export const findModel = (provider, id) => (MODELS[provider] || []).find(m => m.id === id) || null;
/** true / false when we know, null when it is a custom id */
export function isFreeModel(provider, id){
  const m = findModel(provider, id);
  if(m) return m.free;
  if(provider === 'openrouter') return id.endsWith(':free') || id === 'openrouter/free';
  return null;
}

/* ─── OpenRouter live list ────────────────────────────────────────── */
let orCache = { at: 0, models: null };
export async function openrouterModels(){
  if(orCache.models && Date.now() - orCache.at < 3600e3) return orCache.models;
  try {
    const r = await fetch(baseUrl('openrouter') + '/models', { signal: AbortSignal.timeout(10000) });
    if(!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    const list = (j.data || [])
      .filter(m => m && m.id && (!m.architecture || !m.architecture.output_modalities || m.architecture.output_modalities.includes('text')))
      .map(m => {
        const free = (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0) || /:free$/.test(m.id) || m.id === 'openrouter/free';
        return { id: m.id, label: (m.name || m.id).replace(/\s*\(free\)\s*$/i, ''), free: !!free, context: m.context_length || null };
      });
    list.sort((a, b) => (b.id === 'openrouter/free') - (a.id === 'openrouter/free') || (b.id === 'openrouter/auto') - (a.id === 'openrouter/auto') || a.label.localeCompare(b.label));
    if(!list.length) throw new Error('empty');
    orCache = { at: Date.now(), models: list, live: true };
  } catch {
    orCache = { at: Date.now() - 3300e3, models: MODELS.openrouter.map(m => ({ ...m })), live: false }; /* retry in 5 min */
  }
  return orCache.models;
}
export const openrouterIsLive = () => !!orCache.live;

/* ─── calling providers ───────────────────────────────────────────── */
export const baseUrl = id =>
  process.env.TIDDER_TEST_PROVIDER_BASE ? process.env.TIDDER_TEST_PROVIDER_BASE.replace(/\/$/, '') + '/' + id : PROVIDERS[id].base;

class ProviderError extends HttpError {
  constructor(status, message, fatal = false){ super(status, message, 'provider'); this.fatal = fatal; this.provider = true; }
}
export { ProviderError };

function friendly(status, json, text){
  const snippet = String(
    (json && ((json.error && (json.error.message || (typeof json.error === 'string' && json.error))) || json.message)) || text || ''
  ).replace(/\s+/g, ' ').slice(0, 180);
  const tail = snippet ? ' — ' + snippet : '';
  if(status === 401 || status === 403) return new ProviderError(502, `That key was rejected (${status}). Check it in settings.` + tail, true);
  if(status === 402) return new ProviderError(502, `This key has no credits left (${status}). Top up the provider, or switch to a free-tier model.`, true);
  if(status === 404) return new ProviderError(502, `The provider doesn't know that model (404). Pick another one or check the model id.` + tail, true);
  if(status === 408 || status === 429) return new ProviderError(502, `Provider rate limit or daily cap reached (${status}). Try again later.` + tail);
  if(status >= 500) return new ProviderError(502, `The provider had a problem (${status}). Try again shortly.` + tail);
  return new ProviderError(502, `The provider rejected the request (${status}).` + tail);
}

async function post(url, headers, body){
  const ctl = new AbortController();
  const ms = Number(process.env.TIDDER_PROVIDER_TIMEOUT_MS) || 60000;
  const to = setTimeout(() => ctl.abort(), ms);
  let r, text;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    text = await r.text();
  } catch(e){
    throw new ProviderError(502, e && e.name === 'AbortError' ? 'The provider took too long to answer (timed out).' : 'The Tidder server could not reach the provider.');
  } finally { clearTimeout(to); }
  let json = null; try { json = JSON.parse(text); } catch {}
  if(!r.ok) throw friendly(r.status, json, text);
  return json || {};
}

const partsToText = c => Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : p && p.text) || '').join('') : (typeof c === 'string' ? c : '');

async function callOpenAI(provider, o, extras){
  const headers = { Authorization: 'Bearer ' + o.key };
  if(provider === 'openrouter'){ headers['HTTP-Referer'] = process.env.PUBLIC_URL || 'https://tidder.local'; headers['X-Title'] = 'Tidder'; }
  const j = await post(baseUrl(provider) + '/chat/completions', headers, {
    model: o.model, max_tokens: o.maxTokens,
    messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }], ...extras,
  });
  const ch = j.choices && j.choices[0];
  return { text: partsToText(ch && ch.message && ch.message.content).trim(), truncated: !!(ch && ch.finish_reason === 'length') };
}
async function callResponses(provider, o, extras){
  const j = await post(baseUrl(provider) + '/responses', { Authorization: 'Bearer ' + o.key }, {
    model: o.model, instructions: o.system, input: o.user, max_output_tokens: o.maxTokens, store: false, ...extras,
  });
  let text = typeof j.output_text === 'string' ? j.output_text : '';
  if(!text && Array.isArray(j.output)){
    text = j.output.filter(x => x && x.type === 'message')
      .flatMap(x => x.content || []).filter(c => c && (c.type === 'output_text' || c.type === 'text')).map(c => c.text || '').join('');
  }
  return { text: text.trim(), truncated: j.status === 'incomplete' };
}
async function callAnthropic(provider, o){
  const j = await post(baseUrl(provider) + '/messages', { 'x-api-key': o.key, 'anthropic-version': '2023-06-01' }, {
    model: o.model, max_tokens: o.maxTokens, system: o.system, messages: [{ role: 'user', content: o.user }],
  });
  const text = (j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  return { text: text.trim(), truncated: j.stop_reason === 'max_tokens' };
}

/** small extras that keep reasoning models cheap and fast; dropped automatically if the provider objects */
function extrasFor(provider, model){
  if(provider === 'openrouter') return { reasoning: { effort: 'low' } };
  if(provider === 'google') return { reasoning_effort: 'low' };
  if((provider === 'groq' || provider === 'cerebras') && /gpt-oss/.test(model)) return { reasoning_effort: 'low' };
  if(provider === 'openai' && /^(gpt-[56]|o\d)/.test(model)) return { reasoning: { effort: 'low' } };
  return {};
}

export async function generate({ provider, model, key, system, user, maxTokens = 1500, probe = false }){
  const p = PROVIDERS[provider];
  if(!p) throw new ProviderError(400, 'Unknown provider.', true);
  const o = { model, key, system, user, maxTokens };
  const run = extras =>
    p.style === 'anthropic' ? callAnthropic(provider, o)
    : p.style === 'responses' ? callResponses(provider, o, extras)
    : callOpenAI(provider, o, extras);
  const extras = extrasFor(provider, model);
  let out;
  try { out = await run(extras); }
  catch(e){
    if(e instanceof ProviderError && /\(400\)/.test(e.message) && Object.keys(extras).length) out = await run({});
    else throw e;
  }
  if(!out.text && !probe){
    throw new ProviderError(502, out.truncated
      ? 'The model spent its whole token budget thinking and wrote nothing. Try again, or pick a model that reasons less.'
      : 'The model returned an empty reply. Try again.');
  }
  return out;
}

export async function testKey({ provider, model, key }){
  await generate({ provider, model, key, system: 'Reply with the single word: ok', user: 'ping', maxTokens: 64, probe: true });
  return true;
}
