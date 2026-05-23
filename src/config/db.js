/**
 * PostgreSQL connection pool — single instance shared across the app.
 *
 * Uses pg Pool for connection pooling. Configure via DATABASE_URL
 * or individual PG_* environment variables.
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Supabase's prod-ca-2021 root cert — bundled so we can fully verify the
// TLS chain instead of accepting any self-signed cert. Refresh from
// https://supabase-downloads.s3.amazonaws.com/prod/ssl/prod-ca-2021.crt
// if Supabase rotates their CA.
const supabaseCa = fs.readFileSync(path.join(__dirname, 'supabase-ca.crt'), 'utf8')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : {
    ca: supabaseCa,
    rejectUnauthorized: true,
  },
  // Default 50 — R2 PUTs land fast, so finalize calls hit the BE in
  // tighter bursts and would otherwise queue on the pool.
  // Tune per-deploy via PG_POOL_MAX.
  max: parseInt(process.env.PG_POOL_MAX || '50', 10),
  idleTimeoutMillis: 20000,           // Release idle connections after 20s
  connectionTimeoutMillis: 10000,     // Wait up to 10s for a connection
  allowExitOnIdle: true,              // Let pool shrink to 0 when idle
  keepAlive: true,                    // TCP keepalive — detects dead connections
  keepAliveInitialDelayMillis: 10000, // Start keepalive probes after 10s idle
})

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message)
})

/**
 * Run a single query against the pool.
 * @param {string} text  SQL query with $1, $2, … placeholders
 * @param {any[]}  params  Bind values
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now()
  const result = await pool.query(text, params)
  const duration = Date.now() - start

  if (process.env.NODE_ENV !== 'production') {
    console.log('[DB]', { text: text.slice(0, 80), duration: `${duration}ms`, rows: result.rowCount })
  }

  return result
}

/**
 * Acquire a client from the pool for transactions.
 * Caller MUST call client.release() when done.
 * @returns {Promise<pg.PoolClient>}
 */
export async function getClient() {
  return pool.connect()
}

/**
 * Run a callback inside a transaction.
 * Automatically commits on success, rolls back on error.
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function transaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Gracefully close all pool connections.
 */
export async function closePool() {
  await pool.end()
}

export default pool
