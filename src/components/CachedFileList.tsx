import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CachedFile } from '../backup/device';
import { fileSizeText, formatBackupTime } from '../backup/format';

export interface CachedFileListProps {
  files: readonly CachedFile[];
  now: Date;
  busy: boolean;
  onShare(file: CachedFile): void;
  onRestore?(file: CachedFile): void;
  highlightedName?: string;
  focusRequest?: { name: string } | null;
}

/** Recheck the cache before focusing a file that might have been removed. */
export function useCachedFileFocus(
  load: () => Promise<CachedFile[]>,
  onRead: (files: CachedFile[]) => void
) {
  const [focusRequest, setFocusRequest] = useState<CachedFileListProps['focusRequest']>();
  const latestRequest = useRef(0);

  async function locate(name: string): Promise<boolean> {
    const request = ++latestRequest.current;
    const files = await load();
    if (request !== latestRequest.current) return false;
    onRead(files);
    const available = files.some(file => file.name === name && file.unavailableReason === undefined);
    if (available) setFocusRequest({ name });
    return available;
  }

  function clear() {
    latestRequest.current += 1;
    setFocusRequest(null);
  }

  return { focusRequest, locate, clear };
}

export function CachedFileList({
  files, now, busy, onShare, onRestore, highlightedName, focusRequest, title, children,
}: CachedFileListProps & { title: string; children: ReactNode }) {
  const titleId = useId();
  const highlightedRow = useRef<HTMLLIElement>(null);
  const targetName = focusRequest === undefined ? highlightedName : focusRequest?.name;
  const highlighted = files.find(file => file.name === targetName);
  const highlightedKey = highlighted?.name;
  useEffect(() => {
    const row = highlightedRow.current;
    row?.scrollIntoView?.({ block: 'nearest' });
    row?.focus({ preventScroll: true });
  }, [highlightedKey, focusRequest]);
  if (files.length === 0) return null;

  return (
    <section className="backup-cache" aria-labelledby={titleId}>
      <h2 className="backup-cache__title" id={titleId}>{title}</h2>
      {children}
      <ul className="backup-cache__list">
        {files.map(file => (
          <li
            className="backup-cache__row"
            key={file.uri || file.name}
            ref={file === highlighted ? highlightedRow : undefined}
            tabIndex={file === highlighted ? -1 : undefined}
          >
            <div className="backup-cache__body">
              <div className="backup-cache__name">{file.name}</div>
              <div className="backup-cache__meta">
                {fileSizeText(file.bytes)} ·{' '}
                {formatBackupTime(new Date(file.modifiedAt).toISOString(), now)}
              </div>
              {file.unavailableReason !== undefined && (
                <div className="backup-cache__problem">无法使用 · {file.unavailableReason}</div>
              )}
            </div>
            {file.unavailableReason === undefined && (
              <>
                {onRestore !== undefined && (
                  <button
                    className="backup-cache__restore"
                    type="button"
                    aria-label={`恢复 ${file.name}`}
                    onClick={() => onRestore(file)}
                    disabled={busy}
                  >
                    恢复
                  </button>
                )}
                <button
                  className="backup-cache__share"
                  type="button"
                  aria-label={`另存 ${file.name}`}
                  onClick={() => onShare(file)}
                  disabled={busy}
                >
                  另存
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
