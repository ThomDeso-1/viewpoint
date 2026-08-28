/**
 * Wave customers — looked up or created before an invoice so a returning
 * patient doesn't accumulate duplicate Wave records. Split out of the old
 * `wave.ts` (audit P2-26).
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
