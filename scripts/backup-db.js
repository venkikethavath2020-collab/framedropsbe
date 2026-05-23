/**
 * Daily Postgres → Cloudflare R2 backup.
 *
 * Pipeline:
 *   pg_dump (custom format) → gzip → upload to R2 under `db-backups/`
 *   then prune anything older than BACKUP_RETENTION_DAYS (default 30)
 *   and (optionally) send a one-line status email via Brevo.
 *
 * Run with:  node scripts/backup-db.js
 *
 * Required env (already in .env for this project):
 *   DATABASE_URL, R2_*, BACKUP_NOTIFY_EMAIL (optional), BREVO_API_KEY (optional)
 */

import 'dotenv/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10)
const BACKUP_PREFIX = 'db-backups/'
const NOTIFY_EMAIL = process.env.BACKUP_NOTIFY_EMAIL || process.env.SUPPORT_EMAIL || ''
// Must be a verified sender in Brevo. The rest of the app uses
// BREVO_SENDER_EMAIL (see email.transporter.js) — match that so we don't
// trip the "sender not verified" 403.
const NOTIFY_FROM = process.env.BREVO_SENDER_EMAIL || 'noreply@framedrops.in'

function fail(msg, err) {
  console.error(`[backup] FAIL: ${msg}`)
  if (err) console.error(err.stack || err.message || err)
  process.exitCode = 1
}

function buildR2Client() {
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

async function runPgDump(outFile) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
  return new Promise((resolve, reject) => {
    // -Fc = custom format. Smaller than plain SQL, lets pg_restore pick
    // individual tables, parallelize restore, etc.
    // --no-owner / --no-acl strip role assignments so a restore into a
    // fresh project (different owner) works without permission errors.
    const args = [
      process.env.DATABASE_URL,
      '-Fc',
      '--no-owner',
      '--no-acl',
      '-f', outFile,
    ]
    const proc = spawn('pg_dump', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    proc.on('error', reject)
    proc.on('exit', code => code === 0
      ? resolve()
      : reject(new Error(`pg_dump exited with code ${code}`)))
  })
}

async function gzipFile(src, dest) {
  await pipeline(fs.createReadStream(src), createGzip({ level: 9 }), fs.createWriteStream(dest))
}

async function uploadToR2(client, key, filePath, sizeBytes) {
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: 'application/gzip',
    ContentLength: sizeBytes,
    // No CacheControl — these aren't served to browsers.
  }))
}

async function pruneOldBackups(client) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const stale = []
  let token
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: BACKUP_PREFIX,
      ContinuationToken: token,
    }))
    for (const obj of out.Contents || []) {
      if (obj.LastModified && obj.LastModified.getTime() < cutoff) {
        stale.push({ Key: obj.Key })
      }
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined
  } while (token)

  if (!stale.length) return 0
  // R2 caps DeleteObjects at 1000 keys per call.
  for (let i = 0; i < stale.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({
      Bucket: process.env.R2_BUCKET,
      Delete: { Objects: stale.slice(i, i + 1000), Quiet: true },
    }))
  }
  return stale.length
}

async function notifyEmail(subject, textBody) {
  if (!NOTIFY_EMAIL) {
    console.log('[backup] notify skipped — BACKUP_NOTIFY_EMAIL / SUPPORT_EMAIL not set')
    return
  }
  if (!process.env.BREVO_API_KEY) {
    console.log('[backup] notify skipped — BREVO_API_KEY not set')
    return
  }
  console.log(`[backup] sending notify email to ${NOTIFY_EMAIL} (from ${NOTIFY_FROM})`)
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM, name: 'Framedrops Backups' },
        to: [{ email: NOTIFY_EMAIL }],
        subject,
        textContent: textBody,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error(`[backup] notify email FAILED: HTTP ${res.status} ${body}`)
    } else {
      console.log('[backup] notify email sent OK')
    }
  } catch (err) {
    console.error(`[backup] notify email ERROR: ${err.message}`)
  }
}

async function main() {
  const startedAt = Date.now()
  const stamp = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-backup-'))
  const dumpFile = path.join(tmpDir, `framedrops-${stamp}.dump`)
  const gzFile = `${dumpFile}.gz`
  const r2Key = `${BACKUP_PREFIX}framedrops-${stamp}.dump.gz`

  console.log(`[backup] starting — ${stamp}`)
  console.log(`[backup] tmp: ${tmpDir}`)

  try {
    console.log('[backup] running pg_dump…')
    await runPgDump(dumpFile)
    const rawSize = fs.statSync(dumpFile).size
    console.log(`[backup] dump size: ${(rawSize / 1024).toFixed(1)} KB`)

    console.log('[backup] gzipping…')
    await gzipFile(dumpFile, gzFile)
    const gzSize = fs.statSync(gzFile).size
    console.log(`[backup] gzipped: ${(gzSize / 1024).toFixed(1)} KB`)

    console.log(`[backup] uploading to r2://${process.env.R2_BUCKET}/${r2Key}`)
    const client = buildR2Client()
    await uploadToR2(client, r2Key, gzFile, gzSize)

    console.log(`[backup] pruning backups older than ${RETENTION_DAYS} days…`)
    const pruned = await pruneOldBackups(client)
    console.log(`[backup] pruned ${pruned} stale object(s)`)

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
    const summary = [
      'Framedrops DB backup OK',
      '',
      `Date:       ${stamp}`,
      `Object:     ${r2Key}`,
      `Raw size:   ${(rawSize / 1024).toFixed(1)} KB`,
      `Gzip size:  ${(gzSize / 1024).toFixed(1)} KB`,
      `Pruned:     ${pruned} (older than ${RETENTION_DAYS} days)`,
      `Elapsed:    ${elapsedSec}s`,
    ].join('\n')
    console.log(`\n${summary}\n`)
    await notifyEmail(`[Framedrops] DB backup OK — ${stamp}`, summary)
  } catch (err) {
    fail('backup pipeline failed', err)
    await notifyEmail(
      `[Framedrops] DB backup FAILED — ${stamp}`,
      `Backup failed at ${new Date().toISOString()}\n\n${err.stack || err.message || err}`,
    )
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

main().catch(err => fail('unhandled', err))
