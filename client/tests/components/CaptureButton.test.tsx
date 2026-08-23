import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CaptureButton } from '../../src/components/CaptureButton';
import { ToastProvider } from '../../src/components/Toast';

vi.mock('../../src/api/client');
import * as api from '../../src/api/client';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

function renderButton(onCapture = vi.fn()) {
  render(
    <ToastProvider>
      <CaptureButton onCapture={onCapture} />
    </ToastProvider>,
  );
  return onCapture;
}

function fakeFile(name = 'receipt.jpg') {
  return new File(['bytes'], name, { type: 'image/jpeg' });
}

/**
 * Spec (GETTING-STARTED.md "Using it day to day" step 1; CaptureButton.tsx):
 * tapping + opens Camera/Photo Library options; picking a file uploads it
 * and calls onCapture() to refresh the list; a failed upload shows a
 * toast rather than losing the photo silently.
 */
describe('CaptureButton', () => {
  it('opens the camera/library menu on tap', async () => {
    renderButton();
    // The FAB has no accessible name (icon-only) and is the only button
    // present before the menu opens.
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(screen.getByText('Photo Library')).toBeInTheDocument();
  });

  it('uploads a selected file and calls onCapture on success', async () => {
    api.uploadImages.mockResolvedValue([{ id: 'r1' }]);
    const onCapture = renderButton();

    const galleryInput = document.querySelector('input[type=file]:not([capture])') as HTMLInputElement;
    await userEvent.upload(galleryInput, fakeFile());

    expect(api.uploadImages).toHaveBeenCalled();
    const uploadedFiles = api.uploadImages.mock.calls[0][0];
    expect(uploadedFiles).toHaveLength(1);
    expect(onCapture).toHaveBeenCalled();
  });

  it('shows a toast and does not call onCapture if the upload fails', async () => {
    api.uploadImages.mockRejectedValue(new Error('Only image files are allowed.'));
    const onCapture = renderButton();

    const galleryInput = document.querySelector('input[type=file]:not([capture])') as HTMLInputElement;
    await userEvent.upload(galleryInput, fakeFile());

    expect(await screen.findByText('Only image files are allowed.')).toBeInTheDocument();
    expect(onCapture).not.toHaveBeenCalled();
  });

  it('supports selecting multiple files from the photo library at once', async () => {
    api.uploadImages.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    renderButton();

    const galleryInput = document.querySelector('input[type=file]:not([capture])') as HTMLInputElement;
    await userEvent.upload(galleryInput, [fakeFile('a.jpg'), fakeFile('b.jpg')]);

    expect(api.uploadImages.mock.calls[0][0]).toHaveLength(2);
  });
});
