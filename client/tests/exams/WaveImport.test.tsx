import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaveImportDialog } from '../../src/exams/WaveImport';
import { ToastProvider } from '../../src/shared/Toast';
import type { WaveImportPreview } from '../../src/shared/api';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

const UNVERIFIED = { waveConfigured: true, verifiedAt: null, lastImportAt: null };
const VERIFIED = { waveConfigured: true, verifiedAt: '2026-09-27T12:00:00.000Z', lastImportAt: null };

function makePreview(overrides: Partial<WaveImportPreview> = {}): WaveImportPreview {
  return {
    previewId: 'prev-1',
    fetched: 64,
    archived: 2,
    counts: { new: 42, link: 17, update: 0, unchanged: 0, nameMatch: 1 },
    newByType: { patient: 0, customer: 39, business: 3 },
    newClients: [{ waveId: 'w-new', name: 'Alan Turing', email: null, client_type: 'customer' }],
    links: [],
    nameMatches: [
      {
        waveId: 'w-grace',
        waveName: 'Grace Hopper',
        email: 'g@wave.example',
        phone: null,
        client: { id: 'p-grace', full_name: 'Grace Hopper', email: 'grace@here.example', phone: null, client_type: 'patient' },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
});

function renderDialog(onImported = vi.fn()) {
  render(
    <ToastProvider>
      <WaveImportDialog open onClose={() => {}} onImported={onImported} />
    </ToastProvider>,
  );
  return { onImported };
}

/**
 * Spec (server/exams/wave-import.ts): verify → preview → confirm. The
 * import can't be started until a one-customer verify has passed, and
 * nothing is written until the operator confirms the preview.
 */
describe('WaveImportDialog', () => {
  it('offers only "Verify import" until verification has passed', async () => {
    api.getWaveImportStatus.mockResolvedValue(UNVERIFIED);
    renderDialog();

    expect(await screen.findByRole('button', { name: 'Verify import' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import from Wave' })).not.toBeInTheDocument();
  });

  it('switches to "Import from Wave" once verify passes', async () => {
    api.getWaveImportStatus.mockResolvedValueOnce(UNVERIFIED).mockResolvedValueOnce(VERIFIED);
    api.verifyWaveImport.mockResolvedValue({ ok: true, totalCount: 64 });
    renderDialog();

    await userEvent.click(await screen.findByRole('button', { name: 'Verify import' }));

    expect(await screen.findByRole('button', { name: 'Import from Wave' })).toBeInTheDocument();
    expect(screen.getByText(/Wave reports 64 customers/)).toBeInTheDocument();
  });

  it("shows Wave's error when verify fails", async () => {
    api.getWaveImportStatus.mockResolvedValue(UNVERIFIED);
    api.verifyWaveImport.mockResolvedValue({ ok: false, error: "Cannot query field 'mobile'" });
    renderDialog();

    await userEvent.click(await screen.findByRole('button', { name: 'Verify import' }));

    expect(await screen.findByText(/Cannot query field 'mobile'/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import from Wave' })).not.toBeInTheDocument();
  });

  it('asks to connect Wave first when it is not configured', async () => {
    api.getWaveImportStatus.mockResolvedValue({ ...UNVERIFIED, waveConfigured: false });
    renderDialog();
    expect(await screen.findByText(/Connect Wave/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify import' })).not.toBeInTheDocument();
  });

  it('previews the counts without writing, then applies with the chosen decisions', async () => {
    api.getWaveImportStatus.mockResolvedValue(VERIFIED);
    api.previewWaveImport.mockResolvedValue(makePreview());
    api.applyWaveImport.mockResolvedValue({ created: 42, linked: 18, updated: 0, flagged: 0, skipped: 0 });
    const { onImported } = renderDialog();

    await userEvent.click(await screen.findByRole('button', { name: 'Import from Wave' }));

    expect(await screen.findByText(/39 customers, 3 businesses/)).toBeInTheDocument();
    expect(screen.getByText(/will link to an existing client/)).toBeInTheDocument();
    expect(screen.getByText(/2 archived in Wave/)).toBeInTheDocument();
    expect(api.applyWaveImport).not.toHaveBeenCalled();

    await userEvent.selectOptions(
      screen.getByLabelText('What to do with Grace Hopper'),
      'link',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

    await waitFor(() =>
      expect(api.applyWaveImport).toHaveBeenCalledWith('prev-1', { 'w-grace': 'link' }),
    );
    expect(onImported).toHaveBeenCalled();
  });

  it('defaults a name-only match to "keep separate"', async () => {
    api.getWaveImportStatus.mockResolvedValue(VERIFIED);
    api.previewWaveImport.mockResolvedValue(makePreview());
    api.applyWaveImport.mockResolvedValue({ created: 43, linked: 17, updated: 0, flagged: 1, skipped: 0 });
    renderDialog();

    await userEvent.click(await screen.findByRole('button', { name: 'Import from Wave' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));

    await waitFor(() =>
      expect(api.applyWaveImport).toHaveBeenCalledWith('prev-1', { 'w-grace': 'separate' }),
    );
  });

  it('has nothing to confirm when Wave and the directory already agree', async () => {
    api.getWaveImportStatus.mockResolvedValue(VERIFIED);
    api.previewWaveImport.mockResolvedValue(
      makePreview({
        counts: { new: 0, link: 0, update: 0, unchanged: 5, nameMatch: 0 },
        newByType: { patient: 0, customer: 0, business: 0 },
        newClients: [],
        nameMatches: [],
      }),
    );
    renderDialog();

    await userEvent.click(await screen.findByRole('button', { name: 'Import from Wave' }));

    expect(await screen.findByText(/already up to date/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm import' })).not.toBeInTheDocument();
  });
});
