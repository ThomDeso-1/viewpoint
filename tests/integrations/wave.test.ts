import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchMock, jsonResponse, networkFailure } from '../helpers/fetchMock.js';
import {
  fetchBusinesses,
  validateToken,
  fetchIncomeAccounts,
  fetchSalesTaxes,
  checkTokenHealth,
  WaveAPIError,
} from '../../server/integrations/wave/index.js';

/**
 * Spec (CONVERSION-PLAN.md "Wave API Service"):
 *  - Income accounts (exam invoices) = accounts of type "Income", not archived.
 *  - A 401 or an "unauthorized" GraphQL error means the token is bad.
 *
 * (Expense / anchor accounts and createExpenseTransaction went with the
 * receipt upload queue — migration 010.)
 */
describe('wave service', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function graphqlResponse(data: unknown) {
    return jsonResponse(200, { data });
  }

  describe('fetchBusinesses / validateToken', () => {
    it('maps businesses edges into a flat list', async () => {
      fetchMock.mockResolvedValueOnce(
        graphqlResponse({
          businesses: { edges: [{ node: { id: 'b1', name: 'Acme', isPersonal: false } }] },
        }),
      );
      const result = await fetchBusinesses('token');
      expect(result).toEqual([{ id: 'b1', name: 'Acme', isPersonal: false }]);
    });

    it('validateToken rejects a token with zero businesses', async () => {
      fetchMock.mockResolvedValueOnce(graphqlResponse({ businesses: { edges: [] } }));
      await expect(validateToken('token')).rejects.toThrow(WaveAPIError);
    });

    it('treats a 401 response as an expired token, not a generic failure', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
      await expect(fetchBusinesses('token')).rejects.toMatchObject({ code: 'token_expired' });
    });

    it('treats an "unauthorized" GraphQL error as an invalid token', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { errors: [{ message: 'Unauthorized' }] }));
      await expect(fetchBusinesses('token')).rejects.toMatchObject({ code: 'invalid_token' });
    });

    it('surfaces other GraphQL errors distinctly', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { errors: [{ message: 'Something else broke' }] }));
      await expect(fetchBusinesses('token')).rejects.toMatchObject({ code: 'graphql_errors' });
    });

    it('wraps a network failure as a retryable network_error', async () => {
      fetchMock.mockImplementationOnce(networkFailure());
      let caught: any;
      try {
        await fetchBusinesses('token');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WaveAPIError);
      expect(caught.code).toBe('network_error');
      expect(caught.isRetryable).toBe(true);
    });

    it('a 5xx response is a retryable server_error', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
      let caught: any;
      try {
        await fetchBusinesses('token');
      } catch (err) {
        caught = err;
      }
      expect(caught.code).toBe('server_error');
      expect(caught.isRetryable).toBe(true);
    });

    it('an invalid/expired token error is not retryable', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
      let caught: any;
      try {
        await fetchBusinesses('token');
      } catch (err) {
        caught = err;
      }
      expect(caught.isRetryable).toBe(false);
    });
  });

  describe('account classification', () => {
    function accountsResponse(nodes: any[]) {
      return graphqlResponse({
        business: {
          accounts: {
            pageInfo: { currentPage: 1, totalPages: 1 },
            edges: nodes.map((n) => ({ node: n })),
          },
        },
      });
    }

    it('fetchIncomeAccounts keeps only non-archived Income accounts', async () => {
      fetchMock.mockResolvedValueOnce(
        accountsResponse([
          { id: '1', name: 'Exam Fees', type: { name: 'Income' }, subtype: { name: 'Income' }, isArchived: false },
          { id: '2', name: 'Old Income', type: { name: 'Income' }, subtype: { name: 'Income' }, isArchived: true },
          { id: '3', name: 'Chequing', type: { name: 'Assets' }, subtype: { name: 'Cash & Bank' }, isArchived: false },
        ]),
      );
      const result = await fetchIncomeAccounts('biz', 'token');
      expect(result.map((a) => a.id)).toEqual(['1']);
    });

    it('paginates through multiple account pages', async () => {
      fetchMock
        .mockResolvedValueOnce(
          graphqlResponse({
            business: {
              accounts: {
                pageInfo: { currentPage: 1, totalPages: 2 },
                edges: [{ node: { id: '1', name: 'A', type: { name: 'Income' }, subtype: { name: 'x' }, isArchived: false } }],
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          graphqlResponse({
            business: {
              accounts: {
                pageInfo: { currentPage: 2, totalPages: 2 },
                edges: [{ node: { id: '2', name: 'B', type: { name: 'Income' }, subtype: { name: 'x' }, isArchived: false } }],
              },
            },
          }),
        );
      const result = await fetchIncomeAccounts('biz', 'token');
      expect(result.map((a) => a.id).sort()).toEqual(['1', '2']);
    });
  });

  describe('fetchSalesTaxes', () => {
    it('maps sales tax edges into a flat list', async () => {
      fetchMock.mockResolvedValueOnce(
        graphqlResponse({ business: { salesTaxes: { edges: [{ node: { id: 't1', name: 'HST', rate: 0.13 } }] } } }),
      );
      const result = await fetchSalesTaxes('biz', 'token');
      expect(result).toEqual([{ id: 't1', name: 'HST', rate: 0.13 }]);
    });
  });

  describe('checkTokenHealth', () => {
    it('is true when the token can list businesses', async () => {
      fetchMock.mockResolvedValueOnce(
        graphqlResponse({ businesses: { edges: [{ node: { id: 'b1', name: 'A', isPersonal: false } }] } }),
      );
      expect(await checkTokenHealth('token')).toBe(true);
    });

    it('is false (not throwing) for a bad token', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
      expect(await checkTokenHealth('token')).toBe(false);
    });

    it('is false (not throwing) on a network failure', async () => {
      fetchMock.mockImplementationOnce(networkFailure());
      expect(await checkTokenHealth('token')).toBe(false);
    });
  });
});
