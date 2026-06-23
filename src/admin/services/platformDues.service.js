/**
 * Admin Platform Dues Service — list outstanding dues and waive (write-off).
 *
 * A waive is a financial admin action, so it runs inside a transaction with an
 * admin_audit_log entry, mirroring the coupon-admin pattern.
 */

import * as platformDueRepo from '../../repositories/platformDue.repository.js'
import * as adminRepo from '../repositories/admin.repository.js'
import { transaction as dbTransaction } from '../../config/db.js'

const ALLOWED_STATUS = new Set(['unpaid', 'paid', 'waived'])

export async function listDues({ status, page = 1, perPage = 50 } = {}) {
  if (status && !ALLOWED_STATUS.has(status)) {
    return { error: `Invalid status filter: ${status}`, status: 400 }
  }
  const limit = Math.max(1, Math.min(100, Number(perPage) || 50))
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit)

  const rows = await platformDueRepo.listDues({ status, limit, offset })
  const dues = rows.map(r => ({
    id: r.id,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    reason: r.reason,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    waivedAt: r.waived_at,
    userId: r.user_id,
    photographerName: r.photographer_name || null,
    photographerEmail: r.photographer_email || null,
    albumId: r.album_id,
    albumName: r.album_name || null,
    clientId: r.client_id,
    clientName: r.client_name || null,
  }))
  return { data: dues, meta: { page: Number(page) || 1, perPage: limit } }
}

export async function waiveDue(dueId, adminUser, ip, reason) {
  if (!adminUser?.id) return { error: 'Admin identity required', status: 401 }

  const result = await dbTransaction(async (client) => {
    const waived = await platformDueRepo.waiveDue(
      dueId,
      { waivedBy: adminUser.id, waivedReason: reason || null },
      client
    )
    if (!waived) return null // not found OR not in 'unpaid' state

    await adminRepo.insertAuditLog({
      adminId: adminUser.id,
      action: 'platform_due.waive',
      targetType: 'platform_due',
      targetId: dueId,
      details: {
        amount: waived.amount,
        userId: waived.user_id,
        albumId: waived.album_id,
        reason: reason || null,
      },
      ipAddress: ip,
    }, client)
    return waived
  })

  if (!result) {
    return { error: 'Due not found or already resolved', status: 404 }
  }
  return { data: { id: result.id, status: result.status } }
}
