import crypto from 'node:crypto';

/** short url-safe ids that also satisfy the router's \w+ pattern */
export const uid = () => crypto.randomBytes(6).toString('hex');

export class HttpError extends Error {
  constructor(status, message, code){ super(message); this.status = status; this.code = code || null; }
}

/** run fn() once at a time per key (in-process) */
const tails = new Map();
export function withLock(key, fn){
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if(tails.get(key) === tail) tails.delete(key); });
  return run;
}

/** tiny fixed-window rate limiter, in memory */
export function makeLimiter(){
  const hits = new Map();
  let sweepAt = Date.now() + 60_000;
  return function hit(key, max, windowMs){
    const now = Date.now();
    if(now > sweepAt){ for(const [k, v] of hits) if(v.reset < now) hits.delete(k); sweepAt = now + 60_000; }
    let e = hits.get(key);
    if(!e || e.reset < now){ e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
    e.n++;
    return { ok: e.n <= max, retryAfter: Math.ceil((e.reset - now) / 1000) };
  };
}

export function cleanText(v, max){
  return String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

export function fmtDuration(ms){
  if(ms <= 0) return 'now';
  const h = Math.floor(ms / 3600e3), m = Math.ceil((ms % 3600e3) / 60e3);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
