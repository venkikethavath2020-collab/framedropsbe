/**
 * Payout Method Service — saved payout destinations (UPI VPA / UPI QR / Bank).
 *
 * The first method a user creates is auto-flagged is_default. Setting a new
 * default clears the previous one in the same transaction (the partial unique
 * index makes the cleared+set sequence safe under concurrency).
 */

import { transaction as dbTransaction } from '../config/db.js'
import * as repo from './payoutMethod.repository.js'
import { deleteObject } from '../config/r2.js'

const VPA_RE   = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/
const IFSC_RE  = /^[A-Z]{4}0[A-Z0-9]{6}$/
const ACCT_RE  = /^\d{6,20}$/

function httpError(status, message, code) {
  const err = new Error(message)
  err.status = status
  if (code) err.code = code
  return err
}

function trimOrNull(v) {
  if (v == null) return null
  const t = String(v).trim()
  return t.length ? t : null
}

function serialize(row) {
  if (!row) return null
  return {
    id: row.id,
    type: row.method_type,
    label: row.label,
    isDefault: row.is_default,
    upiVpa: row.upi_vpa,
    qrImageUrl: row.qr_image_url,
    accountHolder: row.account_holder,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    ifscCode: row.ifsc_code,
    createdAt: row.created_at,
  }
}

export async function listMine(userId) {
  const rows = await repo.listByUser(userId)
  return rows.map(serialize)
}

// ─── Create ─────────────────────────────────────────────────────────────────

function validateAndNormalise(input) {
  const type = input?.type
  const label = trimOrNull(input?.label)
  if (label && label.length > 80) throw httpError(400, 'Label too long (max 80 chars)')

  if (type === 'upi_vpa') {
    const upiVpa = trimOrNull(input?.upiVpa)
    if (!upiVpa) throw httpError(400, 'UPI ID is required')
    const lower = upiVpa.toLowerCase()
    if (!VPA_RE.test(lower)) throw httpError(400, 'Invalid UPI ID format')
    if (lower.length > 320) throw httpError(400, 'UPI ID too long')
    return { methodType: 'upi_vpa', label, upiVpa: lower }
  }

  // NOTE: 'upi_qr' is intentionally rejected. Old rows still exist in the DB
  // (read-only) so legacy withdrawals keep their QR snapshot, but no new
  // 'upi_qr' methods can be created from the API.
  if (type === 'upi_qr') {
    throw httpError(400, 'UPI QR uploads are no longer supported — add a UPI ID instead')
  }

  if (type === 'bank') {
    const accountHolder = trimOrNull(input?.accountHolder)
    const bankName      = trimOrNull(input?.bankName)
    const accountNumber = trimOrNull(input?.accountNumber)
    const ifscRaw       = trimOrNull(input?.ifscCode)
    if (!accountHolder || !bankName || !accountNumber || !ifscRaw) {
      throw httpError(400, 'Account holder, bank name, account number and IFSC code are required')
    }
    if (accountHolder.length > 255) throw httpError(400, 'Account holder name too long')
    if (bankName.length > 255)      throw httpError(400, 'Bank name too long')
    if (accountNumber.length > 64)  throw httpError(400, 'Account number too long')
    if (ifscRaw.length > 20)        throw httpError(400, 'IFSC code too long')
    if (!ACCT_RE.test(accountNumber)) throw httpError(400, 'Invalid account number')
    const ifscCode = ifscRaw.toUpperCase()
    if (!IFSC_RE.test(ifscCode)) throw httpError(400, 'Invalid IFSC code')
    return { methodType: 'bank', label, accountHolder, bankName, accountNumber, ifscCode }
  }

  throw httpError(400, `Unknown payout method type: ${type}`)
}

export async function create(userId, input) {
  const fields = validateAndNormalise(input)
  const wantsDefault = !!input?.isDefault

  return dbTransaction(async (client) => {
    // First ever method auto-defaults
    const liveCount = await repo.countLive(userId, client)
    const isDefault = wantsDefault || liveCount === 0

    // Reuse an existing live row instead of erroring on uniqueness
    const dup = await repo.findDuplicate({
      userId,
      methodType: fields.methodType,
      upiVpa: fields.upiVpa,
      accountNumber: fields.accountNumber,
      ifscCode: fields.ifscCode,
    }, client)
    if (dup) {
      if (isDefault && !dup.is_default) {
        await repo.clearDefault(userId, client)
        const updated = await repo.updateMeta(dup.id, userId, { isDefault: true }, client)
        return serialize(updated || dup)
      }
      return serialize(dup)
    }

    if (isDefault) await repo.clearDefault(userId, client)

    try {
      const row = await repo.insert({ userId, ...fields, isDefault }, client)
      return serialize(row)
    } catch (err) {
      if (err?.code === '23505') {
        // Race: another request created the same logical row between our dup
        // check and insert. Re-fetch and return that row.
        const dup2 = await repo.findDuplicate({
          userId,
          methodType: fields.methodType,
          upiVpa: fields.upiVpa,
          accountNumber: fields.accountNumber,
          ifscCode: fields.ifscCode,
        }, client)
        if (dup2) return serialize(dup2)
      }
      throw err
    }
  })
}

// ─── Update ─────────────────────────────────────────────────────────────────

export async function update(userId, id, patch) {
  const label = patch?.label === undefined
    ? undefined
    : (trimOrNull(patch.label))
  if (label && label.length > 80) throw httpError(400, 'Label too long (max 80 chars)')

  const isDefault = patch?.isDefault === undefined ? undefined : !!patch.isDefault

  if (label === undefined && isDefault === undefined) {
    throw httpError(400, 'Nothing to update')
  }

  return dbTransaction(async (client) => {
    const existing = await repo.findActiveByIdForUpdate(id, userId, client)
    if (!existing) throw httpError(404, 'Payout method not found')

    if (isDefault === true && !existing.is_default) {
      await repo.clearDefault(userId, client)
    }
    // Disallow turning OFF the only default — a user must always have a
    // default if they have any methods, to keep the modal pre-selection
    // deterministic.
    if (isDefault === false && existing.is_default) {
      throw httpError(400, 'Mark another method as default instead of clearing this one')
    }

    const updated = await repo.updateMeta(id, userId, { label, isDefault }, client)
    return serialize(updated)
  })
}

export async function setDefault(userId, id) {
  return dbTransaction(async (client) => {
    const existing = await repo.findActiveByIdForUpdate(id, userId, client)
    if (!existing) throw httpError(404, 'Payout method not found')
    if (existing.is_default) return serialize(existing)
    await repo.clearDefault(userId, client)
    const updated = await repo.updateMeta(id, userId, { isDefault: true }, client)
    return serialize(updated)
  })
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function remove(userId, id) {
  // Soft delete inside the txn; if a default was just removed, promote the
  // most-recent remaining live method.
  let removed = null
  let promoted = null
  await dbTransaction(async (client) => {
    const existing = await repo.findActiveByIdForUpdate(id, userId, client)
    if (!existing) throw httpError(404, 'Payout method not found')
    removed = await repo.softDelete(id, userId, client)
    if (existing.is_default) {
      const remaining = await repo.listByUser(userId, client)
      const next = remaining[0]  // already sorted by is_default DESC, created_at DESC
      if (next) {
        const updated = await repo.updateMeta(next.id, userId, { isDefault: true }, client)
        promoted = updated
      }
    }
  })

  // Best-effort R2 cleanup for QR uploads. Failure here doesn't roll back the
  // soft delete — orphan QR images are harmless and easy to reap later.
  if (removed?.qr_storage_key) {
    deleteObject(removed.qr_storage_key).catch((err) => {
      console.error(`[payoutMethods] R2 delete failed for key=${removed.qr_storage_key}:`, err.message)
    })
  }

  return { removed: serialize(removed), promotedDefault: promoted ? serialize(promoted) : null }
}

// ─── Internal: load for a withdrawal create ────────────────────────────────
// Used by withdrawal.service when the user submits with payoutMethodId.
export async function loadForWithdrawal(userId, id, client) {
  const row = await repo.findActiveByIdForUpdate(id, userId, client)
  if (!row) throw httpError(404, 'Payout method not found')
  return row  // raw row — caller copies snapshot fields onto the withdrawal
}

export { serialize as serializeRow }
