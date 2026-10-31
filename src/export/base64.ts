/**
 * Base64 for the native filesystem bridge.
 *
 * Capacitor's Filesystem.writeFile accepts a base64 string when no encoding is
 * passed, which is how a binary .xlsx reaches the cache. Browser builds never
 * call this, but keeping the encoder pure and dependency-free means the same
 * bytes are produced on every platform and can be unit-tested in Node.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encodes bytes as RFC 4648 base64, without line breaks or a data: prefix. */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  let index = 0;

  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    output +=
      ALPHABET[(chunk >>> 18) & 0x3f]! +
      ALPHABET[(chunk >>> 12) & 0x3f]! +
      ALPHABET[(chunk >>> 6) & 0x3f]! +
      ALPHABET[chunk & 0x3f]!;
  }

  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index]! << 16;
    output += ALPHABET[(chunk >>> 18) & 0x3f]! + ALPHABET[(chunk >>> 12) & 0x3f]! + '==';
  } else if (remaining === 2) {
    const chunk = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    output +=
      ALPHABET[(chunk >>> 18) & 0x3f]! +
      ALPHABET[(chunk >>> 12) & 0x3f]! +
      ALPHABET[(chunk >>> 6) & 0x3f]! +
      '=';
  }

  return output;
}
