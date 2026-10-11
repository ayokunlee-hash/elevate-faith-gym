// Parent 4-digit PIN handling.
// Only a salted scrypt hash is ever stored in the database. The plain PIN
// is never written to the database and must never be written to logs.
const crypto = require('crypto');

function hashPin(pin) {
  if (!/^\d{4}$/.test(pin)) {
    throw new Error('PIN must be exactly 4 digits');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  try {
    if (typeof stored !== 'string') return false;
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = parts[1];
    const expected = parts[2];
    const check = crypto.scryptSync(String(pin), salt, 64).toString('hex');
    if (check.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) {
    return false;
  }
}

module.exports = { hashPin, verifyPin };
