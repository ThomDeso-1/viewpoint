import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';

/**
 * The one screen header — replaces `.screen-header`, `.page-header` and
 * `.review-header`. `back` adds a chevron that goes to the previous entry
 * in history (or `backTo` for a fixed destination).
 */
export function PageHeader({
  title,
  actions,
  back,
  backTo,
  backLabel = 'Back',
}: {
  title: ReactNode;
  actions?: ReactNode;
  back?: boolean;
  backTo?: string;
  backLabel?: string;
}) {
  const navigate = useNavigate();
  const showBack = back || backTo != null;

  return (
    <header className="vp-page-header">
      {showBack && (
        <button
          type="button"
          className="vp-page-back"
          onClick={() => (backTo != null ? navigate(backTo) : navigate(-1))}
          aria-label={backLabel}
        >
          <Icon name="chevron-left" size={20} />
        </button>
      )}
      <h1 className="vp-page-title">{title}</h1>
      {actions != null && <div className="vp-page-actions">{actions}</div>}
    </header>
  );
}
