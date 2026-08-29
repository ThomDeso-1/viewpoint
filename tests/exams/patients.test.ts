import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * The patient repository is the app's only store of personal health
 * information, so these tests are mostly about the two guarantees it
 * exists to enforce: health card numbers are encrypted at rest, and they
 * only come back out through an audited call.
 */
describe('patient records', () => {
  let ctx: TestContext;
  let patients: typeof import('../../server/exams/patients.js');

  const CARD = '1234567890';

  beforeEach(async () => {
    ctx = await setupTestApp();
    patients = await import('../../server/exams/patients.js');
  });
  afterEach(() => ctx.teardown());

  function rawRow(id: string) {
    const db = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });
    const row = db.prepare(`SELECT * FROM patients WHERE id = ?`).get(id) as Record<string, unknown>;
    db.close();
    return row;
  }

  function auditActions(): string[] {
    const db = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });
    const rows = db.prepare(`SELECT action FROM audit_log ORDER BY id`).all() as { action: string }[];
    db.close();
    return rows.map((r) => r.action);
  }

  it('stores the health card encrypted, not as plaintext', () => {
    const p = patients.createPatient({ full_name: 'Ada Lovelace', health_card_number: CARD });

    const stored = rawRow(p.id);
    expect(stored.health_card_enc).toBeTruthy();
    expect(String(stored.health_card_enc)).not.toContain(CARD);
    expect(JSON.stringify(stored)).not.toContain(CARD);
  });

  it('returns the card only through readHealthCard, and audits it', () => {
    const p = patients.createPatient({ full_name: 'Ada Lovelace', health_card_number: CARD });

    expect(patients.readHealthCard(p.id, 'eligibility check')).toBe(CARD);
    expect(auditActions()).toContain('health_card.decrypt');
  });

  it('masks the card in the API representation', () => {
    const p = patients.createPatient({ full_name: 'Ada Lovelace', health_card_number: CARD });
    const dto = patients.toPatientDto(p);

    expect(dto.has_health_card).toBe(true);
    expect(dto.health_card_masked).toBe('•••• ••7890');
    expect(JSON.stringify(dto)).not.toContain(CARD);
    expect(dto).not.toHaveProperty('health_card_enc');
  });

  it('reports no card when none is on file', () => {
    const p = patients.createPatient({ full_name: 'No Card' });
    const dto = patients.toPatientDto(p);

    expect(dto.has_health_card).toBe(false);
    expect(dto.health_card_masked).toBeNull();
    expect(patients.readHealthCard(p.id, 'test')).toBeNull();
  });

  it('keeps the existing card when an update omits it', () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: CARD });

    patients.updatePatient(p.id, { full_name: 'Ada Lovelace' });

    const after = patients.getPatient(p.id)!;
    expect(after.full_name).toBe('Ada Lovelace');
    expect(patients.readHealthCard(p.id, 'test')).toBe(CARD);
  });

  it('replaces the card when an update supplies a new one', () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: CARD });

    patients.updatePatient(p.id, { health_card_number: '9999999999' });

    expect(patients.readHealthCard(p.id, 'test')).toBe('9999999999');
  });

  it('clears the card when an update explicitly passes null', () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: CARD });

    patients.updatePatient(p.id, { health_card_number: null });

    expect(patients.readHealthCard(p.id, 'test')).toBeNull();
    expect(patients.getPatient(p.id)!.health_card_enc).toBeNull();
  });

  it('encrypts each card under a fresh IV', () => {
    const a = patients.createPatient({ full_name: 'A', health_card_number: CARD });
    const b = patients.createPatient({ full_name: 'B', health_card_number: CARD });

    expect(a.health_card_enc).not.toBe(b.health_card_enc);
    expect(patients.readHealthCard(a.id, 't')).toBe(patients.readHealthCard(b.id, 't'));
  });

  it('records create, update and delete in the audit log', () => {
    const p = patients.createPatient({ full_name: 'Ada' });
    patients.updatePatient(p.id, { phone: '555-0100' });
    patients.deletePatient(p.id);

    expect(auditActions()).toEqual(
      expect.arrayContaining(['patient.create', 'patient.update', 'patient.delete']),
    );
    expect(patients.getPatient(p.id)).toBeUndefined();
  });

  it('delete is a soft delete — the row and its history survive (P1-4)', async () => {
    const eligibility = await import('../../server/exams/eligibility.js');
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });
    await eligibility.checkPatientEligibility({ patientId: p.id });

    expect(patients.deletePatient(p.id)).toBe(true);

    // Invisible to the app…
    expect(patients.getPatient(p.id)).toBeUndefined();
    expect(patients.listPatients()).toHaveLength(0);
    expect(patients.findMatchingPatient(null, 'Ada')).toBeUndefined();

    // …but the row and the eligibility check are still on disk.
    expect(rawRow(p.id).deleted_at).toBeTruthy();
    expect(eligibility.checksForPatient(p.id)).toHaveLength(1);
  });

  it('a hard delete now nulls the eligibility link instead of cascading it away', async () => {
    const eligibility = await import('../../server/exams/eligibility.js');
    const { getDb } = await import('../../server/db/db.js');
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });
    await eligibility.checkPatientEligibility({ patientId: p.id });

    getDb().prepare(`DELETE FROM patients WHERE id = ?`).run(p.id);

    const rows = getDb().prepare(`SELECT patient_id FROM eligibility_checks`).all() as { patient_id: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].patient_id).toBeNull();
  });

  describe('matching an incoming request to an existing record', () => {
    it('matches on email, case-insensitively', () => {
      const p = patients.createPatient({ full_name: 'Ada Lovelace', email: 'ada@example.com' });

      expect(patients.findMatchingPatient('ADA@example.com', null)?.id).toBe(p.id);
    });

    it('falls back to an exact name match when there is no email', () => {
      const p = patients.createPatient({ full_name: 'Ada Lovelace' });

      expect(patients.findMatchingPatient(null, 'ada lovelace')?.id).toBe(p.id);
    });

    it('prefers the email match over a same-name record', () => {
      patients.createPatient({ full_name: 'Ada Lovelace' });
      const byEmail = patients.createPatient({ full_name: 'Someone Else', email: 'ada@example.com' });

      expect(patients.findMatchingPatient('ada@example.com', 'Ada Lovelace')?.id).toBe(byEmail.id);
    });

    it('does not guess when nothing matches', () => {
      patients.createPatient({ full_name: 'Ada Lovelace' });

      expect(patients.findMatchingPatient('nobody@example.com', 'A. Lovelace')).toBeUndefined();
      expect(patients.findMatchingPatient(null, null)).toBeUndefined();
    });
  });
});
