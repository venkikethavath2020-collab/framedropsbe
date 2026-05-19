# Email module

Durable, scalable email pipeline backed by Postgres + node-cron + nodemailer.
The rest of the app talks to one entrypoint: `email.service.js`.

```
API handler ─► emailService.enqueue*()
                      │
                      ▼
                 email_jobs (Postgres)
                      │
                      ▼
              email.worker.js  (cron + advisory lock)
                      │
                      ▼
              nodemailer ─► SMTP (SendGrid / Gmail / …)
                      │
                      ▼
                 email_logs (append-only audit)
```

## Setup

1.  Apply the migration:

    ```bash
    psql "$DATABASE_URL" -f src/database/migrations/2026-04-26-email-queue.sql
    ```

2.  Add SendGrid SMTP credentials to `.env` (free tier — 100 emails/day):

    ```env
    SMTP_ENABLED=true
    SMTP_HOST=smtp.sendgrid.net
    SMTP_PORT=587
    SMTP_USER=apikey
    SMTP_PASS=SG.xxxxxxxxxxxxxxxxxxxxxxxxx
    SMTP_FROM=Framedrops <noreply@yourdomain>
    APP_BASE_URL=https://app.yourdomain
    SUPPORT_EMAIL=support@yourdomain
    ```

    Set `SMTP_ENABLED=false` to skip real delivery — the worker still runs and
    marks jobs as sent, but `email.sender.js` just logs to stdout. Useful in
    dev / CI.

3.  Restart the API. `server.js` calls `startEmailWorker()` which:
    - verifies SMTP credentials once on boot
    - drains any pending jobs immediately
    - polls every `EMAIL_WORKER_CRON` (default `*/30 * * * * *`) thereafter

## Usage

```js
import * as email from '../email/email.service.js'

await email.enqueueOtp({ to, code, expiresMinutes, purpose })
await email.enqueueInvoice({ to, invoiceNumber, lineItems, totalPaise, ... })
await email.enqueueGalleryShared({ to, customerName, galleryUrl, albumName, ... })
await email.enqueueSelectionCompleted({ to, photographerName, clientName, ... })
await email.enqueuePaymentReceived({ to, photographerName, amountFormatted, ... })
await email.enqueueStatusChanged({ to, headline, message, ctaLabel, ctaUrl })
```

Pass `dbClient` (an open pg client) to enlist the insert in an existing
transaction, so the email is only delivered if the surrounding business
write commits.

## Reliability

| Concern              | Solution                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| Lost mail on crash   | Job persists in `email_jobs` until the worker marks it sent.                |
| SMTP outage          | Exponential backoff (1m, 2m, 4m, 8m, 16m), capped at 1h.                    |
| Multi-pod deployment | Postgres advisory lock + `FOR UPDATE SKIP LOCKED` in `claimNextJob`.        |
| Duplicate sends      | The job row flips to `processing` atomically with the claim.                |
| OTP flood            | Per-recipient cap (`EMAIL_OTP_RATE_LIMIT_*`) on top of the IP authLimiter.  |
| Audit trail          | Every attempt (sent or failed) appended to `email_logs` — survives cleanup. |

## Manual ops

```sql
-- See last 50 deliveries
SELECT created_at, type, to_email, status, smtp_message_id, error
  FROM email_logs ORDER BY created_at DESC LIMIT 50;

-- See dead-lettered jobs
SELECT id, type, to_email, attempts, last_error, updated_at
  FROM email_jobs WHERE status = 'dead' ORDER BY updated_at DESC;

-- Retry a dead job (or use email.service.resendJob(id) from code)
UPDATE email_jobs
   SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
 WHERE id = '<uuid>';
```

## Choosing BullMQ instead

The DB-backed queue here is the right call for this project — Postgres is
already in the stack and SendGrid free tier maxes at ~100/day, well below
what `node-cron` polling can handle. If you outgrow it (>1k emails/min,
priority lanes, delayed scheduling beyond hours):

1.  `npm install bullmq ioredis` and stand up Redis.
2.  Replace `email.worker.js` + the `email_jobs` insert in `email.repository.js`
    with a BullMQ queue/worker pair — keep `email.sender.js` and the
    templates as-is. `email.service.js`'s public API does not need to change.
