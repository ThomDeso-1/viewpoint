import { useEffect, useState, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { getAuthStatus, type AuthStatus } from './shared/api';
import { Login } from './auth/Login';
import { Setup } from './auth/Setup';
import { Onboarding } from './auth/Onboarding';
import { ReceiptList } from './receipts/ReceiptList';
import { ReceiptReview } from './receipts/ReceiptReview';
import { BatchReview } from './receipts/BatchReview';
import { Settings } from './receipts/Settings';
import { Inbox } from './exams/Inbox';
import { PatientDetail } from './exams/PatientDetail';
import { Patients } from './exams/Patients';
import { AuditLog } from './exams/AuditLog';

// Split off the Schedule screen — it pulls in FullCalendar (~90 kB gzip),
// which no other screen needs and which most sessions never open.
const Schedule = lazy(() => import('./exams/Schedule').then((m) => ({ default: m.Schedule })));

/**
 * Where a route guard should send an incomplete/unauthenticated session,
 * computed from `auth` rather than hardcoded to '/login'.
 *
 * This matters on the very first render after `loading` flips to false:
 * <Routes> can mount and match against a location that predates the
 * navigate() call checkAuth just made below (a lag in the router's own
 * location state vs. this component's `auth`/`loading` state, observed
 * empirically — not guaranteed to resolve within any fixed number of
 * ticks). If every guard falls back to gateTarget(auth) instead of a
 * hardcoded '/login', the fallback is correct regardless of which stale
 * route <Routes> happens to match on that first render, so the race can't
 * strand a first-run or needs-onboarding user on a login screen they have
 * no way to use yet.
 */
function gateTarget(auth: AuthStatus | null): string {
  if (!auth || auth.needsSetup) return '/setup';
  if (!auth.authenticated) return '/login';
  if (auth.needsOnboarding) return '/onboarding';
  return '/';
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const checkAuth = async () => {
    try {
      const status = await getAuthStatus();
      setAuth(status);

      if (status.needsSetup) {
        navigate('/setup', { replace: true });
      } else if (!status.authenticated) {
        navigate('/login', { replace: true });
      } else if (status.needsOnboarding) {
        navigate('/onboarding', { replace: true });
      }
    } catch {
      setAuth({ authenticated: false, needsSetup: false, needsOnboarding: false, ohipEnabled: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
      </div>
    );
  }

  const authed = !!auth?.authenticated;
  const ohipEnabled = !!auth?.ohipEnabled;

  return (
    <Routes>
      {/* Once the user is past a gate, don't let them sit on its screen —
          after a successful login/setup, checkAuth updates `auth` but the
          URL is still /login or /setup, and nothing else navigates away. */}
      <Route
        path="/setup"
        element={
          auth && !auth.needsSetup ? <Navigate to={gateTarget(auth)} replace /> : <Setup onComplete={checkAuth} />
        }
      />
      <Route
        path="/login"
        element={authed ? <Navigate to={gateTarget(auth)} replace /> : <Login onComplete={checkAuth} />}
      />
      <Route
        path="/onboarding"
        element={
          authed ? (
            <Onboarding onComplete={checkAuth} ohipEnabled={ohipEnabled} />
          ) : (
            <Navigate to={gateTarget(auth)} replace />
          )
        }
      />
      <Route path="/" element={authed ? <ReceiptList /> : <Navigate to={gateTarget(auth)} replace />} />
      <Route
        path="/review/:id"
        element={authed ? <ReceiptReview /> : <Navigate to={gateTarget(auth)} replace />}
      />
      <Route
        path="/review-batch"
        element={authed ? <BatchReview /> : <Navigate to={gateTarget(auth)} replace />}
      />
      <Route
        path="/settings"
        element={authed ? <Settings ohipEnabled={ohipEnabled} /> : <Navigate to={gateTarget(auth)} replace />}
      />
      <Route
        path="/inbox"
        element={authed ? <Inbox ohipEnabled={ohipEnabled} /> : <Navigate to={gateTarget(auth)} replace />}
      />
      <Route
        path="/schedule"
        element={
          authed ? (
            <Suspense fallback={<div className="loading-screen"><div className="loading-spinner" /></div>}>
              <Schedule ohipEnabled={ohipEnabled} />
            </Suspense>
          ) : (
            <Navigate to={gateTarget(auth)} replace />
          )
        }
      />
      <Route path="/patients" element={authed ? <Patients /> : <Navigate to={gateTarget(auth)} replace />} />
      <Route
        path="/patients/:id"
        element={authed ? <PatientDetail ohipEnabled={ohipEnabled} /> : <Navigate to={gateTarget(auth)} replace />}
      />
      <Route path="/audit" element={authed ? <AuditLog /> : <Navigate to={gateTarget(auth)} replace />} />
      <Route path="*" element={<Navigate to={gateTarget(auth)} replace />} />
    </Routes>
  );
}
