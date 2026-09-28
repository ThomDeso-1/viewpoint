/**
 * Wave customers — looked up or created before an invoice so a returning
 * patient doesn't accumulate duplicate Wave records, and read in bulk by
 * the one-time client import (server/exams/wave-import.ts). Split out of
 * the old `wave.ts` (audit P2-26).
 *
 * Wave's developer portal blocks automated schema fetching, so the input
 * field names here were written from Wave's documented schema rather than
 * generated from it — verify them in the API Playground before the first
 * real invoice (see AGENTS.md §6).
 */

import { makeRequest, collectInputErrors, WaveAPIError } from './transport.js';

export interface WaveCustomer {
  id: string;
  name: string;
  email: string | null;
}

/**
 * Looks up a customer by email.
 *
 * Wave has no server-side filter for this, so it pages through and
 * matches locally.
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

/** A Wave customer with every field the client import maps. */
export interface WaveCustomerRecord {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  /** Formatted one-line address, or null when Wave has none. */
  address: string | null;
  internalNotes: string | null;
  isArchived: boolean;
}

export interface WaveCustomerPage {
  customers: WaveCustomerRecord[];
  currentPage: number;
  totalPages: number;
  totalCount: number | null;
}

/**
 * The one query both the import's "verify" pass and its full read use.
 * Verify runs it for a single row, so a field name Wave doesn't recognise
 * fails there — as a GraphQL error naming the field — before anything is
 * read in bulk. Keep the two paths on this constant.
 */
const CUSTOMER_PAGE_QUERY = `
  query($businessId: ID!, $page: Int!, $pageSize: Int!) {
    business(id: $businessId) {
      customers(page: $page, pageSize: $pageSize) {
        pageInfo { currentPage totalPages totalCount }
        edges {
          node {
            id name firstName lastName email phone mobile internalNotes isArchived
            address {
              addressLine1 addressLine2 city postalCode
              province { name }
              country { name }
            }
          }
        }
      }
    }
  }
`;

function formatAddress(a: any): string | null {
  if (!a) return null;
  const parts = [
    a.addressLine1,
    a.addressLine2,
    a.city,
    a.province?.name,
    a.postalCode,
    a.country?.name,
  ]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function blankToNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function fetchCustomerPage(
  businessId: string,
  page: number,
  pageSize: number,
  token: string,
): Promise<WaveCustomerPage> {
  const data = await makeRequest(CUSTOMER_PAGE_QUERY, { businessId, page, pageSize }, token);
  const customers = data.business?.customers;
  if (!customers) {
    throw new WaveAPIError('invalid_response', 'Wave returned no customer list for this business.');
  }

  return {
    customers: (customers.edges ?? []).map((e: any) => ({
      id: e.node.id,
      name: blankToNull(e.node.name) ?? '',
      firstName: blankToNull(e.node.firstName),
      lastName: blankToNull(e.node.lastName),
      email: blankToNull(e.node.email),
      phone: blankToNull(e.node.phone),
      mobile: blankToNull(e.node.mobile),
      address: formatAddress(e.node.address),
      internalNotes: blankToNull(e.node.internalNotes),
      isArchived: !!e.node.isArchived,
    })),
    currentPage: customers.pageInfo?.currentPage ?? page,
    totalPages: customers.pageInfo?.totalPages ?? 1,
    totalCount: customers.pageInfo?.totalCount ?? null,
  };
}

/**
 * Every customer in the business, page by page.
 *
 * Refuses rather than truncates past `maxPages` — a silently partial
 * import would look complete.
 */
export async function listAllCustomers(
  businessId: string,
  token: string,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<WaveCustomerRecord[]> {
  const pageSize = opts.pageSize ?? 50;
  const maxPages = opts.maxPages ?? 200;
  const all: WaveCustomerRecord[] = [];

  for (let page = 1; ; page++) {
    const result = await fetchCustomerPage(businessId, page, pageSize, token);
    all.push(...result.customers);

    if (result.currentPage >= result.totalPages || result.customers.length === 0) break;
    if (page >= maxPages) {
      throw new WaveAPIError(
        'too_many_customers',
        `Wave has more than ${maxPages * pageSize} customers — too many to import in one pass.`,
      );
    }
  }

  return all;
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
