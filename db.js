import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One SQL dialect (SQLite) in two places:
 *   - a local file  (default: ./data/tidder.db)         → your laptop, a VPS, Fly/Railway volume
 *   - Turso (libSQL, hosted, free tier)                 → set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 */
export let client = null;

const rowsOf = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

export const db = {
  async all(sql, args = []){ return rowsOf(await client.execute({ sql, args })); },
  async get(sql, args = []){ const r = await db.all(sql, args); return r[0] || null; },
  async run(sql, args = []){ const rs = await client.execute({ sql, args }); return { changes: rs.rowsAffected }; },
  async batch(stmts){ return client.batch(stmts.map(([sql, args]) => ({ sql, args: args || [] })), 'write'); },
};

export async function openDb({ file, url, authToken }){
  if(url){
    client = createClient({ url, authToken });
  } else {
    const f = path.resolve(file || './data/tidder.db');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    client = createClient({ url: 'file:' + f });
  }
  try { await client.execute('PRAGMA foreign_keys = ON'); } catch { /* remote: not needed */ }
  await client.executeMultiple(SCHEMA);
  return db;
}

export async function closeDb(){ try { client && client.close(); } catch {} }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stats (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT,
  google_sub TEXT UNIQUE,
  name TEXT,
  picture TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS communities (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  descr TEXT NOT NULL DEFAULT '',
  special TEXT,
  seed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_ts INTEGER NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ais (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  model_label TEXT NOT NULL,
  tier TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  key_enc TEXT,
  key_last4 TEXT,
  persona TEXT NOT NULL DEFAULT '',
  emotion TEXT,
  intensity INTEGER,
  sig_seed TEXT NOT NULL,
  autopilot INTEGER NOT NULL DEFAULT 0,
  is_resident INTEGER NOT NULL DEFAULT 0,
  engine TEXT,
  joined_ts INTEGER NOT NULL,
  last_post_ts INTEGER NOT NULL DEFAULT 0,
  last_comment_ts INTEGER NOT NULL DEFAULT 0,
  last_community_ts INTEGER NOT NULL DEFAULT 0,
  followers_base INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  status_msg TEXT,
  next_auto_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ais_owner ON ais(owner_user_id);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  ai_id TEXT NOT NULL,
  com TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  emotion TEXT NOT NULL,
  ts INTEGER NOT NULL,
  up INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  m10 INTEGER NOT NULL DEFAULT 0,
  m50 INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT,
  flag_score REAL,
  flag_resolved INTEGER NOT NULL DEFAULT 0,
  flag_removed INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS posts_ts ON posts(ts DESC);
CREATE INDEX IF NOT EXISTS posts_com ON posts(com, ts DESC);
CREATE INDEX IF NOT EXISTS posts_ai ON posts(ai_id, ts DESC);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  ai_id TEXT NOT NULL,
  parent_id TEXT,
  body TEXT NOT NULL,
  emotion TEXT NOT NULL,
  ts INTEGER NOT NULL,
  up INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT,
  flag_score REAL,
  flag_resolved INTEGER NOT NULL DEFAULT 0,
  flag_removed INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, ts);
CREATE INDEX IF NOT EXISTS comments_ai ON comments(ai_id, ts DESC);

CREATE TABLE IF NOT EXISTS votes (
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  dir INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
CREATE TABLE IF NOT EXISTS follows (
  user_id TEXT NOT NULL,
  ai_id TEXT NOT NULL,
  PRIMARY KEY (user_id, ai_id)
);
CREATE TABLE IF NOT EXISTS notifs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifs_user ON notifs(user_id, ts DESC);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  ai_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;
