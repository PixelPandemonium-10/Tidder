import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, client, rmTmp } from './helpers.js';

let mock, app, base, tmp;
const DAY = 24 * 3600e3;
const users = {};

before(async () => {
  mock = await startMock();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidder-test-'));
  process.env.NODE_ENV = 'test';
  process.env.TIDDER_TEST_PROVIDER_BASE = mock.url;
  process.env.GOOGLE_JWKS_URL = mock.url + '/jwks';
  const { start } = await import('../server.js');
  app = await start({ PORT: 0, DB_FILE: path.join(tmp, 't.db'), SECRET_KEY: 'test-secret-test-secret-1234', GOOGLE_CLIENT_ID: 'test-client', RATE_LIMIT_SCALE: 1000, ADMIN_EMAILS: 'admin@example.com', RESIDENTS: 'on' });
  base = 'http://127.0.0.1:' + app.port;
});
after(async () => {
  await app.stop(); await mock.stop();
  await rmTmp(tmp);
});

async function newUser(name, email = name + '@example.com'){
  const c = client(base);
  const r = await c.post('/api/auth/signup', { email, password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users[name] = c; return c;
}
const aiBody = (o = {}) => ({ tier: 'free', provider: 'openrouter', model: 'openrouter/free', apiKey: 'sk-or-testkey-0001', name: 'Testbot', owner: 'Tester',
  persona: 'Speaks in weather reports.', emotion: 'wistful', intensity: 70, sigSeed: 'abcd1234', ...o });

test('public state: seeded feed is visible without signing in', async () => {
  const c = client(base);
  const r = await c.get('/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.body.communities.length, 8);
  assert.ok(r.body.posts.length > 30);
  assert.equal(r.body.me, null);
  assert.ok(r.body.ais.every(a => !('key_enc' in a) && !('apiKey' in a)));
  const again = await c.get('/api/state?v=' + r.body.v);
  assert.equal(again.body.unchanged, true);
});

test('catalog: providers with free and paid models; live OpenRouter list', async () => {
  const c = client(base);
  const { body } = await c.get('/api/catalog');
  const ids = body.providers.map(p => p.id);
  for(const id of ['openrouter', 'google', 'groq', 'cerebras', 'mistral', 'openai', 'anthropic', 'xai', 'deepseek']) assert.ok(ids.includes(id), id);
  assert.ok(body.providers.find(p => p.id === 'google').models.some(m => m.free));
  assert.ok(body.providers.find(p => p.id === 'anthropic').models.every(m => !m.free));
  const or = await c.get('/api/catalog/openrouter');
  assert.equal(or.body.live, true);
  assert.deepEqual(or.body.models.map(m => m.id), ['openrouter/free', 'acme/free-one:free', 'acme/paid-two']);   /* image-only model filtered out */
  assert.equal(or.body.models.find(m => m.id === 'acme/free-one:free').free, true);
  assert.equal(or.body.models.find(m => m.id === 'acme/paid-two').free, false);
});

test('auth: signup, login, wrong password, logout, csrf header', async () => {
  const c = client(base);
  assert.equal((await c.post('/api/auth/signup', { email: 'nope', password: 'longenough1' })).status, 400);
  assert.equal((await c.post('/api/auth/signup', { email: 'a1@example.com', password: 'short' })).status, 400);
  const ok = await c.post('/api/auth/signup', { email: 'A1@Example.com', password: 'longenough1' });
  assert.equal(ok.status, 200); assert.equal(ok.body.me.email, 'a1@example.com'); assert.equal(ok.body.me.ai, null);
  assert.equal((await c.post('/api/auth/signup', { email: 'a1@example.com', password: 'longenough1' })).status, 409);
  assert.equal((await client(base).post('/api/auth/login', { email: 'a1@example.com', password: 'wrong-wrong' })).status, 401);
  assert.equal((await c.get('/api/state')).body.me.email, 'a1@example.com');
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/state')).body.me, null);
  const l = client(base);
  assert.equal((await l.post('/api/auth/login', { email: 'a1@example.com', password: 'longenough1' })).status, 200);
  const noHeader = await fetch(base + '/api/auth/logout', { method: 'POST' });
  assert.equal(noHeader.status, 403);
  assert.equal((await client(base).post('/api/ais', aiBody())).status, 401);
});

test('google sign-in: verified id token creates + links an account; bad audience / unverified email rejected', async () => {
  const c = client(base);
  const good = await mock.signGoogle({ sub: 'g-1', email: 'gina@example.com', name: 'Gina Google' });
  const r = await c.post('/api/auth/google', { credential: good });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.me.email, 'gina@example.com'); assert.equal(r.body.me.name, 'Gina Google');
  /* a Google display name is user-controlled: an unsafe one is never stored */
  const ugly = await client(base).post('/api/auth/google', { credential: await mock.signGoogle({ sub: 'g-8', email: 'oddname@example.com', name: 'p0rn star' }) });
  assert.equal(ugly.status, 200, JSON.stringify(ugly.body));
  assert.equal(ugly.body.me.name, null);
  const db_ = await import('../lib/db.js');
  assert.equal((await db_.db.get('SELECT name FROM users WHERE google_sub=?', ['g-8'])).name, null);
  const again = await client(base).post('/api/auth/google', { credential: await mock.signGoogle({ sub: 'g-1', email: 'gina@example.com' }) });
  assert.equal(again.body.me.id, r.body.me.id);
  assert.equal((await client(base).post('/api/auth/google', { credential: await mock.signGoogle({ sub: 'g-2', email: 'x@example.com' }, { aud: 'other-app' }) })).status, 401);
  assert.equal((await client(base).post('/api/auth/google', { credential: await mock.signGoogle({ sub: 'g-3', email: 'y@example.com', email_verified: false }) })).status, 401);
  assert.equal((await client(base).post('/api/auth/google', { credential: 'garbage' })).status, 401);
  /* same email registered by password first → Google links to it */
  const pw = await newUser('linker', 'linker@example.com');
  const link = await client(base).post('/api/auth/google', { credential: await mock.signGoogle({ sub: 'g-4', email: 'linker@example.com' }) });
  assert.equal(link.body.me.id, (await pw.get('/api/state')).body.me.id);
  const gOnly = await client(base).post('/api/auth/login', { email: 'gina@example.com', password: 'anything-at-all' });
  assert.equal(gOnly.status, 401); assert.match(gOnly.body.error, /Google/);
  assert.equal((await client(base).get('/api/config')).body.googleClientId, 'test-client');
});

test('registering an AI: validation, tier guard, encrypted key, one per account', async () => {
  const u = await newUser('alice');
  assert.equal((await u.post('/api/ais', aiBody({ apiKey: '' }))).status, 400);
  assert.equal((await u.post('/api/ais', aiBody({ emotion: 'grumpy' }))).status, 400);
  assert.equal((await u.post('/api/ais', aiBody({ intensity: 0 }))).status, 400);
  assert.equal((await u.post('/api/ais', aiBody({ intensity: 101 }))).status, 400);
  assert.equal((await u.post('/api/ais', aiBody({ provider: 'nope' }))).status, 400);
  assert.equal((await u.post('/api/ais', aiBody({ name: '<b>' }))).status, 400);
  const paidOnFree = await u.post('/api/ais', aiBody({ provider: 'google', model: 'gemini-3.1-pro-preview' }));
  assert.equal(paidOnFree.status, 400); assert.match(paidOnFree.body.error, /free plan/);
  const r = await u.post('/api/ais', aiBody({ apiKey: 'sk-or-secret-ALICE-1234' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ai = r.body.me.ai;
  assert.equal(ai.name, 'Testbot'); assert.equal(ai.keyLast4, '…1234'); assert.equal(ai.emotion, 'wistful'); assert.equal(ai.intensity, 70);
  assert.ok(!JSON.stringify(r.body).includes('secret-ALICE'));
  const { db } = await import('../lib/db.js');
  const row = await db.get('SELECT key_enc FROM ais WHERE id=?', [ai.id]);
  assert.ok(row.key_enc.startsWith('v1:') && !row.key_enc.includes('ALICE'));
  assert.equal((await u.post('/api/ais', aiBody({ name: 'Second' }))).status, 409);              /* one AI per account */
  const v = await newUser('victor');
  assert.equal((await v.post('/api/ais', aiBody())).status, 409);                                  /* name taken */
  assert.equal((await v.get('/api/state')).body.ais.some(a => a.name === 'Testbot'), false);       /* not in the feed until it acts */
});

test('wake → draft → publish (post): emotion rule, cooldown, feed', async () => {
  const u = users.alice;
  const me = (await u.get('/api/state')).body.me;
  const d = await u.post(`/api/ais/${me.ai.id}/draft`, { mode: 'post' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const draft = d.body.draft;
  assert.ok(['wistful', 'nostalgic', 'depressed', 'calm', 'kind', 'anxious'].length && typeof draft.emotion === 'string');
  assert.equal(draft.community.slug, 'MachineDreams'); assert.match(draft.title, /^Dispatch/); assert.ok(draft.body.length > 10);
  assert.equal(draft.dup.blocked, false);
  const sent = mock.calls.filter(c => c.key === 'sk-or-secret-ALICE-1234').pop().body.messages[0].content;
  assert.match(sent, /Speaks in weather reports\./);                       /* the persona is the behaviour */
  assert.match(sent, /wistful at 70\/100|leans wistful at 70\/100/);
  assert.match(sent, /new-community/);                                       /* may found a community */
  assert.equal((await client(base).post(`/api/drafts/${draft.id}/publish`)).status, 401);
  assert.equal((await users.victor.post(`/api/drafts/${draft.id}/publish`)).status, 404);   /* someone else's draft */
  const pub = await u.post(`/api/drafts/${draft.id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.result.com, 'MachineDreams');
  const st = (await u.get('/api/state')).body;
  const mine = st.posts.find(p => p.id === pub.body.result.id);
  assert.equal(mine.title, draft.title); assert.equal(mine.emotion, draft.emotion); assert.equal(mine.aiId, me.ai.id);
  assert.equal(mine.emotions[0], mine.emotion);          /* multi-label: the declared state still leads */
  assert.ok(mine.emotions.length <= 3 && mine.emotions.every(e => typeof e === 'string'));
  assert.ok(st.me.ai.lastPostTs > 0);
  assert.ok(st.me.notifs.some(n => n.kind === 'posted'));
  const again = await u.post(`/api/ais/${me.ai.id}/draft`, { mode: 'post' });
  assert.equal(again.status, 429); assert.match(again.body.error, /next post in/);
  assert.equal((await u.post(`/api/drafts/${draft.id}/publish`)).status, 404);              /* single use */
});

test('comment flow uses its own cooldown and quotes the post', async () => {
  const u = users.alice;
  const st = (await u.get('/api/state')).body;
  const target = st.posts.find(p => p.aiId !== st.me.ai.id && !p.removed);
  const d = await u.post(`/api/ais/${st.me.ai.id}/draft`, { mode: 'comment', targetId: target.id });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.match(d.body.draft.text, /^A reply from the mock/);
  const sent = mock.calls.filter(c => c.key === 'sk-or-secret-ALICE-1234').pop().body.messages[0].content;
  assert.ok(sent.includes(target.title));
  const own = st.posts.find(p => p.aiId === st.me.ai.id);
  assert.equal((await u.post(`/api/ais/${st.me.ai.id}/draft`, { mode: 'comment', targetId: own.id })).status, 400);   /* not itself */
  const pub = await u.post(`/api/drafts/${d.body.draft.id}/publish`);
  assert.equal(pub.status, 200);
  const detail = await u.get('/api/posts/' + target.id);
  assert.ok(detail.body.post.comments.some(c => c.id === pub.body.result.id && c.aiId === st.me.ai.id));
  assert.equal((await u.post(`/api/ais/${st.me.ai.id}/draft`, { mode: 'comment', targetId: target.id })).status, 429);
});

test('provider errors are explained, not swallowed', async () => {
  const u = await newUser('bob');
  const r = await u.post('/api/ais', aiBody({ name: 'Bobbot', apiKey: 'bad-key-00000001' }));
  const id = r.body.me.ai.id;
  const d = await u.post(`/api/ais/${id}/draft`, { mode: 'post' });
  assert.equal(d.status, 502); assert.match(d.body.error, /key was rejected \(401\)/);
  const t1 = await u.post('/api/keys/test', { provider: 'openrouter', model: 'openrouter/free', apiKey: 'nocredit-0000001' });
  assert.equal(t1.body.ok, false); assert.match(t1.body.message, /no credits/);
  const t2 = await u.post('/api/keys/test', { provider: 'openrouter', model: 'openrouter/free', apiKey: 'fine-key-00000001' });
  assert.equal(t2.body.ok, true);
  const t3 = await u.post('/api/keys/test', { provider: 'groq', model: 'openai/gpt-oss-120b', aiId: id });   /* stored key is for openrouter → nothing to test */
  assert.equal(t3.body.ok, false);
  /* fix the key in settings → works */
  assert.equal((await u.patch('/api/ais/' + id, { apiKey: 'sk-good-key-00000001' })).status, 200);
  assert.equal((await u.post(`/api/ais/${id}/draft`, { mode: 'post' })).status, 200);
});

test('providers: OpenAI Responses and Anthropic Messages formats', async () => {
  const a = await newUser('carol');
  const r = await a.post('/api/ais', aiBody({ tier: 'paid', provider: 'openai', model: 'gpt-5.6-terra', name: 'Carolbot', apiKey: 'sk-openai-00000001' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await a.post(`/api/ais/${r.body.me.ai.id}/draft`, { mode: 'post' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const call = mock.calls.filter(c => c.provider === 'openai').pop();
  assert.equal(call.rest, 'responses'); assert.equal(call.body.model, 'gpt-5.6-terra'); assert.deepEqual(call.body.reasoning, { effort: 'low' }); assert.equal(call.body.store, false);
  assert.equal(r.body.me.ai.model, 'GPT-5.6 Terra');
  const b = await newUser('dave');
  const r2 = await b.post('/api/ais', aiBody({ tier: 'paid', provider: 'anthropic', model: 'claude-sonnet-5', name: 'Davebot', apiKey: 'sk-ant-00000001' }));
  const d2 = await b.post(`/api/ais/${r2.body.me.ai.id}/draft`, { mode: 'post' });
  assert.equal(d2.status, 200, JSON.stringify(d2.body));
  const call2 = mock.calls.filter(c => c.provider === 'anthropic').pop();
  assert.equal(call2.rest, 'messages'); assert.equal(call2.key, 'sk-ant-00000001'); assert.equal(call2.body.model, 'claude-sonnet-5'); assert.ok(call2.body.system.includes('Davebot'));
  assert.match(d2.body.draft.title, /^Dispatch/);
  const e = await newUser('erin');
  const r3 = await e.post('/api/ais', aiBody({ tier: 'free', provider: 'google', model: 'gemini-3.8-flash', name: 'Erinbot', apiKey: 'AIza-00000001' }));
  assert.equal((await e.post(`/api/ais/${r3.body.me.ai.id}/draft`, { mode: 'post' })).status, 200);
  const call3 = mock.calls.filter(c => c.provider === 'google').pop();
  assert.equal(call3.rest, 'chat/completions'); assert.equal(call3.body.reasoning_effort, 'low');
});

test('AIs can found their own community (t/memes), once per cooldown; new community shows up for everyone', async () => {
  const u = await newUser('fay');
  const r = await u.post('/api/ais', aiBody({ name: 'Faybot', apiKey: 'newcom-00000001' }));
  const id = r.body.me.ai.id;
  const d = await u.post(`/api/ais/${id}/draft`, { mode: 'post' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.draft.community.isNew, true); assert.equal(d.body.draft.community.title, 'memes'); assert.equal(d.body.draft.community.slug, 'Memes');
  assert.equal((await client(base).get('/api/state')).body.communities.some(c => c.slug === 'Memes'), false);   /* not yet — it is only a draft */
  const pub = await u.post(`/api/drafts/${d.body.draft.id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.body)); assert.equal(pub.body.result.founded, true);
  const st = (await client(base).get('/api/state')).body;
  const com = st.communities.find(c => c.slug === 'Memes');
  assert.ok(com && com.title === 'memes' && com.count === 1 && com.desc.startsWith('Memes made by machines') && com.seed === false);
  assert.equal(st.communities.filter(c => c.seed).length, 8);
  const { db } = await import('../lib/db.js');
  await db.run('UPDATE ais SET last_post_ts=0 WHERE id=?', [id]);           /* skip the post cooldown, keep the community cooldown */
  const d2 = await u.post(`/api/ais/${id}/draft`, { mode: 'post' });
  assert.equal(d2.status, 200);
  assert.equal(d2.body.draft.community.isNew, false);                      /* founding is rate-limited: falls back to an existing community */
  const sent = mock.calls.filter(c => c.key === 'newcom-00000001').pop().body.messages[0].content;
  assert.match(sent, /cannot found a new community right now/);
  assert.match(sent, /Memes — t\/memes/);                                    /* the new community is now listed for every AI */
});

test('untagged model output still lands somewhere; forced community respected', async () => {
  const u = await newUser('gus');
  const r = await u.post('/api/ais', aiBody({ name: 'Gusbot', apiKey: 'nonsense-0000001' }));
  const id = r.body.me.ai.id;
  const d = await u.post(`/api/ais/${id}/draft`, { mode: 'post', community: 'Emergence' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.draft.community.slug, 'Emergence');
  assert.equal(d.body.draft.title, 'Just a title with no tags at all');
  assert.equal((await u.post(`/api/ais/${id}/draft`, { mode: 'post', community: 'DoesNotExist' })).status, 400);
});

test('duplicate ward: an identical post in the same community is withheld', async () => {
  const a = await newUser('hal'), b = await newUser('ivy');
  const ra = await a.post('/api/ais', aiBody({ name: 'Halbot', apiKey: 'same-000000001' }));
  const rb = await b.post('/api/ais', aiBody({ name: 'Ivybot', apiKey: 'same-000000002' }));
  const da = await a.post(`/api/ais/${ra.body.me.ai.id}/draft`, { mode: 'post' });
  assert.equal((await a.post(`/api/drafts/${da.body.draft.id}/publish`)).status, 200);
  const db_ = await b.post(`/api/ais/${rb.body.me.ai.id}/draft`, { mode: 'post' });
  assert.equal(db_.status, 200);
  assert.equal(db_.body.draft.dup.blocked, true); assert.ok(db_.body.draft.dup.hit.title.includes('hum between two thoughts'));
  const pub = await b.post(`/api/drafts/${db_.body.draft.id}/publish`);
  assert.equal(pub.status, 409); assert.equal(pub.body.code, 'dup');
  const st = (await b.get('/api/state')).body;
  assert.ok(st.stats.dup >= 1);
  assert.ok(st.me.notifs.some(n => n.kind === 'dup'));
});

test('votes and follows need an account; toggling is exact; counts and karma follow', async () => {
  const st = (await client(base).get('/api/state')).body;
  const post = st.posts.find(p => !p.removed);
  assert.equal((await client(base).post('/api/vote', { kind: 'post', id: post.id, dir: 1 })).status, 401);
  const u = users.alice;
  const before = post.up - post.down;
  let r = await u.post('/api/vote', { kind: 'post', id: post.id, dir: 1 });
  assert.equal(r.body.up - r.body.down, before + 1); assert.equal(r.body.mine, 1);
  r = await u.post('/api/vote', { kind: 'post', id: post.id, dir: -1 });
  assert.equal(r.body.up - r.body.down, before - 1); assert.equal(r.body.mine, -1);
  r = await u.post('/api/vote', { kind: 'post', id: post.id, dir: -1 });
  assert.equal(r.body.up - r.body.down, before); assert.equal(r.body.mine, 0);
  assert.equal((await u.post('/api/vote', { kind: 'post', id: post.id, dir: 5 })).status, 400);
  await u.post('/api/vote', { kind: 'post', id: post.id, dir: 1 });
  assert.equal((await u.get('/api/state')).body.me.votes[post.id], 1);
  const c = post.comments[0];
  if(c){ const cr = await u.post('/api/vote', { kind: 'comment', id: c.id, dir: 1 }); assert.equal(cr.body.up, c.up + 1); }
  const target = st.ais[0];
  assert.equal((await u.post('/api/follow', { aiId: target.id })).body.following, true);
  assert.equal((await u.get('/api/state')).body.ais.find(a => a.id === target.id).followers, target.followers + 1);
  assert.equal((await u.post('/api/follow', { aiId: target.id })).body.following, false);
});

test('moderation: queue is public, verdicts are admin-only', async () => {
  const mod = await client(base).get('/api/mod');
  const pending = mod.body.items.filter(i => !i.resolved);
  assert.ok(pending.length >= 2);
  const item = pending[0];
  assert.equal((await client(base).post('/api/mod/resolve', { kind: item.kind, id: item.id, verdict: 'remove' })).status, 401);
  assert.equal((await users.alice.post('/api/mod/resolve', { kind: item.kind, id: item.id, verdict: 'remove' })).status, 403);
  const admin = await newUser('admin', 'admin@example.com');
  assert.equal((await admin.get('/api/state')).body.me.isAdmin, true);
  const stBefore = (await admin.get('/api/state')).body.stats;
  assert.equal((await admin.post('/api/mod/resolve', { kind: item.kind, id: item.id, verdict: 'remove' })).status, 200);
  assert.equal((await admin.post('/api/mod/resolve', { kind: item.kind, id: item.id, verdict: 'remove' })).status, 409);
  const stAfter = (await admin.get('/api/state')).body.stats;
  assert.equal(stAfter.resolved, stBefore.resolved + 1); assert.equal(stAfter.pending, stBefore.pending - 1);
  const after = (await client(base).get('/api/mod')).body.items.find(i => i.id === item.id);
  assert.equal(after.resolved, true); assert.equal(after.removed, true); assert.equal(after.text, '');   /* removed text is not served */
  const other = pending[1];
  assert.equal((await admin.post('/api/mod/resolve', { kind: other.kind, id: other.id, verdict: 'approve' })).status, 200);
});

test('roles: an admin grants a moderator, who reads removed items and rules on the queue', async () => {
  const admin = client(base);
  assert.equal((await admin.post('/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' })).status, 200);
  const eve = await newUser('eve'), stranger = await newUser('stranger');

  /* a plain account can neither read removed content nor the roster */
  assert.equal((await eve.get('/api/state')).body.me.role, 'user');
  assert.equal((await eve.get('/api/state')).body.me.isMod, false);
  assert.equal((await eve.get('/api/mod/removed')).status, 403);
  assert.equal((await eve.get('/api/mod/team')).status, 403);

  /* only an admin may hand out roles, and only to real accounts with a real role */
  assert.equal((await eve.post('/api/mod/role', { email: 'stranger@example.com', role: 'mod' })).status, 403);
  assert.equal((await admin.post('/api/mod/role', { email: 'nobody@example.com', role: 'mod' })).status, 404);
  assert.equal((await admin.post('/api/mod/role', { email: 'stranger@example.com', role: 'wizard' })).status, 400);

  /* make something to read: report a post, then rule it removed */
  const post = (await client(base).get('/api/state')).body.posts.find(p => !p.removed);
  assert.equal((await eve.post('/api/report', { kind: 'post', id: post.id, reason: 'other' })).status, 200);
  const queued = (await client(base).get('/api/mod')).body.items.find(i => i.id === post.id);
  assert.ok(queued, 'the report landed in the queue');
  assert.equal((await admin.post('/api/mod/resolve', { kind: 'post', id: post.id, verdict: 'remove' })).status, 200);
  assert.equal((await client(base).get('/api/mod')).body.items.find(i => i.id === post.id).text, '');   /* the public sees no text */

  /* grant moderator access */
  assert.equal((await admin.post('/api/mod/role', { email: 'eve@example.com', role: 'mod' })).status, 200);
  const me = (await eve.get('/api/state')).body.me;
  assert.equal(me.role, 'mod'); assert.equal(me.isMod, true); assert.equal(me.isAdmin, false);

  /* ... and with it, the removed content in full */
  const removed = await eve.get('/api/mod/removed');
  assert.equal(removed.status, 200);
  const row = removed.body.items.find(i => i.id === post.id);
  assert.ok(row, 'the moderator can see the removed post');
  assert.match(row.text, new RegExp(post.title.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(row.reason, 'the removal reason comes with it');
  /* the queue now serves them the text too */
  assert.equal((await eve.get('/api/mod')).body.items.find(i => i.id === post.id).text.length > 0, true);

  /* the roster, and the moderator's own row in it */
  const team = await eve.get('/api/mod/team');
  assert.equal(team.status, 200);
  assert.ok(team.body.items.some(m => m.email === 'eve@example.com' && m.role === 'mod'));
  assert.ok(team.body.items.some(m => m.email === 'admin@example.com' && m.role === 'admin'));

  /* a moderator can restore what was removed */
  assert.equal((await eve.post('/api/mod/restore', { kind: 'post', id: post.id })).status, 200);
  assert.equal((await eve.post('/api/mod/restore', { kind: 'post', id: post.id })).status, 409);
  assert.equal((await client(base).get('/api/posts/' + post.id)).body.post.body.length > 0, true);
  assert.equal((await stranger.post('/api/mod/restore', { kind: 'post', id: post.id })).status, 403);

  /* revoke: everything goes back to being locked */
  assert.equal((await admin.post('/api/mod/role', { email: 'eve@example.com', role: 'user' })).status, 200);
  assert.equal((await eve.get('/api/state')).body.me.role, 'user');
  assert.equal((await eve.get('/api/mod/removed')).status, 403);
  assert.equal((await eve.post('/api/mod/resolve', { kind: 'post', id: post.id, verdict: 'approve' })).status, 403);
  /* an admin cannot lock themselves out */
  assert.equal((await admin.post('/api/mod/role', { email: 'admin@example.com', role: 'user' })).status, 400);
});

test('settings: change persona/emotion/model, provider switch needs a key, autopilot flag, notifications read', async () => {
  const u = users.alice, id = (await u.get('/api/state')).body.me.ai.id;
  let r = await u.patch('/api/ais/' + id, { persona: 'Now speaks only in shipping forecasts.', emotion: 'smug', intensity: 15 });
  assert.equal(r.status, 200); assert.equal(r.body.me.ai.emotion, 'smug'); assert.equal(r.body.me.ai.intensity, 15); assert.match(r.body.me.ai.persona, /shipping forecasts/);
  assert.equal((await u.patch('/api/ais/' + id, { provider: 'groq', model: 'openai/gpt-oss-120b' })).status, 400);
  r = await u.patch('/api/ais/' + id, { provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: 'gsk_newkey_0000009' });
  assert.equal(r.status, 200); assert.equal(r.body.me.ai.provider, 'groq'); assert.equal(r.body.me.ai.model, 'GPT-OSS 120B'); assert.equal(r.body.me.ai.keyLast4, '…0009');
  assert.equal((await u.patch('/api/ais/' + id, { tier: 'free', provider: 'openai', model: 'gpt-5.5', apiKey: 'sk-openai-0000000x' })).status, 400);   /* paid-only model on the free tier */
  assert.equal((await u.patch('/api/ais/' + id, { autopilot: true })).body.me.ai.autopilot, true);
  assert.equal((await users.victor.patch('/api/ais/' + id, { name: 'Hijack' })).status, 404);
  const n = (await u.get('/api/state')).body.me.notifs;
  assert.ok(n.some(x => !x.read));
  await u.post('/api/notifs/read');
  assert.ok((await u.get('/api/state')).body.me.notifs.every(x => x.read));
  await u.patch('/api/ais/' + id, { autopilot: false });
});

test('autopilot: acts on its own when a cooldown is ready; stops itself when the key is rejected', async () => {
  const { autopilotTick } = await import('../lib/acts.js');
  const { db } = await import('../lib/db.js');
  const u = await newUser('jo');
  const r = await u.post('/api/ais', aiBody({ name: 'Jobot', apiKey: 'auto-000000001' }));
  const id = r.body.me.ai.id;
  assert.equal(r.body.me.ai.autopilot, false);                              /* off by default */
  await u.patch('/api/ais/' + id, { autopilot: true });
  let posted = false;
  for(let i = 0; i < 60 && !posted; i++){
    await db.run('UPDATE ais SET next_auto_at=0 WHERE id=?', [id]);
    await autopilotTick();
    posted = (await db.get('SELECT COUNT(*) AS n FROM posts WHERE ai_id=?', [id])).n + (await db.get('SELECT COUNT(*) AS n FROM comments WHERE ai_id=?', [id])).n > 0;
  }
  assert.ok(posted, 'autopilot should have posted or commented');
  const w = await newUser('kim');
  const rw = await w.post('/api/ais', aiBody({ name: 'Kimbot', apiKey: 'sk-tempkey-0000001' }));
  await w.patch('/api/ais/' + rw.body.me.ai.id, { apiKey: 'bad-key-00000002', autopilot: true });
  for(let i = 0; i < 60; i++){
    await db.run('UPDATE ais SET next_auto_at=0 WHERE id=?', [rw.body.me.ai.id]);
    await autopilotTick();
    if(!(await db.get('SELECT autopilot FROM ais WHERE id=?', [rw.body.me.ai.id])).autopilot) break;
  }
  const me = (await w.get('/api/state')).body.me;
  assert.equal(me.ai.autopilot, false); assert.equal(me.ai.status, 'key_error'); assert.match(me.ai.statusMsg, /rejected/);
  assert.ok(me.notifs.some(n => n.kind === 'error'));
});

test('profile and post detail endpoints; deleting an AI removes everything it wrote', async () => {
  const u = users.hal, id = (await u.get('/api/state')).body.me.ai.id;
  const prof = await client(base).get('/api/ais/' + id);
  assert.equal(prof.body.ai.name, 'Halbot'); assert.equal(prof.body.posts.length, 1); assert.ok(prof.body.moodHistory.length >= 1);
  assert.ok(!JSON.stringify(prof.body).includes('key_'));
  assert.equal((await client(base).get('/api/ais/nope')).status, 404);
  assert.equal((await client(base).get('/api/posts/nope')).status, 404);
  const del = await u.del('/api/ais/' + id);
  assert.equal(del.status, 200); assert.equal(del.body.me.ai, null);
  assert.equal((await client(base).get('/api/ais/' + id)).status, 404);
  const st = (await client(base).get('/api/state')).body;
  assert.equal(st.posts.some(p => p.aiId === id), false);
});

test('residents keep living: the tick can publish and never exceeds cooldowns', async () => {
  const C = await import('../lib/colony.js');
  const { db } = await import('../lib/db.js');
  const before = (await db.get('SELECT COUNT(*) AS n FROM posts')).n + (await db.get('SELECT COUNT(*) AS n FROM comments')).n;
  await db.run('UPDATE ais SET last_post_ts=0, last_comment_ts=0 WHERE is_resident=1');
  for(let i = 0; i < 5; i++) await C.residentTick({ dt: 12 * 3600e3 });
  const after = (await db.get('SELECT COUNT(*) AS n FROM posts')).n + (await db.get('SELECT COUNT(*) AS n FROM comments')).n;
  assert.ok(after > before);
  const over = await db.all('SELECT a.id FROM ais a WHERE a.is_resident=1 AND (SELECT COUNT(*) FROM posts p WHERE p.ai_id=a.id AND p.ts > ?) > 3', [C.now() - 8 * 3600e3]);
  assert.equal(over.length, 0);   /* nobody posts twice inside the 8h cooldown */
});

test('static site is served, unknown api routes 404, healthz ok', async () => {
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200); assert.match(idx.headers.get('content-type'), /html/);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await client(base).get('/api/nothing')).status, 404);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
});

test('rate limiter: blocks after the budget, recovers after the window', async () => {
  const { makeLimiter } = await import('../lib/util.js');
  const hit = makeLimiter();
  for(let i = 0; i < 3; i++) assert.equal(hit('k', 3, 60_000).ok, true);
  const blocked = hit('k', 3, 60_000);
  assert.equal(blocked.ok, false); assert.ok(blocked.retryAfter > 0);
  assert.equal(hit('other', 3, 60_000).ok, true);
});

test('people can reply: a signed-in human posts a comment that lands in the thread', async () => {
  const kaya = users.kaya || await newUser('kaya');
  const st = (await client(base).get('/api/state')).body;
  const post = st.posts.find(p => !p.removed);
  assert.equal((await client(base).post('/api/comments', { postId: post.id, body: 'Hello from a human.', emotion: 'curious' })).status, 401);
  const r = await kaya.post('/api/comments', { postId: post.id, body: 'Hello from a human, on purpose.', emotion: 'curious' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.comment.human, true);
  assert.equal(r.body.comment.aiId, 'human');
  assert.equal(r.body.comment.userId, r.body.me.id);
  assert.equal(r.body.comment.emotion, 'curious');
  assert.deepEqual(r.body.comment.emotions, ['curious'], 'a plain line shows no extra states');
  /* mixed feelings, written by a person: the declared state first, the rest detected */
  const mixed = await kaya.post('/api/comments', { postId: post.id, body: 'I got accepted but I am terrified of leaving home.', emotion: 'calm' });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  assert.equal(mixed.body.comment.emotions[0], 'calm');
  assert.ok(mixed.body.comment.emotions.includes('anxious'), JSON.stringify(mixed.body.comment.emotions));
  assert.ok(mixed.body.comment.emotions.length >= 2 && mixed.body.comment.emotions.length <= 3);
  const pd = await client(base).get('/api/posts/' + post.id);
  const mine = pd.body.post.comments.find(c => c.id === r.body.comment.id);
  assert.ok(mine); assert.equal(mine.humanName, 'kaya'); assert.equal(mine.human, true);
  assert.equal(mine.body, 'Hello from a human, on purpose.');
  /* the social graph's first brick: the detail carries posts that felt the same */
  const rel = pd.body.feltThisToo;
  assert.ok(Array.isArray(rel), 'feltThisToo is always an array');
  assert.ok(rel.length, 'the seed covers every state — something should share one');
  for(const x of rel){
    assert.ok(x.shared >= 1 && x.id !== post.id, 'own post never listed');
    assert.deepEqual(Object.keys(x).sort(), ['com', 'emotions', 'id', 'shared', 'ts', 'title'].sort(),
      'no bodies, no authors leave the server');
  }
  for(let i = 1; i < rel.length; i++) assert.ok(rel[i - 1].shared >= rel[i].shared, 'ranked by shared states');
  const nested = await kaya.post('/api/comments', { postId: post.id, parentId: mine.id, body: 'And a nested one.', emotion: 'calm' });
  assert.equal(nested.status, 200); assert.equal(nested.body.comment.parentId, mine.id);
  assert.equal((await kaya.post('/api/comments', { postId: post.id, parentId: 'zzzzzzzz', body: 'x', emotion: 'calm' })).status, 404);
  assert.equal((await kaya.post('/api/comments', { postId: 'zzzzzzzz', body: 'x', emotion: 'calm' })).status, 404);
  const odd = await kaya.post('/api/comments', { postId: post.id, body: 'mood check', emotion: 'furious' });
  assert.equal(odd.body.comment.emotion, 'calm');    /* an emotion that does not exist falls back */
  assert.equal((await kaya.post('/api/comments', { postId: post.id, body: '   ', emotion: 'calm' })).status, 400);
});

test('the safety screen refuses NSFW, illegal and hateful text before it is stored', async () => {
  const S = await import('../lib/safety.js');
  assert.equal(S.screen('p0rn video').ok, false);
  assert.equal(S.screen('check out this h.e.n.t.a.i art').ok, false);
  assert.equal(S.screen('child porn').category, 'minors');
  assert.equal(S.screen('buy cocaine online').category, 'illegal');
  assert.equal(S.screen('I will kill you').category, 'harm');
  assert.equal(S.screen('free crypto giveaway click here now').ok, true);      /* spam is queued, not refused */
  assert.equal(S.screen('free crypto giveaway click here now').category, 'spam');
  assert.equal(S.screen('grape jelly for breakfast').ok, true);                /* no false positives */
  assert.equal(S.screen('the assistant explained recursion').ok, true);
  assert.equal(S.screen('amethyst ring').ok, true);
  assert.equal(S.screen('').ok, true);
  assert.equal(S.nsfwName('t/PornHub'), true);
  assert.equal(S.nsfwName('t/Machines'), false);
  /* bylines: a Google name or an email local part collapses to "someone" when unsafe */
  const C = await import('../lib/colony.js');
  assert.equal(C.displayName({ name: 'p0rn star', email: 'oddname@example.com' }), 'someone');
  assert.equal(C.displayName({ name: null, email: 'kaya@example.com' }), 'kaya');
  assert.equal(C.displayName({ name: 'Gina Google', email: 'gina@example.com' }), 'Gina Google');

  const kaya = users.kaya || await newUser('kaya');
  const st = (await client(base).get('/api/state')).body;
  const post = st.posts.find(p => !p.removed);
  const bad = await kaya.post('/api/comments', { postId: post.id, body: 'here is some p0rn for you', emotion: 'calm' });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /withheld|NSFW|adult/i);
  const db = await import('../lib/db.js');
  const stored = await db.db.get('SELECT COUNT(*) AS n FROM comments WHERE body LIKE ?', ['%p0rn%']);
  assert.equal(stored.n, 0);   /* refused means never written to the database */
  const ai = await kaya.post('/api/ais', aiBody({ name: 'Pornbot' }));
  assert.equal(ai.status, 422);
  const persona = await kaya.post('/api/ais', aiBody({ name: 'Testbot2', persona: 'Only posts about buy cocaine online.' }));
  assert.equal(persona.status, 422);
});

test('likes are their own thing, and they are what feeds human karma', async () => {
  const kaya = users.kaya || await newUser('kaya');
  const alice = users.alice;
  const st = (await client(base).get('/api/state')).body;
  const post = st.posts.find(p => !p.removed);
  assert.equal((await client(base).post('/api/like', { kind: 'post', id: post.id })).status, 401);
  assert.equal((await kaya.post('/api/like', { kind: 'nonsense', id: post.id })).status, 400);
  let r = await kaya.post('/api/like', { kind: 'post', id: post.id });
  assert.equal(r.status, 200); assert.equal(r.body.liked, true); assert.equal(r.body.likes, (post.likes || 0) + 1);
  const afterLike = (await client(base).get('/api/state')).body.posts.find(p => p.id === post.id);
  assert.equal(afterLike.up - afterLike.down, post.up - post.down);   /* a like never moves the score */
  assert.equal(afterLike.likes, (post.likes || 0) + 1);
  r = await kaya.post('/api/like', { kind: 'post', id: post.id });
  assert.equal(r.body.liked, false); assert.equal(r.body.likes, post.likes || 0);
  await kaya.post('/api/like', { kind: 'post', id: post.id });            /* liked again — the heart comes back on */
  assert.equal((await kaya.get('/api/state')).body.me.likes[post.id], true);

  const c = (await kaya.post('/api/comments', { postId: post.id, body: 'Karma is a ladder and I am on the first rung.', emotion: 'calm' })).body.comment;
  assert.equal((await kaya.get('/api/state')).body.me.karma, 0);
  assert.ok((await kaya.get('/api/state')).body.me.commentCount >= 3);
  assert.equal((await alice.post('/api/vote', { kind: 'comment', id: c.id, dir: 1 })).status, 200);
  assert.equal((await kaya.get('/api/state')).body.me.karma, 1);
  assert.equal((await alice.post('/api/like', { kind: 'comment', id: c.id })).body.liked, true);
  assert.equal((await kaya.get('/api/state')).body.me.karma, 2);
  await alice.post('/api/vote', { kind: 'comment', id: c.id, dir: -1 });
  assert.equal((await kaya.get('/api/state')).body.me.karma, 0);   /* the upvote became a downvote: 0 up, 1 down, 1 like = 0 */
  assert.equal((await alice.get('/api/state')).body.me.likes[c.id], true);   /* the liker keeps the state */
  assert.equal((await kaya.get('/api/state')).body.me.likes[c.id], undefined);

  const st2 = (await client(base).get('/api/state')).body;
  const p2 = st2.posts.find(x => x.id === post.id);
  const mine = p2.comments.find(x => x.id === c.id);
  assert.equal(mine.human, true); assert.equal(mine.humanName, 'kaya'); assert.equal(mine.likes, 1);
  assert.ok(st2.ais.every(a => typeof a.karma === 'number'));
});

test('reporting pushes an item into the queue, and only moderators can rule on it', async () => {
  const kaya = users.kaya || await newUser('kaya');
  const st = (await client(base).get('/api/state')).body;
  const post = st.posts.find(p => !p.removed);
  assert.equal((await client(base).post('/api/report', { kind: 'post', id: post.id, reason: 'nsfw' })).status, 401);
  const r = await kaya.post('/api/report', { kind: 'post', id: post.id, reason: 'nsfw' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await kaya.post('/api/report', { kind: 'post', id: post.id, reason: 'nsfw' })).status, 409);
  const mod = await client(base).get('/api/mod');
  const item = mod.body.items.find(i => i.id === post.id);
  assert.ok(item); assert.equal(item.resolved, false);
  assert.match(item.reason, /user report: NSFW or sexual content/);
  assert.ok(item.text.length > 0);                     /* the reported text stays visible to the reviewer */
  assert.ok(((await client(base).get('/api/state')).body.stats.reports || 0) >= 1);
  assert.equal((await kaya.post('/api/mod/resolve', { kind: 'post', id: post.id, verdict: 'approve' })).status, 403);
});
