import { describe, expect, it } from 'vitest';
import { buildXlsx, formulaCell, moneyLiteral, numberLiteral } from '../../src/export/xlsx';
import { readZipStrict } from './zipReader';

const utf8 = new TextDecoder();

function part(bytes: Uint8Array, name: string): string {
  const entry = readZipStrict(bytes).find(candidate => candidate.name === name);
  if (entry === undefined) throw new Error(`missing part ${name}`);
  return utf8.decode(entry.data);
}

const SHEETS = [
  {
    name: '明细',
    columnWidths: [12, 12, 12, 30],
    freezeHeader: true,
    rows: [
      ['日期', '金额（元）', '金额（分）', '备注'],
      ['2026-10-01', numberLiteral('12.34'), 1234, '午饭 & "汤" <辣>'],
      ['2026-10-02', numberLiteral('-0.05'), -5, ''],
    ],
  },
  {
    name: '汇总',
    rows: [
      ['分类', '金额（元）', '金额（分）'],
      ['饮食', numberLiteral('12.34'), 1234],
      ['总计', numberLiteral('12.34'), 1234],
    ],
  },
];

describe('buildXlsx', () => {
  it('writes explicit formulas with exact cached results and requests recalculation', () => {
    const bytes = buildXlsx([{ name: '汇总', rows: [
      [formulaCell('SUM(C2:C3)', numberLiteral('30')),
       formulaCell('ROUND(C4/100,2)', moneyLiteral('0.30'))],
    ] }]);
    const xml = part(bytes, 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('<c r="A1"><f>SUM(C2:C3)</f><v>30</v></c>');
    expect(xml).toContain('<c r="B1" s="1"><f>ROUND(C4/100,2)</f><v>0.30</v></c>');
    expect(part(bytes, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1" forceFullCalc="1"');
  });

  it('keeps formula-looking user strings literal and rejects unsupported explicit formulas', () => {
    for (const text of ['=SUM(C2:C3)', '+1+1', '-2+3', '@SUM(A1)', '=HYPERLINK("https://example.com")']) {
      const xml = part(buildXlsx([{ name: 'S', rows: [[text]] }]), 'xl/worksheets/sheet1.xml');
      expect(xml).toContain('t="inlineStr"');
      expect(xml).not.toContain('<f>');
    }
    expect(() => formulaCell('HYPERLINK("https://example.com")', numberLiteral('0'))).toThrow();
    expect(() => buildXlsx([{ name: 'S', rows: [[{ formula: '0', cached: { numberText: 'NaN' } }]] }])).toThrow();
  });

  it('combines report header, total, numeric and wrapping styles without losing number formats', () => {
    const bytes = buildXlsx([{ name: 'S', reportStyle: { wrapColumns: [0], totalRow: 3 },
      rows: [['分类', '元', '分'], ['长分类', moneyLiteral('0.30'), 30],
        ['总计', formulaCell('ROUND(C3/100,2)', moneyLiteral('0.30')), formulaCell('SUM(C2:C2)', numberLiteral('30'))]],
    }]);
    const xml = part(bytes, 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('<c r="A1" s="4" t="inlineStr">');
    expect(xml).toContain('<c r="A2" s="3" t="inlineStr">');
    expect(xml).toContain('<c r="C2" s="2"><v>30</v></c>');
    expect(xml).toContain('<c r="A3" s="5" t="inlineStr">');
    expect(xml).toContain('<c r="B3" s="6"><f>');
    expect(xml).toContain('<c r="C3" s="7"><f>');
    const styles = part(bytes, 'xl/styles.xml');
    expect(styles).toContain('rgb="FFF7DFC4"');
    expect(styles).toContain('rgb="FFFFF1DD"');
    expect(styles).toContain('horizontal="right"');
    expect(styles).toContain('wrapText="1"');
    expect(styles).toContain('formatCode="#,##0;&quot;−&quot;#,##0;0"');
  });

  it('makes wrapped CJK and multiline rows taller and caps excessive text at the Excel height limit', () => {
    const xml = part(buildXlsx([{ name: 'S', columnWidths: [12], reportStyle: { wrapColumns: [0] },
      rows: [['备注'], ['一二三四五六七八九十'], ['a\nb\nc'], ['长'.repeat(3000)]],
    }]), 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('<row r="2" ht="40" customHeight="1">');
    expect(xml).toContain('<row r="3" ht="56" customHeight="1">');
    expect(xml).toContain('<row r="4" ht="409" customHeight="1">');
    expect(xml).toContain('长'.repeat(3000));
  });

  it('emits the minimal SpreadsheetML package with no shared-string table', () => {
    const bytes = buildXlsx(SHEETS);
    const entries = readZipStrict(bytes);

    expect(entries.map(entry => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      // One shared style sheet: Excel needs it for the money format, and a
      // package without it silently drops every number format.
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    expect(entries.some(entry => entry.name.includes('sharedStrings'))).toBe(false);

    const contentTypes = part(bytes, '[Content_Types].xml');
    expect(contentTypes).toContain(
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    );
    expect(contentTypes).toContain(
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    );
    expect(contentTypes).toContain(
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    );
    expect(contentTypes).toContain(
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    );

    const rootRels = part(bytes, '_rels/.rels');
    expect(rootRels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"'
    );
    expect(rootRels).toContain('Target="xl/workbook.xml"');

    const workbook = part(bytes, 'xl/workbook.xml');
    expect(workbook).toContain('<sheet name="明细" sheetId="1" r:id="rId1"/>');
    expect(workbook).toContain('<sheet name="汇总" sheetId="2" r:id="rId2"/>');

    const workbookRels = part(bytes, 'xl/_rels/workbook.xml.rels');
    expect(workbookRels).toContain('Id="rId1"');
    expect(workbookRels).toContain('Target="worksheets/sheet1.xml"');
    expect(workbookRels).toContain('Id="rId2"');
    expect(workbookRels).toContain('Target="worksheets/sheet2.xml"');
    expect(workbookRels).toContain('Id="rId3"');
    expect(workbookRels).toContain('Target="styles.xml"');

    const styles = part(bytes, 'xl/styles.xml');
    expect(styles).toContain('<numFmt numFmtId="164" formatCode="#,##0.00;&quot;−&quot;#,##0.00;0.00"/>');
    expect(styles).toContain('numFmtId="164"');
  });

  it('writes inline strings, real numbers and numeric literals exactly', () => {
    const xml = part(buildXlsx(SHEETS), 'xl/worksheets/sheet1.xml');

    expect(xml).toContain('<dimension ref="A1:D3"/>');
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('<col min="1" max="1" width="12" customWidth="1"/>');
    expect(xml).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">2026-10-01</t></is></c>'
    );
    expect(xml).toContain('<c r="B2"><v>12.34</v></c>');
    expect(xml).toContain('<c r="C2"><v>1234</v></c>');
    expect(xml).toContain(
      '<c r="D2" t="inlineStr"><is><t xml:space="preserve">午饭 &amp; &quot;汤&quot; &lt;辣&gt;</t></is></c>'
    );
    expect(xml).toContain('<c r="B3"><v>-0.05</v></c>');
    expect(xml).toContain('<c r="C3"><v>-5</v></c>');
    expect(xml).not.toContain('t="s"');

    const summary = part(buildXlsx(SHEETS), 'xl/worksheets/sheet2.xml');
    expect(summary).toContain('<c r="B3"><v>12.34</v></c>');
    expect(summary).toContain('<c r="C3"><v>1234</v></c>');
  });

  it('keeps a string that looks like a number as an inline string', () => {
    const xml = part(
      buildXlsx([{ name: 'S', rows: [['12.34', 12.34]] }]),
      'xl/worksheets/sheet1.xml'
    );
    expect(xml).toContain(
      '<c r="A1" t="inlineStr"><is><t xml:space="preserve">12.34</t></is></c>'
    );
    expect(xml).toContain('<c r="B1"><v>12.34</v></c>');
  });

  it('strips XML-illegal control characters rather than emitting a corrupt part', () => {
    const xml = part(
      buildXlsx([{ name: 'S', rows: [['a\u0000b\u0008c']] }]),
      'xl/worksheets/sheet1.xml'
    );
    expect(xml).toContain('abc');
    expect(xml).not.toContain('\u0000');
  });

  it('is deterministic', () => {
    expect(buildXlsx(SHEETS)).toEqual(buildXlsx(SHEETS));
  });

  it('rejects malformed numeric literals', () => {
    expect(() => numberLiteral('12.345')).toThrow(RangeError);
    expect(() => numberLiteral('1e3')).toThrow(RangeError);
    expect(() => numberLiteral('NaN')).toThrow(RangeError);
    expect(() => numberLiteral('')).toThrow(RangeError);
  });

  it('rejects invalid sheet names and non-finite numbers', () => {
    expect(() => buildXlsx([])).toThrow(/at least one sheet/i);
    expect(() => buildXlsx([{ name: 'a/b', rows: [] }])).toThrow(/sheet name/i);
    expect(() => buildXlsx([{ name: 'x'.repeat(32), rows: [] }])).toThrow(/sheet name/i);
    expect(() => buildXlsx([{ name: 'S', rows: [[Number.NaN]] }])).toThrow(RangeError);
    expect(() => buildXlsx([{ name: 'S', rows: [[Number.POSITIVE_INFINITY]] }])).toThrow(
      RangeError
    );
  });
});
