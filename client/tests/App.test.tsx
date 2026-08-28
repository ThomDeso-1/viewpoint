import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';
import { ToastProvider } from '../src/shared/Toast';

/**
 * Spec (client/src/App.tsx routing gate, mirroring the server's auth
 * state machine): on load, the app checks /api/auth/status and routes:
 *   needsSetup        -> /setup
 *   !authenticated     -> /login
 *   needsOnboarding    -> /onboarding
 *   authenticated, done -> the requested page (default: receipt list)
 */
vi.mock('../src/shared/api');
import * as api from '../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listReceipts.mockResolvedValue([]);
  api.getQueueStatus.mockResolvedValue({ uploaded: 0, pending: 0, failed: 0, captured: 0 });
  api.getHealthStatus.mockResolvedValue({ claudeConfigured: false, claudeHealthy: null, waveConfigured: false, waveHealthy: null });
  // ReceiptList reads this for the demo-mode banner.
  api.getSettings.mockResolvedValue({ demoMode: false } as any);
});

function renderApp(initialPath = '/') {
  // Matches the real provider tree in main.tsx — ReceiptList and other
  // pages call useToast(), which throws outside a ToastProvider.
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('App routing gate', () => {
  // Regression coverage: these two used to fail because setLoading(false)
  // and navigate() landed in the same React commit as <Routes> mounting
  // for the first time, so <Routes> rendered against the stale "/"
  // location and its own <Navigate to="/login"> fallback won the race —
  // silently sending first-run/needs-onboarding users to Login. Only the
  // plain "unauthenticated" case masked this, since its target happens to
  // also be /login. Fixed in App.tsx by yielding a microtask before
  // setLoading(false).
  it('sends a first-run user to Setup', async () => {
    api.getAuthStatus.mockResolvedValue({ authenticated: false, needsSetup: true, needsOnboarding: false });
    renderApp();
    await waitFor(() => expect(screen.getByText(/set a password/i)).toBeInTheDocument());
  });

  it('sends an unauthenticated user to Login', async () => {
    api.getAuthStatus.mockResolvedValue({ authenticated: false, needsSetup: false, needsOnboarding: false });
    renderApp();
    await waitFor(() => expect(screen.getByText(/enter your password/i)).toBeInTheDocument());
  });

  it('sends an authenticated-but-not-onboarded user to Onboarding', async () => {
    api.getAuthStatus.mockResolvedValue({ authenticated: true, needsSetup: false, needsOnboarding: true });
    renderApp();
    await waitFor(() => expect(screen.getByText(/claude api key/i)).toBeInTheDocument());
  });

  it('shows the receipt list for a fully authenticated, onboarded user', async () => {
    api.getAuthStatus.mockResolvedValue({ authenticated: true, needsSetup: false, needsOnboarding: false });
    renderApp();
    await waitFor(() => expect(screen.getByText(/no receipts yet/i)).toBeInTheDocument());
  });

  it('treats a failed auth check as unauthenticated rather than crashing', async () => {
    api.getAuthStatus.mockRejectedValue(new Error('network down'));
    renderApp();
    await waitFor(() => expect(screen.getByText(/enter your password/i)).toBeInTheDocument());
  });

  it('redirects away from /onboarding for a user who is not authenticated', async () => {
    api.getAuthStatus.mockResolvedValue({ authenticated: false, needsSetup: false, needsOnboarding: false });
    renderApp('/onboarding');
    await waitFor(() => expect(screen.getByText(/enter your password/i)).toBeInTheDocument());
  });

  it('leaves /login for the app once the user is authenticated', async () => {
    // After a successful login, checkAuth updates auth state but the URL
    // is still /login; the route guard has to carry the user through.
    api.getAuthStatus.mockResolvedValue({ authenticated: true, needsSetup: false, needsOnboarding: false });
    renderApp('/login');
    await waitFor(() => expect(screen.getByText(/no receipts yet/i)).toBeInTheDocument());
  });

  it('leaves /setup for onboarding once a password exists', async () => {
    api.getAuthStatus.mockResolvedValue({ authenticated: true, needsSetup: false, needsOnboarding: true });
    renderApp('/setup');
    await waitFor(() => expect(screen.getByText(/claude api key/i)).toBeInTheDocument());
  });

  it('redirects an unknown path back to the app root', async () => {
    api.getAuthStatus.mockResolvedValue({ authenticated: true, needsSetup: false, needsOnboarding: false });
    renderApp('/some/unknown/path');
    await waitFor(() => expect(screen.getByText(/no receipts yet/i)).toBeInTheDocument());
  });

  it('sends a first-run user to Setup even when deep-linked straight into a protected page', async () => {
    // The worse-case version of the same race: every protected route's
    // guard used to fall back to a hardcoded '/login', which a first-run
    // user has no way to use (no password exists yet).
    api.getAuthStatus.mockResolvedValue({ authenticated: false, needsSetup: true, needsOnboarding: false });
    renderApp('/settings');
    await waitFor(() => expect(screen.getByText(/set a password/i)).toBeInTheDocument());
  });

});
