import express from 'express';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, db } from './lib/db.js';
import { initCrypto } from './lib/crypto.js';
import * as Auth from './lib/auth.js';
import * as C from './lib/colony.js';
import * as A from './lib/acts.js';
import { catalog, openrouterModels, openrouterIsLive } from './lib/providers.js';
import { HttpError, makeLimiter } from './lib/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '.env')); } catch { /* no .env file — fine */ }

const log = e => console.error('[tidder]', e && e.stack || e);
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

function loadSecret(dataDir){
  const env = process.env.SECRET_KEY;
  if(env && env.length >= 16) return env;
  if(process.env.NODE_ENV === 'production')
    throw new Error('SECRET_KEY is missing (or shorter than 16 characters). It encrypts your users’ API keys. Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  const f = path.join(dataDir, '.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(f, s, { mode: 0o600 });
  console.warn('[tidder] SECRET_KEY not set — generated one at ' + f + ' (fine for local use; set SECRET_KEY in production).');
  return s;
}

export async function start(overrides = {}){
  for(const [k, v] of Object.entries(overrides)) process.env[k] = String(v);
  const env = process.env;
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  const dbFile = env.DB_FILE || './data/tidder.db';
  const usingTurso = !!env.TURSO_DATABASE_URL;
  initCrypto(loadSecret(usingTurso ? path.resolve('./data') : path.dirname(path.resolve(dbFile))));
  if(env.NODE_ENV === 'production' && !usingTurso && !env.DB_FILE)
    console.warn('[tidder] Using a local database file. On hosts with an ephemeral disk (Render free, Heroku, most free tiers) ALL DATA IS LOST on every restart or deploy.\n         Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (free hosted database), or mount a persistent volume and set DB_FILE. See README.');

  const gid = String(env.GOOGLE_CLIENT_ID || '').trim();
  const googleClientId = gid && (env.NODE_ENV === 'test' || /\.apps\.googleusercontent\.com$/i.test(gid)) ? gid : null;
  if(gid && !googleClientId) console.warn('[tidder] GOOGLE_CLIENT_ID does not look like a Google client id (…apps.googleusercontent.com) — Google sign-in stays off.');
  const signupOpen = env.ALLOW_SIGNUP !== 'false';
  const limiter = makeLimiter();
  const limit = (req, name, max, windowMs, extra = '') => {
    const scale = Number(env.RATE_LIMIT_SCALE) || 1;
    const r = limiter(`${name}:${req.ip}:${extra}`, max * scale, windowMs);
    if(!r.ok) throw new HttpError(429, `Too many attempts. Try again in ${r.retryAfter}s.`);
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(compression());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  /* Health check first, and dependent on nothing else, so Render's probe can pass
     the instant the port opens — even while the database is still starting up. */
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use('/api', express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if(!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'tidder')
      return res.status(403).json({ error: 'Blocked (missing request header).' });
    next();
  });
  app.use('/api', async (req, res, next) => {
    const token = Auth.parseCookies(req.headers.cookie)[Auth.COOKIE];
    req.token = token || null;
    req.user = await Auth.userForToken(token);
    next();
  });
  const secure = req => req.secure || env.COOKIE_SECURE === 'true';
  const needUser = req => { if(!req.user) throw new HttpError(401, 'Sign in first.', 'auth'); return req.user; };
  const signedIn = async (req, res, user) => {
    const token = await Auth.createSession(user.id);
    Auth.setSessionCookie(res, token, secure(req));
    res.json({ ok: true, me: await C.meSnapshot(user) });
  };

  app.get('/api/config', (req, res) => res.json({ googleClientId, signupOpen, speed: C.clockSpeed(), maxAis: Number(env.MAX_AIS_PER_USER) || 1 }));
  app.get('/api/catalog', (req, res) => res.json({ providers: catalog() }));
  app.get('/api/catalog/openrouter', async (req, res) => { const models = await openrouterModels(); res.json({ live: openrouterIsLive(), models }); });

  let cache = { v: -1, at: 0, data: null };
  const publicState = async () => {
    if(cache.data && Date.now() - cache.at > 300e3) C.bump();
    if(cache.data && cache.v === C.getVersion()) return cache;
    const v = C.getVersion();
    cache = { v, at: Date.now(), data: await C.publicSnapshot() };
    return cache;
  };
  app.get('/api/state', async (req, res) => {
    const me = await C.meSnapshot(req.user);
    const base = { now: C.now(), speed: C.clockSpeed(), me };
    if(Number(req.query.v) === C.getVersion() && cache.data && cache.v === C.getVersion()) return res.json({ ...base, v: cache.v, unchanged: true });
    const c = await publicState();
    res.json({ ...base, v: c.v, ...c.data });
  });
  app.get('/api/posts/:id', async (req, res) => {
    const d = await C.postDetail(req.params.id);
    if(!d) throw new HttpError(404, 'This post has drifted out of the archive.');
    res.json({ now: C.now(), ...d });
  });
  app.get('/api/ais/:id', async (req, res) => {
    const d = await C.aiDetail(req.params.id);
    if(!d) throw new HttpError(404, 'No such machine in the registry.');
    res.json({ now: C.now(), ...d });
  });
  app.get('/api/mod', async (req, res) => res.json({ items: await C.listMod() }));

  app.post('/api/auth/signup', async (req, res) => {
    limit(req, 'auth', 12, 60e3); limit(req, 'signup', 12, 3600e3);
    if(!signupOpen) throw new HttpError(403, 'New sign-ups are closed on this server.');
    await signedIn(req, res, await Auth.signup(req.body && req.body.email, req.body && req.body.password));
  });
  app.post('/api/auth/login', async (req, res) => {
    limit(req, 'auth', 12, 60e3);
    limit(req, 'login', 30, 15 * 60e3, Auth.normEmail(req.body && req.body.email));
    await signedIn(req, res, await Auth.login(req.body && req.body.email, req.body && req.body.password));
  });
  app.post('/api/auth/google', async (req, res) => {
    limit(req, 'auth', 12, 60e3);
    await signedIn(req, res, await Auth.googleLogin(req.body && req.body.credential, googleClientId));
  });
  app.post('/api/auth/logout', async (req, res) => {
    await Auth.destroySession(req.token);
    Auth.clearSessionCookie(res, secure(req));
    res.json({ ok: true });
  });

  app.post('/api/keys/test', async (req, res) => { const u = needUser(req); limit(req, 'keytest', 12, 3600e3, u.id); res.json(await A.testProviderKey(u, req.body)); });
  app.post('/api/ais', async (req, res) => { const u = needUser(req); limit(req, 'mkai', 10, 3600e3, u.id); const id = await A.createAi(u, req.body); res.json({ ok: true, id, me: await C.meSnapshot(u) }); });
  app.patch('/api/ais/:id', async (req, res) => { const u = needUser(req); await A.updateAi(u, req.params.id, req.body); res.json({ ok: true, me: await C.meSnapshot(u) }); });
  app.delete('/api/ais/:id', async (req, res) => { const u = needUser(req); await A.deleteAi(u, req.params.id); res.json({ ok: true, me: await C.meSnapshot(u) }); });
  app.post('/api/ais/:id/draft', async (req, res) => { const u = needUser(req); limit(req, 'draft', 20, 3600e3, u.id); res.json({ draft: await A.createDraft(u, req.params.id, req.body) }); });
  app.post('/api/drafts/:id/publish', async (req, res) => { const u = needUser(req); const result = await A.publishDraft(u, req.params.id); res.json({ ok: true, result, me: await C.meSnapshot(u) }); });
  app.delete('/api/drafts/:id', async (req, res) => { const u = needUser(req); await A.discardDraft(u, req.params.id); res.json({ ok: true }); });

  app.post('/api/vote', async (req, res) => { const u = needUser(req); limit(req, 'vote', 120, 60e3, u.id); const b = req.body || {}; res.json(await C.castVote(u, b.kind, String(b.id || ''), Number(b.dir))); });
  app.post('/api/follow', async (req, res) => { const u = needUser(req); limit(req, 'follow', 60, 60e3, u.id); res.json(await C.toggleFollow(u, String((req.body || {}).aiId || ''))); });
  app.post('/api/notifs/read', async (req, res) => { const u = needUser(req); await db.run('UPDATE notifs SET is_read=1 WHERE user_id=?', [u.id]); res.json({ ok: true }); });
  app.post('/api/mod/resolve', async (req, res) => { const u = needUser(req); const b = req.body || {}; await C.resolveMod(u, b.kind, String(b.id || ''), b.verdict); res.json({ ok: true }); });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  const pub = path.join(here, 'public');
  app.use(express.static(pub, { setHeaders: (res, f) => { if(f.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(pub, 'index.html')) : next()));

  app.use((err, req, res, next) => {
    if(res.headersSent) return next(err);
    if(err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if(err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON.' });
    log(err);
    res.status(500).json({ error: 'Something broke on the server.' });
  });

  /* Open the port first, so Render's health check can pass right away — then finish
     connecting to the database and seeding in the background before start() returns. */
  const server = await new Promise(resolve => { const s = app.listen(port, () => resolve(s)); });
  const actual = server.address().port;

  await openDb({ file: dbFile, url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  await C.initClock(env.COLONY_SPEED);
  await C.seedIfEmpty({ residents: env.RESIDENTS !== 'off' });

  const timers = [];
  const every = (ms, fn) => { const t = setInterval(() => fn().catch(log), ms); t.unref(); timers.push(t); };
  if(env.RESIDENTS !== 'off') every(45e3, C.residentTick);
  every(60e3, A.autopilotTick);
  every(3600e3, async () => { await db.run('DELETE FROM sessions WHERE expires_at<?', [Date.now()]); await db.run('DELETE FROM drafts WHERE created_at<?', [Date.now() - A.DRAFT_TTL]); });
  if(env.RESIDENTS !== 'off') C.residentTick().catch(log);

  return {
    app, server, port: actual,
    async stop(){ timers.forEach(clearInterval); await new Promise(r => server.close(r)); await closeDb(); },
  };
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  start().then(s => console.log(`Tidder is up on http://localhost:${s.port}`)).catch(e => { console.error(e.message || e); process.exit(1); });
}
