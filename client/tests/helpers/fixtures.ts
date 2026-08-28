import type { ReceiptRow } from '../../src/shared/api';

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

// ── Practice fixtures ──

import type { ExamRequest, Patient, Appointment, EligibilityCheck, EligibilityOutcome } from '../../src/shared/api';

export function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'patient-1',
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '555-0100',
    date_of_birth: '1990-01-01',
    has_health_card: true,
    health_card_masked: '•••• ••7890',
    health_card_version: 'AB',
    wave_customer_id: null,
    notes: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeEligibility(overrides: Partial<EligibilityCheck> = {}): EligibilityCheck {
  return {
    id: 'check-1',
    checked_at: '2026-08-20T12:00:00.000Z',
    date_of_service: '2026-09-01',
    is_eligible: true,
    response_code: '50',
    response_description: 'Health card is valid.',
    error: null,
    mode: 'mock',
    ...overrides,
  };
}

/** What the check-eligibility routes return (camelCase) — vs the snake_case history DTO. */
export function makeEligibilityOutcome(
  overrides: Partial<EligibilityOutcome> = {},
): EligibilityOutcome {
  return {
    checkId: 'check-1',
    isEligible: true,
    responseCode: '50',
    responseDescription: 'Health card is valid.',
    mode: 'mock',
    error: null,
    checkedAt: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
}

export function makeAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'appt-1',
    patient_id: 'patient-1',
    google_event_id: 'evt-1',
    starts_at: '2026-09-01T14:00:00.000Z',
    ends_at: '2026-09-01T14:30:00.000Z',
    title: 'Eye exam',
    location: null,
    status: 'scheduled',
    source: 'google',
    ...overrides,
  };
}

export function makeExamRequest(overrides: Partial<ExamRequest> = {}): ExamRequest {
  return {
    id: 'req-1',
    status: 'drafted',
    received_at: '2026-08-20T09:00:00.000Z',
    from_address: 'ada@example.com',
    subject: 'Eye exam request',
    has_source: true,
    extraction: {
      patient_name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '555-0100',
      date_of_birth: '1990-01-01',
      health_card_masked: '•••• ••7890',
      health_card_version: 'AB',
      requested_date: '2026-09-01',
      requested_time: '10:00',
      reason: 'Annual exam',
      confidence: 0.95,
    },
    last_error: null,
    retry_count: 0,
    patient: makePatient(),
    appointment: makeAppointment(),
    eligibility: makeEligibility(),
    reminder: {
      id: 'rem-1',
      status: 'pending',
      channel: 'email',
      scheduled_for: '2026-08-31T14:00:00.000Z',
      subject: 'Reminder: your eye exam',
      body: 'Hello Ada,\n\nThis is a reminder…',
      sent_at: null,
      last_error: null,
    },
    invoice: {
      id: 'inv-row-1',
      status: 'draft',
      amount: 120,
      currency: 'CAD',
      wave_invoice_id: null,
      wave_invoice_url: null,
      invoice_number: null,
      last_error: null,
      line_items: [{ description: 'Comprehensive eye examination', quantity: 1, unitPrice: 120 }],
      editable: true,
    },
    ...overrides,
  };
}
