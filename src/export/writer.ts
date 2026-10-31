/**
 * The binary export boundary.
 *
 * Backups are UTF-8 text and use BackupFileWriter. A workbook is bytes, so it
 * gets the same cache + share-sheet treatment through this small interface;
 * device.ts supplies the Capacitor implementation and the browser fallback.
 */

/** The content type packed into the Blob / handed to the share sheet. */
export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Where an exported binary file goes. */
export interface BinaryFileWriter {
  /** Cache + system share sheet on device, a Blob download in a browser. */
  writeForShare(fileName: string, bytes: Uint8Array, mimeType: string): Promise<void>;
}
