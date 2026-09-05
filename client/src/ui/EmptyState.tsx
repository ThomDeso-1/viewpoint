import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * One empty-state treatment — replaces the mix of a fully illustrated
 * block on Receipts and a bare `<p>` everywhere else.
 */
export function EmptyState({
  icon = 'inbox',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="vp-empty">
      <span className="vp-empty-icon" aria-hidden="true">
        <Icon name={icon} size={26} strokeWidth={1.5} />
      </span>
      <p className="vp-empty-title">{title}</p>
      {children != null && <p className="vp-empty-body">{children}</p>}
      {action != null && <div className="vp-empty-action">{action}</div>}
    </div>
  );
}
