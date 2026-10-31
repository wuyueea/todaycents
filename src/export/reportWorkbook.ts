/**
 * The workbook behind 报表 › 导出表格: one detail sheet and one summary sheet.
 *
 * The summary is the report repository's own category total, so the exported
 * numbers and the numbers on screen cannot disagree. The detail sheet is every
 * live row of the period, including income, transfers and adjustments: a
 * "流水明细" that silently dropped rows would be a different document. Money
 * stays integer cents; the yuan column is a decimal string produced by
 * formatCents, never a division, and the cents column is an integer.
 */
import type { Db } from '../db/driver';
import { isMonthKey } from '../domain/date';
import { formatCents } from '../domain/money';
import { listTagsForTxns } from '../db/repos/tags';
import { listTxnsByMonth } from '../db/repos/txns';
import type { TxnRow } from '../db/repos/txns';
import { monthReport, yearReport } from '../db/repos/reports';
import type { ReportCategory } from '../db/repos/reports';
import { buildXlsx, moneyLiteral } from './xlsx';
import type { XlsxCellValue } from './xlsx';
import { XLSX_MIME_TYPE } from './writer';
import type { BinaryFileWriter } from './writer';

/** Source rows and totals for one period, with tag names already resolved. */
export interface ReportWorkbookInput {
  rows: readonly TxnRow[];
  /** Tag names per transaction id; a missing id means no tags. */
  tagsByTxn: ReadonlyMap<string, readonly string[]>;
  /** The report's category rows, largest first. */
  categories: readonly Pick<ReportCategory, 'name' | 'cents'>[];
  /** The period's expense total in positive integer cents. */
  expenseCents: number;
}

/** A built workbook plus the counts the caller reports after a successful share. */
export interface ReportWorkbookResult {
  fileName: string;
  bytes: Uint8Array;
  detailRows: number;
  summaryRows: number;
}

/** What a successful export tells the screen. */
export interface ReportExportResult {
  fileName: string;
  bytes: number;
  detailRows: number;
}

const DETAIL_WIDTHS = [12, 12, 12, 12, 12, 16, 18, 32] as const;
const SUMMARY_WIDTHS = [18, 14, 14] as const;
const TAG_BATCH_SIZE = 400;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function assertMonthKey(monthKey: string): void {
  if (!isMonthKey(monthKey)) {
    throw new RangeError(`monthKey must be YYYY-MM, received ${monthKey}`);
  }
  const year = Number(monthKey.slice(0, 4));
  if (year < 1000) {
    throw new RangeError(`monthKey must carry a four-digit year, received ${monthKey}`);
  }
}

function assertYear(year: number): void {
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`year must be a four-digit calendar year, received ${year}`);
  }
}

/** The download name for one month, e.g. 记账本-2026-10.xlsx. */
export function monthWorkbookFileName(monthKey: string): string {
  assertMonthKey(monthKey);
  return `记账本-${monthKey}.xlsx`;
}

/** The download name for one year, e.g. 记账本-2026.xlsx. */
export function yearWorkbookFileName(year: number): string {
  assertYear(year);
  return `记账本-${year}.xlsx`;
}

/**
 * How a row's 分类 cell reads. Expenses and income without a category are the
 * report's 未分类; a transfer leg or an adjustment has no category by design,
 * so it is named by the thing it is instead of being mislabelled 未分类.
 */
function categoryLabel(row: TxnRow): string {
  if (row.categoryName !== null) return row.categoryName;
  if (row.direction === 'transfer') return '转账';
  if (row.direction === 'adjust') return '调整';
  return '未分类';
}

function detailRow(row: TxnRow, tagNames: readonly string[]): XlsxCellValue[] {
  return [
    row.occurredDate,
    moneyLiteral(formatCents(row.amountCents)),
    row.amountCents,
    categoryLabel(row),
    row.accountName,
    row.projectName ?? '',
    tagNames.join('、'),
    row.note,
  ];
}

function summaryRows(
  categories: readonly Pick<ReportCategory, 'name' | 'cents'>[],
  expenseCents: number
): XlsxCellValue[][] {
  return [
    ['分类', '金额（元）', '金额（分）'],
    ...categories.map(category => [
      category.name,
      moneyLiteral(formatCents(category.cents)),
      category.cents,
    ]),
    ['总计', moneyLiteral(formatCents(expenseCents)), expenseCents],
  ];
}

/**
 * Builds the two-sheet package from already-read rows.
 *
 * The category rows must add up to the reported expense total. This is the same
 * partition the pie relies on; if it ever fails, exporting must fail loudly
 * instead of producing a summary whose total does not match its lines.
 */
export function buildReportWorkbook(input: ReportWorkbookInput): Uint8Array {
  const categorySum = input.categories.reduce((sum, category) => sum + category.cents, 0);
  if (!Number.isSafeInteger(categorySum) || categorySum !== input.expenseCents) {
    throw new Error(
      `category rows add up to ${categorySum} cents, but the period total is ${input.expenseCents}`
    );
  }

  // The detail read and the report read are two queries. If a write landed
  // between them, the workbook would show a total its own rows contradict;
  // refusing to build is better than exporting a document that does not add up.
  let detailSum = 0;
  for (const row of input.rows) {
    if (row.direction === 'expense' && row.deletedAt === null) {
      detailSum -= row.amountCents;
    }
  }
  if (!Number.isSafeInteger(detailSum) || detailSum !== input.expenseCents) {
    throw new Error(
      `detail rows add up to ${detailSum} cents, but the period total is ${input.expenseCents}`
    );
  }

  const detail: XlsxCellValue[][] = [
    ['日期', '金额（元）', '金额（分）', '分类', '账户', '项目', '标签', '备注'],
    ...input.rows.map(row => detailRow(row, input.tagsByTxn.get(row.id) ?? [])),
  ];

  return buildXlsx([
    {
      name: '明细',
      rows: detail,
      columnWidths: DETAIL_WIDTHS,
      freezeHeader: true,
    },
    {
      name: '汇总',
      rows: summaryRows(input.categories, input.expenseCents),
      columnWidths: SUMMARY_WIDTHS,
      freezeHeader: true,
    },
  ]);
}

/**
 * Tag names for many rows, in batches so a month with hundreds of rows cannot
 * exceed SQLite's bound-variable limit. Archived tags are included by the
 * repository: the row was labelled that way when it was written.
 */
async function loadTagNames(
  db: Db,
  rows: readonly TxnRow[]
): Promise<Map<string, string[]>> {
  const byTxn = new Map<string, string[]>();
  const ids = rows.map(row => row.id);
  for (let index = 0; index < ids.length; index += TAG_BATCH_SIZE) {
    const batch = ids.slice(index, index + TAG_BATCH_SIZE);
    const tags = await listTagsForTxns(db, batch);
    for (const [id, list] of tags) {
      byTxn.set(
        id,
        list.map(tag => tag.name)
      );
    }
  }
  return byTxn;
}

/** Everything the month export needs, read once from the repositories. */
export async function buildMonthWorkbook(db: Db, monthKey: string): Promise<ReportWorkbookResult> {
  const fileName = monthWorkbookFileName(monthKey);
  const report = await monthReport(db, monthKey);
  const rows = await listTxnsByMonth(db, monthKey);
  const tagsByTxn = await loadTagNames(db, rows);

  return {
    fileName,
    bytes: buildReportWorkbook({
      rows,
      tagsByTxn,
      categories: report.categories,
      expenseCents: report.expenseCents,
    }),
    detailRows: rows.length,
    summaryRows: report.categories.length + 1,
  };
}

/**
 * Everything the year export needs. The detail rows come from the same
 * month-bounded read, twelve times over, then sort newest first across the
 * year; the summary is yearReport's category total.
 */
export async function buildYearWorkbook(db: Db, year: number): Promise<ReportWorkbookResult> {
  const fileName = yearWorkbookFileName(year);
  const report = await yearReport(db, year);
  const rows: TxnRow[] = [];
  for (let month = 1; month <= 12; month += 1) {
    rows.push(...(await listTxnsByMonth(db, `${year}-${pad2(month)}`)));
  }
  // ISO dates compare correctly as text; the codepoint comparison is the
  // locale-independent one the rest of the app uses for deterministic order.
  rows.sort((left, right) =>
    left.occurredDate < right.occurredDate ? 1 : left.occurredDate > right.occurredDate ? -1 : 0
  );
  const tagsByTxn = await loadTagNames(db, rows);

  return {
    fileName,
    bytes: buildReportWorkbook({
      rows,
      tagsByTxn,
      categories: report.categories,
      expenseCents: report.expenseCents,
    }),
    detailRows: rows.length,
    summaryRows: report.categories.length + 1,
  };
}

function exportResult(workbook: ReportWorkbookResult): ReportExportResult {
  return {
    fileName: workbook.fileName,
    bytes: workbook.bytes.length,
    detailRows: workbook.detailRows,
  };
}

/**
 * Builds the month workbook, hands its bytes to the shared export channel, and
 * only then returns a success result. A rejected write rejects this function;
 * there is no path that reports a file the writer did not accept.
 */
export async function exportMonthWorkbook(
  db: Db,
  writer: BinaryFileWriter,
  monthKey: string
): Promise<ReportExportResult> {
  const workbook = await buildMonthWorkbook(db, monthKey);
  await writer.writeForShare(workbook.fileName, workbook.bytes, XLSX_MIME_TYPE);
  return exportResult(workbook);
}

/** The year counterpart of exportMonthWorkbook. */
export async function exportYearWorkbook(
  db: Db,
  writer: BinaryFileWriter,
  year: number
): Promise<ReportExportResult> {
  const workbook = await buildYearWorkbook(db, year);
  await writer.writeForShare(workbook.fileName, workbook.bytes, XLSX_MIME_TYPE);
  return exportResult(workbook);
}
