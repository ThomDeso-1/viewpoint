import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailTemplateSettings } from '../../src/exams/EmailTemplateSettings';
import { ToastProvider } from '../../src/shared/Toast';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

const RESPONSE = {
  templates: {
    reminder: {
      subject: 'Reminder: your eye exam on {{appointmentTime}}',
      body: 'Hello {{firstName}},',
      customised: false,
    },
    followup: {
      subject: 'Time for your next eye exam at {{business}}',
      body: 'Hello {{firstName}},',
      customised: true,
    },
  },
  defaults: {
    reminder: { subject: 'Reminder: your eye exam on {{appointmentTime}}', body: 'Hello {{firstName}},' },
    followup: { subject: 'Time for your next eye exam at {{business}}', body: 'Hello {{firstName}},' },
  },
  placeholders: {
    reminder: [{ token: 'appointmentTime', description: 'The appointment date and time' }],
    followup: [{ token: 'cadence', description: 'How often an exam is recommended' }],
  },
};

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getEmailTemplates.mockResolvedValue(structuredClone(RESPONSE));
  api.saveEmailTemplate.mockResolvedValue({
    success: true,
    template: { subject: 'x', body: 'y' },
    customised: true,
  });
  api.resetEmailTemplate.mockResolvedValue({
    success: true,
    template: RESPONSE.defaults.followup,
    customised: false,
  });
});

function renderPanel() {
  return render(
    <ToastProvider>
      <EmailTemplateSettings />
    </ToastProvider>,
  );
}

describe('EmailTemplateSettings', () => {
  it('shows both templates with their current wording', async () => {
    renderPanel();
    expect(
      await screen.findByDisplayValue('Reminder: your eye exam on {{appointmentTime}}'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('Time for your next eye exam at {{business}}')).toBeInTheDocument();
  });

  it('lists the placeholders a template understands', async () => {
    renderPanel();
    await screen.findByRole('button', { name: /Save Appointment reminder template/i });
    expect(screen.getByText(/The appointment date and time/i)).toBeInTheDocument();
    expect(screen.getByText(/How often an exam is recommended/i)).toBeInTheDocument();
  });

  it('saves an edited template', async () => {
    renderPanel();
    const subject = await screen.findByDisplayValue(
      'Reminder: your eye exam on {{appointmentTime}}',
    );
    await userEvent.clear(subject);
    await userEvent.type(subject, 'See you soon');
    await userEvent.click(
      screen.getByRole('button', { name: /Save Appointment reminder template/i }),
    );

    await waitFor(() => expect(api.saveEmailTemplate).toHaveBeenCalled());
    expect(api.saveEmailTemplate.mock.calls[0][0]).toBe('reminder');
    expect(api.saveEmailTemplate.mock.calls[0][1].subject).toBe('See you soon');
  });

  it('blocks a save with an empty body', async () => {
    renderPanel();
    const bodies = await screen.findAllByLabelText('Message');
    await userEvent.clear(bodies[0]);
    await userEvent.click(
      screen.getByRole('button', { name: /Save Appointment reminder template/i }),
    );

    expect(await screen.findByText(/needs both a subject and a message/i)).toBeInTheDocument();
    expect(api.saveEmailTemplate).not.toHaveBeenCalled();
  });

  it('offers Reset only for a customised template', async () => {
    renderPanel();
    await screen.findByRole('button', { name: /Save Appointment reminder template/i });

    expect(
      screen.queryByRole('button', { name: /Reset Appointment reminder template to default/i }),
    ).not.toBeInTheDocument();

    const resetBtn = screen.getByRole('button', {
      name: /Reset Recall \/ follow-up email template to default/i,
    });
    await userEvent.click(resetBtn);
    await waitFor(() => expect(api.resetEmailTemplate).toHaveBeenCalledWith('followup'));
  });
});
