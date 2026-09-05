import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type To } from 'react-router-dom';
import { Spinner } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  /** Render a router `<Link>` to this route instead of a `<button>`. */
  to?: To;
  /** Render a plain `<a href>` instead of a `<button>` (external links). */
  href?: string;
  type?: 'button' | 'submit' | 'reset';
  target?: string;
  rel?: string;
}

/**
 * The one button. `variant` primary | secondary | ghost | danger, `size`
 * sm | md. Pass `to` for a router link, `href` for a plain anchor, else a
 * `<button>`. `loading` shows a spinner and disables the control.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  loading,
  icon,
  children,
  className,
  to,
  href,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  const cn = [
    'vp-btn',
    `vp-btn--${variant}`,
    `vp-btn--${size}`,
    block && 'vp-btn--block',
    loading && 'is-loading',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      {loading ? <Spinner size={size === 'sm' ? 13 : 15} /> : icon}
      {children != null && <span>{children}</span>}
    </>
  );

  if (to !== undefined) {
    return (
      <Link to={to} className={cn} {...(rest as Record<string, unknown>)}>
        {inner}
      </Link>
    );
  }

  if (href !== undefined) {
    return (
      <a href={href} className={cn} {...(rest as Record<string, unknown>)}>
        {inner}
      </a>
    );
  }

  return (
    <button
      type={type}
      className={cn}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...rest}
    >
      {inner}
    </button>
  );
}
