import type { ReceiptRow } from '../../src/api/client';

export function makeReceipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id: 'receipt-1',
    primary_image: '2026-01/2026-01-01_abcd1234.jpg',
    additional_images: '[]',
    receipt_date: '2026-01-01T00:00:00.000Z',
    capture_date: '2026-01-01T00:00:00.000Z',
    month_folder: '2026-01',
    status: 'captured',
    vendor: null,
    summary: null,
    total_amount: null,
    tax_amount: null,
    currency: 'CAD',
    extracted_json: null,
    wave_txn_id: null,
    last_error: null,
    retry_count: 0,
    image_hash: 'abc123',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
