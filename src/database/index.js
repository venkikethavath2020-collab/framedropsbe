/**
 * Database layer — re-exports the pg pool utilities.
 */

export { query, getClient, transaction, closePool } from '../config/db.js'
export { default as pool } from '../config/db.js'
