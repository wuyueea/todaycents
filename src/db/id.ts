/**
 * Primary-key generator. crypto.randomUUID() is present both in Node and in
 * the Android WebView, so the same call works in tests and on device.
 */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}
