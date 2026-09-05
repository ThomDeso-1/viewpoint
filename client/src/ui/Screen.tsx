import type { ReactNode } from 'react';

/**
 * The centred content column inside the app shell. `wide` (~1080px) for
 * lists, tables and the calendar; `read` (~720px) for forms, review and
 * detail screens.
 */
export function Screen({
  width = 'read',
  children,
  className,
}: {
  width?: 'wide' | 'read';
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={['vp-screen', `vp-screen--${width}`, className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}
