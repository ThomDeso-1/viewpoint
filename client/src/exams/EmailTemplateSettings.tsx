import { useEffect, useState } from 'react';
import {
  getEmailTemplates,
  saveEmailTemplate,
  resetEmailTemplate,
  type EmailTemplateKind,
  type EmailTemplatesResponse,
  type EmailTemplate,
} from '../shared/api';
import { useToast } from '../shared/Toast';

/**
 * Lets the operator edit the wording of the two emails the app drafts to
 * patients — the appointment reminder and the recall / follow-up email.
 * Each is a subject line and a message body with `{{placeholder}}` tokens
 * the app fills in per patient. Nothing sent here goes to a patient; the
 * operator still reviews every drafted message before it is sent.
 */

const LABELS: Record<EmailTemplateKind, { title: string; blurb: string }> = {
  reminder: {
    title: 'Appointment reminder',
    blurb: 'Sent ahead of a booked appointment.',
  },
  followup: {
    title: 'Recall / follow-up email',
    blurb: 'Drafted from the "Follow-ups due" list when a patient is due back for an exam.',
  },
};

const KINDS: EmailTemplateKind[] = ['reminder', 'followup'];

export function EmailTemplateSettings() {
  const [data, setData] = useState<EmailTemplatesResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<EmailTemplateKind, EmailTemplate> | null>(null);
  const [busy, setBusy] = useState<EmailTemplateKind | null>(null);
  const { showToast } = useToast();

  const load = async () => {
    try {
      const res = await getEmailTemplates();
      setData(res);
      setDrafts({
        reminder: { subject: res.templates.reminder.subject, body: res.templates.reminder.body },
        followup: { subject: res.templates.followup.subject, body: res.templates.followup.body },
      });
    } catch {
      setData(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (!data || !drafts) return null;

  const setDraft = (kind: EmailTemplateKind, patch: Partial<EmailTemplate>) =>
    setDrafts({ ...drafts, [kind]: { ...drafts[kind], ...patch } });

  const save = async (kind: EmailTemplateKind) => {
    const draft = drafts[kind];
    if (!draft.subject.trim() || !draft.body.trim()) {
      showToast('A template needs both a subject and a message.', 'error');
      return;
    }
    setBusy(kind);
    try {
      await saveEmailTemplate(kind, draft);
      showToast('Template saved.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const reset = async (kind: EmailTemplateKind) => {
    setBusy(kind);
    try {
      const { template } = await resetEmailTemplate(kind);
      setDrafts({ ...drafts, [kind]: { subject: template.subject, body: template.body } });
      showToast('Reverted to the default wording.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="email-templates">
      <h3 className="settings-subheading">Email templates</h3>
      <p className="settings-help">
        The wording of the emails the app drafts to patients. Use the {'{{'}placeholder{'}}'} tokens
        below — the app fills them in for each patient. You still review every message before it is
        sent.
      </p>

      {KINDS.map((kind) => {
        const draft = drafts[kind];
        const isCustom = data.templates[kind].customised;
        return (
          <section key={kind} className="email-template" aria-label={LABELS[kind].title}>
            <h4 className="settings-subheading">
              {LABELS[kind].title}
              {isCustom && <span className="muted"> · customised</span>}
            </h4>
            <p className="settings-help">{LABELS[kind].blurb}</p>

            <label className="wizard-field-label">
              Subject
              <input
                className="auth-input"
                value={draft.subject}
                onChange={(e) => setDraft(kind, { subject: e.target.value })}
              />
            </label>

            <label className="wizard-field-label">
              Message
              <textarea
                className="auth-input"
                rows={12}
                value={draft.body}
                onChange={(e) => setDraft(kind, { body: e.target.value })}
              />
            </label>

            <details className="email-template-tokens">
              <summary>Placeholders</summary>
              <ul>
                {data.placeholders[kind].map((p) => (
                  <li key={p.token}>
                    <code>{`{{${p.token}}}`}</code> — {p.description}
                  </li>
                ))}
              </ul>
            </details>

            <div className="request-actions">
              <button
                className="btn-primary"
                aria-label={`Save ${LABELS[kind].title} template`}
                onClick={() => save(kind)}
                disabled={busy === kind}
              >
                {busy === kind ? 'Saving…' : 'Save wording'}
              </button>
              {isCustom && (
                <button
                  className="btn-secondary"
                  aria-label={`Reset ${LABELS[kind].title} template to default`}
                  onClick={() => reset(kind)}
                  disabled={busy === kind}
                >
                  Reset to default
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
