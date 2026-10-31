/**
 * The retired day grid's data model, kept for a future "常用一笔" feature.
 *
 * A template is a named slot (午餐) pointing at a default account and category.
 * No screen renders the grid any more, so nothing in the app consumes
 * listTemplates/submitDay today; the table, repository and its tests remain so
 * the model can be reused without a migration. Templates are hints only: the
 * account, category and amount a user actually edits live on the transaction
 * row, never on the template.
 *
 * Two invariants shape this module. Money is integer cents, and a day is
 * all-or-nothing: every cell is validated before the single transaction opens,
 * so a bad cell rolls the whole evening back instead of recording half of it.
 * And a submit is idempotent per (date, slot_key): pressing 保存 twice leaves
 * one row per slot, never duplicate spending.
 */
import type { Db, DbParam } from '../driver';
import { newId } from '../id';
import { assertTxnDate, createExpense } from './txns';

/** One retained slot of the day-grid model. */
export interface Template {
  id: string;
  slotKey: string;
  label: string;
  categoryId: string | null;
  defaultAccountId: string | null;
  defaultAmountCents: number | null;
  sort: number;
  active: boolean;
}

/**
 * Everything upsertTemplate needs. slotKey is the identity: it is UNIQUE in
 * the schema and is what makes a second upsert land on the same row. Omitting
 * sort leaves an existing row position untouched; a brand-new slot is
 * appended after the current grid.
 */
export interface UpsertTemplateInput {
  slotKey: string;
  label: string;
  categoryId: string | null;
  defaultAccountId: string | null;
  /** Suggested amount in integer cents; null starts the cell out blank. */
  defaultAmountCents: number | null;
  sort?: number;
}

/**
 * One cell of one evening grid. amountCents === null is a blank cell: it is
 * skipped entirely and neither creates nor deletes nor rewrites anything.
 */
export interface DayCell {
  slotKey: string;
  amountCents: number | null;
  accountId: string;
  categoryId: string | null;
}

/** A cell that carries an amount; the only kind that writes a row. */
interface FilledDayCell extends DayCell {
  amountCents: number;
}

/** Raw template row; the only shape that knows about snake_case columns. */
interface TemplateRow {
  id: string;
  slot_key: string;
  label: string;
  category_id: string | null;
  default_account_id: string | null;
  default_amount_cents: number | null;
  sort: number;
  active: number;
}

const TEMPLATE_COLUMNS = `id, slot_key, label, category_id, default_account_id,
       default_amount_cents, sort, active`;

/** Single row-to-object mapping; nothing else touches raw column names. */
function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    slotKey: row.slot_key,
    label: row.label,
    categoryId: row.category_id,
    defaultAccountId: row.default_account_id,
    defaultAmountCents: row.default_amount_cents,
    sort: row.sort,
    active: row.active === 1,
  };
}

/**
 * Guards the integer-cents invariant for both a template default and a
 * submitted cell. Zero and negative amounts are rejected too: an amount is a
 * magnitude, and the expense sign is applied when the row is written.
 */
function assertAmountCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer number of cents, received ${value}`);
  }
}

/** The slot key is the identity of a grid row; a blank one can never be addressed. */
function assertSlotKey(slotKey: string): void {
  if (typeof slotKey !== 'string' || slotKey.trim() === '') {
    throw new Error(`slotKey must be a non-empty string, received ${JSON.stringify(slotKey)}`);
  }
}

/**
 * Active templates in display order. Ties on sort fall back to slot_key so the
 * grid is identical on every load; inactive slots keep their row but are not
 * rendered, the same way archived accounts and categories disappear.
 */
export async function listTemplates(db: Db): Promise<Template[]> {
  const rows = await db.all<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM template WHERE active = 1 ORDER BY sort, slot_key`
  );
  return rows.map(toTemplate);
}

/** Next append position among all templates, inactive ones included. */
async function nextSort(db: Db): Promise<number> {
  const row = await db.get<{ next_sort: number }>(
    'SELECT COALESCE(MAX(sort), -1) + 1 AS next_sort FROM template'
  );
  return row?.next_sort ?? 0;
}

/**
 * One statement handles both insert and update, keyed on the UNIQUE slot_key.
 * active is deliberately absent from the DO UPDATE list: a slot the user hid
 * stays hidden when its label or default is edited. sort is absent as well;
 * the second statement below is the only one allowed to move a slot.
 */
const UPSERT_TEMPLATE = `INSERT INTO template
   (id, slot_key, label, category_id, default_account_id, default_amount_cents, sort, active)
 VALUES (?, ?, ?, ?, ?, ?, ?, 1)
 ON CONFLICT(slot_key) DO UPDATE SET
   label = excluded.label,
   category_id = excluded.category_id,
   default_account_id = excluded.default_account_id,
   default_amount_cents = excluded.default_amount_cents`;

/** The same upsert, plus an explicit position move. */
const UPSERT_TEMPLATE_WITH_SORT = `${UPSERT_TEMPLATE},
   sort = excluded.sort`;

/**
 * Creates a slot or updates the one already using its slot_key.
 *
 * Validation runs before the statement, so a fractional default amount writes
 * nothing. No transaction is opened: either path is a single statement.
 */
export async function upsertTemplate(db: Db, input: UpsertTemplateInput): Promise<void> {
  assertSlotKey(input.slotKey);
  if (input.label.trim() === '') {
    throw new Error('template label must not be empty');
  }
  if (input.defaultAmountCents !== null) {
    assertAmountCents(input.defaultAmountCents, 'defaultAmountCents');
  }
  if (input.sort !== undefined && !Number.isSafeInteger(input.sort)) {
    throw new RangeError(`sort must be an integer, received ${input.sort}`);
  }

  // An omitted sort must not overwrite the stored one, so it only decides the
  // position of a row that does not exist yet; the DO UPDATE list above leaves
  // sort alone in that case.
  const sort = input.sort ?? (await nextSort(db));
  const sql = input.sort === undefined ? UPSERT_TEMPLATE : UPSERT_TEMPLATE_WITH_SORT;

  const params: DbParam[] = [
    newId(),
    input.slotKey,
    input.label,
    input.categoryId,
    input.defaultAccountId,
    input.defaultAmountCents,
    sort,
  ];
  await db.run(sql, params);
}

/**
 * The live expense of one slot on one day. Soft-deleted rows are excluded, so
 * a slot whose row was deleted counts as empty and a new submit records a new
 * row instead of editing history. direction is narrowed to expense: the grid
 * only ever owns spending rows, and a stray slot_key on anything else must not
 * be hijacked. Newest first, so even a legacy duplicate is updated once.
 */
const FIND_DAY_SLOT = `SELECT id FROM txn
 WHERE occurred_date = ? AND slot_key = ? AND direction = 'expense' AND deleted_at IS NULL
 ORDER BY created_at DESC, id DESC
 LIMIT 1`;

/**
 * Rewrites amount, account and category of an existing slot row. The sign is
 * applied here, exactly as createExpense applies it, because the update path
 * never goes through the transaction repository INSERT.
 */
const UPDATE_DAY_SLOT = `UPDATE txn
 SET amount_cents = ?, account_id = ?, category_id = ?
 WHERE id = ?`;

function isFilledCell(cell: DayCell): cell is FilledDayCell {
  return cell.amountCents !== null;
}

/**
 * Rejects the whole submission before anything is written: a bad amount, a
 * blank slot key, or the same slot twice (two cells for one slot would write
 * one row and report two, so the count would lie).
 */
function assertDayCells(cells: readonly FilledDayCell[]): void {
  const seen = new Set<string>();
  for (const cell of cells) {
    assertSlotKey(cell.slotKey);
    assertAmountCents(cell.amountCents, 'amountCents');
    if (seen.has(cell.slotKey)) {
      throw new Error(`submitDay received two cells for slot ${cell.slotKey}`);
    }
    seen.add(cell.slotKey);
  }
}

/**
 * Turns one evening grid into rows and returns how many were written.
 *
 * A blank cell (amountCents === null) is skipped: it neither creates a row nor
 * deletes or rewrites the one already stored for that slot. Every filled cell
 * is written idempotently: the live expense for that exact (date, slot_key) is
 * updated in place, otherwise createExpense inserts it. Submitting the same day
 * twice therefore leaves exactly one row per slot. The count is incremented per
 * successful write, so it reports the rows actually written (updates included)
 * rather than the size of the input; today every filled cell writes one row, so
 * the two numbers coincide.
 *
 * All validation happens before the single db.transaction opens, and every
 * write happens inside it. A rejected amount therefore leaves no trace of the
 * day, and a row that fails a foreign key rolls back the cells written before
 * it. createExpense opens no transaction of its own by design: the driver
 * transactions are not re-entrant, and this is the one unit of work for the
 * day. A day with nothing filled opens no transaction at all: it writes
 * nothing, so it needs no atomicity. Callers must not wrap submitDay in a
 * transaction of their own for the same reason.
 */
export async function submitDay(db: Db, dateISO: string, cells: DayCell[]): Promise<number> {
  assertTxnDate(dateISO);

  const filled = cells.filter(isFilledCell);
  assertDayCells(filled);
  if (filled.length === 0) return 0;

  return db.transaction(async (tx) => {
    let written = 0;
    for (const cell of filled) {
      const existing = await tx.get<{ id: string }>(FIND_DAY_SLOT, [dateISO, cell.slotKey]);
      if (existing === undefined) {
        await createExpense(tx, {
          date: dateISO,
          accountId: cell.accountId,
          amountCents: cell.amountCents,
          categoryId: cell.categoryId,
          slotKey: cell.slotKey,
        });
      } else {
        await tx.run(UPDATE_DAY_SLOT, [
          -cell.amountCents,
          cell.accountId,
          cell.categoryId,
          existing.id,
        ]);
      }
      written += 1;
    }
    return written;
  });
}
