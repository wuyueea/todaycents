/**
 * Cross-cutting domain types. Direction lives here because every later
 * repository and screen speaks the same four movement kinds.
 */

/** How a transaction moves money: spending, earning, or neither. */
export type Direction = 'expense' | 'income' | 'transfer' | 'adjust';

/** The kinds of account the app supports. Mirrors the v1 account.type CHECK. */
export type AccountType = 'cash' | 'bank' | 'ewallet' | 'prepaid';

/**
 * A bookkeeping account. Balances are never stored: they are always derived
 * as initialBalanceCents + SUM(signed transaction amounts).
 */
export interface Account {
  id: string;
  name: string;
  type: AccountType;
  initialBalanceCents: number;
  monthlyBudgetCents: number | null;
  sort: number;
  archivedAt: string | null;
  createdAt: string;
}
