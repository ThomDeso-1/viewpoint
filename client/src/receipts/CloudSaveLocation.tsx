import { useEffect, useState } from 'react';
import { getCloudStorage, setCloudStorage, type CloudStorageStatus } from '../shared/api';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Notice } from '../ui/Notice';

const LOCAL_ONLY = 'local';

/**
 * Choose a cloud service to store receipts in. There is no sign-in here
 * on purpose: the choices are the services this Mac is already signed in
 * to, and the Mac does the syncing (server/receipts/cloud-folder.ts).
 * Hidden on a machine with nothing to offer.
 */
export function CloudSaveLocation() {
  const [status, setStatus] = useState<CloudStorageStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(LOCAL_ONLY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCloudStorage().then(setStatus).catch(() => {});
  }, []);

  if (!status || (status.options.length === 0 && !status.enabled)) return null;

  const selectedLabel = status.options.find((o) => o.id === status.selectedId)?.label;

  const openDialog = () => {
    setChoice(status.selectedId ?? LOCAL_ONLY);
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await setCloudStorage(choice === LOCAL_ONLY ? null : choice));
      setOpen(false);
    } catch (err) {
      setError((err as Error).message || 'Could not change where receipts are saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="vp-mb-4">
      <div className="vp-cloud-location">
        <span>
          {selectedLabel ? (
            <>
              Saving to <strong>{selectedLabel}</strong>
              {status.waiting > 0 && <span className="vp-muted"> · {status.waiting} waiting</span>}
            </>
          ) : status.enabled ? (
            'Cloud storage unavailable'
          ) : (
            <span className="vp-muted">
              Saved on this Mac only
              {status.waiting > 0 && ` · ${status.waiting} moving back`}
            </span>
          )}
        </span>
        <Button variant="ghost" size="sm" onClick={openDialog}>
          {status.enabled ? 'Change' : 'Save to cloud'}
        </Button>
      </div>

      {status.error && <Notice tone="danger">{status.error}</Notice>}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Where to save receipts"
        description="Uses the accounts already signed in on this Mac, so there's nothing to log in to here. Receipts move to a “Viewpoint Receipts” folder and are removed from this Mac. Choosing “This Mac only” moves them all back."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="vp-stack vp-stack--sm">
          {[...status.options, { id: LOCAL_ONLY, label: 'This Mac only' }].map((option) => (
            <label key={option.id} className="vp-cloud-option">
              <input
                type="radio"
                name="cloud-location"
                checked={choice === option.id}
                onChange={() => setChoice(option.id)}
              />
              {option.label}
            </label>
          ))}
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </Dialog>
    </div>
  );
}
