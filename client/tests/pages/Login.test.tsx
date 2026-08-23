import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Login } from '../../src/pages/Login';

vi.mock('../../src/api/client');
import * as api from '../../src/api/client';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('Login', () => {
  it('disables Sign In until a password is entered', async () => {
    render(<Login onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Password'), 'x');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });

  it('logs in with the entered password and calls onComplete', async () => {
    api.login.mockResolvedValue({ success: true });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<Login onComplete={onComplete} />);

    await userEvent.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(api.login).toHaveBeenCalledWith('hunter2');
    expect(onComplete).toHaveBeenCalled();
  });

  it('shows the server error message on a failed login', async () => {
    api.login.mockRejectedValue(new Error('Incorrect password.'));
    render(<Login onComplete={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Incorrect password.')).toBeInTheDocument();
  });

  it('shows a fallback error message when the failure has no message', async () => {
    api.login.mockRejectedValue({});
    render(<Login onComplete={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/incorrect password/i)).toBeInTheDocument();
  });
});
