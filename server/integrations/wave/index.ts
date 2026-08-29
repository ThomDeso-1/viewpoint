/**
 * Wave API — barrel over the modules the old 691-line `wave.ts` was split
 * into (audit P2-26):
 *
 *   transport   GraphQL client + `WaveAPIError` taxonomy
 *   reference   businesses, accounts, sales taxes, products (read-only)
 *   expenses    createExpenseTransaction (receipt upload queue)
 *   customers   find / create (before an invoice)
 *   invoices    draft / approve / send (behind the approval gate)
 *
 * Consumers import from here; the modules only import `transport`.
 */

export * from './transport.js';
export * from './reference.js';
export * from './expenses.js';
export * from './customers.js';
export * from './invoices.js';
