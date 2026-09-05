import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'progress' | 'attention' | 'done' | 'failed' | 'info' | 'brass';

/**
 * A small status marker. `dot` prefixes a coloured dot; without it the pill
 * is a filled tint. Used for statuses, counts and inline flags — replaces
 * `.status-badge`, `.status-pill`, `.tag` and `.pill-*`.
 */
export function Pill({
  tone = 'neutral',
  dot = true,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={['vp-pill', `vp-pill--${tone}`, dot && 'vp-pill--dot', className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}
