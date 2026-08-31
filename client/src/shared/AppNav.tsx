import { NavLink } from 'react-router-dom';

/**
 * The primary navigation band shown on every main screen.
 *
 * Settings sits alone on the left (a fixed anchor, reachable from
 * anywhere); the four screen toggles sit on the right in a stable order
 * so they never move between screens. The active screen is highlighted.
 */
const TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: 'Receipts', end: true },
  { to: '/inbox', label: 'Exam requests' },
  { to: '/schedule', label: 'Schedule' },
  { to: '/patients', label: 'Patients' },
];

export function AppNav() {
  return (
    <nav className="app-nav" aria-label="Primary">
      <NavLink
        to="/settings"
        className={({ isActive }) => 'app-nav-settings' + (isActive ? ' is-active' : '')}
        title="Settings"
        aria-label="Settings"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="10" cy="10" r="2.5" />
          <path
            d="M10 1.5v2M10 16.5v2M3.4 3.4l1.4 1.4M15.2 15.2l1.4 1.4M1.5 10h2M16.5 10h2M3.4 16.6l1.4-1.4M15.2 4.8l1.4-1.4"
            strokeLinecap="round"
          />
        </svg>
      </NavLink>

      <div className="app-nav-toggles">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => 'app-nav-toggle' + (isActive ? ' is-active' : '')}
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
