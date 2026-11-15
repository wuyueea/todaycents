// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBackHandlers } from '../../src/components/backButton';
import { todayLocalISO } from '../../src/domain/date';
import { createExpense, listTxnsByMonth } from '../../src/db/repos/txns';
import { listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { seedDefaults } from '../../src/db/seed';
import type { Db, DbParam } from '../../src/db/driver';
import { createTestDb } from '../helpers/nodeDb';
import QuickEntryScreen from '../../src/screens/QuickEntryScreen';
import TxnEditScreen from '../../src/screens/TxnEditScreen';

const dbHolder = vi.hoisted(() => ({
  current: null as null | import('../../src/db/driver').Db,
}));

vi.mock('../../src/db', () => ({
  getDb: () => Promise.resolve(dbHolder.current),
}));

interface Gate {
  readonly db: Db;
  readonly entered: Promise<void>;
  release(error?: Error): void;
}

function gatedDb(inner: Db): Gate {
  let release!: (error?: Error) => void;
  const released = new Promise<Error | null>(resolve => {
    release = error => resolve(error ?? null);
  });
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => {
    markEntered = resolve;
  });
  const db: Db = {
    exec(sql) {
      return inner.exec(sql);
    },
    run(sql, params) {
      return inner.run(sql, params);
    },
    all<T>(sql: string, params?: readonly DbParam[]) {
      return inner.all<T>(sql, params);
    },
    get<T>(sql: string, params?: readonly DbParam[]) {
      return inner.get<T>(sql, params);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      markEntered();
      const failure = await released;
      if (failure !== null) throw failure;
      return inner.transaction(fn);
    },
  };
  return { db, entered, release };
}

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

async function renderInRouter(initialPath: string, routes: ReactNode): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={[initialPath]}>{routes}</MemoryRouter>);
  });
  await flush();
}

async function waitForSelector<T extends Element>(selector: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = document.querySelector<T>(selector);
    if (found !== null) return found;
    await flush();
  }
  throw new Error(`没有等到元素：${selector}`);
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
  });
}

function routesFor(initialPath: string): ReactNode {
  if (initialPath === '/add') {
    return (
      <Routes>
        <Route path="/add" element={<QuickEntryScreen />} />
        <Route path="/" element={<div data-testid="home" />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/txn/:id" element={<TxnEditScreen />} />
      <Route path="/ledger" element={<div data-testid="ledger" />} />
    </Routes>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = '';
  dbHolder.current = null;
  expect(runBackHandlers()).toBe(false);
});

describe('save in flight keeps the screen open', () => {
  it('blocks closing quick entry until the save transaction settles', async () => {
    const inner = await createTestDb();
    await seedDefaults(inner);
    const gate = gatedDb(inner);
    dbHolder.current = gate.db;

    await renderInRouter('/add', routesFor('/add'));

    const category = await waitForSelector<HTMLButtonElement>('button[data-category-id]');
    await click(category);
    await click(await waitForSelector('button[data-key="1"]'));
    await click(await waitForSelector('button[data-key="00"]'));

    const save = await waitForSelector<HTMLButtonElement>('button[data-action="save"]');
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
      await gate.entered;
    });
    await flush();

    const close = document.querySelector<HTMLButtonElement>('[data-entry-close]');
    expect(close).not.toBeNull();
    expect(close!.disabled).toBe(true);
    expect(document.querySelector('form.entry-form')).not.toBeNull();
    expect(document.querySelector('[data-testid="home"]')).toBeNull();

    const ledgerLink = document.querySelector<HTMLAnchorElement>('.entry-ledger-link');
    expect(ledgerLink).not.toBeNull();
    expect(ledgerLink!.getAttribute('aria-disabled')).toBe('true');
    expect(ledgerLink!.tabIndex).toBe(-1);
    await click(ledgerLink!);
    await click(document.querySelector('.entry-scrim')!);
    await click(close!);
    expect(runBackHandlers()).toBe(true);
    await flush();

    expect(document.querySelector('form.entry-form')).not.toBeNull();
    expect(document.querySelector('[data-testid="home"]')).toBeNull();

    await act(async () => {
      gate.release();
    });
    await waitForSelector('[data-testid="home"]');

    const rows = await listTxnsByMonth(inner, todayLocalISO().slice(0, 7));
    expect(rows).toHaveLength(1);
  });

  it('blocks leaving the edit page until the save transaction settles', async () => {
    const inner = await createTestDb();
    await seedDefaults(inner);
    const accounts = await listAccounts(inner);
    const categories = await listCategories(inner);
    const expenseCategory = categories.find(category => category.kind === 'expense');
    expect(accounts.length).toBeGreaterThan(0);
    expect(expenseCategory).toBeDefined();
    const txnId = await createExpense(inner, {
      date: todayLocalISO(),
      accountId: accounts[0].id,
      amountCents: 1230,
      categoryId: expenseCategory!.id,
      note: '午饭',
    });

    const gate = gatedDb(inner);
    dbHolder.current = gate.db;

    await renderInRouter(`/txn/${txnId}`, routesFor(`/txn/${txnId}`));

    const save = await waitForSelector<HTMLButtonElement>('button.add-submit');
    await act(async () => {
      save.click();
      await gate.entered;
    });
    await flush();

    const back = document.querySelector<HTMLAnchorElement>('.add-back');
    expect(back).not.toBeNull();
    expect(back!.getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('[data-testid="ledger"]')).toBeNull();
    expect(runBackHandlers()).toBe(true);

    await click(back!);
    await flush();
    expect(document.querySelector('.txn-edit-screen')).not.toBeNull();
    expect(document.querySelector('[data-testid="ledger"]')).toBeNull();

    await act(async () => {
      gate.release();
    });
    await waitForSelector('[data-testid="ledger"]');
  });

  it('keeps the edit page open with an error when the save transaction fails', async () => {
    const inner = await createTestDb();
    await seedDefaults(inner);
    const accounts = await listAccounts(inner);
    const categories = await listCategories(inner);
    const expenseCategory = categories.find(category => category.kind === 'expense');
    expect(accounts.length).toBeGreaterThan(0);
    expect(expenseCategory).toBeDefined();
    const txnId = await createExpense(inner, {
      date: todayLocalISO(),
      accountId: accounts[0].id,
      amountCents: 1230,
      categoryId: expenseCategory!.id,
      note: '午饭',
    });

    const gate = gatedDb(inner);
    dbHolder.current = gate.db;

    await renderInRouter(`/txn/${txnId}`, routesFor(`/txn/${txnId}`));

    const save = await waitForSelector<HTMLButtonElement>('button.add-submit');
    await act(async () => {
      save.click();
      await gate.entered;
    });
    await flush();

    expect(document.querySelector('.add-back')!.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      gate.release(new Error('磁盘已满'));
    });
    const alert = await waitForSelector('[role="alert"]');
    expect(alert.textContent).toContain('保存失败');
    expect(alert.textContent).toContain('磁盘已满');
    expect(document.querySelector('.txn-edit-screen')).not.toBeNull();
    expect(document.querySelector('[data-testid="ledger"]')).toBeNull();

    const back = document.querySelector<HTMLAnchorElement>('.add-back');
    expect(back!.hasAttribute('aria-disabled')).toBe(false);
    expect(back!.tabIndex).not.toBe(-1);
    await click(back!);
    await waitForSelector('[data-testid="ledger"]');

    const rows = await listTxnsByMonth(inner, todayLocalISO().slice(0, 7));
    expect(rows).toHaveLength(1);
  });
});
