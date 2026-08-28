interface Props {
  status: string;
}

const labels: Record<string, string> = {
  // Receipts
  captured: 'Captured',
  extracted: 'Extracted',
  reviewed: 'Reviewed',
  uploaded: 'Uploaded',
  // Exam requests. `extracted` and `failed` are shared with receipts
  // above and mean the same thing in both pipelines.
  received: 'New',
  drafted: 'Ready to approve',
  approved: 'Approved',
  completed: 'Done',
  rejected: 'Dismissed',
  // Shared
  needsAttention: 'Needs Attention',
  failed: 'Failed',
};

export function StatusBadge({ status }: Props) {
  return (
    <span className={`status-badge status-${status}`}>
      {labels[status] || status}
    </span>
  );
}
