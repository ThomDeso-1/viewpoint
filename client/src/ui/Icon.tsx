import type { SVGProps } from 'react';

/**
 * One line-icon set for the whole app — feather-style, 24×24, drawn with
 * `currentColor` so they take the surrounding text colour. Replaces the
 * ~30 hand-inlined SVGs that were scattered across screens.
 */

export type IconName =
  | 'settings'
  | 'search'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'close'
  | 'check'
  | 'circle'
  | 'trash'
  | 'camera'
  | 'image'
  | 'plus'
  | 'receipt'
  | 'inbox'
  | 'calendar'
  | 'user'
  | 'users'
  | 'external'
  | 'download'
  | 'copy'
  | 'alert'
  | 'info'
  | 'logout'
  | 'clock'
  | 'mail';

const PATHS: Record<IconName, string> = {
  settings:
    'M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 13a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.05a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.05a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12.5l5 5L20 6',
  circle: 'M12 21a9 9 0 100-18 9 9 0 000 18z',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  trash: 'M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M6 6l1 14a2 2 0 002 2h6a2 2 0 002-2l1-14M10 11v6M14 11v6',
  camera:
    'M3 8a2 2 0 012-2h2.6l1.2-2h6.4L16.6 6H19a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V8zM12 17a4 4 0 100-8 4 4 0 000 8z',
  image: 'M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5zM8 11a2 2 0 100-4 2 2 0 000 4zM3 17l5-5 4 4 4-4 5 5',
  plus: 'M12 5v14M5 12h14',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-3-2V3zM9 8h6M9 12h6M9 16h3',
  inbox: 'M4 13h4l1.5 3h5L16 13h4M4 13l2.5-8h11L20 13v6a2 2 0 01-2 2H6a2 2 0 01-2-2v-6z',
  calendar: 'M4 6a2 2 0 012-2h12a2 2 0 012 2v13a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM4 10h16M9 3v4M15 3v4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 21a7 7 0 0114 0',
  users: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21a7 7 0 0114 0M17 11a4 4 0 000-8M22 21a7 7 0 00-6-6.7',
  external: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4',
  copy: 'M9 9h10a2 2 0 012 2v9a2 2 0 01-2 2H9a2 2 0 01-2-2v-9a2 2 0 012-2zM15 5V3a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h2',
  alert: 'M12 3l9 16H3l9-16zM12 10v4M12 17.5v.5',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
  logout: 'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  mail: 'M3 6a2 2 0 012-2h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6zM3 7l9 6 9-6',
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, strokeWidth = 1.75, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The Viewpoint mark — a lens ring, a brass aperture, the lens-axis line. */
export function Logo({ size = 28, plate = true }: { size?: number; plate?: boolean }) {
  if (!plate) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <circle cx="24" cy="24" r="14" stroke="currentColor" strokeWidth="3.4" />
        <circle cx="24" cy="24" r="5" fill="var(--brass)" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect width="48" height="48" rx="11" fill="var(--brand)" />
      <circle cx="24" cy="24" r="12.5" stroke="var(--paper)" strokeWidth="2.4" />
      <circle cx="24" cy="24" r="4.6" fill="var(--brass)" />
      <path d="M5 24h6M37 24h6" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** Mark + name lockup, used in the sidebar and on auth screens. */
export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="vp-wordmark">
      <Logo size={size + 4} plate={false} />
      <span className="vp-wordmark-name" style={{ fontSize: size }}>
        Viewpoint
      </span>
    </span>
  );
}

/** An inline spinner that inherits `currentColor`. */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="vp-spinner"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
