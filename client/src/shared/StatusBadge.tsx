import { Pill, type Tone } from '../ui/Pill';

interface Props {
  status: string;
}

const LABELS: Record<string, string> = {
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

const TONES: Record<string, Tone> = {
  captured: 'neutral',
  extracted: 'progress',
  reviewed: 'attention',
  uploaded: 'done',
  received: 'neutral',
  drafted: 'progress',
  approved: 'done',
  completed: 'done',
  rejected: 'neutral',
  needsAttention: 'attention',
  failed: 'failed',
};

export function StatusBadge({ status }: Props) {
  return <Pill tone={TONES[status] ?? 'neutral'}>{LABELS[status] || status}</Pill>;
}
