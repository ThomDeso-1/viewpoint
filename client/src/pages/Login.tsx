import { useState, type FormEvent } from 'react';
import { login } from '../api/client';

interface Props {
  onComplete: () => Promise<void>;
}

export function Login({ onComplete }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await login(password);
      await onComplete();
    } catch (err: any) {
      setError(err.message || 'Incorrect password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="12" fill="var(--accent)" />
            <path d="M14 34V18L24 12L34 18V34" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M20 34V26H28V34" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="21" r="2.5" stroke="white" strokeWidth="2" />
          </svg>
        </div>
        <h1>Viewpoint Receipts</h1>
        <p className="auth-subtitle">Enter your password to continue</p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
            className="auth-input"
          />
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="auth-button" disabled={submitting || !password}>
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
