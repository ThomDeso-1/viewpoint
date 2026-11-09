import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudSaveLocation } from '../../src/receipts/CloudSaveLocation';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

const off = {
  options: [{ id: 'icloud', label: 'iCloud Drive' }],
  enabled: false,
  selectedId: null,
  waiting: 0,
  error: null,
};

/**
 * Spec (server/receipts/cloud-folder.ts): the Receipts screen offers the
 * cloud services this Mac is already signed in to, with no sign-in of its
 * own, and says so when a copy can't be made.
 */
describe('CloudSaveLocation', () => {
  beforeEach(() => {
    api.getCloudStorage.mockReset();
    api.setCloudStorage.mockReset();
  });

  it('stays hidden on a machine with no cloud services', async () => {
    api.getCloudStorage.mockResolvedValue({ ...off, options: [] });
    const { container } = render(<CloudSaveLocation />);
    await waitFor(() => expect(api.getCloudStorage).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('chooses iCloud Drive and shows it as the save location', async () => {
    api.getCloudStorage.mockResolvedValue(off);
    api.setCloudStorage.mockResolvedValue({ ...off, enabled: true, selectedId: 'icloud' });
    render(<CloudSaveLocation />);

    await userEvent.click(await screen.findByRole('button', { name: /save to cloud/i }));
    await userEvent.click(screen.getByRole('radio', { name: 'iCloud Drive' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.setCloudStorage).toHaveBeenCalledWith('icloud'));
    expect(await screen.findByText('iCloud Drive')).toBeInTheDocument();
  });

  it('can go back to this Mac only', async () => {
    api.getCloudStorage.mockResolvedValue({ ...off, enabled: true, selectedId: 'icloud' });
    api.setCloudStorage.mockResolvedValue(off);
    render(<CloudSaveLocation />);

    await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByRole('radio', { name: 'This Mac only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.setCloudStorage).toHaveBeenCalledWith(null));
  });

  it('keeps the dialog open and explains when the folder is blocked', async () => {
    api.getCloudStorage.mockResolvedValue(off);
    api.setCloudStorage.mockRejectedValue(new Error('This Mac is blocking Viewpoint from that folder.'));
    render(<CloudSaveLocation />);

    await userEvent.click(await screen.findByRole('button', { name: /save to cloud/i }));
    await userEvent.click(screen.getByRole('radio', { name: 'iCloud Drive' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/blocking viewpoint/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'iCloud Drive' })).toBeInTheDocument();
  });

  it('shows a sync problem on the screen', async () => {
    api.getCloudStorage.mockResolvedValue({
      ...off,
      enabled: true,
      selectedId: 'icloud',
      waiting: 3,
      error: 'There is not enough space for the cloud copies.',
    });
    render(<CloudSaveLocation />);
    expect(await screen.findByText(/not enough space/i)).toBeInTheDocument();
    expect(screen.getByText(/3 waiting/)).toBeInTheDocument();
  });
});
