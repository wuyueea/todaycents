/**
 * A minimal SpreadsheetML writer.
 *
 * Only the parts Excel/Open XML actually needs are emitted: content types,
 * package relationships, the workbook, its worksheet relationships and the
 * worksheets themselves. There is deliberately no shared-string table:
 * strings are inline (`t="inlineStr"`), which keeps the writer to one pass and
 * makes each sheet part self-contained.
 *
 * Numbers are written as numbers. A money cell is supplied as a NumberLiteral
 * built from integer cents by formatCents, so the decimal text in the XML is
 * produced by string manipulation, never by dividing a float. That is what
 * keeps 12.34 exactly "12.34" and makes 0.10 + 0.20 display 0.30.
 */
import { storeZip } from './zip';

/** A numeric cell whose XML text is already exact (used for yuan). */
export interface XlsxNumberLiteral {
  readonly numberText: string;
  /**
   * 'money' asks for the two-decimal cell format. Without it Excel's General
   * format shows 25.00 as 25, which in a money column reads like a bug.
   */
  readonly style?: 'money';
}

/** Style index 1 in styles.xml: the two-decimal money format. */
const MONEY_STYLE = 1;

/** A cell value: inline text, a JS number, or an exact numeric literal. */
export type XlsxCellValue = string | number | XlsxNumberLiteral | null | undefined;

/** One worksheet: a name, rows of cells, and optional presentation hints. */
export interface XlsxSheet {
  name: string;
  rows: readonly (readonly XlsxCellValue[])[];
  /** Column widths in Excel character units, one per column. */
  columnWidths?: readonly number[];
  /** Freeze row 1 so the heading stays visible while scrolling. */
  freezeHeader?: boolean;
}

const EXACT_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const SHEET_NAME_FORBIDDEN = /[\\/?*\[\]:]/;
const SHEET_NAME_CONTROL = /[\u0000-\u001F]/;
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const MAX_CELL_CHARS = 32767;

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Declares an exact numeric literal. Only plain decimal notation with at most
 * two fraction digits is accepted: money is never represented in exponent
 * notation, and NaN/Infinity cannot reach the XML.
 */
export function numberLiteral(text: string): XlsxNumberLiteral {
  if (!EXACT_NUMBER.test(text)) {
    throw new RangeError(`numeric literal must be a plain decimal with at most 2 decimals: ${text}`);
  }
  return { numberText: text };
}

/** A yuan cell that keeps its two decimals on screen. */
export function moneyLiteral(text: string): XlsxNumberLiteral {
  return { ...numberLiteral(text), style: 'money' };
}

/** One inline string cell's text, made XML-safe and bounded to Excel's limit. */
function xmlText(value: string): string {
  const cleaned = value.replace(XML_ILLEGAL, '');
  const characters = Array.from(cleaned);
  const bounded =
    characters.length > MAX_CELL_CHARS
      ? characters.slice(0, MAX_CELL_CHARS - 1).join('') + '…'
      : cleaned;
  return bounded.replace(/[&<>"']/g, character => XML_ESCAPES[character]!);
}

/** A1-style column name for a zero-based column index. */
function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function isNumberLiteral(value: XlsxCellValue): value is XlsxNumberLiteral {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as XlsxNumberLiteral).numberText === 'string'
  );
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cell numbers must be finite, received ${value}`);
  }
  return Object.is(value, -0) ? '0' : String(value);
}

function cellXml(value: XlsxCellValue, reference: string): string {
  if (typeof value === 'string') {
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlText(
      value
    )}</t></is></c>`;
  }
  if (typeof value === 'number') {
    return `<c r="${reference}"><v>${numberText(value)}</v></c>`;
  }
  if (isNumberLiteral(value)) {
    // Revalidate at the boundary: an object can be produced by hand even
    // though numberLiteral is the documented constructor.
    numberLiteral(value.numberText);
    const style = value.style === 'money' ? ` s="${MONEY_STYLE}"` : '';
    return `<c r="${reference}"${style}><v>${value.numberText}</v></c>`;
  }
  throw new TypeError(`unsupported cell value: ${String(value)}`);
}

function dimensionOf(sheet: XlsxSheet): string {
  const rowCount = Math.max(1, sheet.rows.length);
  let columnCount = 1;
  for (const row of sheet.rows) {
    columnCount = Math.max(columnCount, row.length);
  }
  const last = `${columnName(columnCount - 1)}${rowCount}`;
  return last === 'A1' ? 'A1' : `A1:${last}`;
}

function sheetViewsXml(freezeHeader: boolean): string {
  if (!freezeHeader) return '';
  return (
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    '</sheetView></sheetViews>'
  );
}

function colsXml(widths: readonly number[] | undefined): string {
  if (widths === undefined || widths.length === 0) return '';
  const columns = widths.map((width, index) => {
    if (!Number.isFinite(width) || width <= 0) {
      throw new RangeError(`column width must be positive and finite, received ${width}`);
    }
    const column = index + 1;
    return `<col min="${column}" max="${column}" width="${width}" customWidth="1"/>`;
  });
  return `<cols>${columns.join('')}</cols>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const rows = sheet.rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) => {
      if (value === null || value === undefined) return '';
      return cellXml(value, `${columnName(columnIndex)}${rowNumber}`);
    });
    return `<row r="${rowNumber}">${cells.join('')}</row>`;
  });

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dimensionOf(sheet)}"/>` +
    sheetViewsXml(sheet.freezeHeader === true) +
    colsXml(sheet.columnWidths) +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>'
  );
}

function validateSheetNames(sheets: readonly XlsxSheet[]): void {
  const seen = new Set<string>();
  for (const sheet of sheets) {
    const length = Array.from(sheet.name).length;
    if (
      length === 0 ||
      length > 31 ||
      SHEET_NAME_FORBIDDEN.test(sheet.name) ||
      SHEET_NAME_CONTROL.test(sheet.name) ||
      sheet.name.startsWith("'") ||
      sheet.name.endsWith("'")
    ) {
      throw new Error(`invalid sheet name: ${JSON.stringify(sheet.name)}`);
    }
    const key = sheet.name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`duplicate sheet name: ${sheet.name}`);
    }
    seen.add(key);
  }
}

function contentTypesXml(sheets: readonly XlsxSheet[]): string {
  const worksheetOverrides = sheets
    .map(
      (_sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    worksheetOverrides +
    '</Types>'
  );
}

/**
 * The one style this writer needs: a money cell that shows two decimals.
 *
 * Excel demands the full five-part skeleton even when only one format is used —
 * without fills[gray125] some readers refuse the file, and a cellXfs entry must
 * always be present for the default style.
 */
function stylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    // Excel and openpyxl both want the built-in Normal style declared; without
    // it a reader warns that the workbook has no default style.
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

function rootRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'
  );
}

function workbookXml(sheets: readonly XlsxSheet[]): string {
  const sheetNodes = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${xmlText(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetNodes}</sheets></workbook>`
  );
}

function workbookRelsXml(sheets: readonly XlsxSheet[]): string {
  const relationships =
    sheets
      .map(
        (_sheet, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
      )
      .join('') +
    // The style sheet is never referenced by id, only by position: a package
    // that omits it makes readers drop the number formats entirely.
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    relationships +
    '</Relationships>'
  );
}

/**
 * Builds a complete .xlsx package. The member order is fixed and every
 * timestamp is the ZIP writer's fixed DOS stamp, so equal sheets give equal
 * bytes.
 */
export function buildXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) {
    throw new Error('at least one sheet is required');
  }
  validateSheetNames(sheets);

  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml(sheets) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'xl/workbook.xml', data: workbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml(sheets) },
    { name: 'xl/styles.xml', data: stylesXml() },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: sheetXml(sheet),
    })),
  ];

  return storeZip(entries);
}
