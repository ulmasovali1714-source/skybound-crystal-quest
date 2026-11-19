import pg from 'pg';

const { Pool } = pg;

export function createPool(config) {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'skybound-crystal-quest-api',
  });
}

export async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw error;
  } finally {
    client.release();
  }
}
