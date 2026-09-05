import type { QueueStatus } from '../shared/api';
import { Pill, type Tone } from '../ui/Pill';

interface Props {
  queue: QueueStatus;
}

export function UploadStatusBar({ queue }: Props) {
  const items: { label: string; count: number; tone: Tone }[] = [];
  if (queue.captured > 0) items.push({ label: 'Captured', count: queue.captured, tone: 'neutral' });
  if (queue.pending > 0) items.push({ label: 'Pending', count: queue.pending, tone: 'attention' });
  if (queue.failed > 0) items.push({ label: 'Failed', count: queue.failed, tone: 'failed' });
  if (queue.uploaded > 0) items.push({ label: 'Uploaded', count: queue.uploaded, tone: 'done' });

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
