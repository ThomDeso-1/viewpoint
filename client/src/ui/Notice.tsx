import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Tone = 'info' | 'warning' | 'danger' | 'success';

const ICON: Record<Tone, IconName> = {
  info: 'info',
  warning: 'alert',
  danger: 'alert',
  success: 'check',
};

/**
 * An inline message block — replaces the `.banner-*` family. Use it for
 * page-level context (a missing setting, a degraded connection), not for
 * transient action feedback (that's a toast).
 */
export function Notice({
  tone = 'info',
  icon = true,
  children,
  className,
}: {
  tone?: Tone;
  icon?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={['vp-notice', `vp-notice--${tone}`, className].filter(Boolean).join(' ')}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      {icon && (
        <span className="vp-notice-icon" aria-hidden="true">
          <Icon name={ICON[tone]} size={16} />
        </span>
      )}
      <div className="vp-notice-body">{children}</div>
    </div>
  );
}
