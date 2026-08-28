/**
 * Wave API Service — server-side port of WaveAPIService.swift
 *
 * GraphQL client for Wave's public API: fetch businesses, accounts,
 * sales taxes, and create expense transactions.
 */

import { endpoint } from './endpoints.js';

// ── Types ──

export interface WaveBusiness {
  id: string;
  name: string;
  isPersonal: boolean;
}

export interface WaveAccount {
  id: string;
  name: string;
  typeName: string;
  subtypeName: string;
  isArchived: boolean;
}

export interface WaveSalesTax {
  id: string;
  name: string;
  rate: number;
}

export interface WaveTransactionResult {
  didSucceed: boolean;
  transactionId: string | null;
  errors: string[];
}

export class WaveAPIError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WaveAPIError';
    this.code = code;
  }

  get isRetryable(): boolean {
    return this.code === 'network_error' || this.code === 'server_error';
  }
}

// ── GraphQL Transport ──

async function makeRequest(
  query: string,
  variables: Record<string, any>,
  token: string,
): Promise<Record<string, any>> {
  let res: Response;

  try {
    res = await fetch(endpoint('waveGraphql'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new WaveAPIError('network_error', `Network error: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    throw new WaveAPIError('token_expired', 'Your Wave access token has expired.');
  }

  if (res.status !== 200) {
    throw new WaveAPIError(
      'server_error',
      `Wave API error (${res.status}): ${res.statusText}`,
    );
  }

  const json = (await res.json()) as any;

  if (json.errors) {
    const messages: string[] = json.errors.map((e: any) => e.message || 'Unknown error');
    if (messages.some((m) => m.toLowerCase().includes('unauthorized'))) {
      throw new WaveAPIError('invalid_token', 'Your Wave access token is invalid.');
    }
    throw new WaveAPIError('graphql_errors', `Wave error: ${messages.join('; ')}`);
  }

  if (!json.data) {
    throw new WaveAPIError('invalid_response', 'Wave returned an unexpected response.');
  }

  return json.data;
}

// ── Businesses ──

export async function fetchBusinesses(token: string): Promise<WaveBusiness[]> {
  const query = `
    query($page: Int!, $pageSize: Int!) {
      businesses(page: $page, pageSize: $pageSize) {
        edges { node { id name isPersonal } }
      }
    }
  `;
  const data = await makeRequest(query, { page: 1, pageSize: 25 }, token);
  const edges = data.businesses?.edges ?? [];
  return edges.map((e: any) => ({
    id: e.node.id,
    name: e.node.name,
    isPersonal: e.node.isPersonal ?? false,
  }));
}

export async function validateToken(token: string): Promise<WaveBusiness[]> {
  const businesses = await fetchBusinesses(token);
  if (businesses.length === 0) {
    throw new WaveAPIError('no_business', 'No Wave business found on this account.');
  }
  return businesses;
}

// ── Accounts ──

export async function fetchAccounts(
  businessId: string,
  token: string,
): Promise<WaveAccount[]> {
  const all: WaveAccount[] = [];
  let page = 1;

  while (page <= 20) {
    const query = `
      query($businessId: ID!, $page: Int!, $pageSize: Int!) {
        business(id: $businessId) {
          accounts(page: $page, pageSize: $pageSize) {
            pageInfo { currentPage totalPages }
            edges {
              node {
                id name
                type { name }
                subtype { name }
                isArchived
              }
            }
          }
        }
      }
    `;
    const data = await makeRequest(query, { businessId, page, pageSize: 50 }, token);
    const accounts = data.business?.accounts;
    const edges = accounts?.edges ?? [];
    const pageInfo = accounts?.pageInfo;

    for (const e of edges) {
      const n = e.node;
      all.push({
        id: n.id,
        name: n.name,
        typeName: n.type?.name ?? '',
        subtypeName: n.subtype?.name ?? '',
        isArchived: n.isArchived ?? false,
      });
    }

    if ((pageInfo?.currentPage ?? page) >= (pageInfo?.totalPages ?? 1)) break;
    page++;
  }

  return all;
}

function isExpenseAccount(a: WaveAccount): boolean {
  return a.typeName === 'Expenses' && !a.isArchived;
}

const ANCHOR_SUBTYPES = new Set(['Cash & Bank', 'Credit Card', 'Loan and Line of Credit']);
const ANCHOR_TYPES = new Set(['Assets', 'Liabilities & Credit Cards']);

function isAnchorAccount(a: WaveAccount): boolean {
  return ANCHOR_TYPES.has(a.typeName) && ANCHOR_SUBTYPES.has(a.subtypeName) && !a.isArchived;
}

export async function fetchExpenseAccounts(
  businessId: string,
  token: string,
): Promise<WaveAccount[]> {
  const all = await fetchAccounts(businessId, token);
  return all.filter(isExpenseAccount);
}

export async function fetchAnchorAccounts(
  businessId: string,
  token: string,
): Promise<WaveAccount[]> {
  const all = await fetchAccounts(businessId, token);
  return all.filter(isAnchorAccount);
}

/**
 * Expense and anchor accounts share the same underlying account list —
 * fetched (and paginated) once here rather than twice, unlike calling
 * fetchExpenseAccounts + fetchAnchorAccounts separately.
 */
export async function fetchExpenseAndAnchorAccounts(
  businessId: string,
  token: string,
): Promise<{ expense: WaveAccount[]; anchor: WaveAccount[] }> {
  const all = await fetchAccounts(businessId, token);
  return { expense: all.filter(isExpenseAccount), anchor: all.filter(isAnchorAccount) };
}

// ── Sales Taxes ──

export async function fetchSalesTaxes(
  businessId: string,
  token: string,
): Promise<WaveSalesTax[]> {
  const query = `
    query($businessId: ID!) {
      business(id: $businessId) {
        salesTaxes { edges { node { id name rate } } }
      }
    }
  `;
  const data = await makeRequest(query, { businessId }, token);
  const edges = data.business?.salesTaxes?.edges ?? [];
  return edges.map((e: any) => ({
    id: e.node.id,
    name: e.node.name,
    rate: e.node.rate,
  }));
}


// ── Create Transaction ──

export async function createExpenseTransaction(opts: {
  businessId: string;
  /**
   * The receipt this transaction is for. Used verbatim (prefixed) as
   * Wave's `externalId`, so a retried request for the same receipt is
   * recognized by Wave as the same transaction instead of creating a
   * duplicate expense — must stay stable across retries, never randomized.
   */
  receiptId: string;
  date: string; // "YYYY-MM-DD"
  description: string;
  amount: number;
  expenseAccountId: string;
  anchorAccountId: string;
  salesTaxId?: string;
  token: string;
}): Promise<WaveTransactionResult> {
  const query = `
    mutation($input: MoneyTransactionCreateInput!) {
      moneyTransactionCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        transaction { id }
      }
    }
  `;

  const lineItem: Record<string, any> = {
    accountId: opts.expenseAccountId,
    amount: opts.amount,
    balance: 'INCREASE',
  };

  if (opts.salesTaxId) {
    lineItem.taxes = [{ salesTaxId: opts.salesTaxId }];
  }

  const input = {
    businessId: opts.businessId,
    externalId: `viewpoint-${opts.receiptId}`,
    date: opts.date,
    description: opts.description,
    anchor: {
      accountId: opts.anchorAccountId,
      amount: opts.amount,
      direction: 'WITHDRAWAL',
    },
    lineItems: [lineItem],
  };

  const data = await makeRequest(query, { input }, opts.token);
  const result = data.moneyTransactionCreate;

  if (!result) {
    throw new WaveAPIError('invalid_response', 'Wave returned an unexpected response.');
  }

  if (result.didSucceed) {
    return {
      didSucceed: true,
      transactionId: result.transaction?.id ?? null,
      errors: [],
    };
  }

  const errors = (result.inputErrors ?? []).map((e: any) => {
    const p = e.path || '';
    const m = e.message || 'Unknown error';
    return p ? `${p}: ${m}` : m;
  });

  return { didSucceed: false, transactionId: null, errors };
}

// ── Health Check ──

export async function checkTokenHealth(token: string): Promise<boolean> {
  try {
    await fetchBusinesses(token);
    return true;
  } catch {
    return false;
  }
}

// ── Customers & Invoices ──
//
// Wave's developer portal blocks automated fetching, so these mutations
// were written from Wave's documented schema rather than generated from
// it. Before trusting them against a live account, verify the input field
// names in the API Playground:
//   https://developer.waveapps.com/hc/en-us/articles/360018937431-API-Playground
// The transport, error taxonomy, and pagination below are all shared with
// the expense path above and are already exercised in production.

export interface WaveCustomer {
  id: string;
  name: string;
  email: string | null;
}

export interface WaveProduct {
  id: string;
  name: string;
  description: string | null;
  unitPrice: number | null;
  isArchived: boolean;
}

export interface WaveInvoiceResult {
  didSucceed: boolean;
  invoiceId: string | null;
  invoiceNumber: string | null;
  viewUrl: string | null;
  pdfUrl: string | null;
  total: number | null;
  errors: string[];
}

/** Flattens Wave's inputErrors into the same shape the expense path uses. */
function collectInputErrors(result: any): string[] {
  return (result?.inputErrors ?? []).map((e: any) => {
    const p = e.path || '';
    const m = e.message || 'Unknown error';
    return p ? `${p}: ${m}` : m;
  });
}

export async function fetchIncomeAccounts(
  businessId: string,
  token: string,
): Promise<WaveAccount[]> {
  const all = await fetchAccounts(businessId, token);
  return all.filter((a) => a.typeName === 'Income' && !a.isArchived);
}

export async function fetchProducts(businessId: string, token: string): Promise<WaveProduct[]> {
  const all: WaveProduct[] = [];
  let page = 1;

  while (page <= 20) {
    const query = `
      query($businessId: ID!, $page: Int!, $pageSize: Int!) {
        business(id: $businessId) {
          products(page: $page, pageSize: $pageSize) {
            pageInfo { currentPage totalPages }
            edges {
              node { id name description unitPrice isArchived }
            }
          }
        }
      }
    `;
    const data = await makeRequest(query, { businessId, page, pageSize: 50 }, token);
    const products = data.business?.products;
    const edges = products?.edges ?? [];
    const pageInfo = products?.pageInfo;

    for (const e of edges) {
      const n = e.node;
      all.push({
        id: n.id,
        name: n.name,
        description: n.description ?? null,
        unitPrice: n.unitPrice != null ? Number(n.unitPrice) : null,
        isArchived: n.isArchived ?? false,
      });
    }

    if ((pageInfo?.currentPage ?? page) >= (pageInfo?.totalPages ?? 1)) break;
    page++;
  }

  return all.filter((p) => !p.isArchived);
}

/**
 * Looks up a customer by email.
 *
 * Wave has no server-side filter for this, so it pages through and
 * matches locally. Called before creating a customer so a returning
 * patient doesn't accumulate duplicate Wave records.
 */
export async function findCustomerByEmail(
  businessId: string,
  email: string,
  token: string,
): Promise<WaveCustomer | null> {
  const target = email.trim().toLowerCase();
  let page = 1;

  while (page <= 20) {
    const query = `
      query($businessId: ID!, $page: Int!, $pageSize: Int!) {
        business(id: $businessId) {
          customers(page: $page, pageSize: $pageSize) {
            pageInfo { currentPage totalPages }
            edges { node { id name email } }
          }
        }
      }
    `;
    const data = await makeRequest(query, { businessId, page, pageSize: 50 }, token);
    const customers = data.business?.customers;
    const edges = customers?.edges ?? [];
    const pageInfo = customers?.pageInfo;

    for (const e of edges) {
      if (e.node.email && e.node.email.trim().toLowerCase() === target) {
        return { id: e.node.id, name: e.node.name, email: e.node.email };
      }
    }

    if ((pageInfo?.currentPage ?? page) >= (pageInfo?.totalPages ?? 1)) break;
    page++;
  }

  return null;
}

export async function createCustomer(opts: {
  businessId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  token: string;
}): Promise<WaveCustomer> {
  const query = `
    mutation($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        customer { id name email }
      }
    }
  `;

  const input: Record<string, any> = {
    businessId: opts.businessId,
    name: opts.name,
  };
  if (opts.email) input.email = opts.email;
  if (opts.phone) input.phone = opts.phone;

  const data = await makeRequest(query, { input }, opts.token);
  const result = data.customerCreate;

  if (!result) {
    throw new WaveAPIError('invalid_response', 'Wave returned an unexpected response.');
  }

  if (!result.didSucceed || !result.customer) {
    throw new WaveAPIError(
      'graphql_errors',
      `Wave rejected the customer: ${collectInputErrors(result).join('; ') || 'unknown reason'}`,
    );
  }

  return {
    id: result.customer.id,
    name: result.customer.name,
    email: result.customer.email ?? null,
  };
}

/** Returns the existing customer for this email, or creates one. */
export async function findOrCreateCustomer(opts: {
  businessId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  token: string;
}): Promise<WaveCustomer> {
  if (opts.email) {
    const existing = await findCustomerByEmail(opts.businessId, opts.email, opts.token);
    if (existing) return existing;
  }
  return createCustomer(opts);
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
