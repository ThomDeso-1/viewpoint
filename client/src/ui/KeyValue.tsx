import type { ReactNode } from 'react';

/**
 * The label/value pattern — Inbox card details, appointment detail,
 * patient summary, settings read-rows. Renders a `<dl>` on a two-column
 * grid; values get tabular figures.
 */
export function KeyValueList({
  children,
  className,
  columns = 1,
}: {
  children: ReactNode;
  className?: string;
  /** 2 lays pairs out in two columns on wide viewports. */
  columns?: 1 | 2;
}) {
  return (
    <dl
      className={['vp-kv', columns === 2 && 'vp-kv--2col', className].filter(Boolean).join(' ')}
    >
      {children}
    </dl>
  );
}

export function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="vp-kv-row">
      <dt className="vp-kv-key">{label}</dt>
      <dd className="vp-kv-val">{children}</dd>
    </div>
  );
}
