/**
 * Test-only ZIP reader.
 *
 * It deliberately re-implements CRC-32 bit by bit instead of importing the
 * writer's table, so a wrong table or a wrong stored CRC cannot pass by
 * agreeing with itself. It also walks the central directory, checks every
 * local header against its central record, and proves the directory ends
 * exactly where the end-of-central-directory record starts.
 */

export interface ReadZipEntry {
  name: string;
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  data: Uint8Array;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

/** Independent, bit-at-a-time CRC-32 (IEEE 802.3), for cross-checking. */
export function crc32ForTest(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Parses and validates a stored ZIP, returning every member in directory order. */
export function readZipStrict(bytes: Uint8Array): ReadZipEntry[] {
  // The EOCD record is 22 bytes plus an optional comment of at most 65535.
  let eocd = -1;
  const firstPossible = Math.max(0, bytes.length - 22 - 65535);
  for (let cursor = bytes.length - 22; cursor >= firstPossible; cursor -= 1) {
    if (u32(bytes, cursor) === 0x06054b50) {
      eocd = cursor;
      break;
    }
  }
  assert(eocd >= 0, 'no end-of-central-directory signature found');

  const disk = u16(bytes, eocd + 4);
  const directoryDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const entryCount = u16(bytes, eocd + 10);
  const directorySize = u32(bytes, eocd + 12);
  const directoryOffset = u32(bytes, eocd + 16);
  const commentLength = u16(bytes, eocd + 20);

  assert(disk === 0, `multi-disk ZIP is not expected (disk ${disk})`);
  assert(directoryDisk === 0, `multi-disk ZIP is not expected (directory disk ${directoryDisk})`);
  assert(entriesOnDisk === entryCount, 'entries-on-disk must equal total entries');
  assert(commentLength === 0, 'the test writer must emit no archive comment');
  assert(eocd + 22 === bytes.length, 'bytes after the EOCD record');
  assert(
    directoryOffset + directorySize === eocd,
    'central directory must end exactly at the EOCD record'
  );

  const entries: ReadZipEntry[] = [];
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    assert(cursor + 46 <= directoryOffset + directorySize, 'central directory header overruns');
    assert(u32(bytes, cursor) === 0x02014b50, `bad central-directory signature at entry ${index}`);

    const versionMadeBy = u16(bytes, cursor + 4);
    const versionNeeded = u16(bytes, cursor + 6);
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const dosTime = u16(bytes, cursor + 12);
    const dosDate = u16(bytes, cursor + 14);
    const crc = u32(bytes, cursor + 16);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const entryCommentLength = u16(bytes, cursor + 32);
    const diskStart = u16(bytes, cursor + 34);
    const localOffset = u32(bytes, cursor + 42);
    const nameStart = cursor + 46;
    const name = decodeName(bytes.subarray(nameStart, nameStart + nameLength));

    assert(diskStart === 0, `${name}: multi-disk entry`);
    assert(method === 0, `${name}: expected store-only, method ${method}`);
    assert(compressedSize === uncompressedSize, `${name}: store sizes differ`);

    assert(localOffset + 30 <= directoryOffset, `${name}: local header overlaps directory`);
    assert(u32(bytes, localOffset) === 0x04034b50, `${name}: bad local-file signature`);

    const localVersion = u16(bytes, localOffset + 4);
    const localFlags = u16(bytes, localOffset + 6);
    const localMethod = u16(bytes, localOffset + 8);
    const localTime = u16(bytes, localOffset + 10);
    const localDate = u16(bytes, localOffset + 12);
    const localCrc = u32(bytes, localOffset + 14);
    const localCompressedSize = u32(bytes, localOffset + 18);
    const localUncompressedSize = u32(bytes, localOffset + 22);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const localNameStart = localOffset + 30;
    const localName = decodeName(
      bytes.subarray(localNameStart, localNameStart + localNameLength)
    );

    assert(localName === name, `${name}: local and central names differ`);
    assert(localVersion === versionNeeded, `${name}: local version differs`);
    assert(localFlags === flags, `${name}: local flags differ`);
    assert(localMethod === method, `${name}: local method differs`);
    assert(localTime === dosTime, `${name}: local DOS time differs`);
    assert(localDate === dosDate, `${name}: local DOS date differs`);
    assert(localCrc === crc, `${name}: local CRC differs`);
    assert(localCompressedSize === compressedSize, `${name}: local compressed size differs`);
    assert(localUncompressedSize === uncompressedSize, `${name}: local size differs`);

    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + uncompressedSize;
    assert(dataEnd <= directoryOffset, `${name}: file data overlaps the directory`);
    const data = bytes.subarray(dataStart, dataEnd);

    assert(crc32ForTest(data) === crc, `${name}: stored CRC does not match its data`);
    assert(flags === 0x0800, `${name}: expected the UTF-8 name flag`);

    entries.push({
      name,
      versionMadeBy,
      versionNeeded,
      flags,
      method,
      dosTime,
      dosDate,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      data,
    });

    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }

  assert(cursor === directoryOffset + directorySize, 'central directory size is wrong');
  return entries;
}
