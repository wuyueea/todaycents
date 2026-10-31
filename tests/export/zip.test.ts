import { describe, expect, it } from 'vitest';
import { crc32, storeZip, utf8Bytes } from '../../src/export/zip';
import { crc32ForTest, readZipStrict } from './zipReader';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('crc32', () => {
  it('matches the standard check value and the empty input', () => {
    expect(crc32(utf8Bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(utf8Bytes('账本'))).toBe(crc32ForTest(utf8Bytes('账本')));
  });
});

describe('storeZip', () => {
  it('writes local headers, a central directory and an end record', () => {
    const first = utf8Bytes('hello');
    const second = utf8Bytes('账本 / ledger');
    const bytes = storeZip([
      { name: 'a.txt', data: first },
      { name: 'dir/notes.xml', data: second },
    ]);

    const entries = readZipStrict(bytes);
    expect(entries.map(entry => entry.name)).toEqual(['a.txt', 'dir/notes.xml']);
    expect(entries.map(entry => text(entry.data))).toEqual(['hello', '账本 / ledger']);

    for (const entry of entries) {
      expect(entry.versionMadeBy).toBe(20);
      expect(entry.versionNeeded).toBe(20);
      expect(entry.flags).toBe(0x0800);
      expect(entry.method).toBe(0);
      expect(entry.dosTime).toBe(0);
      expect(entry.dosDate).toBe(0x0021);
      expect(entry.crc).toBe(crc32(entry.data));
    }

    // The first local header starts at byte 0, with the fixed DOS stamp.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint16(12, true)).toBe(0x0021);
  });

  it('is deterministic for identical inputs', () => {
    const input = [
      { name: 'one.xml', data: '<one>1</one>' },
      { name: 'two.xml', data: utf8Bytes('two') },
    ] as const;
    expect(storeZip(input)).toEqual(storeZip(input));
  });

  it('accepts an empty archive and round-trips empty entries', () => {
    expect(readZipStrict(storeZip([]))).toEqual([]);

    const entries = readZipStrict(storeZip([{ name: 'empty', data: new Uint8Array() }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.uncompressedSize).toBe(0);
    expect(entries[0]!.crc).toBe(0);
  });

  it('rejects duplicate names instead of writing an ambiguous archive', () => {
    expect(() =>
      storeZip([
        { name: 'same.txt', data: 'one' },
        { name: 'same.txt', data: 'two' },
      ])
    ).toThrow(/duplicate/i);
  });
});
