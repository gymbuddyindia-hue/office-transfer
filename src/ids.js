import crypto from 'node:crypto';

export const newId = () => crypto.randomBytes(16).toString('base64url');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('base64url')}.${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return true;
  const [saltB64, hashB64] = stored.split('.');
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = crypto.scryptSync(password ?? '', salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Short-lived download tokens so password-protected links never carry the password in the URL. */
export function makeAccessToken(secret, transferId, ttlMs = 12 * 60 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', secret).update(`${transferId}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyAccessToken(secret, transferId, token) {
  if (typeof token !== 'string') return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${transferId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Keep folder structure, drop anything that could escape or break a zip entry. */
export function sanitiseName(raw) {
  const parts = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) return 'file';
  const joined = parts.join('/');
  return joined.length > 512 ? joined.slice(joined.length - 512) : joined;
}
