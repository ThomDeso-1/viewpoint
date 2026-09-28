import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { getCalendarSyncStatus, logout, type CalendarSyncStatus } from '../shared/api';
import { formatRelative } from '../shared/format';
import { Icon, Logo, type IconName } from '../ui/Icon';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Receipts', icon: 'receipt', end: true },
  { to: '/inbox', label: 'Exam requests', icon: 'inbox' },
  { to: '/schedule', label: 'Schedule', icon: 'calendar' },
  { to: '/patients', label: 'Clients', icon: 'users' },
];

/**
 * The application frame for every signed-in screen. Rendered once as a
 * layout route, so the navigation never unmounts (no load-time flash) and
 * the sidebar stays put while the content pane changes.
 *
 * Desktop (≥1024px): a persistent left rail. Narrower: a sticky top bar
 * with the same destinations. Screens fill the pane with <Screen>.
 */
export function AppShell() {
  const navigate = useNavigate();
  const [sync, setSync] = useState<CalendarSyncStatus | null | 'loading'>('loading');

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.resolve()
        .then(() => getCalendarSyncStatus())
        .then((s) => {
          if (live) setSync(s ?? null);
        })
        .catch(() => {
          if (live) setSync(null);
        });
    load();
    const id = window.setInterval(load, 120_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  const handleSignOut = async () => {
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  };

  const navLinks = (variant: 'rail' | 'bar') =>
    NAV.map((item) => (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        className={({ isActive }) =>
          `vp-nav-item vp-nav-item--${variant}${isActive ? ' is-active' : ''}`
        }
      >
        <Icon name={item.icon} size={variant === 'rail' ? 18 : 16} />
        <span>{item.label}</span>
      </NavLink>
    ));

  return (
    <div className="vp-shell">
      <aside className="vp-sidebar">
        <div className="vp-sidebar-brand">
          <Logo size={26} plate={false} />
          <span className="vp-sidebar-name">Viewpoint</span>
        </div>

        <nav className="vp-sidebar-nav" aria-label="Primary">
          {navLinks('rail')}
        </nav>

        <div className="vp-sidebar-foot">
          <NavLink
            to="/settings"
            className={({ isActive }) => `vp-nav-item vp-nav-item--rail${isActive ? ' is-active' : ''}`}
          >
            <Icon name="settings" size={18} />
            <span>Settings</span>
          </NavLink>
          <button type="button" className="vp-nav-item vp-nav-item--rail" onClick={handleSignOut}>
            <Icon name="logout" size={18} />
            <span>Sign out</span>
          </button>
          <SyncLine sync={sync} />
        </div>
      </aside>

      <header className="vp-topbar">
        <NavLink to="/" end className="vp-topbar-brand" aria-label="Viewpoint — Receipts">
          <Logo size={22} plate={false} />
          <span className="vp-sidebar-name">Viewpoint</span>
        </NavLink>
        <nav className="vp-topbar-nav" aria-label="Primary">
          {navLinks('bar')}
        </nav>
        <NavLink
          to="/settings"
          className={({ isActive }) => `vp-topbar-settings${isActive ? ' is-active' : ''}`}
          aria-label="Settings"
        >
          <Icon name="settings" size={18} />
        </NavLink>
      </header>

      <main className="vp-main">
        <Outlet />
      </main>
    </div>
  );
}

function SyncLine({ sync }: { sync: CalendarSyncStatus | null | 'loading' }) {
  if (sync === 'loading') return <span className="vp-sync vp-sync--idle">Checking Outlook…</span>;
  if (!sync || !sync.connected) {
    return <span className="vp-sync vp-sync--off">Outlook not connected</span>;
  }
  return (
    <span className="vp-sync vp-sync--ok">
      Outlook synced{sync.lastSyncedAt ? ` ${formatRelative(sync.lastSyncedAt)}` : ''}
    </span>
  );
}
