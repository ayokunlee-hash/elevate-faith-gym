// Shared Postgres connection pool for Vercel serverless functions.
// Reads the connection string from DATABASE_URL. Never logs it.
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon requires TLS
      max: 5,
    });
  }
  return pool;
}

module.exports = { getPool };
