/**
 * Wave API Service — server-side port of WaveAPIService.swift
 *
 * GraphQL client for Wave's public API: fetch businesses, accounts,
 * sales taxes, vendors, and create expense transactions.
 */

const ENDPOINT = 'https://gql.waveapps.com/graphql/public';

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

export interface WaveVendor {
  id: string;
  name: string;
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
    res = await fetch(ENDPOINT, {
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

export async function fetchExpenseAccounts(
  businessId: string,
  token: string,
): Promise<WaveAccount[]> {
  const all = await fetchAccounts(businessId, token);
  return all.filter((a) => a.typeName === 'Expenses' && !a.isArchived);
}

export async function fetchAnchorAccounts(
  businessId: string,
  token: string,
): Promise<WaveAccount[]> {
  const all = await fetchAccounts(businessId, token);
  const anchorSubtypes = new Set(['Cash & Bank', 'Credit Card', 'Loan and Line of Credit']);
  const anchorTypes = new Set(['Assets', 'Liabilities & Credit Cards']);
  return all.filter(
    (a) => anchorTypes.has(a.typeName) && anchorSubtypes.has(a.subtypeName) && !a.isArchived,
  );
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

// ── Vendors ──

export async function fetchVendors(
  businessId: string,
  token: string,
): Promise<WaveVendor[]> {
  const query = `
    query($businessId: ID!) {
      business(id: $businessId) {
        vendors { edges { node { id name } } }
      }
    }
  `;
  const data = await makeRequest(query, { businessId }, token);
  const edges = data.business?.vendors?.edges ?? [];
  return edges.map((e: any) => ({ id: e.node.id, name: e.node.name }));
}

export async function findVendor(
  vendorName: string,
  businessId: string,
  token: string,
): Promise<WaveVendor | null> {
  const vendors = await fetchVendors(businessId, token);
  return (
    vendors.find((v) => v.name.toLowerCase() === vendorName.toLowerCase()) ?? null
  );
}

// ── Create Transaction ──

export async function createExpenseTransaction(opts: {
  businessId: string;
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
    externalId: `viewpoint-${crypto.randomUUID().slice(0, 12)}`,
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
