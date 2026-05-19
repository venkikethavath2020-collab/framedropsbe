/**
 * Withdrawal Service — business logic for photographer payouts.
 *
 * Balance model (additive over existing wallet schema):
 *   totalBalance       = wallets.balance + wallets.pending_balance
 *   pendingBalance     = wallets.pending_balance  (funds locked in active requests)
 *   withdrawableBalance = wallets.balance         (freely spendable + withdrawable)
 *
 * Existing wallet flows only read/write `wallets.balance`, so they see the
 * withdrawable portion exactly as before. Locked funds are invisible to them.
 */

import { transaction as dbTransaction, query } from '../config/db.js'
import * as repo from './withdrawal.repository.js'
import * as walletRepo from '../wallet/wallet.repository.js'
import * as userRepo from '../repositories/user.repository.js'
import * as emailService from '../email/email.service.js'
import * as payoutMethodService from '../payoutMethods/payoutMethod.service.js'
import * as notificationService from '../services/notification.service.js'

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://framedrops.in').replace(/\/+$/, '')

// Minimum withdrawal in paise. Configure via env — defaults to ₹1000.
//   MIN_WITHDRAWAL_RUPEES=1000  (rupees, preferred)
//   MIN_WITHDRAWAL_PAISE=100000 (paise, overrides rupees if set)
export const MIN_WITHDRAWAL_PAISE = (() => {
  const paiseEnv = process.env.MIN_WITHDRAWAL_PAISE
  if (paiseEnv && Number.isFinite(Number(paiseEnv))) return Math.max(1, Math.floor(Number(paiseEnv)))
  const rupeesEnv = process.env.MIN_WITHDRAWAL_RUPEES
  const rupees = rupeesEnv && Number.isFinite(Number(rupeesEnv)) ? Number(rupeesEnv) : 1000
  return Math.max(1, Math.floor(rupees * 100))
})()

// Absolute ceiling imposed by the wallets.balance / withdrawals.amount
// INTEGER columns (Postgres int4). Requests above this are rejected cleanly
// at the service boundary instead of surfacing as a DB error.
const INT32_MAX = 2_147_483_647

// Hard upper cap per request (paise). Optional — defaults to the INT32 ceiling.
export const MAX_WITHDRAWAL_PAISE = (() => {
  const parse = (v) => (v && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null)
  const fromPaise  = parse(process.env.MAX_WITHDRAWAL_PAISE)
  const fromRupees = parse(process.env.MAX_WITHDRAWAL_RUPEES)
  const configured = fromPaise ?? (fromRupees !== null ? fromRupees * 100 : null)
  if (configured === null) return INT32_MAX
  return Math.min(configured, INT32_MAX)
})()

function format(p) { return `\u20B9${(p / 100).toFixed(2)}` }

function serialize(w) {
  if (!w) return null
  return {
    id: w.id,
    userId: w.user_id,
    amount: w.amount,
    amountFormatted: format(w.amount),
    status: w.status,
    // Method snapshot
    methodType: w.method_type || (w.bank_name ? 'bank' : null),  // legacy fallback
    payoutMethodId: w.payout_method_id || null,
    upiVpa: w.upi_vpa || null,
    qrImageUrl: w.qr_image_url || null,
    bankName: w.bank_name,
    accountNumber: w.account_number,
    ifscCode: w.ifsc_code,
    accountHolder: w.account_holder,
    adminNote: w.admin_note,
    paymentReference: w.payment_reference || null,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    processedAt: w.processed_at,
    userName: w.user_name,
    userEmail: w.user_email,
  }
}

// Mask all but the last 4 digits of an account number for safe display in
// emails. "123456789012" → "••••9012".
function maskAccount(account) {
  if (!account) return ''
  const tail = String(account).slice(-4)
  return `••••${tail}`
}

// Human-readable destination phrase used in payout emails. Returns something
// like "your account ••••9012" / "your UPI ID priya@okhdfcbank" / "your saved UPI QR".
function describeDestination(w) {
  const type = w.method_type || (w.bank_name ? 'bank' : null)
  if (type === 'upi_vpa') return `your UPI ID ${w.upi_vpa || ''}`.trim()
  if (type === 'upi_qr')  return w.upi_vpa
    ? `your UPI ID ${w.upi_vpa}`
    : 'your saved UPI QR'
  if (type === 'bank' && w.account_number) return `your account ${maskAccount(w.account_number)}`
  return 'your saved payout method'
}

// ─── Photographer-facing ────────────────────────────────────────────────────

export async function getEarnings(userId) {
  const wallet = await walletRepo.getOrCreate(userId)
  const pending = wallet.pending_balance ?? 0
  const withdrawable = wallet.balance ?? 0
  const total = pending + withdrawable

  return {
    totalBalance: total,
    totalBalanceFormatted: format(total),
    pendingBalance: pending,
    pendingBalanceFormatted: format(pending),
    withdrawableBalance: withdrawable,
    withdrawableBalanceFormatted: format(withdrawable),
    minWithdrawal: MIN_WITHDRAWAL_PAISE,
    minWithdrawalFormatted: format(MIN_WITHDRAWAL_PAISE),
    maxWithdrawal: MAX_WITHDRAWAL_PAISE,
    maxWithdrawalFormatted: MAX_WITHDRAWAL_PAISE ? format(MAX_WITHDRAWAL_PAISE) : null,
    canWithdraw: withdrawable >= MIN_WITHDRAWAL_PAISE,
  }
}

// Build the snapshot fields we'll insert onto the withdrawal row, given
// either a saved payout_method (preferred) or inline bank fields (legacy).
function buildMethodSnapshot({ payoutMethod, inlineBank }) {
  if (payoutMethod) {
    const m = payoutMethod
    if (m.method_type === 'upi_vpa') {
      return {
        payoutMethodId: m.id,
        methodType: 'upi_vpa',
        upiVpa: m.upi_vpa,
      }
    }
    if (m.method_type === 'upi_qr') {
      return {
        payoutMethodId: m.id,
        methodType: 'upi_qr',
        upiVpa: m.upi_vpa || null,        // optional accompanying VPA
        qrImageUrl: m.qr_image_url,
        qrStorageKey: m.qr_storage_key || null,
      }
    }
    if (m.method_type === 'bank') {
      return {
        payoutMethodId: m.id,
        methodType: 'bank',
        bankName: m.bank_name,
        accountNumber: m.account_number,
        ifscCode: m.ifsc_code,
        accountHolder: m.account_holder,
      }
    }
    throw httpError(400, `Unsupported payout method type: ${m.method_type}`)
  }
  // Legacy inline-bank path
  return {
    methodType: 'bank',
    bankName: inlineBank.bankName,
    accountNumber: inlineBank.accountNumber,
    ifscCode: inlineBank.ifscCode,
    accountHolder: inlineBank.accountHolder,
  }
}

function validateInlineBank({ bankName, accountNumber, ifscCode, accountHolder }) {
  const bankNameTrimmed      = bankName != null ? String(bankName).trim() : ''
  const accountNumberTrimmed = accountNumber != null ? String(accountNumber).trim() : ''
  const ifscCodeTrimmed      = ifscCode != null ? String(ifscCode).trim() : ''
  const accountHolderTrimmed = accountHolder != null ? String(accountHolder).trim() : ''
  if (!bankNameTrimmed || !accountNumberTrimmed || !ifscCodeTrimmed) {
    throw httpError(400, 'Bank name, account number and IFSC code are required')
  }
  if (bankNameTrimmed.length > 255)      throw httpError(400, 'Bank name too long')
  if (accountNumberTrimmed.length > 64)  throw httpError(400, 'Account number too long')
  if (ifscCodeTrimmed.length > 20)       throw httpError(400, 'IFSC code too long')
  if (accountHolderTrimmed && accountHolderTrimmed.length > 255) {
    throw httpError(400, 'Account holder name too long')
  }
  const ifscUpper = ifscCodeTrimmed.toUpperCase()
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscUpper)) throw httpError(400, 'Invalid IFSC code')
  if (!/^\d{6,20}$/.test(accountNumberTrimmed))  throw httpError(400, 'Invalid account number')
  return {
    bankName: bankNameTrimmed,
    accountNumber: accountNumberTrimmed,
    ifscCode: ifscUpper,
    accountHolder: accountHolderTrimmed || null,
  }
}

export async function requestWithdrawal(userId, {
  amount, payoutMethodId,
  // Legacy inline-bank path (kept so older clients keep working)
  bankName, accountNumber, ifscCode, accountHolder,
}) {
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw httpError(400, 'Amount must be a whole number of paise')
  }
  if (amount < MIN_WITHDRAWAL_PAISE) {
    throw httpError(400, `Minimum withdrawal is ${format(MIN_WITHDRAWAL_PAISE)}`)
  }
  if (amount > MAX_WITHDRAWAL_PAISE) {
    throw httpError(400, `Maximum withdrawal per request is ${format(MAX_WITHDRAWAL_PAISE)}`)
  }

  // Pre-validate the inline-bank payload up front so we fail fast outside
  // the transaction. The saved-method path validates inside the txn.
  let inlineBank = null
  if (!payoutMethodId) {
    inlineBank = validateInlineBank({ bankName, accountNumber, ifscCode, accountHolder })
  }

  const created = await dbTransaction(async (client) => {
    // Serialize per-photographer requests via row lock on wallet
    await walletRepo.getOrCreate(userId)
    await client.query(
      'SELECT id FROM wallets WHERE photographer_id = $1 FOR UPDATE',
      [userId]
    )

    // Prevent double submission: only one active request at a time
    if (await repo.hasActiveRequest(userId, client)) {
      throw httpError(409, 'You already have a withdrawal request in progress')
    }

    // Resolve method
    let payoutMethod = null
    if (payoutMethodId) {
      payoutMethod = await payoutMethodService.loadForWithdrawal(userId, payoutMethodId, client)
    }
    const snapshot = buildMethodSnapshot({ payoutMethod, inlineBank })

    // Lock funds — atomic check-and-decrement on wallets.balance
    const updated = await repo.lockFunds(userId, amount, client)
    if (!updated) {
      throw httpError(400, 'Insufficient withdrawable balance')
    }

    let row
    try {
      row = await repo.insert({ userId, amount, ...snapshot }, client)
    } catch (err) {
      // 23505 = unique_violation on uq_withdrawals_one_active_per_user.
      // Defense in depth against a race that bypasses hasActiveRequest().
      if (err?.code === '23505') {
        throw httpError(409, 'You already have a withdrawal request in progress')
      }
      throw err
    }

    return serialize(row)
  })

  // Emit admin notification AFTER the transaction commits. Best-effort —
  // notifyAdminWithdrawalRequested swallows its own errors so a notification
  // failure cannot poison the successful withdrawal response.
  try {
    const photographer = await userRepo.findById(userId)
    await notificationService.notifyAdminWithdrawalRequested({
      withdrawalId: created.id,
      photographerId: userId,
      photographerName: photographer?.name || null,
      photographerEmail: photographer?.email || null,
      amountFormatted: created.amountFormatted,
      methodLabel: describeDestination({
        method_type: created.methodType,
        upi_vpa: created.upiVpa,
        account_number: created.accountNumber,
        bank_name: created.bankName,
      }),
    })
  } catch (err) {
    console.error('[Withdrawal] admin notification emit failed:', err.message)
  }

  return created
}

export async function listMine(userId, { page = 1, perPage = 20 } = {}) {
  page = Math.max(1, page)
  perPage = Math.min(100, Math.max(1, perPage))
  const offset = (page - 1) * perPage
  const [rows, total] = await Promise.all([
    repo.findByUser(userId, { limit: perPage, offset }),
    repo.countByUser(userId),
  ])
  return {
    data: rows.map(serialize),
    meta: { total, page, perPage },
  }
}

// ─── Admin-facing ───────────────────────────────────────────────────────────

export async function adminList({ status, from, to, page = 1, perPage = 20 } = {}) {
  page = Math.max(1, page)
  perPage = Math.min(100, Math.max(1, perPage))
  const offset = (page - 1) * perPage
  const [rows, total] = await Promise.all([
    repo.listAdmin({ status, from, to, limit: perPage, offset }),
    repo.countAdmin({ status, from, to }),
  ])
  return {
    data: rows.map(serialize),
    meta: { total, page, perPage },
  }
}

const ALLOWED_TRANSITIONS = {
  pending:    ['approved', 'rejected', 'cancelled'],
  approved:   ['processing', 'completed', 'rejected'],
  processing: ['completed', 'rejected'],
  rejected:   [],
  completed:  [],
  cancelled:  [],
}

/**
 * Admin transitions: approve | reject | complete | process.
 *
 * - approve    : status → approved (funds stay locked)
 * - process    : status → processing (funds stay locked)
 * - reject     : status → rejected, unlock funds back to withdrawable balance
 * - complete   : status → completed, finalize deduction + audit wallet_transaction.
 *                Requires `paymentReference` (the bank UTR) — admin must record
 *                the external transfer reference before the wallet is debited.
 *
 * Side effect: on `complete` and `reject`, an email is enqueued to the
 * photographer after the DB transaction commits. The email send is
 * best-effort — a mail-system blip never rolls back the wallet ledger.
 */
export async function adminTransition(id, action, { adminId, adminNote, paymentReference } = {}) {
  const actionMap = {
    approve:  'approved',
    process:  'processing',
    reject:   'rejected',
    complete: 'completed',
  }
  const nextStatus = actionMap[action]
  if (!nextStatus) throw httpError(400, `Unknown action: ${action}`)

  // Normalise + validate payment reference up front. Required on completion
  // (the whole point of the field is auditable proof a bank transfer happened).
  const refTrimmed = paymentReference != null ? String(paymentReference).trim() : ''
  if (action === 'complete' && !refTrimmed) {
    throw httpError(400, 'Payment reference (bank UTR) is required to complete a withdrawal')
  }
  if (refTrimmed.length > 100) {
    throw httpError(400, 'Payment reference too long (max 100 chars)')
  }

  const updated = await dbTransaction(async (client) => {
    const w = await repo.findByIdForUpdate(id, client)
    if (!w) throw httpError(404, 'Withdrawal not found')

    const allowed = ALLOWED_TRANSITIONS[w.status] || []
    if (!allowed.includes(nextStatus)) {
      throw httpError(409, `Cannot transition from ${w.status} to ${nextStatus}`)
    }

    // Lock wallet row before touching balances
    await client.query(
      'SELECT id FROM wallets WHERE photographer_id = $1 FOR UPDATE',
      [w.user_id]
    )

    if (nextStatus === 'rejected') {
      const unlocked = await repo.unlockFunds(w.user_id, w.amount, client)
      if (!unlocked) {
        // Invariant broken: pending_balance < amount. Fail loudly — the
        // transaction rolls back instead of silently healing the drift.
        throw httpError(500, 'Wallet pending balance inconsistent with withdrawal; aborted')
      }
    } else if (nextStatus === 'completed') {
      const finalized = await repo.finalizeFunds(w.user_id, w.amount, client)
      if (!finalized) {
        throw httpError(500, 'Wallet pending balance inconsistent with withdrawal; aborted')
      }
      // Audit-only debit row; source='withdrawal' already exists in the enum.
      // reference_id prevents double-audit if retried.
      const { rows: dupes } = await client.query(
        `SELECT id FROM wallet_transactions WHERE reference_id = $1 LIMIT 1`,
        [`withdrawal:${w.id}`]
      )
      if (dupes.length === 0) {
        await client.query(
          `INSERT INTO wallet_transactions
             (photographer_id, type, total_amount, platform_fee, net_amount, source, reference_id, status)
           VALUES ($1, 'debit', $2, 0, $2, 'withdrawal', $3, 'success')`,
          [w.user_id, w.amount, `withdrawal:${w.id}`]
        )
      }
    }

    const row = await repo.updateStatus(
      id,
      nextStatus,
      { adminId, adminNote, paymentReference: refTrimmed || null },
      client,
    )
    return row
  })

  // Best-effort photographer notification, post-commit. A mail-system blip
  // must not roll back the wallet ledger.
  if (nextStatus === 'completed' || nextStatus === 'rejected') {
    sendWithdrawalEmail(updated, nextStatus).catch((err) => {
      console.error(`[Withdrawal] notify email failed (id=${updated.id}, status=${nextStatus}):`,
        err.message)
    })
  }

  return serialize(updated)
}

async function sendWithdrawalEmail(w, status) {
  const user = await userRepo.findById(w.user_id)
  if (!user || !user.email) return  // no inbox to reach — silently skip
  if (user.lifecycle_emails_enabled === false) return  // DPDP unsubscribe gate

  const recipientName = user.name || 'there'
  const amountFormatted = format(w.amount)
  const destination = describeDestination(w)
  const walletUrl = `${APP_BASE_URL}/wallet`

  if (status === 'completed') {
    const ref = w.payment_reference || ''
    const headline = `Payout sent — ${amountFormatted}`
    const message =
      `Your withdrawal of ${amountFormatted} has been transferred to ${destination}.\n\n` +
      `Reference: ${ref || 'see transaction in your bank/UPI app'}\n\n` +
      `If you don't see the credit within 24 hours, please reach out and quote this reference.`
    await emailService.enqueueStatusChanged({
      to: user.email,
      recipientName,
      headline,
      message,
      ctaLabel: 'View wallet',
      ctaUrl: walletUrl,
    })
    return
  }

  if (status === 'rejected') {
    const reason = (w.admin_note && String(w.admin_note).trim()) || ''
    const headline = `Withdrawal request rejected`
    const message =
      `Your withdrawal request for ${amountFormatted} couldn't be processed and the amount has been ` +
      `returned to your wallet balance.\n\n` +
      (reason ? `Reason: ${reason}\n\n` : '') +
      `You can submit a new request from your wallet anytime.`
    await emailService.enqueueStatusChanged({
      to: user.email,
      recipientName,
      headline,
      message,
      ctaLabel: 'Open wallet',
      ctaUrl: walletUrl,
    })
  }
}

// ─── Photographer-initiated cancellation ────────────────────────────────────

/**
 * Cancel a withdrawal request the photographer themselves submitted.
 *
 * Rules:
 * - Only the owning user can cancel.
 * - Only `pending` requests are cancellable. Once an admin advances the row
 *   to `approved` or `processing`, the photographer can no longer self-cancel
 *   (admin must `reject` instead — they may already be mid-transfer).
 * - On cancel, locked funds are returned to the user's withdrawable balance
 *   (mirrors what admin `reject` does), so the wallet net stays correct.
 *
 * Returns the serialized withdrawal.
 */
export async function cancelByUser(userId, id) {
  const updated = await dbTransaction(async (client) => {
    const w = await repo.findByIdForUpdate(id, client)
    if (!w) throw httpError(404, 'Withdrawal not found')
    if (w.user_id !== userId) throw httpError(403, 'Not your withdrawal')

    if (w.status !== 'pending') {
      // Already moved on by admin — the user should ask admin to reject.
      throw httpError(409,
        `This request is already ${w.status} and can no longer be cancelled. ` +
        `Contact support if you need to stop the payout.`)
    }

    // Lock wallet row before mutating balance
    await client.query(
      'SELECT id FROM wallets WHERE photographer_id = $1 FOR UPDATE',
      [w.user_id]
    )

    const unlocked = await repo.unlockFunds(w.user_id, w.amount, client)
    if (!unlocked) {
      // Invariant broken: pending_balance < amount. Fail loudly — the
      // transaction rolls back instead of silently healing the drift.
      throw httpError(500, 'Wallet pending balance inconsistent with withdrawal; aborted')
    }

    const row = await repo.updateStatus(
      id,
      'cancelled',
      // adminId is null — this transition was photographer-initiated.
      // Surface that in the audit field so admin views can distinguish
      // user-cancelled rows from admin-rejected ones at a glance.
      { adminId: null, adminNote: 'Cancelled by user' },
      client,
    )
    return row
  })

  return serialize(updated)
}

// ─── utils ──────────────────────────────────────────────────────────────────

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}
