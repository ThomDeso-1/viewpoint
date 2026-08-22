interface Props {
  status: string;
}

const labels: Record<string, string> = {
  captured: 'Captured',
  extracted: 'Extracted',
  reviewed: 'Reviewed',
  uploaded: 'Uploaded',
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
