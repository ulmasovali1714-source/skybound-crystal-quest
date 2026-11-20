import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const directory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be configured before running migrations.');
const pool = new Pool({ connectionString: databaseUrl, application_name: 'skybound-migrations' });

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS skybound_schema_migrations (
    migration_name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [771904261]);
    const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
    for (const name of files) {
      const applied = await client.query('SELECT 1 FROM skybound_schema_migrations WHERE migration_name = $1', [name]);
      if (applied.rowCount) continue;
      const sql = await readFile(join(directory, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO skybound_schema_migrations (migration_name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [771904261]);
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
