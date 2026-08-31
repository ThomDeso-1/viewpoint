import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getExamSettings, type Settings } from '../shared/api';

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
    {
      label: 'Connect a mailbox for reminder emails',
      done: settings.googleConnected || settings.microsoftConnected,
    },
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
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <ul className="setup-checklist-items">
        {items.map((item) => (
          <li key={item.label} className={item.done ? 'is-done' : ''}>
            <span className="setup-checklist-check" aria-hidden="true">
              {item.done ? (
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="10" cy="10" r="7" />
                </svg>
              )}
            </span>
            <span className="setup-checklist-label">{item.label}</span>
          </li>
        ))}
      </ul>
      <Link to="/settings" className="btn-secondary" style={{ width: '100%' }}>
        Open Settings
      </Link>
    </div>
  );
}
