import { useState } from 'react';
import type { CachedFile } from '../backup/device';
import { withStorageTimeout } from '../storage/access';
import { deviceFolder } from '../storage/folder';

export type ExportFileNotice = { text: string } & (
  | { kind: 'folder'; folderName: string; folderId?: string }
  | { kind: 'cache'; fileName: string }
  | { kind: 'download' }
);

export function ExportResultPanel({
  result,
  cachedFiles,
  onViewCached,
  busy = false,
}: {
  result: ExportFileNotice;
  cachedFiles: readonly CachedFile[];
  onViewCached?: (fileName: string) => Promise<boolean>;
  busy?: boolean;
}) {
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function runAction(action: () => Promise<boolean>, fallback: string) {
    setActing(true);
    setNotice(null);
    try {
      if (!await action()) setNotice(fallback);
    } catch {
      setNotice(fallback);
    } finally {
      setActing(false);
    }
  }

  const folderId = result.kind === 'folder' ? result.folderId : undefined;
  const folderFallback = result.kind === 'folder'
    ? `无法打开本次保存的文件夹，请在文件管理器中到「${result.folderName}」查找上方文件。`
    : null;
  const viewCache = result.kind === 'cache' && cachedFiles.some(
    file => file.name === result.fileName && file.unavailableReason === undefined
  ) ? onViewCached : undefined;
  const detail = notice ?? (folderId === undefined ? folderFallback : null);

  return (
    <section className="export-result" aria-label="导出结果">
      <p className="export-result__text" role="status">{result.text}</p>
      {folderId !== undefined && folderFallback !== null && (
        <button
          className="export-result__action"
          type="button"
          disabled={busy || acting}
          onClick={() => void runAction(
            () => withStorageTimeout(() => deviceFolder.open(folderId), '打开文件夹超时。'),
            folderFallback
          )}
        >
          打开文件夹
        </button>
      )}
      {result.kind === 'cache' && viewCache !== undefined && (
        <button
          className="export-result__action"
          type="button"
          disabled={busy || acting}
          onClick={() => void runAction(
            () => viewCache(result.fileName), `暂时无法查看「${result.fileName}」。`
          )}
        >
          查看缓存文件
        </button>
      )}
      {detail !== null && <p className="export-result__notice" role="status">{detail}</p>}
    </section>
  );
}
