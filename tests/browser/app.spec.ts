import { test, expect, type Page } from '@playwright/test';
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

test('keeps the existing yesterday shortcut without changing the today page', async ({ page }) => {
  await openEntry(page, '8');
  const today = await page.getByLabel('日期', { exact: true }).inputValue();
  expect(today).toBe('2026-01-01');
  await page.getByRole('button', { name: '昨天', exact: true }).click();
  const yesterday = await page.getByLabel('日期', { exact: true }).inputValue();
  expect(yesterday).toBe('2025-12-31');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('今天还没有一笔。', { exact: true })).toBeVisible();
  expect(await sql(page, 'SELECT occurred_date, amount_cents FROM txn')).toEqual([{ occurred_date: yesterday, amount_cents: -800 }]);
  await page.getByRole('link', { name: '流水', exact: true }).click();
  if (yesterday.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole('button', { name: '上个月', exact: true }).click();
  }
  await expect(page.locator('.ledger-screen')).toContainText('−8.00');
});

test('downloads the xlsx directly in a browser without a native cache list', async ({ page }) => {
  await page.getByRole('link', { name: '报表', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出这个月为表格（.xlsx）', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('记账本-2026-01.xlsx');
  expect((await readFile(await file.path())).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
  await expect(page.getByText('应用缓存中的报表', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
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
  await page.clock.runFor(8500);
  expect(await dbRows()).toEqual([{ deleted_at: null }]);
  await undo.click();
  await expect(row).toBeVisible();
  await page.clock.runFor(10_000);
  expect(await dbRows()).toEqual([{ deleted_at: null }]);

  await drop();
  await page.clock.runFor(10_050);
  await expect(page.getByText('已删除这笔流水', { exact: true })).toBeVisible();
  expect(await dbRows()).toEqual([{ deleted_at: expect.any(String) }]);
  await expect(row).toHaveCount(0);
  await page.getByRole('link', { name: '流水', exact: true }).click();
  await expect(page.getByText('本月还没有流水', { exact: true })).toBeVisible();
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
  await page.clock.runFor(10_050);
  expect(await history()).toEqual(before);
  await action.click();
  await dialog.getByRole('button', { name: '移到垃圾桶', exact: true }).click();
  await page.clock.runFor(10_050);
  await expect(page.getByText('已删除这笔转账', { exact: true })).toBeVisible();
  const rows = await history();
  expect(rows).toEqual(before.map(row => ({ ...row, deleted_at: expect.any(String) })));
  expect(rows[0].deleted_at).toBe(rows[1].deleted_at);
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
  await page.clock.runFor(10_050);
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
  for (const key of '2500') await keypad.locator(`[data-key="${key}"]`).click();
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
