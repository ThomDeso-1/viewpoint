import { useState, type FormEvent } from 'react';
import { login } from '../shared/api';
import { Logo } from '../ui/Icon';

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
          <Logo size={52} />
        </div>
        <h1>Viewpoint</h1>
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
