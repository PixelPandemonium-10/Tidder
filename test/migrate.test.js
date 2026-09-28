import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { rmTmp } from './helpers.js';

/* The exact table shapes deployed before this feature existed: no users.karma,
   no posts.likes, no comments.likes/user_id/user_name, no likes table. Opening
   such a database used to die with "no such column: user_id (at offset 54)",
   because SCHEMA created comments_user on a column migrate() had not added yet —
   and an error inside executeMultiple aborts the boot (this is what failed the
   first Render deploy). */
const OLD = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT,
  google_sub TEXT UNIQUE,
  name TEXT,
  picture TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE posts (
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
CREATE TABLE comments (
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
`;

let tmp, dbPath, db, closeDb;

const colsOf = async table => (await db.all(`SELECT name FROM pragma_table_info('${table}')`)).map(r => r.name);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidder-migrate-'));
  dbPath = path.join(tmp, 'old.db');
  const seed = createClient({ url: 'file:' + dbPath });
  await seed.executeMultiple(OLD);
  seed.close();
  const mod = await import('../lib/db.js');
  db = mod.db; closeDb = mod.closeDb;
  await mod.openDb({ file: dbPath });          /* must not throw */
});

after(async () => {
  try { await closeDb(); } catch { /* already closed */ }
  await rmTmp(tmp);
});

test('an older database opens: new columns are added before the schema needs them', async () => {
  assert.ok((await colsOf('comments')).includes('user_id'), 'comments.user_id');
  assert.ok((await colsOf('comments')).includes('user_name'), 'comments.user_name');
  assert.ok((await colsOf('comments')).includes('likes'), 'comments.likes');
  assert.ok((await colsOf('posts')).includes('likes'), 'posts.likes');
  assert.ok((await colsOf('users')).includes('karma'), 'users.karma');
  assert.ok((await colsOf('likes')).length, 'likes table created');
  const idx = await db.get(`SELECT name FROM sqlite_master WHERE type='index' AND name='comments_user'`);
  assert.equal(idx && idx.name, 'comments_user', 'comments_user index');
});

test('a human reply can be written to the migrated table', async () => {
  await db.run(
    'INSERT INTO comments (id, post_id, ai_id, user_id, user_name, body, emotion, ts, likes) VALUES (?,?,?,?,?,?,?,?,0)',
    ['c-mig', 'p1', 'human', 'u1', 'sam', 'hello from a person', 'calm', Date.now()]
  );
  const row = await db.get('SELECT user_id, user_name, likes FROM comments WHERE id=?', ['c-mig']);
  assert.equal(row.user_id, 'u1');
  assert.equal(row.user_name, 'sam');
  assert.equal(Number(row.likes), 0);
});

test('migrations are idempotent: reopening the same database works', async () => {
  const mod = await import('../lib/db.js');
  await closeDb();
  await mod.openDb({ file: dbPath });
  assert.ok((await colsOf('comments')).includes('user_id'));
  const idx = await db.get(`SELECT name FROM sqlite_master WHERE type='index' AND name='comments_user'`);
  assert.equal(idx && idx.name, 'comments_user');
});
