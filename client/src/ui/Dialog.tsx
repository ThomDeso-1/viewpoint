import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

/**
 * A modal dialog: focus trap, Esc to close, backdrop click, scroll lock,
 * focus returned to the trigger on close. Hand-rolled — no dependency —
 * matching the repo's zero-UI-library stance.
 */
export function Dialog({
  open,
  onClose,
  title,
  ariaLabel,
  description,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  /** Rendered as the dialog's heading. Omit and pass `ariaLabel` when the
   *  content supplies its own heading. */
  title?: ReactNode;
  ariaLabel?: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  closeOnBackdrop?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const labelId = useId();
  const descId = useId();

  const focusables = useCallback(() => {
    const el = panelRef.current;
    if (!el) return [] as HTMLElement[];
    return Array.from(
      el.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const t = window.setTimeout(() => {
      (focusables()[0] ?? panelRef.current)?.focus();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      lastFocused.current?.focus?.();
    };
  }, [open, onClose, focusables]);

  if (!open) return null;

  return createPortal(
    <div
      className="vp-dialog-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`vp-dialog vp-dialog--${size}${title == null ? ' vp-dialog--untitled' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? labelId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className="vp-dialog-head">
          {title != null && (
            <h2 id={labelId} className="vp-dialog-title">
              {title}
            </h2>
          )}
          <button type="button" className="vp-dialog-x" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {description != null && (
          <p id={descId} className="vp-dialog-desc">
            {description}
          </p>
        )}
        {children != null && <div className="vp-dialog-body">{children}</div>}
        {footer != null && <div className="vp-dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirm-before-acting dialog, replacing `window.confirm()`. `destructive`
 * makes the confirm button red.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="vp-confirm-message">{message}</p>
    </Dialog>
  );
}
