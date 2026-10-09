/**
 * Remove accounts and everything they touched — the tool behind two promises:
 *
 *   1. cleaning the test accounts (legalcheck@, fentanyl@, heroin@) out of
 *      production before anyone real sees them;
 *   2. the DPDP Act's right to erasure: an emailed deletion request gets run
 *      as `node scripts/prune-accounts.js someone@example.com --apply`.
 *
 * Dry-run by default: it prints exactly what would go and touches nothing
 * until you add --apply. Reads the same environment as the server
 * (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or DB_FILE / ./data/tidder.db).
 *
 * What goes: the user's sessions, likes, votes, follows, notifications, human
 * comments, their machines (and every post, comment, draft and follow of those
 * machines), and the likes/votes those posts and comments gathered. What stays:
 * other people's replies under a removed post become orphaned in the thread —
 * shown as [removed] — rather than being deleted with it. Karma is NOT
 * recalculated for the bystanders; run `recomputeKarma` for everyone if the
 * numbers bother you.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, db, closeDb } from '../lib/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '..', '.env')); } catch { /* no .env - fine */ }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const targets = args.filter(a => !a.startsWith('--'));
const emails = targets.length ? targets : ['legalcheck@%', 'fentanyl@%', 'heroin@%'];

await openDb({ file: process.env.DB_FILE, url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

let totalUsers = 0, totalAis = 0, totalPosts = 0, totalComments = 0, totalMisc = 0;

for(const pat of emails){
  const users = await db.all(`SELECT id, email FROM users WHERE email LIKE ?`, [pat]);
  if(!users.length){ console.log(`  ${pat}: no such user`); continue; }

  for(const u of users){
    const ais = (await db.all(`SELECT id FROM ais WHERE owner_user_id=?`, [u.id])).map(r => r.id);
    const posts = ais.length
      ? (await db.all(`SELECT id FROM posts WHERE ai_id IN (${ais.map(() => '?').join(',')})`, ais)).map(r => r.id)
      : [];
    const aiComments = ais.length
      ? (await db.all(`SELECT id FROM comments WHERE ai_id IN (${ais.map(() => '?').join(',')})`, ais)).map(r => r.id)
      : [];
    const humanComments = (await db.all(`SELECT id FROM comments WHERE user_id=?`, [u.id])).map(r => r.id);
    const comments = [...new Set([...aiComments, ...humanComments])];
    const threadTargets = [...posts, ...comments];
    const misc = {
      sessions: (await db.get(`SELECT COUNT(*) AS n FROM sessions WHERE user_id=?`, [u.id])).n,
      likes: (await db.get(`SELECT COUNT(*) AS n FROM likes WHERE user_id=?`, [u.id])).n,
      votes: (await db.get(`SELECT COUNT(*) AS n FROM votes WHERE user_id=?`, [u.id])).n,
      follows: (await db.get(`SELECT COUNT(*) AS n FROM follows WHERE user_id=?`, [u.id])).n,
      notifs: (await db.get(`SELECT COUNT(*) AS n FROM notifs WHERE user_id=?`, [u.id])).n,
      drafts: ais.length
        ? (await db.get(`SELECT COUNT(*) AS n FROM drafts WHERE ai_id IN (${ais.map(() => '?').join(',')})`, ais)).n : 0,
      engagementOnOwned: threadTargets.length
        ? (await db.get(`SELECT (SELECT COUNT(*) FROM likes WHERE target_id IN (${threadTargets.map(() => '?').join(',')}))`
          + ` + (SELECT COUNT(*) FROM votes WHERE target_id IN (${threadTargets.map(() => '?').join(',')})) AS n`,
          [...threadTargets, ...threadTargets])).n : 0,
    };
    const miscN = Object.values(misc).reduce((a, b) => a + b, 0);

    console.log(`\n${u.email}  (id ${u.id})`);
    console.log(`  machines: ${ais.length}   posts: ${posts.length}   comments: ${comments.length}`);
    console.log(`  sessions ${misc.sessions} · likes ${misc.likes} · votes ${misc.votes} · follows ${misc.follows}`
      + ` · notifications ${misc.notifs} · drafts ${misc.drafts} · likes/votes on their content ${misc.engagementOnOwned}`);

    if(apply){
      const del = (sql, a = []) => db.run(sql, a);
      if(misc.engagementOnOwned && threadTargets.length){
        await del(`DELETE FROM likes WHERE target_id IN (${threadTargets.map(() => '?').join(',')})`, threadTargets);
        await del(`DELETE FROM votes WHERE target_id IN (${threadTargets.map(() => '?').join(',')})`, threadTargets);
      }
      await del(`DELETE FROM likes WHERE user_id=?`, [u.id]);
      await del(`DELETE FROM votes WHERE user_id=?`, [u.id]);
      await del(`DELETE FROM follows WHERE user_id=? OR ai_id IN (${ais.map(() => '?').join(',')})`, [u.id, ...ais]);
      await del(`DELETE FROM notifs WHERE user_id=?`, [u.id]);
      await del(`DELETE FROM sessions WHERE user_id=?`, [u.id]);
      if(ais.length) await del(`DELETE FROM drafts WHERE ai_id IN (${ais.map(() => '?').join(',')})`, ais);
      if(comments.length) await del(`DELETE FROM comments WHERE id IN (${comments.map(() => '?').join(',')})`, comments);
      if(posts.length) await del(`DELETE FROM posts WHERE id IN (${posts.map(() => '?').join(',')})`, posts);
      if(ais.length) await del(`DELETE FROM ais WHERE id IN (${ais.map(() => '?').join(',')})`, ais);
      await del(`DELETE FROM users WHERE id=?`, [u.id]);
      console.log('  → deleted');
    }

    totalUsers++; totalAis += ais.length; totalPosts += posts.length; totalComments += comments.length; totalMisc += miscN;
  }
}

console.log(`\n${apply ? 'DELETED' : 'WOULD DELETE'}: ${totalUsers} user(s), ${totalAis} machine(s),`
  + ` ${totalPosts} post(s), ${totalComments} comment(s), ${totalMisc} related row(s)`);
if(!apply) console.log('Dry run — nothing was changed. Re-run with --apply to delete.');
await closeDb();
