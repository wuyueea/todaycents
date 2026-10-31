import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createExpense, createIncome } from '../../src/db/repos/txns';
import { createTag, setTxnTags } from '../../src/db/repos/tags';
import { createProject, setTxnProject } from '../../src/db/repos/projects';
import { buildMonthWorkbook } from '../../src/export/reportWorkbook';
import { readZipStrict } from './zipReader';

/**
 * One real, human-openable sample. It lives under .superpowers (gitignored) so
 * a reviewer can open it in Excel/LibreOffice without running the app.
 */
const SAMPLE_PATH = join(
  process.cwd(),
  '.superpowers',
  'sdd',
  '2026-10-20-记账本-竖切MVP',
  'sample.xlsx'
);

describe('sample.xlsx', () => {
  it('writes a real October 2026 workbook next to the phase reports', async () => {
    const db = await createTestDb();
    await seedDefaults(db);

    const cardId = await createAccount(db, {
      name: '饭卡',
      type: 'prepaid',
      monthlyBudgetCents: 75000,
    });
    const wechat = (await listAccounts(db)).find(account => account.name === '微信')!;
    const bank = (await listAccounts(db)).find(account => account.name === '银行卡')!;
    const categories = await listCategories(db);
    const food = categories.find(category => category.name === '饮食')!;
    const transport = categories.find(category => category.name === '交通')!;
    const home = categories.find(category => category.name === '居住')!;
    const subscription = categories.find(category => category.name === '订阅')!;
    const allowance = categories.find(category => category.name === '生活费')!;

    const project = await createProject(db, { name: '杭州行' });
    const daily = await createTag(db, '日常');
    const travel = await createTag(db, '旅行');

    const lunch = await createExpense(db, {
      date: '2026-10-01',
      accountId: cardId,
      amountCents: 1234,
      categoryId: food.id,
      note: '午饭 & 例汤',
    });
    await setTxnTags(db, lunch, [daily]);

    const subway = await createExpense(db, {
      date: '2026-10-03',
      accountId: wechat.id,
      amountCents: 300,
      categoryId: transport.id,
      note: '地铁',
    });
    await setTxnProject(db, subway, project);
    await setTxnTags(db, subway, [travel]);

    await createExpense(db, {
      date: '2026-10-05',
      accountId: bank.id,
      amountCents: 120000,
      categoryId: home.id,
      note: '房租',
    });
    await createExpense(db, {
      date: '2026-10-08',
      accountId: cardId,
      amountCents: 888,
      categoryId: food.id,
      note: '早餐',
    });
    await createExpense(db, {
      date: '2026-10-12',
      accountId: wechat.id,
      amountCents: 2500,
      categoryId: subscription.id,
      note: '会员续费',
    });
    await createIncome(db, {
      date: '2026-10-10',
      accountId: cardId,
      amountCents: 150000,
      categoryId: allowance.id,
      note: '生活费',
    });

    const workbook = await buildMonthWorkbook(db, '2026-10');
    mkdirSync(dirname(SAMPLE_PATH), { recursive: true });
    writeFileSync(SAMPLE_PATH, workbook.bytes);

    expect(readZipStrict(workbook.bytes)).toHaveLength(7);
    expect(statSync(SAMPLE_PATH).size).toBe(workbook.bytes.length);
    expect(workbook.detailRows).toBe(6);
    expect(workbook.fileName).toBe('记账本-2026-10.xlsx');
  });
});
