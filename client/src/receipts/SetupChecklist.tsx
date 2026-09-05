import { useEffect, useState } from 'react';
import { getExamSettings, type Settings } from '../shared/api';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

const DISMISSED_KEY = 'viewpoint.setup-checklist.dismissed';

interface Props {
  settings: Settings | null;
}

interface Item {
  label: string;
  done: boolean;
}

/**
 * A dismissible "finish setting up" checklist on the home screen.
 *
 * Onboarding is deliberately short — it only captures what's needed to
 * start. This surfaces the rest (reminder mailbox, patient-files folder,
 * invoicing) without forcing anyone through it, and disappears for good
 * once every item is done or the user dismisses it.
 */
export function SetupChecklist({ settings }: Props) {
  const [examFolderSet, setExamFolderSet] = useState<boolean | null>(null);
  const [invoicingReady, setInvoicingReady] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    Promise.resolve()
      .then(() => getExamSettings())
      .then((e) => {
        setExamFolderSet(!!e.sourceFolder);
        setInvoicingReady(e.invoicingReady);
      })
      .catch(() => {
        setExamFolderSet(true); // don't nag if we can't tell
        setInvoicingReady(true);
      });
  }, []);

  if (dismissed || !settings || examFolderSet === null || invoicingReady === null) {
    return null;
  }

  const items: Item[] = [
    { label: 'Add your Claude API key', done: settings.hasClaudeKey },
    { label: 'Connect Wave for expense uploads', done: settings.hasWaveToken },
    { label: 'Sign in with Microsoft for mail + calendar', done: settings.microsoftConnected },
    { label: 'Point at your patient files folder', done: examFolderSet },
    { label: 'Choose an invoice product or account', done: invoicingReady },
  ];

  const remaining = items.filter((i) => !i.done).length;
  if (remaining === 0) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* private mode — just hide for this session */
    }
    setDismissed(true);
  };

  return (
    <div className="setup-checklist">
      <div className="setup-checklist-head">
        <span className="setup-checklist-title">Finish setting up ({remaining} left)</span>
        <button className="setup-checklist-dismiss" onClick={dismiss} aria-label="Dismiss">
          <Icon name="close" size={16} />
        </button>
      </div>
      <ul className="setup-checklist-items">
        {items.map((item) => (
          <li key={item.label} className={item.done ? 'is-done' : ''}>
            <span className="setup-checklist-check" aria-hidden="true">
              <Icon name={item.done ? 'check' : 'circle'} size={15} strokeWidth={item.done ? 2.4 : 1.6} />
            </span>
            <span className="setup-checklist-label">{item.label}</span>
          </li>
        ))}
      </ul>
      <Button variant="secondary" block to="/settings">
        Open Settings
      </Button>
    </div>
  );
}
