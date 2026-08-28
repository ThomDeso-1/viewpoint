/**
 * Wave expense transactions — the write path the receipt upload queue
 * uses. Split out of the old `wave.ts` (audit P2-26).
 */

import { makeRequest, WaveAPIError } from './transport.js';

export interface WaveTransactionResult {
  didSucceed: boolean;
  transactionId: string | null;
  errors: string[];
}

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
