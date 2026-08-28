/**
 * Wave reference data: businesses, accounts (expense / anchor / income),
 * sales taxes, and products — the read-only lookups the Settings screen
 * populates its dropdowns from, plus `validateToken` / `checkTokenHealth`.
 *
 * Split out of the old `wave.ts` (audit P2-26).
 */

import { makeRequest, WaveAPIError } from './transport.js';

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

export interface WaveProduct {
  id: string;
  name: string;
  description: string | null;
  unitPrice: number | null;
  isArchived: boolean;
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

export async function fetchIncomeAccounts(
  businessId: string,
  token: string,
): Promise<WaveAccount[]> {
  const all = await fetchAccounts(businessId, token);
  return all.filter((a) => a.typeName === 'Income' && !a.isArchived);
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

// ── Products ──

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

// ── Health Check ──

export async function checkTokenHealth(token: string): Promise<boolean> {
  try {
    await fetchBusinesses(token);
    return true;
  } catch {
    return false;
  }
}
