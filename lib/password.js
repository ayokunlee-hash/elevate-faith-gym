// Parent password handling for email sign-up and sign-in.
// Only a salted scrypt hash is ever stored in the database. The plain
// password is never written to the database and must never be written
// to logs. Same scrypt parameters as the PIN hasher in pin.js.
const crypto = require('crypto');

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = parts[1];
    const expected = parts[2];
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    if (check.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
