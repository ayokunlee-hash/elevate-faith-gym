// Small token helpers for OAuth state values and magic-link tokens.
// Raw tokens go to the user (URL or email). Only SHA-256 hashes are stored.
const crypto = require('crypto');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = { randomToken, sha256 };
