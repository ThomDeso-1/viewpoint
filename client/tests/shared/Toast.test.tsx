import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from '../../src/shared/Toast';

afterEach(() => {
  vi.useRealTimers();
});

function Trigger({ message }: { message: string }) {
  const { showToast } = useToast();
  return <button onClick={() => showToast(message)}>trigger</button>;
}

describe('Toast', () => {
  it('throws if useToast is called outside a ToastProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Bare() {
      useToast();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/must be used within a ToastProvider/);
    spy.mockRestore();
  });

  it('shows a toast when showToast is called', async () => {
    render(
      <ToastProvider>
        <Trigger message="Something went wrong." />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByText('trigger'));
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  });

  it('dismisses a toast when it is clicked', async () => {
    render(
      <ToastProvider>
        <Trigger message="Click me away." />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByText('trigger'));
    await userEvent.click(screen.getByText('Click me away.'));
    expect(screen.queryByText('Click me away.')).not.toBeInTheDocument();
  });

  it('auto-dismisses after 4 seconds', async () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger message="Auto dismiss." />
      </ToastProvider>,
    );
    await act(async () => {
      screen.getByText('trigger').click();
    });
    expect(screen.getByText('Auto dismiss.')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText('Auto dismiss.')).not.toBeInTheDocument();
  });

  it('shows multiple simultaneous toasts independently', async () => {
    function MultiTrigger() {
      const { showToast } = useToast();
      return (
        <button
          onClick={() => {
            showToast('First');
            showToast('Second');
          }}
        >
          trigger
        </button>
      );
    }
    render(
      <ToastProvider>
        <MultiTrigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByText('trigger'));
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });
});
