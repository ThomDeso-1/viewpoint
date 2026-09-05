import { useState, type FormEvent } from 'react';
import { setup } from '../shared/api';
import { Logo } from '../ui/Icon';

interface Props {
  onComplete: () => Promise<void>;
}

export function Setup({ onComplete }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await setup(password);
      await onComplete();
    } catch (err: any) {
      setError(err.message || 'Setup failed.');
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
        <p className="wizard-steps">Step 1</p>
        <h1>Welcome to Viewpoint</h1>
        <p className="auth-subtitle">Set a password to protect your receipts</p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Choose a password"
            autoFocus
            autoComplete="new-password"
            className="auth-input"
          />
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            autoComplete="new-password"
            className="auth-input"
          />
          {error && <p className="auth-error">{error}</p>}
          <button
            type="submit"
            className="auth-button"
            disabled={submitting || !password || !confirm}
          >
            {submitting ? 'Setting up…' : 'Get Started'}
          </button>
        </form>
      </div>
    </div>
  );
}
