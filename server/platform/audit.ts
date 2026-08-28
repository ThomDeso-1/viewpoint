import type { Request } from 'express';
import { getDb } from '../db/db.js';

/**
 * Append-only audit trail.
 *
 * Written whenever personal health information is read or changed, and
 * whenever something is sent to a patient or posted to Wave on their
 * behalf. Never throws: an audit failure must not take down the request
 * that triggered it, but it should be loud in the logs.
 */

export type AuditAction =
  | 'login.success'
  | 'login.failure'
  | 'logout'
  | 'password.set'
  | 'patient.read'
  | 'patient.create'
  | 'patient.update'
  | 'patient.delete'
  | 'exam_request.source_read'
  | 'health_card.decrypt'
  | 'eligibility.check'
  | 'invoice.create'
  | 'invoice.send'
  | 'reminder.send'
  | 'oauth.connect'
  | 'oauth.disconnect';

export interface AuditEntry {
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  detail?: string;
  ip?: string;
}

export function audit(entry: AuditEntry): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO audit_log (at, action, entity_type, entity_id, detail, ip)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.detail ?? null,
        entry.ip ?? null,
      );
  } catch (err) {
    console.error('[audit] failed to record entry:', entry.action, err);
  }
}

/** Same as `audit`, with the caller's IP pulled off the request. */
export function auditRequest(req: Request, entry: Omit<AuditEntry, 'ip'>): void {
  audit({ ...entry, ip: req.ip });
}

export interface AuditLogRow {
  id: number;
  at: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: string | null;
  ip: string | null;
}

export function recentAuditEntries(limit = 100): AuditLogRow[] {
  return getDb()
    .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`)
    .all(limit) as AuditLogRow[];
}
