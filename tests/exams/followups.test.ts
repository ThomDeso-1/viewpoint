import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import type { PatientRow } from '../../server/exams/types.js';

/**
 * Patient recall. The pure resolution rules (which date, is it due) carry
 * most of the weight; the DB-backed helpers just wire them to the
 * appointments table.
 */
describe('follow-ups', () => {
  let ctx: TestContext;
  let followups: typeof import('../../server/exams/followups.js');
  let patients: typeof import('../../server/exams/patients.js');
  let appointments: typeof import('../../server/exams/appointments.js');

  beforeEach(async () => {
    ctx = await setupTestApp();
    followups = await import('../../server/exams/followups.js');
    patients = await import('../../server/exams/patients.js');
    appointments = await import('../../server/exams/appointments.js');
  });
  afterEach(() => ctx.teardown());

  /** A minimal patient-shaped object for the pure functions. */
  const p = (over: Partial<PatientRow> = {}): PatientRow =>
    ({
      date_of_birth: null,
      followup_mode: 'remind',
      followup_date_override: null,
      followup_dismissed_at: null,
      followup_last_emailed_at: null,
      ...over,
    }) as PatientRow;

  describe('addMonths', () => {
    it('adds whole months', () => {
      expect(followups.addMonths('2026-01-15T00:00:00.000Z', 24).slice(0, 10)).toBe('2028-01-15');
    });

    it('clamps a rolled-over day to the end of the target month', () => {
      expect(followups.addMonths('2026-01-31T00:00:00.000Z', 1).slice(0, 10)).toBe('2026-02-28');
      expect(followups.addMonths('2024-01-31T00:00:00.000Z', 1).slice(0, 10)).toBe('2024-02-29');
    });
  });

  describe('recallIntervalMonths', () => {
    const ref = '2026-06-01T00:00:00.000Z';
    it('is 12 months for patients under 20 or 65+', () => {
      expect(followups.recallIntervalMonths('2010-01-01', ref)).toBe(12); // age 16
      expect(followups.recallIntervalMonths('2006-07-01', ref)).toBe(12); // age 19
      expect(followups.recallIntervalMonths('1955-01-01', ref)).toBe(12); // age 71
    });

    it('is 24 months for patients 20–64', () => {
      expect(followups.recallIntervalMonths('2006-05-01', ref)).toBe(24); // just turned 20
      expect(followups.recallIntervalMonths('1980-01-01', ref)).toBe(24);
      expect(followups.recallIntervalMonths('1961-07-01', ref)).toBe(24); // age 64
    });

    it('defaults to 24 months when the date of birth is unknown', () => {
      expect(followups.recallIntervalMonths(null, ref)).toBe(24);
    });
  });

  describe('resolveFollowup', () => {
    it('prefers a booked upcoming appointment', () => {
      const r = followups.resolveFollowup({
        patient: p({ followup_date_override: '2027-01-01' }),
        lastAppointmentAt: '2024-01-01T00:00:00.000Z',
        currentAppointmentAt: '2026-10-01T14:00:00.000Z',
        currentAppointmentId: 'appt-9',
      });
      expect(r).toEqual({ date: '2026-10-01T14:00:00.000Z', source: 'booked', appointmentId: 'appt-9' });
    });

    it('falls back to the operator override', () => {
      const r = followups.resolveFollowup({
        patient: p({ followup_date_override: '2027-03-15' }),
        lastAppointmentAt: '2024-01-01T00:00:00.000Z',
        currentAppointmentAt: null,
      });
      expect(r?.source).toBe('override');
      expect(r?.date.slice(0, 10)).toBe('2027-03-15');
    });

    it('otherwise computes last-exam-plus-interval', () => {
      const r = followups.resolveFollowup({
        patient: p({ date_of_birth: '1980-01-01' }),
        lastAppointmentAt: '2024-08-01T00:00:00.000Z',
        currentAppointmentAt: null,
      });
      expect(r?.source).toBe('computed');
      expect(r?.date.slice(0, 10)).toBe('2026-08-01'); // +24 months
    });

    it('is null with no history and no override', () => {
      expect(
        followups.resolveFollowup({ patient: p(), lastAppointmentAt: null, currentAppointmentAt: null }),
      ).toBeNull();
    });
  });

  describe('isFollowupDue', () => {
    const now = new Date('2026-08-15T00:00:00.000Z');
    const dueSoon = { date: '2026-08-20T00:00:00.000Z', source: 'computed' as const };

    it('is due when the date is within the lead window', () => {
      expect(
        followups.isFollowupDue({ patient: p(), resolved: dueSoon, lastAppointmentAt: '2024-08-01', now }),
      ).toBe(true);
    });

    it('is never due for a booked appointment', () => {
      expect(
        followups.isFollowupDue({
          patient: p(),
          resolved: { date: '2026-08-20T00:00:00.000Z', source: 'booked' },
          lastAppointmentAt: '2024-08-01',
          now,
        }),
      ).toBe(false);
    });

    it('respects mode "off"', () => {
      expect(
        followups.isFollowupDue({
          patient: p({ followup_mode: 'off' }),
          resolved: dueSoon,
          lastAppointmentAt: '2024-08-01',
          now,
        }),
      ).toBe(false);
    });

    it('is not due far ahead of the lead window', () => {
      expect(
        followups.isFollowupDue({
          patient: p(),
          resolved: { date: '2026-12-01T00:00:00.000Z', source: 'computed' },
          lastAppointmentAt: '2024-12-01',
          now,
        }),
      ).toBe(false);
    });

    it('drops off once it is more than a year overdue', () => {
      expect(
        followups.isFollowupDue({
          patient: p(),
          resolved: { date: '2025-01-01T00:00:00.000Z', source: 'computed' },
          lastAppointmentAt: '2023-01-01',
          now,
        }),
      ).toBe(false);
    });

    it('stays dismissed until a newer exam resets the cycle', () => {
      const dismissed = p({ followup_dismissed_at: '2026-08-10T00:00:00.000Z' });
      // Dismissed after the last exam → handled.
      expect(
        followups.isFollowupDue({
          patient: dismissed,
          resolved: dueSoon,
          lastAppointmentAt: '2024-08-01T00:00:00.000Z',
          now,
        }),
      ).toBe(false);
      // A newer exam (after the dismiss) reopens it.
      expect(
        followups.isFollowupDue({
          patient: dismissed,
          resolved: dueSoon,
          lastAppointmentAt: '2026-08-12T00:00:00.000Z',
          now,
        }),
      ).toBe(true);
    });
  });

  describe('followupForPatient', () => {
    it('is due for a patient whose last exam was two years ago with nothing booked', () => {
      const now = new Date();
      const patient = patients.createPatient({ full_name: 'Grace Hopper', date_of_birth: '1980-01-01' });
      appointments.createAppointment({
        patientId: patient.id,
        startsAt: new Date(now.getTime() - 25 * 30 * 86_400_000).toISOString(),
        title: 'Eye exam',
      });

      const summary = followups.followupForPatient(patient.id);
      expect(summary?.followup_source).toBe('computed');
      expect(summary?.due).toBe(true);
    });

    it('is not due once a future appointment is on the books', () => {
      const now = Date.now();
      const patient = patients.createPatient({ full_name: 'Ada', date_of_birth: '1980-01-01' });
      appointments.createAppointment({
        patientId: patient.id,
        startsAt: new Date(now - 25 * 30 * 86_400_000).toISOString(),
      });
      appointments.createAppointment({
        patientId: patient.id,
        startsAt: new Date(now + 14 * 86_400_000).toISOString(),
      });

      const summary = followups.followupForPatient(patient.id);
      expect(summary?.followup_source).toBe('booked');
      expect(summary?.due).toBe(false);
    });
  });

  describe('listDueFollowups', () => {
    it('lists due patients, skips "off" and the already-booked', () => {
      const past = new Date(Date.now() - 25 * 30 * 86_400_000).toISOString();
      const future = new Date(Date.now() + 14 * 86_400_000).toISOString();

      const due = patients.createPatient({ full_name: 'Due Person', date_of_birth: '1980-01-01' });
      appointments.createAppointment({ patientId: due.id, startsAt: past });

      const off = patients.createPatient({ full_name: 'Opted Out', date_of_birth: '1980-01-01' });
      appointments.createAppointment({ patientId: off.id, startsAt: past });
      patients.updatePatient(off.id, { followup_mode: 'off' });

      const booked = patients.createPatient({ full_name: 'Rebooked', date_of_birth: '1980-01-01' });
      appointments.createAppointment({ patientId: booked.id, startsAt: past });
      appointments.createAppointment({ patientId: booked.id, startsAt: future });

      const names = followups.listDueFollowups().map((f) => f.full_name);
      expect(names).toContain('Due Person');
      expect(names).not.toContain('Opted Out');
      expect(names).not.toContain('Rebooked');
    });
  });

  describe('composeFollowupEmail', () => {
    it('greets by first name and names the interval', () => {
      const patient = patients.createPatient({ full_name: 'Grace Hopper', date_of_birth: '1980-01-01' });
      const { subject, body } = followups.composeFollowupEmail({
        patient: patients.getPatient(patient.id)!,
        lastAppointmentAt: '2024-08-01T00:00:00.000Z',
      });
      expect(subject).toMatch(/eye exam/i);
      expect(body).toMatch(/Hello Grace,/);
      expect(body).toMatch(/two years/);
    });
  });
});
