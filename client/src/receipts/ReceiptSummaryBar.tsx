import type { ReceiptSummary } from '../shared/api';
import { Pill, type Tone } from '../ui/Pill';

interface Props {
  summary: ReceiptSummary;
}

/** "2 Reading · 3 To check · 1 Couldn't read" above the list; hidden when all clear. */
export function ReceiptSummaryBar({ summary }: Props) {
  const items: { label: string; count: number; tone: Tone }[] = [];
  if (summary.processing > 0) items.push({ label: 'Reading', count: summary.processing, tone: 'progress' });
  if (summary.toCheck > 0) items.push({ label: 'To check', count: summary.toCheck, tone: 'attention' });
  if (summary.unreadable > 0) items.push({ label: "Couldn't read", count: summary.unreadable, tone: 'failed' });

  if (items.length === 0) return null;

  return (
    <div className="vp-queue-bar">
      {items.map((item) => (
        <Pill key={item.label} tone={item.tone}>
          {item.count} {item.label}
        </Pill>
      ))}
    </div>
  );
}
