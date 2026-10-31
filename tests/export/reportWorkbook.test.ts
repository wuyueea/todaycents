import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/driver';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createExpense, createIncome } from '../../src/db/repos/txns';
import { createTransfer } from '../../src/db/repos/transfers';
import { createTag, setTxnTags } from '../../src/db/repos/tags';
import { createProject, setTxnProject } from '../../src/db/repos/projects';
import {
  buildMonthWorkbook,
  buildReportWorkbook,
  buildYearWorkbook,
  exportMonthWorkbook,
  exportYearWorkbook,
  monthWorkbookFileName,
  yearWorkbookFileName,
} from '../../src/export/reportWorkbook';
import type { TxnRow } from '../../src/db/repos/txns';
import type { BinaryFileWriter } from '../../src/export/writer';
import { readZipStrict } from './zipReader';

const utf8 = new TextDecoder();

async function seededDb(): Promise<Db> {
  const db = await createTestDb();
  await seedDefaults(db);
  // Not a starter account: the workbook assertions name a prepaid card, so the
  // fixture writes the one it expects to export.
  await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
  return db;
}

async function account(db: Db, name: string) {
  const found = (await listAccounts(db)).find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(`missing seeded account ${name}`);
  return found;
}

async function category(db: Db, name: string) {
  const found = (await listCategories(db)).find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(`missing seeded category ${name}`);
  return found;
}

function part(bytes: Uint8Array, name: string): string {
  const entry = readZipStrict(bytes).find(candidate => candidate.name === name);
  if (entry === undefined) throw new Error(`missing part ${name}`);
  return utf8.decode(entry.data);
}

function summarySheet(bytes: Uint8Array): string {
  return part(bytes, 'xl/worksheets/sheet2.xml');
}

function detailSheet(bytes: Uint8Array): string {
  return part(bytes, 'xl/worksheets/sheet1.xml');
}

interface Written {
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
}

function memoryWriter(): BinaryFileWriter & { written: Written[] } {
  const written: Written[] = [];
  return {
    written,
    async writeForShare(fileName, bytes, mimeType) {
      written.push({ fileName, bytes, mimeType });
    },
  };
}

describe('monthWorkbookFileName / yearWorkbookFileName', () => {
  it('names the download after the period, keeping the .xlsx extension', () => {
    expect(monthWorkbookFileName('2026-10')).toBe('记账本-2026-10.xlsx');
    expect(yearWorkbookFileName(2026)).toBe('记账本-2026.xlsx');
  });

  it('rejects month keys and years that cannot describe a real period', () => {
    expect(() => monthWorkbookFileName('2026-13')).toThrow(RangeError);
    expect(() => monthWorkbookFileName('2026-1')).toThrow(RangeError);
    expect(() => yearWorkbookFileName(999)).toThrow(RangeError);
    expect(() => yearWorkbookFileName(2026.5)).toThrow(RangeError);
  });
});

describe('buildMonthWorkbook', () => {
  it('writes every live row with its date, exact cents, yuan, names and tags', async () => {
    const db = await seededDb();
    const card = await account(db, '饭卡');
    const wechat = await account(db, '微信');
    const food = await category(db, '饮食');
    const project = await createProject(db, { name: '杭州行' });
    const tagOne = await createTag(db, '旅行');
    const tagTwo = await createTag(db, '日常');

    const expenseId = await createExpense(db, {
      date: '2026-10-03',
      accountId: card.id,
      amountCents: 1234,
      categoryId: food.id,
      note: '午饭 & "汤"',
    });
    await setTxnProject(db, expenseId, project);
    await setTxnTags(db, expenseId, [tagTwo, tagOne]);
    await createIncome(db, {
      date: '2026-10-04',
      accountId: wechat.id,
      amountCents: 5000,
      categoryId: null,
      note: '报销',
    });
    await createTransfer(db, {
      date: '2026-10-05',
      fromAccountId: card.id,
      toAccountId: wechat.id,
      amountCents: 1000,
      note: '充值',
    });

    const workbook = await buildMonthWorkbook(db, '2026-10');

    expect(workbook.fileName).toBe('记账本-2026-10.xlsx');
    expect(workbook.detailRows).toBe(4);
    expect(workbook.summaryRows).toBe(2);

    const detail = detailSheet(workbook.bytes);
    expect(detail).toContain('<dimension ref="A1:H5"/>');
    expect(detail).toContain(
      '<c r="A5" t="inlineStr"><is><t xml:space="preserve">2026-10-03</t></is></c>'
    );
    expect(detail).toContain('<c r="B5" s="1"><v>-12.34</v></c>');
    expect(detail).toContain('<c r="C5"><v>-1234</v></c>');
    expect(detail).toContain('<c r="D5" t="inlineStr"><is><t xml:space="preserve">饮食</t></is></c>');
    expect(detail).toContain('<c r="E5" t="inlineStr"><is><t xml:space="preserve">饭卡</t></is></c>');
    expect(detail).toContain('<c r="F5" t="inlineStr"><is><t xml:space="preserve">杭州行</t></is></c>');
    expect(detail).toContain(
      '<c r="G5" t="inlineStr"><is><t xml:space="preserve">旅行、日常</t></is></c>'
    );
    expect(detail).toContain(
      '<c r="H5" t="inlineStr"><is><t xml:space="preserve">午饭 &amp; &quot;汤&quot;</t></is></c>'
    );

    // Income and both transfer legs are detail rows, not spending. The two
    // legs tie on date and creation time, so their order is not asserted.
    expect(detail).toContain('<v>-10.00</v>');
    expect(detail).toContain('<v>10.00</v>');
    expect(detail).toContain('<c r="B4" s="1"><v>50.00</v></c>');
    expect(detail.match(/转账/g)?.length).toBe(2);

    const summary = summarySheet(workbook.bytes);
    expect(summary).toContain(
      '<c r="A1" t="inlineStr"><is><t xml:space="preserve">分类</t></is></c>'
    );
    expect(summary).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">饮食</t></is></c>'
    );
    expect(summary).toContain('<c r="B2" s="1"><v>12.34</v></c>');
    expect(summary).toContain('<c r="C2"><v>1234</v></c>');
    expect(summary).toContain(
      '<c r="A3" t="inlineStr"><is><t xml:space="preserve">总计</t></is></c>'
    );
    expect(summary).toContain('<c r="B3" s="1"><v>12.34</v></c>');
    expect(summary).toContain('<c r="C3"><v>1234</v></c>');
    expect(summary).not.toContain('50.00');
    expect(summary).not.toContain('20.00');
  });

  it('keeps 12.34 exactly as 12.34, never as a binary-float neighbour', async () => {
    const db = await seededDb();
    const card = await account(db, '饭卡');
    await createIncome(db, {
      date: '2026-10-01',
      accountId: card.id,
      amountCents: 1234,
      categoryId: null,
    });

    const detail = detailSheet((await buildMonthWorkbook(db, '2026-10')).bytes);
    expect(detail).toContain('<c r="B2" s="1"><v>12.34</v></c>');
    expect(detail).toContain('<c r="C2"><v>1234</v></c>');
    expect(detail).not.toContain('12.340000000000001');
  });

  it('adds integer cents, so 0.10 + 0.20 is exactly 0.30', async () => {
    const db = await seededDb();
    const card = await account(db, '饭卡');
    const food = await category(db, '饮食');
    await createExpense(db, {
      date: '2026-10-01',
      accountId: card.id,
      amountCents: 10,
      categoryId: food.id,
    });
    await createExpense(db, {
      date: '2026-10-02',
      accountId: card.id,
      amountCents: 20,
      categoryId: food.id,
    });

    const summary = summarySheet((await buildMonthWorkbook(db, '2026-10')).bytes);
    expect(summary).toContain('<c r="B3" s="1"><v>0.30</v></c>');
    expect(summary).toContain('<c r="C3"><v>30</v></c>');
    expect(summary).not.toContain('0.30000000000000004');
  });

  it('still writes a total row for a month without any rows', async () => {
    const db = await seededDb();
    const workbook = await buildMonthWorkbook(db, '2026-11');
    expect(workbook.detailRows).toBe(0);
    expect(workbook.summaryRows).toBe(1);

    const detail = detailSheet(workbook.bytes);
    expect(detail).toContain('<dimension ref="A1:H1"/>');
    expect(detail.match(/<row /g)).toHaveLength(1);

    const summary = summarySheet(workbook.bytes);
    expect(summary).toContain('<c r="B2" s="1"><v>0.00</v></c>');
    expect(summary).toContain('<c r="C2"><v>0</v></c>');
  });

  it('is byte-for-byte deterministic for the same month', async () => {
    const db = await seededDb();
    const card = await account(db, '饭卡');
    const food = await category(db, '饮食');
    await createExpense(db, {
      date: '2026-10-01',
      accountId: card.id,
      amountCents: 1234,
      categoryId: food.id,
      note: 'deterministic',
    });

    const first = await buildMonthWorkbook(db, '2026-10');
    const second = await buildMonthWorkbook(db, '2026-10');
    expect(first.bytes).toEqual(second.bytes);
  });

  it('rejects an invalid month before reading anything', async () => {
    const db = await seededDb();
    await expect(buildMonthWorkbook(db, '2026-13')).rejects.toThrow(RangeError);
  });
});

describe('buildReportWorkbook', () => {
  it('refuses a summary whose detail rows do not add up to it', () => {
    const expense: TxnRow = {
      id: 't-one',
      occurredDate: '2026-10-01',
      accountId: 'a-one',
      accountName: '现金',
      amountCents: -100,
      direction: 'expense',
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
    };

    expect(() =>
      buildReportWorkbook({
        rows: [expense],
        tagsByTxn: new Map(),
        categories: [{ name: '饮食', cents: 200 }],
        expenseCents: 200,
      })
    ).toThrow(/detail|total/i);
  });
});

describe('buildYearWorkbook', () => {
  it('collects both months and totals the year in integer cents', async () => {
    const db = await seededDb();
    const card = await account(db, '饭卡');
    const food = await category(db, '饮食');
    await createExpense(db, {
      date: '2026-09-20',
      accountId: card.id,
      amountCents: 5000,
      categoryId: food.id,
    });
    await createExpense(db, {
      date: '2026-10-03',
      accountId: card.id,
      amountCents: 1234,
      categoryId: food.id,
    });

    const workbook = await buildYearWorkbook(db, 2026);
    expect(workbook.fileName).toBe('记账本-2026.xlsx');
    expect(workbook.detailRows).toBe(2);
    expect(workbook.summaryRows).toBe(2);

    const detail = detailSheet(workbook.bytes);
    expect(detail).toContain('2026-10-03');
    expect(detail).toContain('2026-09-20');

    const summary = summarySheet(workbook.bytes);
    expect(summary).toContain('<c r="B2" s="1"><v>62.34</v></c>');
    expect(summary).toContain('<c r="C2"><v>6234</v></c>');
    expect(summary).toContain('<c r="B3" s="1"><v>62.34</v></c>');
    expect(summary).toContain('<c r="C3"><v>6234</v></c>');
  });

  it('rejects a year that is not four digits', async () => {
    const db = await seededDb();
    await expect(buildYearWorkbook(db, 999)).rejects.toThrow(RangeError);
  });
});

describe('exportMonthWorkbook / exportYearWorkbook', () => {
  it('hands the bytes and MIME type to the writer, then reports the size', async () => {
    const db = await seededDb();
    const card = await account(db, '饭卡');
    const food = await category(db, '饮食');
    await createExpense(db, {
      date: '2026-10-01',
      accountId: card.id,
      amountCents: 1234,
      categoryId: food.id,
    });

    const writer = memoryWriter();
    const result = await exportMonthWorkbook(db, writer, '2026-10');

    expect(writer.written).toHaveLength(1);
    expect(writer.written[0]!.fileName).toBe('记账本-2026-10.xlsx');
    expect(writer.written[0]!.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(result).toEqual({
      fileName: '记账本-2026-10.xlsx',
      bytes: writer.written[0]!.bytes.length,
      detailRows: 1,
    });
    expect(readZipStrict(writer.written[0]!.bytes)).toHaveLength(7);
  });

  it('rejects when the share step fails, with no success result', async () => {
    const db = await seededDb();
    const writer: BinaryFileWriter = {
      async writeForShare() {
        throw new Error('磁盘已满');
      },
    };

    await expect(exportMonthWorkbook(db, writer, '2026-10')).rejects.toThrow('磁盘已满');
  });

  it('never calls the writer for an invalid period', async () => {
    const db = await seededDb();
    const writer = memoryWriter();
    await expect(exportMonthWorkbook(db, writer, '2026-13')).rejects.toThrow(RangeError);
    await expect(exportYearWorkbook(db, writer, 999)).rejects.toThrow(RangeError);
    expect(writer.written).toHaveLength(0);
  });
});