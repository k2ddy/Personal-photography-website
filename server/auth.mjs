import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('密码需要 12–256 个字符');
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
}
export async function verifyPassword(password, credentials) {
  if (typeof password !== 'string' || password.length > 256 || !credentials?.hash) return false;
  const result = await scrypt(password, credentials.salt, 64);
  const expected = Buffer.from(credentials.hash, 'hex');
  return result.length === expected.length && timingSafeEqual(result, expected);
}
