import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UploadStatusBar } from '../../src/components/UploadStatusBar';

describe('UploadStatusBar', () => {
  it('renders nothing when every count is zero', () => {
    const { container } = render(
      <UploadStatusBar queue={{ uploaded: 0, pending: 0, failed: 0, captured: 0 }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('only shows pills for non-zero categories', () => {
    render(<UploadStatusBar queue={{ uploaded: 3, pending: 0, failed: 0, captured: 0 }} />);
    expect(screen.getByText('3 Uploaded')).toBeInTheDocument();
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/captured/i)).not.toBeInTheDocument();
  });

  it('shows all four pills when every count is non-zero', () => {
    render(<UploadStatusBar queue={{ uploaded: 1, pending: 2, failed: 3, captured: 4 }} />);
    expect(screen.getByText('4 Captured')).toBeInTheDocument();
    expect(screen.getByText('2 Pending')).toBeInTheDocument();
    expect(screen.getByText('3 Failed')).toBeInTheDocument();
    expect(screen.getByText('1 Uploaded')).toBeInTheDocument();
  });
});
