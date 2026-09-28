import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from './db.js';
import { HttpError, uid } from './util.js';

const scrypt = promisify(crypto.scrypt);
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

export const COOKIE = 'tidder_sid';
export const SESSION_MS = 30 * 24 * 3600e3;

/* ─── passwords ───────────────────────────────────────────────────── */
export async function hashPassword(pw){
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
export async function verifyPassword(pw, stored){
  if(!stored) return false;
  const [scheme, s, h] = String(stored).split('$');
  if(scheme !== 'scrypt') return false;
  const want = Buffer.from(h, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), want.length);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/* ─── sessions (random token in an HttpOnly cookie; only its hash is stored) ─ */
export async function createSession(userId){
  const token = crypto.randomBytes(32).toString('base64url');
  const t = Date.now();
  await db.run('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)', [sha256(token), userId, t, t + SESSION_MS]);
  return token;
}
export async function userForToken(token){
  if(!token) return null;
  const row = await db.get(
    `SELECT u.*, s.expires_at AS s_exp FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, [sha256(token)]);
  if(!row) return null;
  if(row.s_exp < Date.now()){ await db.run('DELETE FROM sessions WHERE id=?', [sha256(token)]); return null; }
  return row;
}
export async function destroySession(token){ if(token) await db.run('DELETE FROM sessions WHERE id=?', [sha256(token)]); }

export function parseCookies(header){
  const out = {};
  String(header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if(i > 0){ try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch {} }
  });
  return out;
}
export function setSessionCookie(res, token, secure){
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure ? '; Secure' : ''}`);
}
export function clearSessionCookie(res, secure){
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

/* ─── users ───────────────────────────────────────────────────────── */
export const normEmail = e => String(e || '').trim().toLowerCase();
export const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;

const adminEmails = () => (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
export const isAdminEmail = email => adminEmails().includes(email);

export async function signup(email, password){
  email = normEmail(email);
  if(!validEmail(email)) throw new HttpError(400, 'That does not look like an email address.');
  if(String(password || '').length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
  if(String(password).length > 200) throw new HttpError(400, 'That password is too long.');
  if(await db.get('SELECT id FROM users WHERE email=?', [email]))
    throw new HttpError(409, 'An account with that email already exists. Try signing in.');
  const id = uid();
  await db.run('INSERT INTO users(id,email,pass_hash,is_admin,created_at) VALUES(?,?,?,?,?)',
    [id, email, await hashPassword(password), isAdminEmail(email) ? 1 : 0, Date.now()]);
  return db.get('SELECT * FROM users WHERE id=?', [id]);
}
export async function login(email, password){
  email = normEmail(email);
  const u = await db.get('SELECT * FROM users WHERE email=?', [email]);
  if(!u) { await hashPassword('x'); throw new HttpError(401, 'Wrong email or password.'); } /* keep timing similar */
  if(!u.pass_hash) throw new HttpError(401, 'That account signs in with Google. Use “Continue with Google”.');
  if(!(await verifyPassword(String(password || ''), u.pass_hash))) throw new HttpError(401, 'Wrong email or password.');
  if(isAdminEmail(email) && !u.is_admin){ await db.run('UPDATE users SET is_admin=1 WHERE id=?', [u.id]); u.is_admin = 1; }
  return u;
}

/* ─── Google sign-in (Google Identity Services → ID token → verified here) ─ */
let jwks = null;
export async function googleLogin(credential, clientId){
  if(!clientId) throw new HttpError(503, 'Google sign-in is not configured on this server yet.');
  if(!credential || typeof credential !== 'string') throw new HttpError(400, 'Missing Google credential.');
  jwks = jwks || createRemoteJWKSet(new URL(process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs'));
  let payload;
  try {
    ({ payload } = await jwtVerify(credential, jwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId }));
  } catch (e) {
    console.error('jwtVerify failed:', e);
    throw new HttpError(401, 'Google could not verify that sign-in. Try again.');
  }
  if(!payload.sub || !payload.email || payload.email_verified !== true)
    throw new HttpError(401, 'Your Google account needs a verified email address.');
  const email = normEmail(payload.email);
  let u = await db.get('SELECT * FROM users WHERE google_sub=?', [payload.sub]);
  if(!u){
    u = await db.get('SELECT * FROM users WHERE email=?', [email]);
    if(u){
      await db.run('UPDATE users SET google_sub=?, name=COALESCE(name,?), picture=COALESCE(picture,?) WHERE id=?',
        [payload.sub, payload.name || null, payload.picture || null, u.id]);
    } else {
      const id = uid();
      await db.run('INSERT INTO users(id,email,google_sub,name,picture,is_admin,created_at) VALUES(?,?,?,?,?,?,?)',
        [id, email, payload.sub, payload.name || null, payload.picture || null, isAdminEmail(email) ? 1 : 0, Date.now()]);
    }
    u = await db.get('SELECT * FROM users WHERE google_sub=?', [payload.sub]);
  }
  if(isAdminEmail(email) && !u.is_admin){ await db.run('UPDATE users SET is_admin=1 WHERE id=?', [u.id]); u.is_admin = 1; }
  return u;
}
