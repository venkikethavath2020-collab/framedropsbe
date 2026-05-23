/**
 * Restore helper — download a backup from R2 and (optionally) restore it
 * into a target Postgres URL.
 *
 * Usage:
 *   # List available backups
 *   node scripts/restore-db.js --list
 *
 *   # Download a specific backup to ./restores/ (no restore — safe)
 *   node scripts/restore-db.js --date 2026-05-23
 *
 *   # Download AND restore into TARGET_DATABASE_URL (NEVER your prod URL)
 *   TARGET_DATABASE_URL=postgres://… node scripts/restore-db.js \
 *     --date 2026-05-23 --apply
 *
 * Safety:
 *   - This script REFUSES to apply if TARGET_DATABASE_URL equals DATABASE_URL.
 *   - --apply is required to actually run pg_restore. Without it, the script
 *     only downloads and decompresses the dump, leaving you free to inspect.
 */

import 'dotenv/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'

const BACKUP_PREFIX = 'db-backups/'
const OUT_DIR = path.resolve(process.cwd(), 'restores')

function parseArgs(argv) {
  const args = { list: false, date: '', apply: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') args.list = true
    else if (a === '--apply') args.apply = true
    else if (a === '--date') args.date = argv[++i] || ''
  }
  return args
}

function buildClient() {
  for (const v of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
    if (!process.env[v]) throw new Error(`Missing required env: ${v}`)
  }
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT
      || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })
}

async function listBackups(client) {
  const all = []
  let token
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: BACKUP_PREFIX,
      ContinuationToken: token,
    }))
    for (const obj of out.Contents || []) {
      all.push({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
      })
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined
  } while (token)
  // Newest first.
  all.sort((a, b) => b.lastModified - a.lastModified)
  return all
}

async function downloadBackup(client, key, destPath) {
  const out = await client.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
  }))
  await pipeline(out.Body, fs.createWriteStream(destPath))
}

async function gunzip(src, dest) {
  await pipeline(fs.createReadStream(src), createGunzip(), fs.createWriteStream(dest))
}

async function pgRestore(targetUrl, dumpFile) {
  return new Promise((resolve, reject) => {
    // --clean: drop existing objects before recreating (safe because we
    //   require a separate TARGET_DATABASE_URL).
    // --if-exists: don't fail on DROP if the object doesn't exist yet.
    // --no-owner / --no-acl: match the dump options.
    const args = [
      '-d', targetUrl,
      '--clean', '--if-exists',
      '--no-owner', '--no-acl',
      dumpFile,
    ]
    const proc = spawn('pg_restore', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    proc.on('error', reject)
    proc.on('exit', code => code === 0
      ? resolve()
      : reject(new Error(`pg_restore exited with code ${code}`)))
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const client = buildClient()

  if (args.list) {
    const backups = await listBackups(client)
    if (!backups.length) {
      console.log('No backups found in R2.')
      return
    }
    console.log(`Found ${backups.length} backup(s):`)
    for (const b of backups) {
      const kb = (b.size / 1024).toFixed(1)
      console.log(`  ${b.lastModified.toISOString().slice(0, 19)}  ${kb.padStart(8)} KB  ${b.key}`)
    }
    return
  }

  if (!args.date) {
    console.error('Pass --list to see available backups, or --date YYYY-MM-DD to fetch one.')
    process.exit(1)
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const key = `${BACKUP_PREFIX}framedrops-${args.date}.dump.gz`
  const gzPath = path.join(OUT_DIR, `framedrops-${args.date}.dump.gz`)
  const dumpPath = path.join(OUT_DIR, `framedrops-${args.date}.dump`)

  console.log(`[restore] downloading r2://${process.env.R2_BUCKET}/${key}`)
  await downloadBackup(client, key, gzPath)
  console.log(`[restore] downloaded: ${gzPath} (${(fs.statSync(gzPath).size / 1024).toFixed(1)} KB)`)

  console.log('[restore] gunzipping…')
  await gunzip(gzPath, dumpPath)
  console.log(`[restore] uncompressed: ${dumpPath} (${(fs.statSync(dumpPath).size / 1024).toFixed(1)} KB)`)

  if (!args.apply) {
    console.log('')
    console.log('Skipping pg_restore — pass --apply to restore into TARGET_DATABASE_URL.')
    console.log(`To inspect manually:  pg_restore --list ${dumpPath}`)
    return
  }

  const targetUrl = process.env.TARGET_DATABASE_URL
  if (!targetUrl) {
    console.error('TARGET_DATABASE_URL is required when --apply is set.')
    process.exit(1)
  }
  if (targetUrl === process.env.DATABASE_URL) {
    console.error('REFUSING TO APPLY: TARGET_DATABASE_URL equals DATABASE_URL.')
    console.error('Restore to a SEPARATE Postgres instance, verify, then promote.')
    process.exit(1)
  }

  console.log(`[restore] applying to ${targetUrl.replace(/:[^:@]+@/, ':***@')}`)
  await pgRestore(targetUrl, dumpPath)
  console.log('[restore] done — verify with SELECT COUNT(*) FROM albums; etc.')
}

main().catch(err => {
  console.error('[restore] FAIL:', err.message || err)
  process.exit(1)
})
