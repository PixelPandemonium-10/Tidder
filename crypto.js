import crypto from 'node:crypto';

/**
 * API keys are encrypted at rest with AES-256-GCM.
 * The key is derived from SECRET_KEY (an environment variable), so a copy of
 * the database on its own is not enough to read anyone's provider keys.
 */
let KEY = null;
export function initCrypto(secret){
  KEY = crypto.scryptSync(String(secret), 'tidder-provider-keys-v1', 32);
}
export function encrypt(plain){
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(blob){
  if(!blob || !String(blob).startsWith('v1:')) throw new Error('bad blob');
  const buf = Buffer.from(String(blob).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
