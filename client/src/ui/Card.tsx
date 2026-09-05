import type { ReactNode } from 'react';

/**
 * `Card` — a bordered surface, used when something genuinely is a separate
 * object. `Section` — a hairline-ruled group with an optional heading and
 * actions, the lighter-weight default for grouping related content without
 * boxing everything.
 */

export function Card({
  children,
  className,
  as: As = 'div',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'form';
  padded?: boolean;
}) {
  return (
    <As className={['vp-card', padded && 'vp-card--padded', className].filter(Boolean).join(' ')}>
      {children}
    </As>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={['vp-section', className].filter(Boolean).join(' ')}>
      {(title != null || actions != null) && (
        <div className="vp-section-head">
          <div className="vp-section-heading">
            {title != null && <h2 className="vp-section-title">{title}</h2>}
            {description != null && <p className="vp-section-desc">{description}</p>}
          </div>
          {actions != null && <div className="vp-section-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
