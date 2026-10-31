import { describe, expect, it } from 'vitest';
import { countMovements } from '../../src/components/txnOrder';
import type { TxnRow } from '../../src/db/repos/txns';

function row(overrides: Partial<TxnRow> & Pick<TxnRow, 'id' | 'direction'>): TxnRow {
  return {
    occurredDate: '2026-10-30',
    accountId: 'a-card',
    accountName: '校园卡',
    amountCents: -100,
    categoryId: null,
    categoryName: null,
    note: '',
    slotKey: null,
    isFixedCost: false,
    transferGroupId: null,
    deletedAt: null,
    projectId: null,
    projectName: null,
    projectArchived: false,
    ...overrides,
  };
}

describe('countMovements', () => {
  it('counts two transfer legs as one movement', () => {
    expect(
      countMovements([
        row({ id: 'out', direction: 'transfer', amountCents: -500, transferGroupId: 'g1' }),
        row({ id: 'in', direction: 'transfer', amountCents: 500, transferGroupId: 'g1' }),
        row({ id: 'food', direction: 'expense' }),
      ])
    ).toBe(2);
  });

  it('does not merge legacy legs without a group id', () => {
    expect(
      countMovements([
        row({ id: 'a', direction: 'transfer' }),
        row({ id: 'b', direction: 'transfer' }),
      ])
    ).toBe(2);
  });

  it('counts every ordinary row', () => {
    expect(
      countMovements([
        row({ id: 'a', direction: 'expense' }),
        row({ id: 'b', direction: 'income', amountCents: 100 }),
        row({ id: 'c', direction: 'adjust', amountCents: 0 }),
      ])
    ).toBe(3);
  });
});
