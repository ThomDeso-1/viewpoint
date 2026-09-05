import { useEffect, useState } from 'react';
import { getFollowupDraft, sendFollowupEmail, type PatientFollowup } from '../shared/api';
import { useToast } from '../shared/Toast';

/**
 * Loads a prefilled recall email for a patient, lets the operator edit it,
 * and sends it from the Outlook mailbox. Nothing is sent until Send is
 * tapped — same review-before-send rule as reminders and invoices.
 */
export function FollowupEmailComposer({
  patientId,
  onSent,
  onCancel,
}: {
  patientId: string;
  onSent: (followup: PatientFollowup) => void;
  onCancel: () => void;
}) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getFollowupDraft(patientId)
      .then((d) => {
        if (!cancelled) setDraft({ subject: d.subject, body: d.body });
      })
      .catch((err) => {
        if (!cancelled) {
          showToast((err as Error).message, 'error');
          onCancel();
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const send = async () => {
    if (!draft) return;
    if (!draft.subject.trim() || !draft.body.trim()) {
      showToast('A follow-up email needs a subject and a message.', 'error');
      return;
    }
    setSending(true);
    try {
      const { followup } = await sendFollowupEmail(patientId, draft);
      showToast('Follow-up email sent.', 'success');
      onSent(followup);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <p className="muted">Loading draft…</p>;
  if (!draft) return null;

  return (
    <div className="followup-composer">
      <label>
        Subject
        <input
          value={draft.subject}
          onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
        />
      </label>
      <label>
        Message
        <textarea
          rows={10}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
      </label>
      <div className="request-actions">
        <button className="primary" onClick={send} disabled={sending}>
          {sending ? 'Sending…' : 'Send from Outlook'}
        </button>
        <button className="secondary" onClick={onCancel} disabled={sending}>
          Cancel
        </button>
      </div>
    </div>
  );
}
