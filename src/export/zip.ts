/**
 * A minimal, deterministic, store-only ZIP writer.
 *
 * An .xlsx is an OPC package: a ZIP whose members are XML parts and
 * relationships. There is no need to compress a few hundred kilobytes of
 * spreadsheet, and "stored" removes both the deflate implementation and a
 * whole class of size/CRC bugs from this app. Every header field is written
 * little-endian by hand, so the only dependency is the platform's TextEncoder.
 *
 * The DOS timestamp is fixed at 1980-01-01 00:00:00. Determinism is a feature,
 * not a side effect: the same workbook must produce the same bytes on every
 * run, which lets tests compare archives byte for byte and lets a backup-like
 * export be reasoned about without a clock.
 */

/** One member of the archive. Text is encoded as UTF-8. */
export interface ZipEntryInput {
  /** Relative member path, e.g. xl/worksheets/sheet1.xml. */
  name: string;
  data: string | Uint8Array;
}

/** Fixed DOS date for 1980-01-01. DOS dates start counting at 1980. */
const DOS_DATE_1980_01_01 = 0x0021;
/** Fixed DOS time: midnight. */
const DOS_TIME_MIDNIGHT = 0;

/** The UTF-8 name flag; every name we write is UTF-8 by definition. */
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

/** UTF-8 bytes, the one encoding every ZIP member uses here. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** CRC-32 (IEEE 802.3), as required by the ZIP local and central headers. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dataBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? utf8Bytes(data) : data;
}

function assertMemberName(name: string, seen: Set<string>): void {
  if (name === '') {
    throw new Error('ZIP member name must not be empty');
  }
  if (name.startsWith('/') || name.includes('\\') || name.includes('\u0000')) {
    throw new Error(`ZIP member name must be a relative path without NUL: ${name}`);
  }
  if (seen.has(name)) {
    throw new Error(`duplicate ZIP member name: ${name}`);
  }
  seen.add(name);
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

interface EncodedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  localOffset: number;
}

/**
 * Builds one archive from the given members, in the given order.
 *
 * No directory, no compression, no extra fields, no comment: every byte is
 * accounted for by the local headers, the central directory and the EOCD.
 */
export function storeZip(entries: readonly ZipEntryInput[]): Uint8Array {
  if (entries.length > 0xffff) {
    throw new RangeError('a store-only ZIP can hold at most 65535 members');
  }

  const seen = new Set<string>();
  const encoded: EncodedEntry[] = [];
  let localSize = 0;
  let centralSize = 0;

  for (const entry of entries) {
    assertMemberName(entry.name, seen);
    const nameBytes = utf8Bytes(entry.name);
    const data = dataBytes(entry.data);
    localSize += 30 + nameBytes.length + data.length;
    centralSize += 46 + nameBytes.length;
    encoded.push({ nameBytes, data, crc: crc32(data), localOffset: 0 });
  }

  const eocdSize = 22;
  const totalSize = localSize + centralSize + eocdSize;
  if (totalSize > 0xffffffff) {
    throw new RangeError('ZIP is too large for the 32-bit format');
  }

  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  for (const entry of encoded) {
    entry.localOffset = offset;
    writeU32(view, offset, 0x04034b50);
    writeU16(view, offset + 4, VERSION);
    writeU16(view, offset + 6, FLAG_UTF8);
    writeU16(view, offset + 8, 0); // store
    writeU16(view, offset + 10, DOS_TIME_MIDNIGHT);
    writeU16(view, offset + 12, DOS_DATE_1980_01_01);
    writeU32(view, offset + 14, entry.crc);
    writeU32(view, offset + 18, entry.data.length);
    writeU32(view, offset + 22, entry.data.length);
    writeU16(view, offset + 26, entry.nameBytes.length);
    writeU16(view, offset + 28, 0); // no extra field
    bytes.set(entry.nameBytes, offset + 30);
    bytes.set(entry.data, offset + 30 + entry.nameBytes.length);
    offset += 30 + entry.nameBytes.length + entry.data.length;
  }

  const centralOffset = offset;
  for (const entry of encoded) {
    writeU32(view, offset, 0x02014b50);
    writeU16(view, offset + 4, VERSION); // version made by
    writeU16(view, offset + 6, VERSION); // version needed
    writeU16(view, offset + 8, FLAG_UTF8);
    writeU16(view, offset + 10, 0); // store
    writeU16(view, offset + 12, DOS_TIME_MIDNIGHT);
    writeU16(view, offset + 14, DOS_DATE_1980_01_01);
    writeU32(view, offset + 16, entry.crc);
    writeU32(view, offset + 20, entry.data.length);
    writeU32(view, offset + 24, entry.data.length);
    writeU16(view, offset + 28, entry.nameBytes.length);
    writeU16(view, offset + 30, 0); // no extra field
    writeU16(view, offset + 32, 0); // no comment
    writeU16(view, offset + 34, 0); // disk number
    writeU16(view, offset + 36, 0); // internal attributes
    writeU32(view, offset + 38, 0); // external attributes
    writeU32(view, offset + 42, entry.localOffset);
    bytes.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.length;
  }

  if (offset !== centralOffset + centralSize) {
    throw new Error('internal ZIP error: central directory size drifted');
  }

  writeU32(view, offset, 0x06054b50);
  writeU16(view, offset + 4, 0); // this disk
  writeU16(view, offset + 6, 0); // disk with central directory
  writeU16(view, offset + 8, encoded.length);
  writeU16(view, offset + 10, encoded.length);
  writeU32(view, offset + 12, centralSize);
  writeU32(view, offset + 16, centralOffset);
  writeU16(view, offset + 20, 0); // no archive comment

  return bytes;
}
