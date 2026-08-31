import { v4 as uuid } from 'uuid';
import { getDb } from '../db/db.js';
import type { ReminderRow, ReminderChannelName, AppointmentRow, PatientRow } from './types.js';
import { sendMessage } from '../integrations/google/gmail.js';
import { audit } from '../platform/audit.js';
import { applyFailure } from '../platform/failure.js';
import { DEFAULT_MAX_RETRIES } from '../platform/backoff.js';

/**
 * Appointment reminders.
 *
 * Email via Gmail is the only channel today, but it sits behind a
 * ReminderChannel interface so adding SMS later is a new implementation
 * rather than a change to the queue that drives it.
 */

export interface ReminderContext {
  reminder: ReminderRow;
  appointment: AppointmentRow;
  patient: PatientRow;
}

export interface ReminderChannel {
  readonly name: ReminderChannelName;
  /** Returns the provider's id for the sent message. */
  send(context: ReminderContext): Promise<string>;
}

export class GmailReminderChannel implements ReminderChannel {
  readonly name = 'email' as const;

  async send({ reminder, patient }: ReminderContext): Promise<string> {
    if (!patient.email) {
      throw new Error('Patient has no email address on file.');
    }

    return sendMessage({
      to: patient.email,
      subject: reminder.subject ?? 'Appointment reminder',
      body: reminder.body ?? '',
    });
  }
}

const channels = new Map<ReminderChannelName, ReminderChannel>([
  ['email', new GmailReminderChannel()],
]);

export function getChannel(name: ReminderChannelName): ReminderChannel {
  const channel = channels.get(name);
  if (!channel) {
    throw new Error(`No reminder channel registered for "${name}".`);
  }
  return channel;
}

/** Registers an additional channel — the seam an SMS provider plugs into. */
export function registerChannel(channel: ReminderChannel): void {
  channels.set(channel.name, channel);
}

// ── Composition ──

export function defaultReminderLeadMs(): number {
  const hours = Number(process.env.REMINDER_LEAD_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

function formatAppointmentTime(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return startsAt;

  return date.toLocaleString('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: process.env.BUSINESS_TIMEZONE || 'America/Toronto',
  });
}

/**
 * Drafts the reminder text.
 *
 * Kept plain and factual — it is sent from the business's own mailbox and
 * the operator reads it before it goes out.
 */
export function composeReminder(
  appointment: AppointmentRow,
  patient: PatientRow,
): { subject: string; body: string } {
  const business = process.env.BUSINESS_NAME || 'Viewpoint Vision Care';
  const when = formatAppointmentTime(appointment.starts_at);
  const firstName = patient.full_name.split(/\s+/)[0];

  // Locale time formats can already end in a period ("1:00 a.m."), which
  // would otherwise produce a doubled one mid-sentence.
  const sentenceEnd = when.endsWith('.') ? '' : '.';

  const lines = [
    `Hello ${firstName},`,
    '',
    `This is a reminder of your eye exam at ${business} on ${when}${sentenceEnd}`,
  ];

  if (appointment.location) {
    lines.push('', `Location: ${appointment.location}`);
  }

  lines.push(
    '',
    'Please bring your health card and your current glasses or contact lenses.',
    '',
    'If you need to reschedule, just reply to this message.',
    '',
    `— ${business}`,
  );

  return {
    subject: `Reminder: your eye exam on ${when}`,
    body: lines.join('\n'),
  };
}

// ── Persistence ──

export function getReminder(id: string): ReminderRow | undefined {
  return getDb().prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as ReminderRow | undefined;
}

export function findForAppointment(appointmentId: string): ReminderRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM reminders WHERE appointment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(appointmentId) as ReminderRow | undefined;
}

/**
 * Drafts (or re-drafts) the reminder for an appointment.
 *
 * One pending reminder per appointment: re-running the draft step updates
 * the existing row rather than queueing a second message to the patient.
 */
export function draftReminder(
  appointment: AppointmentRow,
  patient: PatientRow,
  channel: ReminderChannelName = 'email',
): ReminderRow {
  const { subject, body } = composeReminder(appointment, patient);
  const scheduledFor = new Date(
    new Date(appointment.starts_at).getTime() - defaultReminderLeadMs(),
  ).toISOString();

  const existing = findForAppointment(appointment.id);
  const now = new Date().toISOString();

  if (existing && existing.status === 'pending') {
    getDb()
      .prepare(
        `UPDATE reminders SET subject = ?, body = ?, scheduled_for = ?, channel = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(subject, body, scheduledFor, channel, now, existing.id);
    return getReminder(existing.id)!;
  }

  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO reminders (
         id, appointment_id, channel, scheduled_for, status, subject, body,
         retry_count, created_at, updated_at
       ) VALUES (@id, @appointment_id, @channel, @scheduled_for, 'pending', @subject, @body, 0, @created_at, @updated_at)`,
    )
    .run({
      id,
      appointment_id: appointment.id,
      channel,
      scheduled_for: scheduledFor,
      subject,
      body,
      created_at: now,
      updated_at: now,
    });

  return getReminder(id)!;
}

/**
 * Moves a still-pending reminder to a new send time.
 *
 * The card lets the operator override the default lead time per patient.
 * A reminder that has already sent (or been cancelled) is left alone.
 */
export function reschedule(id: string, scheduledFor: string): ReminderRow | undefined {
  const row = getReminder(id);
  if (!row || row.status !== 'pending') return undefined;

  getDb()
    .prepare(`UPDATE reminders SET scheduled_for = ?, updated_at = ? WHERE id = ?`)
    .run(scheduledFor, new Date().toISOString(), id);

  return getReminder(id);
}

/** Pending reminders whose send time has arrived. */
export function listDue(now: Date = new Date()): ReminderRow[] {
  return getDb()
    .prepare(`SELECT * FROM reminders WHERE status = 'pending' AND scheduled_for <= ? ORDER BY scheduled_for ASC`)
    .all(now.toISOString()) as ReminderRow[];
}

export function markSent(id: string, providerMessageId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE reminders SET status = 'sent', sent_at = ?, provider_message_id = ?,
         last_error = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(now, providerMessageId, now, id);

  audit({ action: 'reminder.send', entityType: 'reminder', entityId: id });
}

export function recordFailure(
  id: string,
  error: string,
  retryable: boolean,
  maxRetries = DEFAULT_MAX_RETRIES,
): void {
  const row = getReminder(id);
  if (!row) return;

  const { status, retryCount } = applyFailure(row, retryable, {
    retrying: 'pending',
    exhausted: 'failed',
    maxRetries,
  });

  getDb()
    .prepare(`UPDATE reminders SET status = ?, last_error = ?, retry_count = ?, updated_at = ? WHERE id = ?`)
    .run(status, error, retryCount, new Date().toISOString(), id);
}

export function cancelReminder(id: string): void {
  getDb()
    .prepare(`UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

/** Sends one reminder through its channel and records the outcome. */
export async function sendReminder(context: ReminderContext): Promise<void> {
  const channel = getChannel(context.reminder.channel);
  const messageId = await channel.send(context);
  markSent(context.reminder.id, messageId);
}
