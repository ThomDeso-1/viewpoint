import { describe, it, expect, afterEach } from 'vitest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * P1-4(c): the audit_log hash chain — an edit or a deletion breaks it and
 * verifyAuditChain() can point at where.
 */

describe('audit hash chain', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.teardown());

  async function load() {
    const audit = await import('../../server/platform/audit.js');
    const { getDb } = await import('../../server/db/db.js');
    return { audit, db: getDb() };
  }

  it('verifies an untampered chain', async () => {
    ctx = await setupTestApp();
    const { audit } = await load();

    audit.audit({ action: 'patient.create', entityType: 'patient', entityId: 'p1' });
    audit.audit({ action: 'health_card.decrypt', entityType: 'patient', entityId: 'p1' });
    audit.audit({ action: 'eligibility.check', entityType: 'patient', entityId: 'p1' });

    expect(audit.verifyAuditChain()).toEqual({ ok: true, brokenAtId: null });
  });

  it('detects an edited row', async () => {
    ctx = await setupTestApp();
    const { audit, db } = await load();

    audit.audit({ action: 'patient.create', entityType: 'patient', entityId: 'p1' });
    audit.audit({ action: 'patient.read', entityType: 'patient', entityId: 'p1' });
    audit.audit({ action: 'health_card.decrypt', entityType: 'patient', entityId: 'p1' });

    const target = db.prepare(`SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 1`).get() as { id: number };
    db.prepare(`UPDATE audit_log SET detail = 'nudged' WHERE id = ?`).run(target.id);

    const result = audit.verifyAuditChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(target.id);
  });

  it('detects a deleted row', async () => {
    ctx = await setupTestApp();
    const { audit, db } = await load();

    audit.audit({ action: 'patient.create', entityType: 'patient', entityId: 'p1' });
    audit.audit({ action: 'patient.read', entityType: 'patient', entityId: 'p1' });
    audit.audit({ action: 'health_card.decrypt', entityType: 'patient', entityId: 'p1' });

    const rows = db.prepare(`SELECT id FROM audit_log ORDER BY id ASC`).all() as { id: number }[];
    db.prepare(`DELETE FROM audit_log WHERE id = ?`).run(rows[1].id);

    // The row after the hole no longer chains to its (now missing) predecessor.
    expect(audit.verifyAuditChain().ok).toBe(false);
  });
});
