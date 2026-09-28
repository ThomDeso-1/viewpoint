import { useEffect, useState } from 'react';
import {
  getWaveImportStatus,
  verifyWaveImport,
  previewWaveImport,
  applyWaveImport,
  type WaveImportStatus,
  type WaveImportPreview,
  type NameMatchDecision,
  type ClientType,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { Pill } from '../ui/Pill';
import { SkeletonRows } from '../ui/Skeleton';

export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  patient: 'Patient',
  customer: 'Customer',
  business: 'Business',
};

const CLIENT_TYPE_PLURAL: Record<ClientType, string> = {
  patient: 'patients',
  customer: 'customers',
  business: 'businesses',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The one-time Wave customer import (server/exams/wave-import.ts).
 *
 * Verify → preview → confirm. "Verify import" reads a single customer to
 * prove the field names match Wave's schema; only once that has passed
 * does "Import from Wave" appear. That reads the whole list and shows what
 * would change — nothing is written until "Confirm import".
 */
export function WaveImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<WaveImportStatus | null>(null);
  const [busy, setBusy] = useState<'verify' | 'preview' | 'apply' | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifiedCount, setVerifiedCount] = useState<number | null>(null);
  const [preview, setPreview] = useState<WaveImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, NameMatchDecision>>({});

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setVerifyError(null);
    getWaveImportStatus()
      .then(setStatus)
      .catch((err) => showToast((err as Error).message, 'error'));
  }, [open]);

  const verify = async () => {
    setBusy('verify');
    setVerifyError(null);
    try {
      const result = await verifyWaveImport();
      if (result.ok) {
        setVerifiedCount(result.totalCount ?? null);
        setStatus(await getWaveImportStatus());
      } else {
        setVerifyError(result.error ?? 'Wave rejected the request.');
      }
    } catch (err) {
      setVerifyError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async () => {
    setBusy('preview');
    try {
      const p = await previewWaveImport();
      setPreview(p);
      setDecisions(Object.fromEntries(p.nameMatches.map((m) => [m.waveId, 'separate' as const])));
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy('apply');
    try {
      const r = await applyWaveImport(preview.previewId, decisions);
      const parts = [
        r.created && `${r.created} added`,
        r.linked && `${r.linked} linked`,
        r.updated && `${r.updated} updated`,
        r.flagged && `${r.flagged} flagged as possible duplicates`,
      ].filter(Boolean);
      showToast(parts.length ? `Imported: ${parts.join(', ')}.` : 'Nothing changed.', 'success');
      onImported();
      onClose();
    } catch (err) {
      showToast((err as Error).message, 'error');
      // An expired preview can't be applied — send them back a step.
      setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const nothingToDo =
    preview &&
    preview.counts.new + preview.counts.link + preview.counts.update + preview.counts.nameMatch === 0;

  const footer = !status ? null : preview ? (
    <>
      <Button variant="secondary" onClick={() => setPreview(null)} disabled={busy === 'apply'}>
        Back
      </Button>
      {!nothingToDo && (
        <Button variant="primary" onClick={apply} loading={busy === 'apply'}>
          Confirm import
        </Button>
      )}
    </>
  ) : !status.waveConfigured ? (
    <Button variant="secondary" onClick={onClose}>
      Close
    </Button>
  ) : status.verifiedAt ? (
    <>
      <Button variant="ghost" onClick={verify} loading={busy === 'verify'} disabled={!!busy}>
        Verify again
      </Button>
      <Button variant="primary" onClick={runPreview} loading={busy === 'preview'} disabled={!!busy}>
        Import from Wave
      </Button>
    </>
  ) : (
    <Button variant="primary" onClick={verify} loading={busy === 'verify'}>
      Verify import
    </Button>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Import clients from Wave" size="lg" footer={footer}>
      {!status ? (
        <SkeletonRows rows={3} />
      ) : !status.waveConfigured ? (
        <Notice tone="warning">Connect Wave and choose a business in Settings first.</Notice>
      ) : preview ? (
        <PreviewBody preview={preview} decisions={decisions} setDecisions={setDecisions} />
      ) : (
        <div className="vp-stack">
          {status.verifiedAt ? (
            <Notice tone="success">
              Verified {fmtDay(status.verifiedAt)}
              {verifiedCount != null ? ` — Wave reports ${plural(verifiedCount, 'customer')}` : ''}.
            </Notice>
          ) : (
            <p>
              First, a quick check: <strong>Verify import</strong> reads a single customer from Wave to make
              sure every field the import needs comes back. Nothing is saved.
            </p>
          )}

          {verifyError && (
            <Notice tone="danger">
              Wave didn't accept the request: {verifyError}
            </Notice>
          )}

          {status.verifiedAt && (
            <p>
              <strong>Import from Wave</strong> reads your whole customer list and shows what would change.
              Nothing is saved until you confirm.
            </p>
          )}

          {status.lastImportAt && (
            <p className="vp-muted">
              Last imported {fmtDay(status.lastImportAt)}. Running it again only adds new customers and fills
              in missing details — it never overwrites what's on file.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function PreviewBody({
  preview,
  decisions,
  setDecisions,
}: {
  preview: WaveImportPreview;
  decisions: Record<string, NameMatchDecision>;
  setDecisions: (d: Record<string, NameMatchDecision>) => void;
}) {
  const { counts, newByType } = preview;
  const typeBreakdown = (Object.keys(newByType) as ClientType[])
    .filter((t) => newByType[t] > 0)
    .map((t) => plural(newByType[t], CLIENT_TYPE_LABEL[t].toLowerCase(), CLIENT_TYPE_PLURAL[t]))
    .join(', ');

  return (
    <div className="vp-stack vp-wave-import">
      <p className="vp-muted">Read {plural(preview.fetched, 'customer')} from Wave. Nothing has been saved yet.</p>

      <ul className="vp-wave-import-summary">
        <li>
          <strong>{counts.new}</strong> new {counts.new === 1 ? 'client' : 'clients'}
          {typeBreakdown ? ` (${typeBreakdown})` : ''}
        </li>
        <li>
          <strong>{counts.link}</strong> will link to an existing client with the same email
        </li>
        {counts.update > 0 && (
          <li>
            <strong>{counts.update}</strong> already linked — missing details will be filled in
          </li>
        )}
        {counts.unchanged > 0 && (
          <li>
            <strong>{counts.unchanged}</strong> already linked, nothing to change
          </li>
        )}
        {counts.nameMatch > 0 && (
          <li>
            <strong>{counts.nameMatch}</strong> share a name with an existing client — check below
          </li>
        )}
        {preview.archived > 0 && (
          <li className="vp-muted">
            {preview.archived} archived in Wave — skipped
          </li>
        )}
      </ul>

      {counts.new + counts.link + counts.update + counts.nameMatch === 0 && (
        <Notice tone="info">Nothing to import — your clients are already up to date with Wave.</Notice>
      )}

      {preview.nameMatches.length > 0 && (
        <section>
          <h3 className="vp-wave-import-h">Same name, no matching email</h3>
          <p className="vp-muted">
            These might be the same person — or two people who share a name. Kept separate, the new record is
            flagged "Possible duplicate" so you can check it later.
          </p>
          <div className="vp-stack">
            {preview.nameMatches.map((m) => (
              <div key={m.waveId} className="vp-wave-match">
                <div className="vp-wave-match-sides">
                  <span>
                    <span className="vp-muted">Wave</span>
                    <strong>{m.waveName}</strong>
                    <span className="vp-muted">{m.email ?? m.phone ?? 'No contact details'}</span>
                  </span>
                  <span>
                    <span className="vp-muted">Already here</span>
                    <strong>{m.client.full_name}</strong>
                    <span className="vp-muted">{m.client.email ?? m.client.phone ?? 'No contact details'}</span>
                  </span>
                </div>
                <select
                  aria-label={`What to do with ${m.waveName}`}
                  value={decisions[m.waveId] ?? 'separate'}
                  onChange={(e) =>
                    setDecisions({ ...decisions, [m.waveId]: e.target.value as NameMatchDecision })
                  }
                >
                  <option value="separate">Keep separate (flag as possible duplicate)</option>
                  <option value="link">Same person — link them</option>
                  <option value="skip">Don't import</option>
                </select>
              </div>
            ))}
          </div>
        </section>
      )}

      {preview.links.length > 0 && (
        <details>
          <summary>Show the {plural(preview.links.length, 'email match', 'email matches')}</summary>
          <ul className="vp-wave-import-list">
            {preview.links.map((l) => (
              <li key={l.waveId}>
                {l.waveName} → {l.client.full_name} <span className="vp-muted">{l.email}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {preview.newClients.length > 0 && (
        <details>
          <summary>Show the {plural(preview.newClients.length, 'new client')}</summary>
          <ul className="vp-wave-import-list">
            {preview.newClients.map((c) => (
              <li key={c.waveId}>
                {c.name}{' '}
                {c.client_type !== 'customer' && <Pill tone="info">{CLIENT_TYPE_LABEL[c.client_type]}</Pill>}{' '}
                <span className="vp-muted">{c.email ?? ''}</span>
              </li>
            ))}
          </ul>
          <p className="vp-muted">You can change anyone's type afterwards on their record.</p>
        </details>
      )}
    </div>
  );
}
