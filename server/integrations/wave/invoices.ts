/**
 * Wave invoices — draft, approve, send. The patient-facing write path,
 * only ever reached after the operator taps Approve. Split out of the old
 * `wave.ts` (audit P2-26).
 *
 * As with customers.ts, the input field names were written from Wave's
 * docs rather than generated — verify before the first real invoice.
 */

import { makeRequest, collectInputErrors, WaveAPIError } from './transport.js';

export interface WaveInvoiceResult {
  didSucceed: boolean;
  invoiceId: string | null;
  invoiceNumber: string | null;
  viewUrl: string | null;
  pdfUrl: string | null;
  total: number | null;
  errors: string[];
}

export interface InvoiceLineItem {
  /** A Wave product, or an income account via `accountId` below. */
  productId?: string;
  accountId?: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  salesTaxId?: string;
}

/**
 * Creates a *draft* invoice. Nothing is sent to the patient here —
 * approving and sending are separate, deliberate steps.
 */
export async function createInvoice(opts: {
  businessId: string;
  customerId: string;
  items: InvoiceLineItem[];
  invoiceDate: string; // "YYYY-MM-DD"
  dueDate?: string;
  memo?: string;
  currency?: string;
  token: string;
}): Promise<WaveInvoiceResult> {
  const query = `
    mutation($input: InvoiceCreateInput!) {
      invoiceCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        invoice {
          id
          invoiceNumber
          status
          viewUrl
          pdfUrl
          total { value }
        }
      }
    }
  `;

  const input: Record<string, any> = {
    businessId: opts.businessId,
    customerId: opts.customerId,
    invoiceDate: opts.invoiceDate,
    items: opts.items.map((item) => {
      const line: Record<string, any> = {
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      };
      if (item.productId) line.productId = item.productId;
      if (item.accountId) line.accountId = item.accountId;
      if (item.description) line.description = item.description;
      if (item.salesTaxId) line.taxes = [{ salesTaxId: item.salesTaxId }];
      return line;
    }),
  };

  if (opts.dueDate) input.dueDate = opts.dueDate;
  if (opts.memo) input.memo = opts.memo;
  if (opts.currency) input.currency = opts.currency;

  const data = await makeRequest(query, { input }, opts.token);
  const result = data.invoiceCreate;

  if (!result) {
    throw new WaveAPIError('invalid_response', 'Wave returned an unexpected response.');
  }

  if (!result.didSucceed) {
    return {
      didSucceed: false,
      invoiceId: null,
      invoiceNumber: null,
      viewUrl: null,
      pdfUrl: null,
      total: null,
      errors: collectInputErrors(result),
    };
  }

  const invoice = result.invoice ?? {};
  return {
    didSucceed: true,
    invoiceId: invoice.id ?? null,
    invoiceNumber: invoice.invoiceNumber ?? null,
    viewUrl: invoice.viewUrl ?? null,
    pdfUrl: invoice.pdfUrl ?? null,
    total: invoice.total?.value != null ? Number(invoice.total.value) : null,
    errors: [],
  };
}

/** Moves a draft invoice to approved. Required before it can be sent. */
export async function approveInvoice(invoiceId: string, token: string): Promise<WaveInvoiceResult> {
  const query = `
    mutation($input: InvoiceApproveInput!) {
      invoiceApprove(input: $input) {
        didSucceed
        inputErrors { path message code }
        invoice { id invoiceNumber status viewUrl pdfUrl total { value } }
      }
    }
  `;

  const data = await makeRequest(query, { input: { invoiceId } }, token);
  const result = data.invoiceApprove;

  if (!result) {
    throw new WaveAPIError('invalid_response', 'Wave returned an unexpected response.');
  }

  const invoice = result.invoice ?? {};
  return {
    didSucceed: !!result.didSucceed,
    invoiceId: invoice.id ?? invoiceId,
    invoiceNumber: invoice.invoiceNumber ?? null,
    viewUrl: invoice.viewUrl ?? null,
    pdfUrl: invoice.pdfUrl ?? null,
    total: invoice.total?.value != null ? Number(invoice.total.value) : null,
    errors: result.didSucceed ? [] : collectInputErrors(result),
  };
}

/**
 * Emails the invoice to the customer from Wave.
 *
 * This is patient-facing, so it only ever runs after the operator has
 * approved the drafted request.
 */
export async function sendInvoice(opts: {
  invoiceId: string;
  to: string;
  subject?: string;
  message?: string;
  attachPDF?: boolean;
  token: string;
}): Promise<{ didSucceed: boolean; errors: string[] }> {
  const query = `
    mutation($input: InvoiceSendInput!) {
      invoiceSend(input: $input) {
        didSucceed
        inputErrors { path message code }
      }
    }
  `;

  const input: Record<string, any> = {
    invoiceId: opts.invoiceId,
    to: opts.to,
    attachPDF: opts.attachPDF ?? true,
  };
  if (opts.subject) input.subject = opts.subject;
  if (opts.message) input.message = opts.message;

  const data = await makeRequest(query, { input }, opts.token);
  const result = data.invoiceSend;

  if (!result) {
    throw new WaveAPIError('invalid_response', 'Wave returned an unexpected response.');
  }

  return {
    didSucceed: !!result.didSucceed,
    errors: result.didSucceed ? [] : collectInputErrors(result),
  };
}
