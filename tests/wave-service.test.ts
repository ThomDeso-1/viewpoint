import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchMock, jsonResponse, networkFailure } from './helpers/fetchMock.js';
import {
  fetchBusinesses,
  validateToken,
  fetchExpenseAccounts,
  fetchAnchorAccounts,
  fetchSalesTaxes,
  createExpenseTransaction,
  checkTokenHealth,
  WaveAPIError,
} from '../server/services/wave.js';

/**
 * Spec (CONVERSION-PLAN.md "Wave API Service"):
 *  - Expense accounts = accounts of type "Expenses", not archived.
 *  - Anchor accounts (what the expense is "paid from") = Cash & Bank /
 *    Credit Card / Loan and Line of Credit under Assets or
 *    Liabilities & Credit Cards, not archived.
 *  - A 401 or an "unauthorized" GraphQL error means the token is bad.
 *  - createExpenseTransaction reports business-rule rejections
 *    (didSucceed: false + inputErrors) distinctly from thrown transport
 *    errors, so callers can tell "Wave rejected this" from "couldn't
 *    reach Wave."
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

    it('fetchExpenseAccounts keeps only non-archived Expenses accounts', async () => {
      fetchMock.mockResolvedValueOnce(
        accountsResponse([
          { id: '1', name: 'Office Supplies', type: { name: 'Expenses' }, subtype: { name: 'Operating Expenses' }, isArchived: false },
          { id: '2', name: 'Old Expense', type: { name: 'Expenses' }, subtype: { name: 'Operating Expenses' }, isArchived: true },
          { id: '3', name: 'Chequing', type: { name: 'Assets' }, subtype: { name: 'Cash & Bank' }, isArchived: false },
        ]),
      );
      const result = await fetchExpenseAccounts('biz', 'token');
      expect(result.map((a) => a.id)).toEqual(['1']);
    });

    it('fetchAnchorAccounts keeps only bank/credit-card/loan accounts under Assets or Liabilities', async () => {
      fetchMock.mockResolvedValueOnce(
        accountsResponse([
          { id: '1', name: 'Chequing', type: { name: 'Assets' }, subtype: { name: 'Cash & Bank' }, isArchived: false },
          { id: '2', name: 'Visa', type: { name: 'Liabilities & Credit Cards' }, subtype: { name: 'Credit Card' }, isArchived: false },
          { id: '3', name: 'Line of Credit', type: { name: 'Liabilities & Credit Cards' }, subtype: { name: 'Loan and Line of Credit' }, isArchived: false },
          { id: '4', name: 'Archived Card', type: { name: 'Liabilities & Credit Cards' }, subtype: { name: 'Credit Card' }, isArchived: true },
          { id: '5', name: 'Office Supplies', type: { name: 'Expenses' }, subtype: { name: 'Operating Expenses' }, isArchived: false },
          { id: '6', name: 'Owner Equity', type: { name: 'Equity' }, subtype: { name: 'Owner Investment/Drawings' }, isArchived: false },
        ]),
      );
      const result = await fetchAnchorAccounts('biz', 'token');
      expect(result.map((a) => a.id).sort()).toEqual(['1', '2', '3']);
    });

    it('paginates through multiple account pages', async () => {
      fetchMock
        .mockResolvedValueOnce(
          graphqlResponse({
            business: {
              accounts: {
                pageInfo: { currentPage: 1, totalPages: 2 },
                edges: [{ node: { id: '1', name: 'A', type: { name: 'Expenses' }, subtype: { name: 'x' }, isArchived: false } }],
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          graphqlResponse({
            business: {
              accounts: {
                pageInfo: { currentPage: 2, totalPages: 2 },
                edges: [{ node: { id: '2', name: 'B', type: { name: 'Expenses' }, subtype: { name: 'x' }, isArchived: false } }],
              },
            },
          }),
        );
      const result = await fetchExpenseAccounts('biz', 'token');
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

  describe('createExpenseTransaction', () => {
    const baseOpts = {
      businessId: 'biz',
      date: '2026-01-01',
      description: 'Office Depot — supplies',
      amount: 42.5,
      expenseAccountId: 'exp1',
      anchorAccountId: 'anchor1',
      token: 'token',
    };

    it('reports success with the new transaction id', async () => {
      fetchMock.mockResolvedValueOnce(
        graphqlResponse({
          moneyTransactionCreate: { didSucceed: true, inputErrors: [], transaction: { id: 'txn-1' } },
        }),
      );
      const result = await createExpenseTransaction(baseOpts);
      expect(result).toEqual({ didSucceed: true, transactionId: 'txn-1', errors: [] });
    });

    it('reports a business-rule rejection as a normal (non-throwing) result with error messages', async () => {
      fetchMock.mockResolvedValueOnce(
        graphqlResponse({
          moneyTransactionCreate: {
            didSucceed: false,
            inputErrors: [{ path: 'anchor.amount', message: 'Amount must be greater than zero', code: 'INVALID' }],
            transaction: null,
          },
        }),
      );
      const result = await createExpenseTransaction(baseOpts);
      expect(result.didSucceed).toBe(false);
      expect(result.transactionId).toBeNull();
      expect(result.errors[0]).toContain('Amount must be greater than zero');
    });

    it('throws (rather than returning a result) when Wave itself is unreachable', async () => {
      fetchMock.mockImplementationOnce(networkFailure());
      await expect(createExpenseTransaction(baseOpts)).rejects.toBeInstanceOf(WaveAPIError);
    });

    it('includes a sales tax line item only when a salesTaxId is provided', async () => {
      fetchMock.mockResolvedValueOnce(
        graphqlResponse({ moneyTransactionCreate: { didSucceed: true, inputErrors: [], transaction: { id: 't' } } }),
      );
      await createExpenseTransaction({ ...baseOpts, salesTaxId: 'tax1' });

      const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      expect(sentBody.variables.input.lineItems[0].taxes).toEqual([{ salesTaxId: 'tax1' }]);
    });

    it('omits tax line items when no salesTaxId is given', async () => {
      fetchMock.mockResolvedValueOnce(
        graphqlResponse({ moneyTransactionCreate: { didSucceed: true, inputErrors: [], transaction: { id: 't' } } }),
      );
      await createExpenseTransaction(baseOpts);

      const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      expect(sentBody.variables.input.lineItems[0].taxes).toBeUndefined();
    });

    it('withdraws from the anchor account and increases the expense line by the same amount', async () => {
      fetchMock.mockResolvedValueOnce(
        graphqlResponse({ moneyTransactionCreate: { didSucceed: true, inputErrors: [], transaction: { id: 't' } } }),
      );
      await createExpenseTransaction(baseOpts);

      const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      const input = sentBody.variables.input;
      expect(input.anchor).toMatchObject({ accountId: 'anchor1', amount: 42.5, direction: 'WITHDRAWAL' });
      expect(input.lineItems[0]).toMatchObject({ accountId: 'exp1', amount: 42.5, balance: 'INCREASE' });
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
