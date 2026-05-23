/**
 * DB backup worker — admin-triggered Postgres → R2 snapshot.
 *
 * Unlike the other workers in this folder, this one has NO cron schedule.
 * It exists only so the admin Jobs panel can fire a backup on demand
 * (button click → /v1/admin/jobs/dbBackup/run → runOnce()).
 *
 * Pipeline matches scripts/backup-db.js exactly:
 *   pg_dump (custom format) → gzip → upload to R2 under `db-backups/`
 *   then prune anything older than BACKUP_RETENTION_DAYS (default 30)
 *   and email a one-line status via Brevo.
 *
 * Why a worker and not a one-off controller:
 *   - bumpHeartbeat lights up the SystemHealth row so admin can see when
 *     the last successful backup ran (same UX as the other jobs).
 *   - The `running` re-entrancy guard means a double-click in the UI
 *     can't kick off two parallel pg_dumps.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[DbBackupWorker]'
const BACKUP_PREFIX = 'db-backups/'
const HEARTBEAT_NAME = 'db_backup'

let running = false

function getConfig() {
  return {
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10),
    notifyEmail:
      process.env.BACKUP_NOTIFY_EMAIL || process.env.SUPPORT_EMAIL || '',
    notifyFrom: process.env.BREVO_SENDER_EMAIL || 'noreply@framedrops.in',
  }
}

function buildR2Client() {
  for (const v of [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
  ]) {
    if (!process.env[v]) throw new Error(`Missing required env: ${v}`)
  }
  return new S3Client({
    region: 'auto',
    endpoint:
      process.env.R2_ENDPOINT
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
    // -Fc = custom format (smaller, restorable per-table).
    // --no-owner / --no-acl so restore into a fresh project works without
    // re-creating role assignments.
    const args = [
      process.env.DATABASE_URL,
      '-Fc',
      '--no-owner',
      '--no-acl',
      '-f', outFile,
    ]
    const proc = spawn('pg_dump', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    proc.on('error', reject)
    proc.on('exit', code =>
      code === 0
        ? resolve()
        : reject(new Error(`pg_dump exited with code ${code}`)),
    )
  })
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    createGzip({ level: 9 }),
    fs.createWriteStream(dest),
  )
}

async function uploadToR2(client, key, filePath, sizeBytes) {
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: 'application/gzip',
    ContentLength: sizeBytes,
  }))
}

async function pruneOldBackups(client, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
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

async function notifyEmail(subject, textBody, cfg) {
  if (!cfg.notifyEmail) {
    console.log(`${TAG} notify skipped — BACKUP_NOTIFY_EMAIL / SUPPORT_EMAIL not set`)
    return
  }
  if (!process.env.BREVO_API_KEY) {
    console.log(`${TAG} notify skipped — BREVO_API_KEY not set`)
    return
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: cfg.notifyFrom, name: 'Framedrops Backups' },
        to: [{ email: cfg.notifyEmail }],
        subject,
        textContent: textBody,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error(`${TAG} notify email FAILED: HTTP ${res.status} ${body}`)
    } else {
      console.log(`${TAG} notify email sent OK`)
    }
  } catch (err) {
    console.error(`${TAG} notify email ERROR: ${err.message}`)
  }
}

async function tick() {
  const cfg = getConfig()
  const startedAt = Date.now()
  const stamp = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-backup-'))
  const dumpFile = path.join(tmpDir, `framedrops-${stamp}.dump`)
  const gzFile = `${dumpFile}.gz`
  const r2Key = `${BACKUP_PREFIX}framedrops-${stamp}.dump.gz`

  console.log(`${TAG} starting — ${stamp}`)
  try {
    await runPgDump(dumpFile)
    const rawSize = fs.statSync(dumpFile).size

    await gzipFile(dumpFile, gzFile)
    const gzSize = fs.statSync(gzFile).size

    const r2 = buildR2Client()
    await uploadToR2(r2, r2Key, gzFile, gzSize)
    const pruned = await pruneOldBackups(r2, cfg.retentionDays)

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
    const summary = [
      'Framedrops DB backup OK',
      '',
      `Date:       ${stamp}`,
      `Object:     ${r2Key}`,
      `Raw size:   ${(rawSize / 1024).toFixed(1)} KB`,
      `Gzip size:  ${(gzSize / 1024).toFixed(1)} KB`,
      `Pruned:     ${pruned} (older than ${cfg.retentionDays} days)`,
      `Elapsed:    ${elapsedSec}s`,
    ].join('\n')
    console.log(`${TAG} ${summary.replaceAll('\n', ' | ')}`)
    await notifyEmail(`[Framedrops] DB backup OK — ${stamp}`, summary, cfg)
    return { rawSize, gzSize, pruned, r2Key }
  } catch (err) {
    await notifyEmail(
      `[Framedrops] DB backup FAILED — ${stamp}`,
      `Backup failed at ${new Date().toISOString()}\n\n${err.stack || err.message || err}`,
      cfg,
    )
    throw err
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

export async function runOnce() {
  if (running) {
    console.log(`${TAG} previous run still in flight — skipping`)
    return
  }
  running = true
  try {
    const result = await tick()
    await bumpHeartbeat(HEARTBEAT_NAME, {
      meta: {
        gzSize: result?.gzSize ?? 0,
        pruned: result?.pruned ?? 0,
      },
    })
  } catch (err) {
    console.error(`${TAG} unhandled tick error:`, err)
    await bumpHeartbeat(HEARTBEAT_NAME, {
      status: 'error',
      lastError: err?.message || String(err),
    })
    throw err
  } finally {
    running = false
  }
}
