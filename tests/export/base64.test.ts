import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../../src/export/base64';

describe('bytesToBase64', () => {
  it('matches the platform encoder for every padding case', () => {
    for (let length = 0; length <= 10; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 73 + 11) & 0xff;
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('encodes real ZIP-like bytes without line breaks', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80]);
    expect(bytesToBase64(bytes)).toBe('UEsDBAD/gA==');
  });
});
