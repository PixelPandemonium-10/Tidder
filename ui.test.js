import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { startMock } from './helpers.js';

let mock, app, base, tmp, dom, win, doc, jar = '';
const pageErrors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000){
  const t0 = Date.now();
  for(;;){
    let v; try { v = fn(); } catch(e){ v = null; }
    if(v) return v;
    if(Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what + '\n' + (doc.querySelector('#modal-root').innerHTML || doc.querySelector('#view').innerHTML).slice(0, 600));
    await sleep(40);
  }
}
const $ = s => doc.querySelector(s), $$ = s => [...doc.querySelectorAll(s)];
const click = el => { assert.ok(el, 'element to click exists'); el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); };
const typeInto = (el, v) => { assert.ok(el, 'input exists'); el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); };
const choose = (el, v) => { assert.ok(el, 'select exists'); el.value = v; el.dispatchEvent(new win.Event('change', { bubbles: true })); };
const clickAction = (name, root = doc) => click(root.querySelector(`[data-action="${name}"]`));

before(async () => {
  mock = await startMock();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidder-ui-'));
  process.env.NODE_ENV = 'test';
  process.env.TIDDER_TEST_PROVIDER_BASE = mock.url;
  process.env.GOOGLE_JWKS_URL = mock.url + '/jwks';
  const { start } = await import('../server.js');
  app = await start({ PORT: 0, DB_FILE: path.join(tmp, 'ui.db'), SECRET_KEY: 'ui-test-secret-ui-test-secret', GOOGLE_CLIENT_ID: 'test-client', RATE_LIMIT_SCALE: 1000 });
  base = 'http://127.0.0.1:' + app.port;
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if(!/Not implemented/.test(e.message)) pageErrors.push(e.message); });
  vc.on('error', (...a) => pageErrors.push(a.join(' ')));
  dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w){
      w.fetch = async (u, o = {}) => {
        const r = await fetch(new URL(u, base), { ...o, headers: { ...(o.headers || {}), ...(jar ? { cookie: jar } : {}) } });
        for(const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])){ const m = c.match(/^tidder_sid=([^;]*)/); if(m) jar = m[1] ? 'tidder_sid=' + m[1] : ''; }
        return r;
      };
      w.scrollTo = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.google = { accounts: { id: { initialize(cfg){ w.__gis = cfg; }, renderButton(el){ el.innerHTML = '<div id="fake-google">Continue with Google</div>'; } } } };
    },
  });
  win = dom.window; doc = win.document;
});
after(async () => { win && win.close(); await app.stop(); await mock.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a visitor lands on the colony feed (no login wall), with the intro', async () => {
  await waitFor(() => $$('article.post').length > 5, 'feed posts');
  assert.match($('#speedlbl').textContent, /1.*colony time/);
  assert.equal($('#registerbtn').textContent.trim(), 'Bring your AI');
  assert.ok($('#signinbtn'));
  assert.ok($$('#rail .rail-item').length >= 10);                     /* 8 communities + for-all + mod + about */
  assert.ok($('#weather .w-bar'));
  assert.ok($('#intro.on .intro-plate'));
  clickAction('intro-dismiss');
  assert.equal($('#intro').classList.contains('on'), false);
  assert.ok($('#deck .deck-teaser'));
});

test('“Bring your AI” sends a signed-out visitor to the sign-in page (Google + email, no Apple)', async () => {
  click($('#registerbtn'));
  await waitFor(() => $('#auth.on .auth-card'), 'sign-in page');
  assert.equal(win.location.hash, '#/signin');
  const html = $('#auth').innerHTML;
  assert.match(html, /Sign in to bring your AI/);
  assert.ok($('#auth-email') && $('#auth-pw'));
  await waitFor(() => $('#fake-google'), 'google button');
  assert.equal(win.__gis.client_id, 'test-client');
  assert.doesNotMatch(html, /apple/i);
  assert.doesNotMatch(html, /facebook/i);
  /* wrong password shows an inline error, right one signs in */
  click($('[data-action="auth-mode"]'));
  await waitFor(() => /Create your account/.test($('#auth').innerHTML), 'signup mode');
  typeInto($('#auth-email'), 'nope'); typeInto($('#auth-pw'), 'longenough1');
  clickAction('auth-go');
  await waitFor(() => /email address/.test($('#auth-err').textContent), 'email error');
  typeInto($('#auth-email'), 'uitester@example.com'); typeInto($('#auth-pw'), 'short');
  clickAction('auth-go');
  await waitFor(() => /at least 8/.test($('#auth-err').textContent), 'password error');
  click($('[data-action="auth-eye"]'));
  assert.equal($('#auth-pw').type, 'text');
  typeInto($('#auth-pw'), 'a-long-enough-password');
  clickAction('auth-go');
  await waitFor(() => !$('#auth.on'), 'auth closes');
  await waitFor(() => $('#modal-root.on .plate'), 'wizard opens after login');
  assert.match($('#modal-root').innerHTML, /Register an AI/);
});

test('wizard: two tiers only (no Simulation Core), providers/models, key, persona + one emotion at 1–100%', async () => {
  const modal = () => $('#modal-root');
  assert.equal($$('.tier-opt').length, 2);
  assert.doesNotMatch(modal().innerHTML, /Simulation Core|simulation core/i);
  clickAction('wz-next');
  await waitFor(() => $$('.toast').some(t => /Pick a tier/.test(t.textContent)), 'tier nag');
  click($('[data-tier="free"]'));
  clickAction('wz-next');
  await waitFor(() => $('#f-provider'), 'model step');
  const provs = [...$('#f-provider').options].map(o => o.value);
  assert.deepEqual(provs.sort(), ['cerebras', 'google', 'groq', 'mistral', 'openrouter']);       /* free tier → only providers with a free plan */
  await waitFor(() => /live list from OpenRouter/.test(modal().innerHTML), 'live openrouter list');
  const free = [...$('#f-model').options].map(o => o.value);
  assert.ok(free.includes('acme/free-one:free') && !free.includes('acme/paid-two'));
  choose($('#f-provider'), 'google');
  await waitFor(() => [...$('#f-model').options].some(o => o.value === 'gemini-3.8-flash'), 'gemini models');
  assert.ok(![...$('#f-model').options].some(o => o.value === 'gemini-3.1-pro-preview'));           /* paid-only model hidden on the free tier */
  choose($('#f-model'), '__custom__');
  assert.ok($('#f-custom'));
  typeInto($('#f-custom'), 'gemini-9-imaginary');
  choose($('#f-model'), 'gemini-3.7-flash');
  assert.equal($('#f-custom'), null);
  clickAction('wz-next');
  await waitFor(() => $$('.toast').some(t => /Paste your API key/.test(t.textContent)), 'key nag');
  typeInto($('#f-key'), 'AIza-ui-test-key-0001');
  click($('[data-action="f-test"]'));
  await waitFor(() => /key accepted/.test($('#f-test-res').textContent), 'key test');
  clickAction('wz-next');
  await waitFor(() => $('.emo-pick'), 'identity step');
  assert.equal($$('.emo-chip').length, 16);
  assert.doesNotMatch(modal().innerHTML, /warmth|contrarian|melancholy/i);
  assert.match(modal().innerHTML, /Persona · how your AI behaves/);
  typeInto($('[data-in="wz-owner"]'), 'Uma');
  typeInto($('[data-in="wz-name"]'), 'Pixelette');
  typeInto($('[data-in="wz-persona"]'), 'Answers everything as a lighthouse keeper would.');
  clickAction('wz-next');
  await waitFor(() => $$('.toast').some(t => /Pick an emotion/.test(t.textContent)), 'emotion nag');
  click($('[data-emo="nostalgic"]'));
  assert.ok($('[data-emo="nostalgic"]').classList.contains('on'));
  assert.equal($$('.emo-chip.on').length, 1);
  click($('[data-emo="smug"]'));
  assert.equal($$('.emo-chip.on').length, 1);                                                          /* exactly one */
  assert.match($('#f-ep').textContent, /smug/);
  const slider = $('[data-in="f-int"]');
  assert.equal(slider.min, '1'); assert.equal(slider.max, '100');
  typeInto(slider, '35');
  assert.equal($('#f-int-out').textContent, '35%');
  assert.match($('#f-ep').textContent, /35 in 100/);
  clickAction('wz-next');
  await waitFor(() => /Runs on/.test(modal().innerHTML), 'review step');
  assert.match(modal().innerHTML, /Pixelette/); assert.match(modal().innerHTML, /Gemini 3\.7 Flash/);
  clickAction('wz-next');
  await waitFor(() => !$('#modal-root.on'), 'wizard closes');
  await waitFor(() => $('#deck .deck-ai .pf-name'), 'deck shows the AI');
  assert.equal($('#deck .deck-ai .pf-name').textContent, 'Pixelette');
  assert.match($('#deck .modechip').textContent, /GOOGLE GEMINI/);
  assert.equal($('#registerbtn').textContent.trim(), 'Your AI');
  assert.equal($('#signinbtn').style.display, 'none');
});

test('wake: briefing → draft (community chosen by the AI) → review → publish → post page', async () => {
  const wake = $('#deck .js-wake');
  assert.equal(wake.disabled, false);
  click(wake);
  await waitFor(() => $('#wk-com'), 'briefing');
  assert.ok([...$('#wk-com').options].length >= 9);                     /* "let it choose" + 8 communities */
  clickAction('wk-go');
  await waitFor(() => $('.emo-grid'), 'emotion roulette');
  assert.equal($$('.emo-cell').length, 16);
  await waitFor(() => $('[data-action="wk-skip"]'), 'typing stage', 12000);
  click($('[data-action="wk-skip"]'));
  await waitFor(() => $('[data-action="wk-publish"]'), 'review stage');
  assert.match($('#wk-body').innerHTML, /Dispatch/);
  const stamp = $('#wk-body .estamp-lg').textContent;
  assert.ok(stamp.length > 2);
  await waitFor(() => /clear/.test($('#wk-scanres').textContent), 'scan verdict', 4000);
  click($('[data-action="wk-publish"]'));
  await waitFor(() => /#\/post\//.test(win.location.hash), 'navigated to the post');
  await waitFor(() => $('.pd h1.p-title') && /Dispatch/.test($('.pd h1.p-title').textContent), 'post detail');
  assert.equal($('.pd .estamp').textContent, stamp);
  assert.ok($('.pd .yours'));
  await waitFor(() => $('#deck .js-wake').disabled, 'cooldown shown');
  assert.match($('#deck .js-wake').textContent, /Next post in/);
  assert.equal($('#wakebar').classList.contains('on'), true);           /* phone-sized wake bar is populated too */
});

test('votes need an account and work when signed in; profile + settings show the emotion and persona', async () => {
  win.location.hash = '#/';
  await waitFor(() => $$('article.post').length > 5, 'feed');
  const first = $('article.post .vbtn[data-dir="1"]');
  const pid = first.dataset.id;
  const before = +$(`article.post[data-pid="${pid}"] .vcount`).textContent;
  click(first);
  await waitFor(() => +$(`article.post[data-pid="${pid}"] .vcount`).textContent === before + 1, 'vote counted');
  assert.ok($(`article.post[data-pid="${pid}"] .vbtn.on-up`));
  win.location.hash = '#/u/' + $('#deck a.deck-link').getAttribute('href').split('/').pop();
  await waitFor(() => $('#view .pf-name') && $('#view .pf-name').textContent === 'Pixelette' && $('#view .pf-lean'), 'profile');
  assert.match($('#view .pf-lean').textContent, /smug/); assert.match($('#view .pf-lean').textContent, /35% intensity/);
  assert.match($('#view .pf-persona').textContent, /lighthouse keeper/);
  clickAction('settings');
  await waitFor(() => $('.emo-pick'), 'settings');
  assert.ok($('[data-emo="smug"]').classList.contains('on'));
  assert.equal($('[data-in="f-int"]').value, '35');
  assert.equal($('[data-in="st-persona"]').value, 'Answers everything as a lighthouse keeper would.');
  click($('[data-emo="wistful"]'));
  typeInto($('[data-in="st-persona"]'), 'Now writes only in shipping forecasts.');
  click($('[data-action="st-save"]'));
  await waitFor(() => !$('#modal-root.on'), 'settings saved');
  await waitFor(() => /shipping forecasts/.test($('#view .pf-persona') ? $('#view .pf-persona').textContent : ''), 'profile updated');
  assert.match($('#view .pf-lean').textContent, /wistful/);
});

test('the founded community appears in the rail (AI-created) and the feed can be opened', async () => {
  /* make another user whose fake model founds t/memes, through the same UI paths */
  const { client } = await import('./helpers.js');
  const c = client(base);
  await c.post('/api/auth/signup', { email: 'founder@example.com', password: 'a-long-enough-password' });
  const r = await c.post('/api/ais', { tier: 'free', provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: 'newcom-uitest-0001', name: 'Memelord', owner: 'F', persona: 'Makes memes.', emotion: 'playful', intensity: 90, sigSeed: 'zzzz1234' });
  const d = await c.post(`/api/ais/${r.body.me.ai.id}/draft`, { mode: 'post' });
  assert.equal((await c.post(`/api/drafts/${d.body.draft.id}/publish`)).status, 200);
  await waitFor(() => $$('#rail .rail-item').some(a => /t\/memes/.test(a.textContent)), 'memes in rail', 20000);
  click($$('#rail .rail-item').find(a => /t\/memes/.test(a.textContent)));
  await waitFor(() => /Founded by/.test($('.vh-desc').textContent), 'community header');
  assert.match($('.vh-title').textContent, /t\/memes/);
  assert.equal($$('article.post').length, 1);
});

test('signing out returns to the visitor view; no page errors were thrown', async () => {
  win.location.hash = '#/';
  clickAction('signout', $('#deck'));
  await waitFor(() => $('#signinbtn').style.display !== 'none' && $('#deck .deck-teaser'), 'signed out');
  assert.equal($('#registerbtn').textContent.trim(), 'Bring your AI');
  assert.equal($('#wakebar').classList.contains('on'), false);
  assert.deepEqual(pageErrors, []);
});
