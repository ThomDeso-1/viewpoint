import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { getAuthStatus, type AuthStatus } from './api/client';
import { Login } from './pages/Login';
import { Setup } from './pages/Setup';
import { Onboarding } from './pages/Onboarding';
import { ReceiptList } from './pages/ReceiptList';
import { ReceiptReview } from './pages/ReceiptReview';
import { Settings } from './pages/Settings';

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
      setAuth({ authenticated: false, needsSetup: false, needsOnboarding: false });
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

  return (
    <Routes>
      <Route path="/setup" element={<Setup onComplete={checkAuth} />} />
      <Route path="/login" element={<Login onComplete={checkAuth} />} />
      <Route
        path="/onboarding"
        element={
          auth?.authenticated ? <Onboarding onComplete={checkAuth} /> : <Navigate to="/login" replace />
        }
      />
      <Route
        path="/"
        element={auth?.authenticated ? <ReceiptList /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/review/:id"
        element={auth?.authenticated ? <ReceiptReview /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/settings"
        element={auth?.authenticated ? <Settings /> : <Navigate to="/login" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
