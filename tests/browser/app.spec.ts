import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function sql<T>(page: Page, statement: string, params: (string | number | null)[] = []): Promise<T[]> {
  return page.evaluate(async ({ statement, params }) => {
    const response = await fetch('/__e2e/sql', {
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        'X-Test-Session': sessionStorage.getItem('todaycents-e2e-session')!,
      }, body: JSON.stringify({ op: 'all', sql: statement, params }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result.value;
  }, { statement, params });
}

async function openEntry(page: Page, amount = '12.50') {
  await page.getByRole('link', { name: '记一笔', exact: true }).click();
  await expect(page.getByRole('button', { name: '饮食', exact: true })).toBeVisible();
  for (const key of amount) await page.locator(`.entry-key[data-key="${key}"]`).click();
  await page.getByRole('button', { name: '饮食', exact: true }).click();
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function seedEditReturnRows(page: Page, date: string, projectId: string | null = null) {
  await sql(page, `
    WITH RECURSIVE rows(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM rows WHERE n < 24)
    INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, category_id,
                     project_id, note, created_at)
    SELECT 'edit-return-' || n, ?, account.id, -100, 'expense',
           (SELECT id FROM category WHERE name = '饮食'), ?,
           '样本流水 ' || n, printf('2026-01-01T00:00:%02dZ', n)
      FROM rows CROSS JOIN account WHERE account.name = '微信'
  `, [date, projectId]);
}

async function openScrolledTxn(page: Page, row: Locator) {
  const position = await row.evaluate(element => {
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    return { rowTop: element.getBoundingClientRect().top, scrollY: window.scrollY };
  });
  expect(position.scrollY).toBeGreaterThan(0);
  await row.click();
  await expect(page.getByRole('heading', { name: '编辑流水', exact: true })).toBeInViewport();
  return position;
}

async function expectRestoredRow(row: Locator, originalTop: number) {
  await expect(row).toBeFocused();
  await expect.poll(async () => Math.abs(await row.evaluate(element => element.getBoundingClientRect().top) - originalTop))
    .toBeLessThanOrEqual(2);
}

test.beforeEach(async ({ page }) => {
  // Fail even if an error is otherwise hidden behind a successful assertion.
  page.on('pageerror', error => { throw error; });
  // Keep dates deterministic without freezing timers. Jan 1 also makes the
  // yesterday shortcut exercise both a month and a year boundary on every run.
  await page.clock.setFixedTime(new Date('2026-01-01T12:00:00+08:00'));
  await page.goto('/');
  await expect(page.getByText('今天还没有一笔。', { exact: true })).toBeVisible();
  await expect(page.getByText('正在加载数据…', { exact: true })).toHaveCount(0);
});

test('records an expense through the real UI, survives reload and appears in ledger', async ({ page }) => {
  await openEntry(page);
  await page.getByLabel('备注', { exact: true }).fill('浏览器午餐');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('浏览器午餐');
  await expect(page.locator('.today-card')).toContainText('−12.50');
  expect(await sql(page, 'SELECT amount_cents, direction FROM txn')).toEqual([{ amount_cents: -1250, direction: 'expense' }]);
  await page.reload();
  await expect(page.locator('.today-card')).toContainText('浏览器午餐');
  await page.getByRole('link', { name: '流水', exact: true }).click();
  await expect(page.locator('.ledger-screen')).toContainText('浏览器午餐');
  await noHorizontalOverflow(page);
});

test('expands quick-entry categories and reveals the selected parent and child when collapsed', async ({ page }) => {
  await sql(page, `
    INSERT INTO category (id, parent_id, name, kind, sort, archived_at) VALUES
      ('picker-parent', NULL, '日常采购', 'expense', 40, NULL),
      ('picker-archived-parent', NULL, '已归档一级', 'expense', 41, '2025-12-31T00:00:00Z'),
      ('picker-archived-child', 'picker-parent', '已归档细分', 'expense', 12, '2025-12-31T00:00:00Z');
  `);
  await sql(page, `
    WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < 8)
    INSERT INTO category (id, parent_id, name, kind, sort)
    SELECT 'picker-child-' || i, 'picker-parent', '家庭日用品 ' || i, 'expense', i FROM n;
  `);
  await sql(page, `
    INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, category_id, created_at)
    SELECT 'picker-history', '2025-12-30', id, -500, 'expense', 'picker-child-8', '2025-12-30T00:00:00Z'
    FROM account WHERE name = '微信';
  `);

  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const more = entry.getByRole('button', { name: '全部分类', exact: true });
  const less = entry.getByRole('button', { name: '收起分类', exact: true });
  const top = entry.locator('#entry-top-categories');
  const children = entry.locator('#entry-sub-categories');
  const parent = top.getByRole('button', { name: '日常采购', exact: true });
  const lastChild = children.getByRole('button', { name: '家庭日用品 8', exact: true });
  const newChild = children.getByRole('button', { name: '家庭日用品 7', exact: true });
  const note = entry.getByLabel('备注', { exact: true });

  await open.click();
  await expect(more).toBeInViewport({ ratio: 1 });
  expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(parent).toHaveAttribute('aria-pressed', 'true');
  await expect(lastChild).toHaveAttribute('aria-pressed', 'true');
  // Scroll offsets are rounded to device pixels in Chromium.
  await expect(parent).toBeInViewport({ ratio: 0.99 });
  await expect(lastChild).toBeInViewport({ ratio: 0.99 });

  for (const key of '6.5') await entry.locator(`.entry-key[data-key="${key}"]`).click();
  await entry.getByRole('button', { name: '昨天', exact: true }).click();
  await note.fill('分类展开草稿');
  await more.click();
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  for (const row of [top, children]) {
    expect(await row.evaluate(element => {
      const first = element.firstElementChild!.getBoundingClientRect();
      const last = element.lastElementChild!.getBoundingClientRect();
      return element.scrollWidth === element.clientWidth && last.top > first.top;
    })).toBe(true);
  }
  await expect(top.getByRole('button').last()).toHaveText('未分类');
  await expect(entry.getByRole('button', { name: /已归档/ })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await newChild.click();
  await expect(newChild).toHaveAttribute('aria-pressed', 'true');
  await less.click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(newChild).toBeInViewport({ ratio: 0.99 });

  await entry.getByRole('button', { name: '收入', exact: true }).click();
  await expect(more).toBeVisible();
  await expect(parent).toHaveCount(0);
  await entry.getByRole('button', { name: '转账', exact: true }).click();
  await expect(more).toHaveCount(0);
  await entry.getByRole('button', { name: '支出', exact: true }).click();
  await entry.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await open.click();
  await expect(parent).toBeInViewport({ ratio: 0.99 });
  await expect(newChild).toBeInViewport({ ratio: 0.99 });
  await expect(parent).toHaveAttribute('aria-pressed', 'true');
  await expect(newChild).toHaveAttribute('aria-pressed', 'true');
  await expect(note).toHaveValue('分类展开草稿');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toHaveCount(0);
  expect(await sql(page, 'SELECT category_id, amount_cents, occurred_date, note FROM txn WHERE id <> ?', ['picker-history']))
    .toEqual([{ category_id: 'picker-child-7', amount_cents: -650, occurred_date: '2025-12-31', note: '分类展开草稿' }]);
});

test('explains both keypad limits in quick entry and saves the retained amount', async ({ page }) => {
  await openEntry(page, '1234567');
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const keypad = entry.getByRole('group', { name: '数字键盘', exact: true });
  const limit = keypad.getByRole('status');
  const press = (key: string) => keypad.locator(`[data-key="${key}"]`).click();

  await expect(limit).toBeEmpty();
  await press('8');
  await expect(limit).toHaveText('整数最多 7 位');
  await expect(entry.getByRole('button', { name: '金额 −1,234,567', exact: true })).toBeInViewport();

  await press('.');
  await expect(limit).toBeEmpty();
  for (const key of ['8', '9', '0']) await press(key);
  await expect(limit).toHaveText('小数最多 2 位');
  await expect(limit).toBeInViewport();
  const amount = entry.getByRole('button', { name: '金额 −1,234,567.89', exact: true });
  await expect(amount).toBeInViewport();
  await page.evaluate(async () => { await document.fonts.ready; });
  expect(await amount.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const button = element.getBoundingClientRect();
    return text.left >= button.left && text.right <= button.right;
  })).toBe(true);
  await noHorizontalOverflow(page);

  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('−1,234,567.89');
  expect(await sql(page, 'SELECT amount_cents FROM txn')).toEqual([{ amount_cents: -123456789 }]);
});

test('keeps the allowed zero and resets the limit message in the edit keypad', async ({ page }) => {
  await openEntry(page, '27.89');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('a.today-card').click();
  await page.getByRole('button', { name: '金额 27.89', exact: true }).click();
  const keypad = page.getByRole('dialog', { name: '金额键盘', exact: true });
  const amount = keypad.locator('.txn-keypad-head strong');
  const limit = keypad.getByRole('status');
  const press = (key: string) => keypad.locator(`[data-key="${key}"]`).click();
  const done = keypad.getByRole('button', { name: '完成', exact: true });

  await press('2');
  await expect(amount).toHaveText('2');
  await expect(limit).toBeEmpty();
  for (const key of ['.', '5', '00']) await press(key);
  await expect(amount).toHaveText('2.50');
  await expect(limit).toHaveText('小数最多 2 位');
  await press('del');
  await expect(amount).toHaveText('2.5');
  await expect(limit).toBeEmpty();
  await press('1');
  await press('0');
  await expect(limit).toHaveText('小数最多 2 位');

  await done.click();
  await page.getByRole('button', { name: '金额 2.51', exact: true }).click();
  await expect(limit).toBeEmpty();
  await expect(amount).toHaveText('2.51');
  await done.click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('−2.51');
  expect(await sql(page, 'SELECT amount_cents FROM txn')).toEqual([{ amount_cents: -251 }]);
});

test('opens the date picker on the first tap and gives a large date its own row', async ({ page }) => {
  await openEntry(page, '8.25');
  const entry = page.getByRole('dialog', { name: '随手记' });
  const date = entry.getByLabel('日期', { exact: true });
  const note = entry.getByLabel('备注', { exact: true });
  const amount = entry.getByRole('button', { name: '金额 −8.25', exact: true });
  const keypad = entry.getByRole('group', { name: '数字键盘', exact: true });
  await note.fill('日期复验草稿');
  await amount.click();
  await expect(keypad).toBeVisible();
  await expect(date).toHaveAttribute('max', '2026-01-01');

  await date.evaluate(input => {
    const dateRow = input.closest('.entry-date-row')!;
    for (const element of dateRow.querySelectorAll<HTMLElement>('button, input')) {
      element.style.fontSize = `${parseFloat(getComputedStyle(element).fontSize) * 1.3}px`;
    }
    (input as HTMLInputElement).showPicker = function () {
      this.dataset.pickerCalls = String(Number(this.dataset.pickerCalls ?? 0) + 1);
      this.dataset.pickerActivated = String(navigator.userActivation.isActive);
      this.dataset.pickerKeypadVisible = String(document.querySelector('.entry-keypad') !== null);
    };
  });
  await date.scrollIntoViewIfNeeded();
  await expect(date).toBeInViewport();
  const fits = await date.evaluate(input => {
    const dateField = input as HTMLInputElement;
    const dateRow = dateField.parentElement!;
    const dateBounds = dateField.getBoundingClientRect();
    const chipsBottom = Math.max(...Array.from(dateRow.querySelectorAll('button'),
      chip => chip.getBoundingClientRect().bottom));
    const probe = dateField.cloneNode() as HTMLInputElement;
    probe.removeAttribute('id');
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', inlineSize: 'max-content', maxInlineSize: 'none' });
    dateRow.append(probe);
    const naturalWidth = probe.getBoundingClientRect().width;
    probe.remove();
    return dateBounds.top >= chipsBottom && dateBounds.width >= naturalWidth && dateBounds.height >= 44;
  });
  expect(fits).toBe(true);
  await noHorizontalOverflow(page);

  await date.tap();
  await expect(date).toHaveAttribute('data-picker-calls', '1');
  await expect(date).toHaveAttribute('data-picker-activated', 'true');
  await expect(date).toHaveAttribute('data-picker-keypad-visible', 'true');
  await expect(keypad).toHaveCount(0);
  await expect(date).toHaveValue('2026-01-01');
  await expect(note).toHaveValue('日期复验草稿');
  await expect(amount).toBeVisible();

  await date.fill('2025-11-29');
  await expect(date).toHaveValue('2025-11-29');
  await amount.click();
  await expect(keypad).toBeVisible();
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toHaveCount(0);
  expect(await sql(page, 'SELECT occurred_date, amount_cents, note FROM txn')).toEqual([
    { occurred_date: '2025-11-29', amount_cents: -825, note: '日期复验草稿' },
  ]);
});

test('prefills from the last saved expense even when it was backdated', async ({ page }) => {
  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const save = entry.getByRole('button', { name: '保存', exact: true });
  await openEntry(page, '10');
  await save.click();
  await expect(entry).toHaveCount(0);

  await open.click();
  await expect(entry.getByRole('button', { name: '饮食', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(entry.getByRole('button', { name: '微信', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await entry.locator('.entry-key[data-key="7"]').click();
  await entry.getByRole('button', { name: '交通', exact: true }).click();
  await entry.getByRole('button', { name: '支付宝', exact: true }).click();
  await entry.getByRole('button', { name: '昨天', exact: true }).click();
  await save.click();
  await expect(entry).toHaveCount(0);

  expect(await sql(page, `
    SELECT t.occurred_date, c.name AS category, a.name AS account, t.amount_cents
    FROM txn t JOIN category c ON c.id = t.category_id JOIN account a ON a.id = t.account_id
    ORDER BY t.rowid
  `)).toEqual([
    { occurred_date: '2026-01-01', category: '饮食', account: '微信', amount_cents: -1000 },
    { occurred_date: '2025-12-31', category: '交通', account: '支付宝', amount_cents: -700 },
  ]);
  await open.click();
  await expect(entry.getByRole('button', { name: '交通', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(entry.getByRole('button', { name: '支付宝', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(entry.getByLabel('日期', { exact: true })).toHaveValue('2026-01-01');
});

test('keeps the existing yesterday shortcut without changing the today page', async ({ page }) => {
  await openEntry(page, '8');
  const today = await page.getByLabel('日期', { exact: true }).inputValue();
  expect(today).toBe('2026-01-01');
  await page.getByRole('button', { name: '昨天', exact: true }).click();
  const yesterday = await page.getByLabel('日期', { exact: true }).inputValue();
  expect(yesterday).toBe('2025-12-31');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '随手记', exact: true })).toHaveCount(0);
  await expect(page.getByText('今天还没有一笔。', { exact: true })).toBeVisible();
  expect(await sql(page, 'SELECT occurred_date, amount_cents FROM txn')).toEqual([{ occurred_date: yesterday, amount_cents: -800 }]);
  await page.getByRole('link', { name: '流水', exact: true }).click();
  if (yesterday.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole('button', { name: '上个月', exact: true }).click();
  }
  await expect(page.locator('.ledger-screen')).toContainText('−8.00');
});

test('refreshes Today and the open entry date at local midnight across a year boundary', async ({ page }) => {
  await page.clock.install({ time: new Date('2025-12-31T23:59:00+08:00') });
  await page.reload();
  const day = page.locator('.today-header time');
  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const date = entry.getByLabel('日期', { exact: true });
  await expect(day).toHaveAttribute('datetime', '2025-12-31');

  await openEntry(page, '12');
  await entry.getByLabel('备注', { exact: true }).fill('去年最后一笔');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('去年最后一笔');
  await open.click();
  await expect(date).toHaveValue('2025-12-31');

  await page.clock.fastForward(61_000);
  await expect(day).toHaveAttribute('datetime', '2026-01-01');
  await expect(page.locator('.today-eyebrow')).toHaveText('1月1日周四');
  await expect(page.locator('.today-card')).toHaveCount(0);
  await expect(date).toHaveValue('2026-01-01');
  await expect(date).toHaveAttribute('max', '2026-01-01');
  await expect(entry.getByRole('button', { name: '昨天', exact: true })).toHaveAttribute('data-date', '2025-12-31');
  await expect(entry.getByRole('button', { name: '前天', exact: true })).toHaveAttribute('data-date', '2025-12-30');

  await entry.getByRole('button', { name: '收起', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '保留这笔草稿？' })).toHaveCount(0);
  await openEntry(page, '25');
  await entry.getByLabel('备注', { exact: true }).fill('新年第一笔');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toHaveText(/新年第一笔/);
  expect(await sql(page, 'SELECT occurred_date, note FROM txn ORDER BY occurred_date')).toEqual([
    { occurred_date: '2025-12-31', note: '去年最后一笔' },
    { occurred_date: '2026-01-01', note: '新年第一笔' },
  ]);
});

test('refreshes on foreground events and preserves a chosen date in the retained draft', async ({ page }) => {
  const day = page.locator('.today-header time');
  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const date = entry.getByLabel('日期', { exact: true });
  const note = entry.getByLabel('备注', { exact: true });
  await openEntry(page, '16');
  await note.fill('保留的补记');
  await expect(date).toHaveValue('2026-01-01');

  await page.clock.setFixedTime(new Date('2026-01-02T12:00:00+08:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(day).toHaveAttribute('datetime', '2026-01-02');
  await expect(date).toHaveValue('2026-01-02');
  await expect(note).toHaveValue('保留的补记');
  await entry.getByRole('button', { name: '昨天', exact: true }).click();
  await expect(date).toHaveValue('2026-01-01');

  await page.clock.setFixedTime(new Date('2026-01-03T12:00:00+08:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('todaycents:resume')));
  await expect(day).toHaveAttribute('datetime', '2026-01-03');
  await expect(date).toHaveAttribute('max', '2026-01-03');
  await expect(date).toHaveValue('2026-01-01');
  await expect(entry.getByRole('button', { name: '前天', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await entry.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await open.click();
  await expect(date).toHaveValue('2026-01-01');
  await expect(note).toHaveValue('保留的补记');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await expect(page.getByText('今天还没有一笔。', { exact: true })).toBeVisible();
  expect(await sql(page, 'SELECT occurred_date, amount_cents, note FROM txn')).toEqual([
    { occurred_date: '2026-01-01', amount_cents: -1600, note: '保留的补记' },
  ]);
});

test('downloads the xlsx directly in a browser without a native cache list', async ({ page }) => {
  await page.getByRole('link', { name: '报表', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出这个月为表格（.xlsx）', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('记账本-2026-01.xlsx');
  expect((await readFile(await file.path())).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
  const result = page.getByRole('region', { name: '导出结果' });
  await expect(result).toContainText(file.suggestedFilename());
  await expect(result.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('应用缓存中的报表', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('opens the displayed month’s year report and restores that month after browsing years', async ({ page }) => {
  await sql(page, `
    WITH samples(id, date, amount) AS (
      VALUES ('report-dec', '2025-12-20', -1250),
             ('report-feb', '2025-02-01', -2500),
             ('report-2024', '2024-12-20', -9000)
    )
    INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, category_id, created_at)
    SELECT samples.id, date, account.id, amount, 'expense',
           (SELECT id FROM category WHERE name = '饮食'), '2026-01-01T00:00:00Z'
      FROM samples CROSS JOIN account WHERE account.name = '微信'
  `);
  await page.getByRole('link', { name: '报表', exact: true }).click();
  const period = page.locator('.reports-period__label');
  const total = page.locator('.reports-total strong');
  const month = page.getByRole('button', { name: '月', exact: true });
  const year = page.getByRole('button', { name: '年', exact: true });
  await expect(period).toHaveText('2026年1月');
  await page.getByRole('button', { name: '上个月', exact: true }).click();
  await expect(period).toHaveText('2025年12月');
  await expect(total).toHaveText('12.50');

  await year.click();
  await expect(period).toHaveText('2025 年');
  await expect(total).toHaveText('37.50');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出全年为表格（.xlsx）', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('记账本-2025.xlsx');

  await page.getByRole('button', { name: '上一年', exact: true }).click();
  await expect(period).toHaveText('2024 年');
  await expect(total).toHaveText('90.00');
  await year.click();
  await expect(period).toHaveText('2024 年');
  await month.click();
  await expect(period).toHaveText('2025年12月');
  await expect(total).toHaveText('12.50');
  await year.click();
  await expect(period).toHaveText('2025 年');
  await expect(total).toHaveText('37.50');
});

test('checks monthly and annual spending details against the category rankings', async ({ page }) => {
  await sql(page, `
    INSERT INTO category (id, parent_id, name, kind, sort, archived_at)
    SELECT 'report-lunch', id, '旧午餐', 'expense', 80, '2025-12-31T00:00:00Z'
      FROM category WHERE name = '饮食'
  `);
  await sql(page, `
    WITH RECURSIVE older(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM older WHERE n < 12),
    samples(id, date, category_id, amount, note) AS (
      SELECT 'report-food-root', '2025-12-05', id, -1200, '一级样本' FROM category WHERE name = '饮食'
      UNION ALL SELECT 'report-food-child', '2025-12-31', 'report-lunch', -1800, '细分样本'
      UNION ALL SELECT 'report-earlier-' || n, '2025-02-01', 'report-lunch', -100, '旧月样本 ' || n FROM older
      UNION ALL SELECT 'report-uncat-null', '2025-12-28', NULL, -300, '无分类样本'
      UNION ALL SELECT 'report-uncat-system', '2025-12-21', id, -200, '系统未分类样本' FROM category WHERE name = '未分类'
    )
    INSERT INTO txn (id, occurred_date, category_id, account_id, amount_cents, direction, note, created_at)
    SELECT samples.id, date, category_id, account.id, amount, 'expense', note, '2026-01-01T00:00:00Z'
      FROM samples CROSS JOIN account WHERE account.name = '微信'
  `);
  await page.getByRole('link', { name: '报表', exact: true }).click();
  await page.getByRole('button', { name: '上个月', exact: true }).click();
  const period = page.locator('.reports-period__label');
  const rankings = page.getByRole('region', { name: '分类排行' });
  const food = rankings.getByRole('button', { name: /^饮食/ });
  const uncat = rankings.getByRole('button', { name: /^未分类/ });
  const detail = page.getByRole('dialog', { name: '饮食支出明细', exact: true });
  const close = detail.getByRole('button', { name: '关闭', exact: true });
  const total = detail.locator('.reports-detail__total');
  await expect(food).toContainText('30.00');
  await food.tap();
  await expect(close).toBeFocused();
  await expect(detail).toContainText('2025年12月');
  await expect(total).toHaveText('2 笔支出合计30.00');
  const rows = detail.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('旧午餐 · 微信');
  await expect(rows.first()).toContainText('细分样本');
  await expect(rows.last()).toContainText('一级样本');
  await expect(detail.getByRole('button')).toHaveCount(1);
  await expect(detail.getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => window.__todaycentsBack?.())).toBe(1);
  await expect(detail).toHaveCount(0);
  await expect(food).toBeFocused();
  await expect(period).toHaveText('2025年12月');

  await expect(uncat).toContainText('5.00');
  await uncat.click();
  const uncatDetail = page.getByRole('dialog', { name: '未分类支出明细', exact: true });
  await expect(uncatDetail.locator('.reports-detail__total')).toHaveText('2 笔支出合计5.00');
  await expect(uncatDetail.getByRole('listitem')).toHaveCount(2);
  await uncatDetail.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(uncat).toBeFocused();

  await page.getByRole('button', { name: '年', exact: true }).click();
  await expect(food).toContainText('42.00');
  await food.click();
  await expect(detail).toContainText('2025 年');
  await expect(total).toHaveText('14 笔支出合计42.00');
  await expect(rows).toHaveCount(14);
  const list = detail.getByRole('region', { name: '支出流水' });
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.keyboard.press('Tab');
  await expect(list).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(close).toBeInViewport();
  await expect(total).toBeInViewport();
  await noHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(food).toBeFocused();
  await expect(period).toHaveText('2025 年');
});

test('keeps the first confirmed backup and shows both restore times after reimport', async ({ page }) => {
  await openEntry(page);
  await page.getByLabel('备注', { exact: true }).fill('备份测试午餐');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('备份测试午餐');
  await sql(page, 'UPDATE txn SET deleted_at = ? WHERE note = ?', ['2026-01-01T04:00:00.000Z', '备份测试午餐']);
  await page.getByRole('link', { name: '记一笔', exact: true }).click();
  await page.getByRole('button', { name: '转账', exact: true }).click();
  await page.locator('.entry-key[data-key="2"]').click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card[data-direction="transfer"]')).toHaveCount(2);
  await page.getByRole('link', { name: '流水', exact: true }).click();
  await expect(page.locator('.ledger-month__count')).toHaveText('1 笔');

  const rowCountNote = '每笔转账的转出和转入各计 1 行，已删除的流水也计入。';
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '清除所有数据', exact: true }).click();
  const reset = page.getByRole('dialog', { name: '清除所有数据' });
  await expect(reset).toContainText('将删除 3 行流水记录');
  await expect(reset).toContainText(rowCountNote);
  await reset.getByRole('button', { name: '取消', exact: true }).click();
  const backupLink = page.getByRole('link', { name: '备份与恢复' });
  await backupLink.click();
  const confirmed = page.getByRole('region', { name: '最近一次确认备份' });
  await expect(confirmed).toContainText('还没有确认保存的备份');

  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出到文件' }).click();
  const file = await downloaded;
  const buffer = await readFile(await file.path());
  const result = page.getByRole('region', { name: '导出结果' });
  await expect(result).toContainText(file.suggestedFilename());
  await expect(result.getByRole('button')).toHaveCount(0);
  await expect(confirmed).toContainText('刚刚');
  await expect(confirmed).toContainText('3 行流水记录');
  await expect(confirmed).toContainText(rowCountNote);
  expect(JSON.parse(buffer.toString('utf8')).counts.txn).toBe(3);

  await page.clock.setFixedTime(new Date('2026-01-02T12:00:00+08:00'));
  await page.getByLabel('选择备份文件').setInputFiles({
    name: file.suggestedFilename(),
    mimeType: 'application/octet-stream',
    buffer,
  });
  const dialog = page.getByRole('dialog', { name: '从文件导入' });
  await expect(dialog).toContainText('本机现在有 3 行流水记录，备份文件有 3 行流水记录。');
  await expect(dialog).toContainText(rowCountNote);
  await dialog.getByRole('button', { name: '覆盖并导入' }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByText(/已导入.*3 行流水记录/)).toBeVisible();
  await backupLink.click();
  await page.reload();

  await expect(confirmed).toContainText('昨天 12:00');
  await expect(confirmed).toContainText('3 行流水记录');
  const restored = page.getByRole('region', { name: '最近一次恢复' });
  await expect(restored).toContainText('刚刚');
  await expect(restored).toContainText('源文件生成时间 · 昨天 12:00');
  expect(await sql(page, 'SELECT amount_cents, direction, deleted_at FROM txn ORDER BY amount_cents')).toEqual([
    { amount_cents: -1250, direction: 'expense', deleted_at: '2026-01-01T04:00:00.000Z' },
    { amount_cents: -200, direction: 'transfer', deleted_at: null },
    { amount_cents: 200, direction: 'transfer', deleted_at: null },
  ]);
  await noHorizontalOverflow(page);
});

test('distinguishes same-named backups with the same row count by their transaction dates', async ({ page }) => {
  await openEntry(page);
  await page.getByLabel('备注', { exact: true }).fill('本机流水');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('本机流水');
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('link', { name: '备份与恢复' }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出到文件' }).click();
  const file = await downloaded;
  const backup = JSON.parse(await readFile(await file.path(), 'utf8')) as {
    tables: { txn: Array<{ occurred_date: string }> };
  };

  const dialog = page.getByRole('dialog', { name: '从文件导入' });
  for (const date of ['2025-11-07', '2025-12-09']) {
    backup.tables.txn[0].occurred_date = date;
    await page.getByLabel('选择备份文件').setInputFiles({
      name: '同名备份.ledger',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await expect(dialog.getByText('同名备份.ledger', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('备份文件有 1 行流水记录。');
    await expect(dialog.getByText(`流水日期 · ${date}`, { exact: true })).toBeInViewport();
    await expect(dialog.getByText('未归档账户 · 3 个', { exact: true })).toBeInViewport();
    const cancel = dialog.getByRole('button', { name: '取消', exact: true });
    await expect(cancel).toBeFocused();
    await noHorizontalOverflow(page);
    await cancel.click();
    await expect(dialog).toHaveCount(0);
  }

  expect(await sql(page, 'SELECT occurred_date, note FROM txn')).toEqual([
    { occurred_date: '2026-01-01', note: '本机流水' },
  ]);
});

test('long-press touch drop stages an expense and only writes after the undo window', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00+08:00') });
  await openEntry(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const row = page.locator('.today-card');
  await expect(row).toBeVisible();
  const zone = page.locator('.txn-drop-zone');
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  const cdp = await page.context().newCDPSession(page);
  const box = (await row.boundingBox())!;
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const dbRows = () => sql(page, 'SELECT deleted_at FROM txn');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y - 90 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.clock.runFor(500);
  await expect(zone).toHaveCount(0);

  async function press() {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.clock.runFor(500);
    await expect(zone).toBeVisible();
    // Android can blur the row and send contextmenu during the same hold.
    await row.evaluate(el => el.dispatchEvent(new FocusEvent('blur')));
    expect(await zone.evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
    })))).toBe(false);
    await expect(zone).toBeVisible();
  }
  await press();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(zone).toHaveCount(0);
  await expect(row).toBeVisible();
  expect(await dbRows()).toEqual([{ deleted_at: null }]);

  async function drop() {
    await press();
    const target = (await zone.boundingBox())!;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: Math.round(target.x + target.width / 2), y: Math.round(target.y + 25) }],
    });
    await expect(zone).toContainText('松手，移到垃圾桶');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(undo).toBeVisible();
    await expect(row).toBeHidden();
  }
  await drop();
  await page.clock.runFor(3000);
  expect(await dbRows()).toEqual([{ deleted_at: null }]);
  await undo.click();
  await expect(row).toBeVisible();
  await page.clock.runFor(5000);
  expect(await dbRows()).toEqual([{ deleted_at: null }]);

  await drop();
  await page.clock.runFor(5050);
  await expect(page.getByText('已删除这笔流水', { exact: true })).toBeVisible();
  expect(await dbRows()).toEqual([{ deleted_at: expect.any(String) }]);
  await expect(row).toHaveCount(0);
  await page.getByRole('link', { name: '流水', exact: true }).click();
  await expect(page.getByText('本月还没有流水', { exact: true })).toBeVisible();
});

test('opens either transfer leg, previews balance changes and saves or rolls back the pair', async ({ page }) => {
  await sql(page, `UPDATE account SET initial_balance_cents = CASE name
    WHEN '微信' THEN 10000 WHEN '支付宝' THEN 20000 WHEN '银行卡' THEN 30000 END`);
  const accountIds = await sql<{ id: string; name: string }>(page, 'SELECT id, name FROM account');
  const id = (name: string) => accountIds.find(account => account.name === name)!.id;
  await page.getByRole('link', { name: '记一笔', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  await entry.getByRole('button', { name: '转账', exact: true }).click();
  await entry.locator('[data-from-account-id]').filter({ hasText: '微信' }).click();
  await entry.locator('[data-to-account-id]').filter({ hasText: '支付宝' }).click();
  for (const key of '12.50') await entry.locator(`.entry-key[data-key="${key}"]`).click();
  await entry.getByLabel('备注', { exact: true }).fill('原转账');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toHaveCount(0);

  const history = () => sql<{
    id: string; transfer_group_id: string; occurred_date: string; created_at: string;
    account_id: string; amount_cents: number; note: string;
  }>(page, `SELECT id, transfer_group_id, occurred_date, created_at, account_id, amount_cents, note
    FROM txn ORDER BY amount_cents`);
  const before = await history();
  expect(before).toHaveLength(2);
  const outgoing = page.locator(`a.today-card[data-txn-id="${before[0].id}"]`);
  const title = page.getByRole('heading', { name: '转账详情', exact: true });
  const from = page.getByLabel('转出账户', { exact: true });
  const to = page.getByLabel('转入账户', { exact: true });
  const note = page.getByLabel('备注', { exact: true });
  const save = page.getByRole('button', { name: '保存修改', exact: true });
  const preview = page.getByRole('region', { name: '账户余额变化', exact: true });
  await outgoing.click();
  await expect(title).toBeVisible();
  await expect(from).toHaveValue(id('微信'));
  await expect(to).toHaveValue(id('支付宝'));
  await expect(note).toHaveValue('原转账');
  await expect(page.locator('time[datetime="2026-01-01"]')).toBeVisible();
  await expect(page.locator('input[type="date"]')).toHaveCount(0);
  await expect(preview).toHaveCount(0);

  await from.selectOption(id('银行卡'));
  await to.selectOption(id('银行卡'));
  await expect(page.getByRole('alert')).toContainText('必须使用不同账户');
  await save.click();
  expect(await history()).toEqual(before);
  await to.selectOption(id('微信'));
  await page.getByRole('button', { name: '金额 12.50', exact: true }).click();
  const keypad = page.getByRole('dialog', { name: '金额键盘', exact: true });
  for (const key of '7.5') await keypad.locator(`[data-key="${key}"]`).click();
  await keypad.getByRole('button', { name: '完成', exact: true }).click();
  await note.fill('修正账户与金额');
  for (const balance of [
    ['微信', '当前 87.50', '保存后 107.50'],
    ['支付宝', '当前 212.50', '保存后 200.00'],
    ['银行卡', '当前 300.00', '保存后 292.50'],
  ]) {
    const line = preview.locator('dl > div').filter({ hasText: balance[0] });
    await expect(line).toContainText(balance[1]);
    await expect(line).toContainText(balance[2]);
  }
  await noHorizontalOverflow(page);

  await sql(page, `CREATE TRIGGER skip_incoming_leg BEFORE UPDATE ON txn WHEN OLD.amount_cents > 0
    BEGIN SELECT RAISE(IGNORE); END`);
  await save.click();
  await expect(page.getByRole('alert')).toContainText('未能完整保存');
  expect(await history()).toEqual(before);
  await expect(note).toHaveValue('修正账户与金额');
  await expect(from).toHaveValue(id('银行卡'));
  await expect(to).toHaveValue(id('微信'));
  await sql(page, 'DROP TRIGGER skip_incoming_leg');
  await save.click();
  await expect(outgoing).toBeFocused();
  const expected = [
    { ...before[0], account_id: id('银行卡'), amount_cents: -750, note: '修正账户与金额' },
    { ...before[1], account_id: id('微信'), amount_cents: 750, note: '修正账户与金额' },
  ];
  expect(await history()).toEqual(expected);

  await sql(page, `UPDATE account SET archived_at = '2026-01-01T12:01:00Z'
    WHERE name IN ('支付宝', '银行卡')`);
  await page.getByRole('link', { name: '流水', exact: true }).click();
  const incoming = page.locator(`a.ledger-row[data-txn-id="${before[1].id}"]`);
  await incoming.click();
  await expect(title).toBeVisible();
  await expect(from).toHaveValue(id('银行卡'));
  await expect(from.getByRole('option', { name: '银行卡（已归档）', exact: true })).toHaveCount(1);
  await expect(to.getByRole('option', { name: /已归档/ })).toHaveCount(0);
  await expect(to).toHaveValue(id('微信'));
  await expect(note).toHaveValue('修正账户与金额');
  await note.fill('只改备注');
  await expect(preview).toHaveCount(0);
  await save.click();
  await expect(incoming).toBeFocused();
  expect(await history()).toEqual(expected.map(leg => ({ ...leg, note: '只改备注' })));
  await expect(page.getByLabel('本月合计').locator('.num')).toHaveText(['0.00', '0.00']);
});

test('either transfer leg stages both legs and navigating away cancels the request', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00+08:00') });
  await page.getByRole('link', { name: '记一笔', exact: true }).click();
  await page.getByRole('button', { name: '转账', exact: true }).click();
  await page.locator('.entry-key[data-key="2"]').click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const legs = page.locator('.today-card[data-direction="transfer"]');
  await expect(legs).toHaveCount(2);
  const history = () => sql<{ amount_cents: number; account_id: string; deleted_at: string | null }>(
    page, 'SELECT amount_cents, account_id, deleted_at FROM txn ORDER BY amount_cents'
  );
  const before = await history();
  const action = page.getByRole('button', { name: '删除转账，转账 · 2.00', exact: true });
  const dialog = page.getByRole('dialog');
  const keep = page.getByRole('button', { name: '撤销', exact: true });
  await action.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toContainText('转出和转入会一起删除');
  await expect(dialog).toContainText('5 秒可以撤销');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeFocused();
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: '移到垃圾桶', exact: true }).click();
  await expect(keep).toBeFocused();
  await expect(legs.first()).toBeHidden();
  await expect(legs.last()).toBeHidden();
  expect(await history()).toEqual(before);
  await page.getByRole('link', { name: '流水', exact: true }).click();
  await expect(keep).toHaveCount(0);
  await expect(page.locator('.ledger-row[data-direction="transfer"]')).toHaveCount(2);
  await page.clock.runFor(5050);
  expect(await history()).toEqual(before);
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await expect(page.getByText('离开页面时已取消删除这笔转账', { exact: true })).toBeVisible();
  await expect(legs).toHaveCount(2);
  await action.click();
  await dialog.getByRole('button', { name: '移到垃圾桶', exact: true }).click();
  await page.clock.runFor(5050);
  await expect(page.getByText('已删除这笔转账', { exact: true })).toBeVisible();
  const rows = await history();
  expect(rows).toEqual(before.map(row => ({ ...row, deleted_at: expect.any(String) })));
  expect(rows[0].deleted_at).toBe(rows[1].deleted_at);
});

test('shows the five-second delete countdown, cancels in background and updates totals after the write', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00+08:00') });
  await openEntry(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toBeVisible();
  await page.getByRole('link', { name: '流水', exact: true }).click();
  const row = page.locator('.ledger-row');
  const total = page.getByLabel('本月合计').locator('.num').first();
  const feedback = page.locator('.txn-delete-feedback');
  const countdown = feedback.locator('#txn-delete-countdown');
  const undo = feedback.getByRole('button', { name: '撤销', exact: true });
  const cancelled = page.getByText('切到后台时已取消删除这笔流水', { exact: true });
  const stored = () => sql(page, 'SELECT deleted_at FROM txn');
  await expect(row).toBeVisible();
  await expect(total).toHaveText('12.50');
  await page.clock.pauseAt(new Date('2026-01-01T12:01:00+08:00'));

  async function stage() {
    await page.getByRole('button', { name: /^删除流水，/ }).click();
    await page.getByRole('button', { name: '移到垃圾桶', exact: true }).click();
    await expect(row).toBeHidden();
    await expect(countdown).toHaveText('剩 5 秒');
    await expect(total).toHaveText('12.50');
  }

  await stage();
  await expect(feedback).toContainText('写入后合计更新。离页或切到后台会取消。');
  expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(5050);
  expect(await stored()).toEqual([{ deleted_at: null }]);
  await expect(cancelled).toHaveCount(0);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(cancelled).toBeVisible();
  await expect(row).toBeVisible();

  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/__e2e/sql', async route => {
    const body = route.request().postDataJSON();
    if (body.op === 'run' && /UPDATE txn SET deleted_at/.test(body.sql)) {
      entered();
      await held;
    }
    await route.continue();
  });
  try {
    await stage();
    await page.clock.runFor(1000);
    await expect(countdown).toHaveText('剩 4 秒');
    await page.clock.runFor(3999);
    await expect(countdown).toHaveText('剩 1 秒');
    await expect(undo).toBeVisible();
    expect(await stored()).toEqual([{ deleted_at: null }]);
    await page.clock.runFor(1);
    await started;
    await expect(feedback).toContainText('正在写入删除');
    await expect(undo).toHaveCount(0);
    await expect(total).toHaveText('12.50');
  } finally {
    release();
  }

  await expect(page.getByText('已删除这笔流水', { exact: true })).toBeVisible();
  await expect(total).toHaveText('0.00');
  await expect(row).toHaveCount(0);
  expect(await stored()).toEqual([{ deleted_at: expect.any(String) }]);
});

test('cancels pending deletion on a quick Android background round trip without WebView visibility events', async ({ page }) => {
  type AndroidPage = Window & {
    androidForegroundSession?: number;
    TodayCentsForeground?: { currentSession(): number };
  };
  await page.clock.install({ time: new Date('2026-01-01T12:00:00+08:00') });
  await page.evaluate(() => {
    const android = window as AndroidPage;
    android.androidForegroundSession = 1;
    android.TodayCentsForeground = { currentSession: () => android.androidForegroundSession ?? 0 };
  });
  await openEntry(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toBeVisible();
  await page.getByRole('link', { name: '流水', exact: true }).click();
  const row = page.locator('.ledger-row');
  const cancelled = page.getByText('切到后台时已取消删除这笔流水', { exact: true });
  const stored = () => sql(page, 'SELECT deleted_at FROM txn');
  await page.clock.pauseAt(new Date('2026-01-01T12:01:00+08:00'));

  async function foreground(session: number, event?: string) {
    await page.evaluate(({ session, event }) => {
      const android = window as AndroidPage;
      android.androidForegroundSession = session;
      if (event) document.dispatchEvent(new Event(event));
    }, { session, event });
  }

  async function stage() {
    await page.getByRole('button', { name: /^删除流水，/ }).click();
    await page.getByRole('button', { name: '移到垃圾桶', exact: true }).click();
    await expect(row).toBeHidden();
    await expect(page.locator('#txn-delete-countdown')).toHaveText('剩 5 秒');
  }

  await stage();
  await foreground(0);
  await page.clock.runFor(500);
  await foreground(2, 'todaycents:resume');
  await expect(cancelled).toBeVisible();
  await expect(row).toBeVisible();
  await page.clock.runFor(5000);
  expect(await stored()).toEqual([{ deleted_at: null }]);

  // Both notification callbacks can arrive after the deadline callback.
  await stage();
  await foreground(0);
  await page.clock.runFor(700);
  await foreground(3);
  await page.clock.runFor(4300);
  await expect(cancelled).toBeVisible();
  await expect(row).toBeVisible();
  expect(await stored()).toEqual([{ deleted_at: null }]);

  await stage();
  await foreground(0, 'todaycents:pause');
  await expect(row).toBeVisible();
  await expect(cancelled).toHaveCount(0);
  await foreground(4, 'todaycents:resume');
  await expect(cancelled).toBeVisible();
  expect(await stored()).toEqual([{ deleted_at: null }]);

  await stage();
  await foreground(4, 'todaycents:pause');
  await foreground(4, 'todaycents:resume');
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  await expect(row).toBeHidden();
  await page.clock.runFor(5000);
  await expect(row).toHaveCount(0);
  expect(await stored()).toEqual([{ deleted_at: expect.any(String) }]);
});

test('restores a staged row when soft deletion fails', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00+08:00') });
  await openEntry(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const row = page.locator('.today-card');
  await expect(row).toBeVisible();
  await sql(page, "CREATE TRIGGER block_delete BEFORE UPDATE OF deleted_at ON txn BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await page.getByRole('button', { name: /^删除流水，/ }).click();
  await page.getByRole('button', { name: '移到垃圾桶', exact: true }).click();
  await expect(row).toBeHidden();
  await page.clock.runFor(5050);
  await expect(page.getByRole('alert')).toContainText('删除失败');
  await expect(row).toBeVisible();
  expect(await sql(page, 'SELECT deleted_at FROM txn')).toEqual([{ deleted_at: null }]);
});

test('traps focus in reset confirmation and closes by cancel, Escape and scrim', async ({ page }) => {
  await page.getByRole('link', { name: '设置', exact: true }).click();
  const reset = page.getByRole('button', { name: '清除所有数据', exact: true });
  await reset.click();
  const dialog = page.getByRole('dialog');
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '确认清除', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(reset).toBeFocused();
  await reset.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await reset.click();
  await page.locator('.sheet__scrim').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);
  expect(await sql<{ n: number }>(page, 'SELECT COUNT(*) n FROM account')).toEqual([{ n: 3 }]);
  await noHorizontalOverflow(page);
});

test('blocks sheet dismissals until the actual save commits', async ({ page }) => {
  await openEntry(page);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/__e2e/sql', async route => {
    const body = route.request().postDataJSON();
    if (body.op === 'run' && /INSERT INTO txn/.test(body.sql)) {
      entered();
      await held;
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await started;
    await expect(page.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '收起', exact: true })).toBeDisabled();
    await page.locator('.entry-scrim').click({ position: { x: 2, y: 2 }, force: true });
    await expect(page).toHaveURL(/#\/add$/);
    await expect(page.locator('.entry-layer')).toBeVisible();
    await expect(page.getByRole('link', { name: '记错了？去流水里改' })).toHaveAttribute('aria-disabled', 'true');
  } finally {
    release();
  }
  await expect(page.locator('.today-card')).toContainText('−12.50');
  expect(await sql<{ n: number }>(page, 'SELECT COUNT(*) n FROM txn')).toEqual([{ n: 1 }]);
});

test('shows a failed write and can retry without losing the draft', async ({ page }) => {
  await openEntry(page);
  await page.route('**/__e2e/sql', async route => {
    const body = route.request().postDataJSON();
    if (body.op === 'run' && /INSERT INTO txn/.test(body.sql)) {
      await route.fulfill({ status: 500, json: { error: '模拟磁盘写入失败' } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('模拟磁盘写入失败');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  expect(await sql(page, 'SELECT id FROM txn')).toEqual([]);
  await page.unroute('**/__e2e/sql');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('−12.50');
});

test('keeps quick-entry fields across exits and discards a retained draft when asked', async ({ page }) => {
  await sql(page, "INSERT INTO tag (id, name) VALUES ('draft-tag', '草稿标签')");
  await sql(page, "INSERT INTO project (id, name, created_at) VALUES ('draft-project', '草稿项目', '2025-12-01T12:00:00Z')");
  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const decision = page.getByRole('dialog', { name: '保留这笔草稿？', exact: true });
  const close = entry.getByRole('button', { name: '收起', exact: true });
  await open.click();
  await close.click();
  await expect(entry).toHaveCount(0);
  await expect(decision).toHaveCount(0);

  await openEntry(page, '26.40');
  await entry.getByRole('button', { name: '支付宝', exact: true }).click();
  await entry.getByRole('button', { name: '草稿标签', exact: true }).click();
  await entry.getByRole('button', { name: '草稿项目', exact: true }).click();
  await entry.getByRole('button', { name: '昨天', exact: true }).click();
  await entry.getByLabel('备注', { exact: true }).fill('未记的午餐');

  await page.locator('.entry-scrim').click({ position: { x: 5, y: 5 } });
  await expect(decision.getByRole('button', { name: '继续填写' })).toBeFocused();
  await expect(entry).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(decision).toHaveCount(0);
  await expect(entry.getByLabel('备注', { exact: true })).toHaveValue('未记的午餐');
  expect(await page.evaluate(() => window.__todaycentsBack?.())).toBe(1);
  await decision.getByRole('button', { name: '保留草稿' }).click();
  await expect(entry).toHaveCount(0);
  expect(await sql(page, 'SELECT id FROM txn')).toEqual([]);

  await open.click();
  await expect(entry.getByRole('button', { name: '金额 −26.40', exact: true })).toBeVisible();
  for (const value of ['饮食', '支付宝', '草稿标签', '草稿项目']) {
    await expect(entry.getByRole('button', { name: value, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(entry.getByLabel('日期', { exact: true })).toHaveValue('2025-12-31');
  await expect(entry.getByLabel('备注', { exact: true })).toHaveValue('未记的午餐');
  await entry.getByRole('link', { name: '记错了？去流水里改', exact: true }).click();
  await expect(decision).toBeVisible();
  await noHorizontalOverflow(page);
  await decision.getByRole('button', { name: '放弃草稿' }).click();
  await expect(page).toHaveURL(/#\/ledger$/);

  await open.click();
  await expect(entry.getByRole('button', { name: '金额 0.00', exact: true })).toBeVisible();
  await expect(entry.getByLabel('备注', { exact: true })).toHaveValue('');
  await expect(entry.getByLabel('日期', { exact: true })).toHaveValue('2026-01-01');
  await expect(entry.getByRole('button', { name: '草稿标签', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await close.click();
  await expect(entry).toHaveCount(0);
  await expect(decision).toHaveCount(0);
});

test('keeps manual accounts separate for expense and income through a saved draft', async ({ page }) => {
  await sql(page, `
    WITH history(direction, account_name, category_name, amount_cents) AS (
      VALUES ('expense', '微信', '饮食', -500), ('income', '银行卡', '生活费', 500)
    )
    INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, category_id, created_at)
    SELECT 'account-history-' || h.direction, '2025-12-30', a.id, h.amount_cents, h.direction, c.id, '2025-12-30T00:00:00Z'
    FROM history h JOIN account a ON a.name = h.account_name
    JOIN category c ON c.kind = h.direction AND c.name = h.category_name;
  `);
  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const expense = entry.getByRole('button', { name: '支出', exact: true });
  const income = entry.getByRole('button', { name: '收入', exact: true });
  const account = (name: string) => entry.locator('[data-account-id]').filter({ hasText: name });

  await open.click();
  await expect(account('微信')).toHaveAttribute('aria-pressed', 'true');
  await account('支付宝').click();
  await income.click();
  await expect(account('银行卡')).toHaveAttribute('aria-pressed', 'true');
  await account('微信').click();

  await entry.getByRole('button', { name: '转账', exact: true }).click();
  await entry.locator('[data-from-account-id]').filter({ hasText: '银行卡' }).click();
  await entry.locator('[data-to-account-id]').filter({ hasText: '支付宝' }).click();
  await expense.click();
  await expect(account('支付宝')).toHaveAttribute('aria-pressed', 'true');
  await entry.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await open.click();
  await expect(account('支付宝')).toHaveAttribute('aria-pressed', 'true');
  await income.click();
  await expect(account('微信')).toHaveAttribute('aria-pressed', 'true');
  await expect(entry.getByRole('button', { name: '生活费', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await entry.locator('.entry-key[data-key="7"]').click();
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toHaveCount(0);
  expect(await sql(page, `
    SELECT a.name, t.direction, t.amount_cents FROM txn t JOIN account a ON a.id = t.account_id
    WHERE t.id NOT LIKE 'account-history-%'
  `)).toEqual([{ name: '微信', direction: 'income', amount_cents: 700 }]);
  await open.click();
  await expect(account('微信')).toHaveAttribute('aria-pressed', 'true');
});

test('offers to keep a draft when only the inactive direction has a manual account', async ({ page }) => {
  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const income = entry.getByRole('button', { name: '收入', exact: true });
  const expense = entry.getByRole('button', { name: '支出', exact: true });
  const close = entry.getByRole('button', { name: '收起', exact: true });
  const account = entry.getByRole('button', { name: '支付宝', exact: true });

  await open.click();
  await income.click();
  await account.click();
  await expense.click();
  await expect(entry.getByRole('button', { name: '微信', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await close.click();
  await page.getByRole('button', { name: '保留草稿', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await open.click();
  await income.click();
  await expect(account).toHaveAttribute('aria-pressed', 'true');
  await expense.click();
  await close.click();
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await open.click();
  await income.click();
  await expect(account).toHaveAttribute('aria-pressed', 'false');
});

test('keeps both transfer sides through a failed save and clears the kept entry after retry', async ({ page }) => {
  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const decision = page.getByRole('dialog', { name: '保留这笔草稿？', exact: true });
  await open.click();
  await entry.getByRole('button', { name: '转账', exact: true }).click();
  await entry.locator('.entry-key[data-key="8"]').click();
  const from = entry.locator('[data-from-account-id]').filter({ hasText: '支付宝' });
  const to = entry.locator('[data-to-account-id]').filter({ hasText: '微信' });
  await from.click();
  await to.click();
  await entry.getByLabel('备注', { exact: true }).fill('未提交的转账');
  await entry.getByRole('button', { name: '收起', exact: true }).click();
  await decision.getByRole('button', { name: '保留草稿' }).click();
  await expect(entry).toHaveCount(0);
  await open.click();
  await expect(from).toHaveAttribute('aria-pressed', 'true');
  await expect(to).toHaveAttribute('aria-pressed', 'true');
  await expect(entry.getByRole('button', { name: '金额 8', exact: true })).toBeVisible();

  await sql(page, "CREATE TRIGGER block_draft_transfer BEFORE INSERT ON txn WHEN NEW.amount_cents > 0 BEGIN SELECT RAISE(ABORT, '模拟写入失败'); END");
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry.getByRole('alert')).toContainText('模拟写入失败');
  expect(await sql(page, 'SELECT id FROM txn')).toEqual([]);
  await expect(entry.getByLabel('备注', { exact: true })).toHaveValue('未提交的转账');
  await expect(from).toHaveAttribute('aria-pressed', 'true');
  await expect(to).toHaveAttribute('aria-pressed', 'true');

  await sql(page, 'DROP TRIGGER block_draft_transfer');
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry).toHaveCount(0);
  expect(await sql(page, `
    SELECT a.name, t.amount_cents FROM txn t JOIN account a ON a.id = t.account_id ORDER BY t.amount_cents
  `)).toEqual([{ name: '支付宝', amount_cents: -800 }, { name: '微信', amount_cents: 800 }]);
  await open.click();
  await expect(entry.getByRole('button', { name: '支出', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(entry.getByLabel('备注', { exact: true })).toHaveValue('');
  await expect(entry.getByRole('button', { name: '金额 0.00', exact: true })).toBeVisible();
});

test('blocks an archived draft account and clears the draft with a ledger reset', async ({ page }) => {
  await openEntry(page, '12');
  const open = page.getByRole('link', { name: '记一笔', exact: true });
  const entry = page.getByRole('dialog', { name: '随手记', exact: true });
  const decision = page.getByRole('dialog', { name: '保留这笔草稿？', exact: true });
  await entry.getByRole('button', { name: '支付宝', exact: true }).click();
  await entry.getByRole('button', { name: '收起', exact: true }).click();
  await decision.getByRole('button', { name: '保留草稿' }).click();
  await expect(entry).toHaveCount(0);
  await sql(page, "UPDATE account SET archived_at = '2026-01-01T00:00:00Z' WHERE name = '支付宝'");
  await open.click();
  await expect(entry.getByRole('button', { name: '饮食', exact: true })).toBeVisible();
  await entry.getByRole('button', { name: '保存', exact: true }).click();
  await expect(entry.getByRole('alert')).toContainText('账户');
  expect(await sql(page, 'SELECT id FROM txn')).toEqual([]);
  await entry.getByRole('link', { name: '记错了？去流水里改', exact: true }).click();
  await decision.getByRole('button', { name: '保留草稿' }).click();
  await expect(page).toHaveURL(/#\/ledger$/);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '清除所有数据', exact: true }).click();
  await page.getByRole('button', { name: '确认清除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await open.click();
  await expect(entry.getByRole('button', { name: '金额 0.00', exact: true })).toBeVisible();
  await entry.getByRole('button', { name: '收起', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await expect(decision).toHaveCount(0);
});

test('restores a second transfer account and keeps the amount, date and note', async ({ page }) => {
  await sql(page, 'UPDATE account SET archived_at = ? WHERE name <> ?',
    ['2026-01-01T00:00:00Z', '微信']);
  await page.getByRole('link', { name: '记一笔', exact: true }).click();
  const entry = page.getByRole('dialog', { name: '随手记' });
  await entry.getByRole('button', { name: '转账', exact: true }).click();
  const prompt = entry.getByText('转账需要两个可用账户。目前只有一个。', { exact: true });
  await expect(prompt).toBeInViewport();
  const save = entry.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeDisabled();
  await expect(entry.locator('[data-from-account-id], [data-to-account-id]')).toHaveCount(0);
  await noHorizontalOverflow(page);

  for (const key of ['1', '2', '.', '3']) await entry.locator(`.entry-key[data-key="${key}"]`).click();
  await entry.getByRole('button', { name: '昨天', exact: true }).click();
  await entry.getByLabel('备注', { exact: true }).fill('恢复账户时保留的草稿');
  await expect(save).toBeDisabled();
  expect(await sql(page, 'SELECT id FROM txn')).toEqual([]);

  const restoreLink = entry.getByRole('link', { name: '恢复已归档账户', exact: true });
  expect((await restoreLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await restoreLink.click();
  await expect(page.getByRole('checkbox', { name: '显示已归档' })).toBeChecked();
  await page.getByRole('button', { name: /^支付宝/ }).click();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByText(/^已恢复「支付宝」/)).toBeVisible();
  await page.getByRole('link', { name: '返回记账', exact: true }).click();

  await expect(prompt).toHaveCount(0);
  await expect(entry.getByRole('button', { name: '金额 12.3', exact: true })).toBeVisible();
  await expect(entry.getByLabel('日期', { exact: true })).toHaveValue('2025-12-31');
  await expect(entry.getByLabel('备注', { exact: true })).toHaveValue('恢复账户时保留的草稿');
  await entry.locator('[data-from-account-id]').filter({ hasText: '微信' }).click();
  await entry.locator('[data-to-account-id]').filter({ hasText: '支付宝' }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(entry).toHaveCount(0);

  const legs = await sql<{ transfer_group_id: string }>(page, `SELECT a.name, t.amount_cents, t.occurred_date, t.note, t.transfer_group_id
    FROM txn t JOIN account a ON a.id = t.account_id ORDER BY t.amount_cents`);
  expect(legs).toEqual([
    { name: '微信', amount_cents: -1230, occurred_date: '2025-12-31', note: '恢复账户时保留的草稿', transfer_group_id: expect.any(String) },
    { name: '支付宝', amount_cents: 1230, occurred_date: '2025-12-31', note: '恢复账户时保留的草稿', transfer_group_id: expect.any(String) },
  ]);
  expect(legs[0]?.transfer_group_id).toBe(legs[1]?.transfer_group_id);
});

test('opens account creation directly from a single-account transfer draft', async ({ page }) => {
  await sql(page, 'DELETE FROM account WHERE name <> ?', ['微信']);
  await openEntry(page, '6.25');
  const entry = page.getByRole('dialog', { name: '随手记' });
  await entry.getByRole('button', { name: '转账', exact: true }).click();
  await expect(entry.getByText('转账需要两个可用账户。目前只有一个。', { exact: true })).toBeVisible();
  await expect(entry.getByRole('link', { name: '恢复已归档账户', exact: true })).toHaveCount(0);
  await entry.getByRole('link', { name: '新增账户', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新增账户', exact: true })).toBeInViewport();
  await page.getByRole('link', { name: '返回记账', exact: true }).click();
  await expect(entry.getByRole('button', { name: '金额 6.25', exact: true })).toBeVisible();
  await expect(entry.getByRole('button', { name: '保存', exact: true })).toBeDisabled();

  await entry.getByRole('link', { name: '新增账户', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('备用现金');
  await page.getByRole('button', { name: '新增账户', exact: true }).click();
  await expect(page.getByText('已新增账户', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回记账', exact: true }).click();
  await expect(entry.getByRole('button', { name: '金额 6.25', exact: true })).toBeVisible();
  await expect(entry.locator('[data-to-account-id]').filter({ hasText: '备用现金' })).toBeVisible();
  await expect(entry.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await noHorizontalOverflow(page);
});

test('adds an account from the empty-account state and keeps the entry draft', async ({ page }) => {
  await sql(page, 'UPDATE account SET archived_at = ?', [new Date().toISOString()]);
  await openEntry(page, '12.3');
  await page.getByLabel('备注', { exact: true }).fill('未丢的草稿');
  const entry = page.getByRole('link', { name: '还没有账户，先去添加一个' });
  const target = await entry.boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);
  await entry.click();
  await page.getByRole('button', { name: '＋ 新增账户', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('浏览器现金');
  await page.getByRole('button', { name: '新增账户', exact: true }).click();
  await expect(page.getByText('已新增账户', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回记账' }).click();
  await expect(page.getByLabel('备注', { exact: true })).toHaveValue('未丢的草稿');
  await expect(page.getByRole('button', { name: '浏览器现金', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('未丢的草稿');
  expect(await sql(page, 'SELECT amount_cents FROM txn')).toEqual([{ amount_cents: -1230 }]);
});

test('reconciles an account only after an explicit balance and shows the delta before saving', async ({ page }) => {
  await sql(page, 'UPDATE account SET initial_balance_cents = ? WHERE name = ?', [10000, '微信']);
  await sql(page, 'UPDATE account SET initial_balance_cents = ?, archived_at = ? WHERE name = ?',
    [4500, '2026-01-01T00:00:00Z', '支付宝']);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('link', { name: '账户', exact: true }).click();
  const balance = page.getByRole('region', { name: '账户余额', exact: true });
  await expect(balance.getByText('仅合计未归档账户的余额', { exact: true })).toBeInViewport();
  await expect(balance.locator('.num')).toHaveText('100.00');
  await page.getByRole('checkbox', { name: '显示已归档', exact: true }).check();
  await expect(page.getByRole('button', { name: /^支付宝/ })).toContainText('45.00');
  await expect(balance.locator('.num')).toHaveText('100.00');

  const accountButton = page.getByRole('button', { name: /^微信/ });
  const account = page.getByRole('listitem').filter({ has: accountButton });
  await accountButton.click();

  const open = account.getByRole('button', { name: '对账', exact: true });
  const confirm = account.getByRole('button', { name: '确认对账', exact: true });
  const field = account.getByRole('button', { name: '对账金额 输入实际余额' });
  const preview = account.locator('.accounts-reconcile__preview dd');
  const readTransactions = () => sql(page, 'SELECT amount_cents, direction FROM txn');
  const enterBalance = async (amount: string) => {
    await field.click();
    const keypad = page.getByRole('dialog', { name: '对账金额键盘' });
    await expect(keypad.getByText('待输入', { exact: true })).toBeVisible();
    for (const key of amount) await keypad.getByRole('button', { name: key, exact: true }).click();
    await keypad.getByRole('button', { name: '完成', exact: true }).click();
  };

  await open.click();
  await expect(preview).toHaveText(['100.00', '—', '—']);
  await confirm.click();
  await expect(account.getByRole('alert')).toHaveText('请输入实际余额。');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(await readTransactions()).toEqual([]);

  await enterBalance('100');
  await expect(preview).toHaveText(['100.00', '100.00', '0.00']);
  await confirm.click();
  await expect(page.getByText('余额一致，无需调整', { exact: true })).toBeVisible();
  expect(await readTransactions()).toEqual([]);

  await open.click();
  await enterBalance('0');
  await expect(preview).toHaveText(['100.00', '0.00', '−100.00']);
  await noHorizontalOverflow(page);
  await confirm.click();
  await expect(account.locator('.accounts-row__balance')).toHaveText('0.00');
  await expect(balance.locator('.num')).toHaveText('0.00');
  expect(await readTransactions()).toEqual([{ amount_cents: -10000, direction: 'adjust' }]);

  await page.getByRole('link', { name: '返回设置', exact: true }).click();
  await page.getByRole('link', { name: '流水', exact: true }).click();
  await expect(page.getByLabel('本月合计').locator('.num')).toHaveText(['0.00', '0.00']);
});

test('edits only the note of an account adjustment', async ({ page }) => {
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('link', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: /^微信/ }).click();
  await page.getByRole('button', { name: '对账', exact: true }).click();
  await page.getByRole('button', { name: '对账金额 输入实际余额' }).click();
  const keypad = page.getByRole('dialog', { name: '对账金额键盘' });
  for (const key of ['6', '5']) await keypad.getByRole('button', { name: key, exact: true }).click();
  await keypad.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '确认对账', exact: true }).click();
  await expect(page.getByText('已调整「微信」的余额 65.00', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '返回设置', exact: true }).click();
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await page.locator('a.today-card[data-direction="adjust"]').click();
  const facts = page.getByRole('region', { name: '对账调整' });
  await expect(facts.locator('dd')).toHaveText(['2026-01-01', '微信', '+65.00']);
  await expect(facts).toContainText('对原账户重新对账');
  await expect(page.locator('[data-amount-open], button[data-account-id], [data-category-id], [data-tag-id], [data-project-id]')).toHaveCount(0);
  const note = page.getByRole('textbox', { name: '备注', exact: true });
  await expect(note).toHaveValue('对账差额');
  await noHorizontalOverflow(page);

  await note.fill('余额已复核');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  expect(await sql(page, `
    SELECT a.name, t.amount_cents, t.occurred_date, t.category_id, t.note
    FROM txn t JOIN account a ON a.id = t.account_id
  `)).toEqual([{ name: '微信', amount_cents: 6500, occurred_date: '2026-01-01', category_id: null, note: '余额已复核' }]);
});

test('restores the scrolled Today list after leaving or saving a transaction edit', async ({ page }) => {
  await seedEditReturnRows(page, '2026-01-01');
  await page.reload();
  const row = page.locator('.today-card[data-txn-id="edit-return-12"]');
  await expect(row).toContainText('样本流水 12');
  const beforeBack = await openScrolledTxn(page, row);
  await page.getByRole('link', { name: '返回今天', exact: true }).click();
  await expectRestoredRow(row, beforeBack.rowTop);

  const beforeSave = await openScrolledTxn(page, row);
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('今天已核对');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(row).toContainText('今天已核对');
  await expectRestoredRow(row, beforeSave.rowTop);
});

test('saves the fixed-cost switch with the note and keeps both edits on failure', async ({ page }) => {
  await openEntry(page);
  await page.getByLabel('备注', { exact: true }).fill('原备注');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const row = page.locator('a.today-card[data-direction="expense"]');
  const fixed = page.getByRole('switch', { name: '固定支出', exact: true });
  const note = page.getByRole('textbox', { name: '备注', exact: true });
  const save = page.getByRole('button', { name: '保存', exact: true });
  const readStored = () => sql(page, 'SELECT note, is_fixed_cost FROM txn');
  const original = [{ note: '原备注', is_fixed_cost: 0 }];

  await row.click();
  await expect(fixed).not.toBeChecked();
  await fixed.click();
  await note.fill('新备注');
  await expect(fixed).toBeChecked();
  expect(await readStored()).toEqual(original);
  await page.getByRole('link', { name: '返回今天', exact: true }).click();

  await row.click();
  await expect(fixed).not.toBeChecked();
  await expect(note).toHaveValue('原备注');
  await fixed.click();
  await note.fill('新备注');
  await sql(page, `
    CREATE TRIGGER block_fixed_edit BEFORE UPDATE OF is_fixed_cost ON txn
    BEGIN SELECT RAISE(ABORT, '模拟固定支出写入失败'); END
  `);
  await save.click();
  await expect(page.getByRole('alert')).toContainText('模拟固定支出写入失败');
  expect(await readStored()).toEqual(original);
  await expect(fixed).toBeChecked();
  await expect(note).toHaveValue('新备注');

  await sql(page, 'DROP TRIGGER block_fixed_edit');
  await save.click();
  await expect(row).toContainText('新备注');
  expect(await readStored()).toEqual([{ note: '新备注', is_fixed_cost: 1 }]);
  await row.click();
  await expect(fixed).toBeChecked();
  await expect(note).toHaveValue('新备注');

  await fixed.click();
  await save.click();
  await expect(row).toBeVisible();
  expect(await readStored()).toEqual([{ note: '新备注', is_fixed_cost: 0 }]);
});

test('shows overdue fixed costs apart from expenses actually recorded this month', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-02-09T12:00:00+08:00'));
  await sql(page, `
    INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, category_id,
                     note, is_fixed_cost, created_at)
    SELECT 'fixed-january', '2026-01-08', account.id, -4500, 'expense',
           (SELECT id FROM category WHERE name = '饮食'),
           '一月实记', 1, '2026-01-08T00:00:00Z'
      FROM account WHERE account.name = '微信'
  `);

  await page.getByRole('link', { name: '设置', exact: true }).click();
  const fixed = page.getByRole('link', { name: /^固定支出/ });
  const totals = page.locator('[data-fixed-total]');
  const list = page.locator('[data-fixed-list]');
  await fixed.click();
  await expect(totals.locator('dt')).toHaveText(['本月已记', '预计月额']);
  await expect(totals.locator('dd')).toHaveText(['0.00', '45.00']);
  await expect(list).toContainText('待核对 · 上次实记 2026-01-08');
  await expect(list).not.toContainText('2月8日');
  await noHorizontalOverflow(page);

  await page.getByRole('link', { name: '返回设置', exact: true }).click();
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await openEntry(page, '47');
  await page.getByLabel('备注', { exact: true }).fill('二月实记');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-card')).toContainText('二月实记');

  await page.getByRole('link', { name: '设置', exact: true }).click();
  await fixed.click();
  await expect(totals.locator('dd')).toHaveText(['47.00', '47.00']);
  await expect(list).toContainText('预计下次 3月9日');
  await expect(list).not.toContainText('待核对');
  expect(await sql(page, 'SELECT amount_cents, is_fixed_cost FROM txn ORDER BY occurred_date')).toEqual([
    { amount_cents: -4500, is_fixed_cost: 1 },
    { amount_cents: -4700, is_fixed_cost: 0 },
  ]);
  await noHorizontalOverflow(page);
});

test('jumps to a month or a specific day from the ledger title', async ({ page }) => {
  await seedEditReturnRows(page, '2024-02-29');
  await page.getByRole('link', { name: '流水', exact: true }).click();
  const monthTitle = (name: string) => page.getByRole('heading', { name, level: 1 }).getByRole('button');
  const calendar = page.getByRole('dialog', { name: '选择日期', exact: true });
  const year = calendar.getByLabel('年份', { exact: true });
  const month = calendar.getByLabel('月份', { exact: true });
  const allMonth = calendar.getByRole('button', { name: '查看整月', exact: true });
  const cancel = calendar.getByRole('button', { name: '取消', exact: true });

  await monthTitle('2026年1月').click();
  await expect(year).toHaveValue('2026');
  await expect(month).toHaveValue('1');
  await expect(month.getByRole('option')).toHaveCount(1);
  await expect(calendar.getByRole('button', { name: '2026年1月2日', exact: true })).toBeDisabled();
  expect((await calendar.getByRole('button', { name: '2026年1月1日', exact: true }).boundingBox())!.height)
    .toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);

  await year.fill('20');
  await expect(month).toBeDisabled();
  await expect(allMonth).toBeDisabled();
  await year.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await cancel.press('Tab');
  await expect(year).toBeFocused();
  await year.fill('2027');
  await expect(calendar.getByRole('status')).toHaveText('请选择本年或更早的年份。');
  await year.fill('2025');
  await month.selectOption('3');
  await allMonth.click();
  await expect(calendar).toHaveCount(0);
  await expect(monthTitle('2025年3月')).toBeVisible();
  await expect(page.getByText('本月还没有流水', { exact: true })).toBeVisible();

  await monthTitle('2025年3月').click();
  await year.fill('2024');
  await month.selectOption('2');
  await calendar.getByRole('button', { name: '2024年2月29日', exact: true }).click();
  await expect(calendar).toHaveCount(0);
  await expect(monthTitle('2024年2月')).toBeVisible();
  const selectedDay = page.locator('.ledger-day[data-date="2024-02-29"]');
  await expect(selectedDay).toHaveAttribute('data-calendar-selected', 'true');
  const dayHeading = selectedDay.getByRole('heading', { level: 2 });
  await expect(dayHeading).toBeFocused();
  await expect.poll(() => selectedDay.evaluate(element => {
    const inset = document.querySelector('.status-veil')?.getBoundingClientRect().height ?? 0;
    return Math.abs(element.getBoundingClientRect().top - inset - 8);
  })).toBeLessThanOrEqual(2);

  const row = selectedDay.getByRole('link').nth(12);
  const opened = await openScrolledTxn(page, row);
  await page.getByRole('link', { name: '返回流水', exact: true }).click();
  await expect(monthTitle('2024年2月')).toBeVisible();
  await expectRestoredRow(row, opened.rowTop);
  await expect(selectedDay).toHaveAttribute('data-calendar-selected', 'true');

  await monthTitle('2024年2月').click();
  await calendar.getByRole('button', { name: '2024年2月17日', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('2024年2月17日没有流水。');
  await expect(selectedDay).toBeVisible();
  const openedFromEmptyDay = await openScrolledTxn(page, row);
  expect(await page.evaluate(() => window.__todaycentsBack?.())).toBe(1);
  await expect(page.getByRole('status')).toHaveText('2024年2月17日没有流水。');
  await expectRestoredRow(row, openedFromEmptyDay.rowTop);
  await monthTitle('2024年2月').click();
  await year.fill('2018');
  expect(await page.evaluate(() => window.__todaycentsBack?.())).toBe(1);
  await expect(calendar).toHaveCount(0);
  await expect(monthTitle('2024年2月')).toBeFocused();
});

test('restores the historical Ledger month and row on Android back and on save', async ({ page }) => {
  await seedEditReturnRows(page, '2025-12-20');
  await page.getByRole('link', { name: '流水', exact: true }).click();
  await page.getByRole('button', { name: '上个月', exact: true }).click();
  const month = page.getByRole('heading', { name: '2025年12月', exact: true });
  await expect(month).toBeVisible();
  const row = page.locator('.ledger-row[data-txn-id="edit-return-12"]');
  await expect(row).toContainText('样本流水 12');
  const beforeBack = await openScrolledTxn(page, row);
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('未保存修改');
  expect(await page.evaluate(() => window.__todaycentsBack?.())).toBe(1);
  await expect(month).toBeVisible();
  await expect(row).toContainText('样本流水 12');
  await expectRestoredRow(row, beforeBack.rowTop);

  const beforeSave = await openScrolledTxn(page, row);
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('历史月已核对');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(month).toBeVisible();
  await expect(row).toContainText('历史月已核对');
  await expectRestoredRow(row, beforeSave.rowTop);
});

test('edits transaction subcategories by parent and retains an archived selection', async ({ page }) => {
  await seedEditReturnRows(page, '2025-12-20');
  await sql(page, `
    INSERT INTO category (id, parent_id, name, kind, sort, archived_at) VALUES
      ('edit-food-other', (SELECT id FROM category WHERE name = '饮食'), '其他细分', 'expense', 90, NULL),
      ('edit-transit-other', (SELECT id FROM category WHERE name = '交通'), '其他细分', 'expense', 90, NULL),
      ('edit-food-retired', (SELECT id FROM category WHERE name = '饮食'), '旧细分', 'expense', 91, '2025-12-31T00:00:00Z')
  `);
  await sql(page, `UPDATE txn SET category_id = 'edit-food-other' WHERE id = 'edit-return-12'`);
  await sql(page, `UPDATE txn SET category_id = 'edit-food-retired' WHERE id = 'edit-return-13'`);
  await page.getByRole('link', { name: '流水', exact: true }).click();
  await page.getByRole('button', { name: '上个月', exact: true }).click();

  const liveRow = page.locator('.ledger-row[data-txn-id="edit-return-12"]');
  const archivedRow = page.locator('.ledger-row[data-txn-id="edit-return-13"]');
  const food = page.getByRole('button', { name: '饮食', exact: true });
  const transport = page.getByRole('button', { name: '交通', exact: true });
  const foodGroup = page.getByRole('group', { name: '细分 · 饮食' });
  const transportGroup = page.getByRole('group', { name: '细分 · 交通' });
  const save = page.getByRole('button', { name: '保存', exact: true });
  const before = await openScrolledTxn(page, liveRow);
  await expect(food).toHaveAttribute('aria-pressed', 'true');
  await food.click();
  await expect(foodGroup.getByRole('button', { name: '其他细分' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-subcategory-id="edit-transit-other"]')).toHaveCount(0);
  await transport.click();
  await expect(foodGroup).toHaveCount(0);
  await expect(transportGroup.getByRole('button', { name: '不细分' })).toHaveAttribute('aria-pressed', 'true');
  await transportGroup.getByRole('button', { name: '其他细分' }).click();
  await noHorizontalOverflow(page);
  await save.click();
  await expectRestoredRow(liveRow, before.rowTop);
  expect(await sql(page, `SELECT category_id FROM txn WHERE id = 'edit-return-12'`))
    .toEqual([{ category_id: 'edit-transit-other' }]);

  await archivedRow.click();
  await expect(food).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('当前分类「饮食 / 旧细分」不可选。不重新选择会保留原分类。')).toBeVisible();
  await expect(foodGroup.getByRole('button', { name: '旧细分' })).toHaveCount(0);
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('保留旧细分');
  await save.click();
  await expect(archivedRow).toContainText('保留旧细分');
  expect(await sql(page, `SELECT category_id FROM txn WHERE id = 'edit-return-13'`))
    .toEqual([{ category_id: 'edit-food-retired' }]);

  await archivedRow.click();
  await foodGroup.getByRole('button', { name: '不细分' }).click();
  await expect(page.getByText('不重新选择会保留原分类。', { exact: false })).toHaveCount(0);
  await save.click();
  await expect(archivedRow).toBeFocused();
  expect(await sql(page, `SELECT category.name FROM txn JOIN category ON txn.category_id = category.id WHERE txn.id = 'edit-return-13'`))
    .toEqual([{ name: '饮食' }]);
});

test('returns to the project and restores its scroll even when the edited row moves out', async ({ page }) => {
  await sql(page, `
    INSERT INTO project (id, name, created_at) VALUES ('return-project', '编辑返回测试项目', '2025-12-01T00:00:00Z')
  `);
  await seedEditReturnRows(page, '2025-12-20', 'return-project');
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('link', { name: '项目', exact: true }).click();
  await page.getByRole('link').filter({ hasText: '编辑返回测试项目' }).click();
  const project = page.getByRole('heading', { name: '编辑返回测试项目', exact: true });
  const row = page.locator('.project-txn[data-txn-id="edit-return-20"]');
  await expect(row).toBeVisible();
  const beforeBack = await openScrolledTxn(page, row);
  await page.getByRole('link', { name: '返回项目详情', exact: true }).click();
  await expect(project).toBeVisible();
  await expectRestoredRow(row, beforeBack.rowTop);

  const beforeSave = await openScrolledTxn(page, row);
  await page.getByRole('button', { name: '不归项目', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(project).toBeVisible();
  await expect(page.getByRole('region', { name: '最近几笔' }).getByText('样本流水 19', { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - beforeSave.scrollY))
    .toBeLessThanOrEqual(2);
  expect(await sql(page, `SELECT project_id FROM txn WHERE id = 'edit-return-20'`)).toEqual([{ project_id: null }]);
});

test('opens all project transactions and restores an older row after editing', async ({ page }) => {
  await sql(page, `
    INSERT INTO project (id, name, status, created_at) VALUES
      ('history-project', '跨年项目', 'archived', '2024-11-01T00:00:00Z'),
      ('short-project', '短项目', 'active', '2025-12-01T00:00:00Z')
  `);
  await seedEditReturnRows(page, '2025-12-20', 'history-project');
  await sql(page, `UPDATE txn SET deleted_at = '2025-12-28T00:00:00Z' WHERE id = 'edit-return-24'`);
  await sql(page, `UPDATE txn SET project_id = 'short-project' WHERE id = 'edit-return-23'`);
  await sql(page, `
    INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, project_id, note, created_at)
    SELECT 'project-refund', '2024-12-01', id, 2500, 'income', 'history-project', '历史报销', '2025-01-01T00:00:00Z'
      FROM account WHERE name = '微信'
  `);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('link', { name: '项目', exact: true }).click();
  await page.getByRole('link').filter({ hasText: '短项目' }).click();
  await expect(page.locator('.project-txn')).toHaveCount(1);
  await expect(page.getByRole('link', { name: '查看全部流水', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '返回项目', exact: true }).click();
  await page.getByRole('link').filter({ hasText: '跨年项目' }).click();

  const openAll = page.getByRole('link', { name: '查看全部流水', exact: true });
  const heading = page.getByRole('heading', { name: '项目流水', exact: true });
  const preview = page.getByRole('region', { name: '最近几笔' });
  await expect(preview.locator('.project-txn')).toHaveCount(5);
  await expect(page.locator('.project-hero__value')).toHaveText('22.00');
  await openAll.tap();
  await expect(heading).toBeVisible();
  const rows = page.locator('.project-txn');
  await expect(rows).toHaveCount(23);
  await expect(rows.first()).toHaveAttribute('data-txn-id', 'edit-return-22');
  await expect(rows.last()).toContainText('2024-12-01');
  await expect(rows.last()).toContainText('+25.00');
  const oldExpense = page.locator('.project-txn[data-txn-id="edit-return-8"]');
  const refund = page.locator('.project-txn[data-txn-id="project-refund"]');
  await noHorizontalOverflow(page);

  const beforeBack = await openScrolledTxn(page, oldExpense);
  await expect(page.getByRole('link', { name: '返回项目流水', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__todaycentsBack?.())).toBe(1);
  await expect(heading).toBeVisible();
  await expectRestoredRow(oldExpense, beforeBack.rowTop);

  const beforeSave = await openScrolledTxn(page, refund);
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('历史报销已核对');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(refund).toContainText('历史报销已核对');
  await expectRestoredRow(refund, beforeSave.rowTop);
  expect(await sql(page, `SELECT project_id FROM txn WHERE id = 'project-refund'`))
    .toEqual([{ project_id: 'history-project' }]);

  const beforeUnassign = await openScrolledTxn(page, oldExpense);
  await page.getByRole('button', { name: '不归项目', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(rows).toHaveCount(22);
  await expect(oldExpense).toHaveCount(0);
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - beforeUnassign.scrollY))
    .toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.__todaycentsBack?.())).toBe(1);
  await expect(page.getByRole('heading', { name: '跨年项目', exact: true })).toBeVisible();
  await expect(preview.locator('.project-txn')).toHaveCount(5);
});

test('edits a project with real keypad, scroll and touch targets', async ({ page }) => {
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('link', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('浏览器项目');
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByRole('link').filter({ hasText: '浏览器项目' }).click();
  const name = page.getByLabel('名称', { exact: true });
  await name.fill('项目已改名');
  await expect(name).toBeFocused();
  expect((await name.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: /^预算 / }).click();
  const keypad = page.getByRole('dialog');
  for (const key of ['2', '5', '0', '0', '.', '0', '00']) {
    await keypad.locator(`[data-key="${key}"]`).click();
  }
  await expect(keypad.getByRole('status')).toHaveText('小数最多 2 位');
  await expect(keypad.locator('.txn-keypad-head strong')).toHaveText('2,500.00');
  await keypad.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目已改名', exact: true })).toBeVisible();
  expect(await sql(page, 'SELECT name, budget_cents FROM project')).toEqual([{ name: '项目已改名', budget_cents: 250000 }]);
  await noHorizontalOverflow(page);
});

test('lays out the three settings cards and keeps reset clear of the dock at narrow widths', async ({ page }) => {
  await page.getByRole('link', { name: '设置', exact: true }).click();
  const groups = page.locator('.settings-group');
  await expect(groups).toHaveCount(3);
  await expect(groups.locator('h2')).toHaveText(['记账管理', '数据与备份']);
  const management = page.getByRole('region', { name: '记账管理' });
  await expect(management.getByRole('link').locator('.settings-row__title')).toHaveText([
    '账户', '分类', '标签', '项目', '固定支出',
  ]);
  const dataGroup = page.getByRole('region', { name: '数据与备份' });
  await expect(dataGroup.getByRole('link').locator('.settings-row__title')).toHaveText([
    '备份与恢复', '存储',
  ]);
  const reset = page.getByRole('region', { name: '清除数据' })
    .getByRole('button', { name: '清除所有数据', exact: true });
  await reset.scrollIntoViewIfNeeded();
  const box = (await reset.boundingBox())!;
  const dataBox = (await dataGroup.boundingBox())!;
  const dock = (await page.getByRole('navigation', { name: '主导航' }).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.y - (dataBox.y + dataBox.height)).toBeGreaterThanOrEqual(24);
  expect(box.y + box.height).toBeLessThanOrEqual(dock.y);
  await noHorizontalOverflow(page);
});
