import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Setup } from '../../src/pages/Setup';

vi.mock('../../src/api/client');
import * as api from '../../src/api/client';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

/**
 * Spec (server/routes/auth.ts): password must be at least 4 characters.
 * The client mirrors that rule client-side (CONVERSION-PLAN.md: "same
 * fields, same validations") and additionally requires the two entries
 * to match before ever calling the API.
 */
describe('Setup', () => {
  it('disables Get Started until both fields have something in them', async () => {
    render(<Setup onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: /get started/i })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Choose a password'), 'abcd');
    expect(screen.getByRole('button', { name: /get started/i })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Confirm password'), 'abcd');
    expect(screen.getByRole('button', { name: /get started/i })).toBeEnabled();
  });

  it('rejects a password shorter than 4 characters without calling the API', async () => {
    render(<Setup onComplete={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('Choose a password'), 'abc');
    await userEvent.type(screen.getByPlaceholderText('Confirm password'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: /get started/i }));

    expect(screen.getByText(/at least 4 characters/i)).toBeInTheDocument();
    expect(api.setup).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords without calling the API', async () => {
    render(<Setup onComplete={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('Choose a password'), 'abcdef');
    await userEvent.type(screen.getByPlaceholderText('Confirm password'), 'abcdeg');
    await userEvent.click(screen.getByRole('button', { name: /get started/i }));

    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
    expect(api.setup).not.toHaveBeenCalled();
  });

  it('submits a valid matching password and calls onComplete', async () => {
    api.setup.mockResolvedValue({ success: true });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<Setup onComplete={onComplete} />);

    await userEvent.type(screen.getByPlaceholderText('Choose a password'), 'abcdef');
    await userEvent.type(screen.getByPlaceholderText('Confirm password'), 'abcdef');
    await userEvent.click(screen.getByRole('button', { name: /get started/i }));

    expect(api.setup).toHaveBeenCalledWith('abcdef');
    expect(onComplete).toHaveBeenCalled();
  });

  it('shows the server error if setup fails', async () => {
    api.setup.mockRejectedValue(new Error('Password is already set. Use login instead.'));
    render(<Setup onComplete={vi.fn()} />);

    await userEvent.type(screen.getByPlaceholderText('Choose a password'), 'abcdef');
    await userEvent.type(screen.getByPlaceholderText('Confirm password'), 'abcdef');
    await userEvent.click(screen.getByRole('button', { name: /get started/i }));

    expect(await screen.findByText(/already set/i)).toBeInTheDocument();
  });
});
