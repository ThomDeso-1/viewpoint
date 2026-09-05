/**
 * Editable email templates for the two messages the app drafts to patients:
 *
 *   - `reminder`  — the appointment reminder (server/exams/reminders.ts)
 *   - `followup`  — the recall / "time for your next exam" email
 *                   (server/exams/followups.ts)
 *
 * The operator edits the wording in Settings → Exam workflow → Reminders.
 * An override is stored as JSON in `app_config`; with nothing stored the
 * built-in `DEFAULT_TEMPLATES` wording is used. Either way the compose
 * step substitutes `{{placeholder}}` tokens with values it computes per
 * patient — the same dynamic pieces (name, appointment time, recall
 * interval) that made the wording hard-coded before.
 */

import { getConfig, setConfig } from '../db/db.js';

export type EmailTemplateKind = 'reminder' | 'followup';

export interface EmailTemplate {
  subject: string;
  body: string;
}

export interface TemplatePlaceholder {
  token: string;
  description: string;
}

/** The `{{token}}`s each template understands — shown as hints in the editor. */
export const TEMPLATE_PLACEHOLDERS: Record<EmailTemplateKind, TemplatePlaceholder[]> = {
  reminder: [
    { token: 'firstName', description: "The patient's first name" },
    { token: 'business', description: 'Your business name' },
    { token: 'appointmentTime', description: 'The appointment date and time, in your timezone' },
    {
      token: 'locationBlock',
      description: 'A blank line then "Location: …", or nothing when the appointment has no location',
    },
  ],
  followup: [
    { token: 'firstName', description: "The patient's first name" },
    { token: 'business', description: 'Your business name' },
    {
      token: 'historySentence',
      description:
        'How long since the last exam, e.g. "Our records show it has been about two years since your last eye exam…"',
    },
    { token: 'elapsed', description: 'Time since the last exam on its own, e.g. "two years"' },
    {
      token: 'cadence',
      description: 'How often an exam is recommended for this patient, e.g. "every two years"',
    },
  ],
};

export const DEFAULT_TEMPLATES: Record<EmailTemplateKind, EmailTemplate> = {
  reminder: {
    subject: 'Reminder: your eye exam on {{appointmentTime}}',
    body: [
      'Hello {{firstName}},',
      '',
      'This is a reminder of your eye exam at {{business}} on {{appointmentTime}}.{{locationBlock}}',
      '',
      'Please bring your health card and your current glasses or contact lenses.',
      '',
      'If you need to reschedule, just reply to this message.',
      '',
      '— {{business}}',
    ].join('\n'),
  },
  followup: {
    subject: 'Time for your next eye exam at {{business}}',
    body: [
      'Hello {{firstName}},',
      '',
      '{{historySentence}}',
      "A routine eye exam is recommended {{cadence}}, so it's time to book your next appointment.",
      '',
      'Please reply to this message or call us and we will find a time that works for you.',
      '',
      '— {{business}}',
    ].join('\n'),
  },
};

const CONFIG_KEY: Record<EmailTemplateKind, string> = {
  reminder: 'email_template_reminder',
  followup: 'email_template_followup',
};

export function isEmailTemplateKind(value: unknown): value is EmailTemplateKind {
  return value === 'reminder' || value === 'followup';
}

/** The operator's override for `kind`, falling back field-by-field to the default. */
export function getEmailTemplate(kind: EmailTemplateKind): EmailTemplate {
  const fallback = DEFAULT_TEMPLATES[kind];
  const raw = getConfig(CONFIG_KEY[kind]);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as Partial<EmailTemplate>;
    return {
      subject:
        typeof parsed.subject === 'string' && parsed.subject.trim() ? parsed.subject : fallback.subject,
      body: typeof parsed.body === 'string' && parsed.body.trim() ? parsed.body : fallback.body,
    };
  } catch {
    return fallback;
  }
}

/** True once the operator has saved wording of their own for `kind`. */
export function isEmailTemplateCustomised(kind: EmailTemplateKind): boolean {
  return !!getConfig(CONFIG_KEY[kind]);
}

export function setEmailTemplate(kind: EmailTemplateKind, template: EmailTemplate): void {
  setConfig(
    CONFIG_KEY[kind],
    JSON.stringify({ subject: template.subject.trim(), body: template.body }),
  );
}

/** Drop the override and go back to the built-in wording. */
export function resetEmailTemplate(kind: EmailTemplateKind): void {
  setConfig(CONFIG_KEY[kind], '');
}

/** Replaces `{{token}}` with `vars[token]`; an unknown token is left as-is. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(vars, token) ? vars[token] : match,
  );
}

/** Convenience: fetch `kind`'s template and render both halves with `vars`. */
export function renderEmailTemplate(
  kind: EmailTemplateKind,
  vars: Record<string, string>,
): EmailTemplate {
  const template = getEmailTemplate(kind);
  return {
    subject: renderTemplate(template.subject, vars),
    body: renderTemplate(template.body, vars),
  };
}
