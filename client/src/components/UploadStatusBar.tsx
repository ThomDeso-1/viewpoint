import type { QueueStatus } from '../api/client';

interface Props {
  queue: QueueStatus;
}

export function UploadStatusBar({ queue }: Props) {
  const total = queue.captured + queue.pending + queue.failed + queue.uploaded;
  if (total === 0) return null;

  const items: { label: string; count: number; className: string }[] = [];

  if (queue.captured > 0) items.push({ label: 'Captured', count: queue.captured, className: 'pill-captured' });
  if (queue.pending > 0) items.push({ label: 'Pending', count: queue.pending, className: 'pill-pending' });
  if (queue.failed > 0) items.push({ label: 'Failed', count: queue.failed, className: 'pill-failed' });
  if (queue.uploaded > 0) items.push({ label: 'Uploaded', count: queue.uploaded, className: 'pill-uploaded' });

  if (items.length === 0) return null;

  return (
    <div className="status-bar">
      {items.map((item) => (
        <span key={item.label} className={`status-pill ${item.className}`}>
          {item.count} {item.label}
        </span>
      ))}
    </div>
  );
}
