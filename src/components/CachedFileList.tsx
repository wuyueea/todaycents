import { useId } from 'react';
import type { ReactNode } from 'react';
import type { CachedFile } from '../backup/device';
import { fileSizeText, formatBackupTime } from '../backup/format';

export interface CachedFileListProps {
  files: readonly CachedFile[];
  now: Date;
  busy: boolean;
  onShare(file: CachedFile): void;
}

export function CachedFileList({
  files, now, busy, onShare, title, children,
}: CachedFileListProps & { title: string; children: ReactNode }) {
  const titleId = useId();
  if (files.length === 0) return null;

  return (
    <section className="backup-cache" aria-labelledby={titleId}>
      <h2 className="backup-cache__title" id={titleId}>{title}</h2>
      {children}
      <ul className="backup-cache__list">
        {files.map(file => (
          <li className="backup-cache__row" key={file.uri || file.name}>
            <div className="backup-cache__body">
              <div className="backup-cache__name">{file.name}</div>
              <div className="backup-cache__meta">
                {fileSizeText(file.bytes)} ·{' '}
                {formatBackupTime(new Date(file.modifiedAt).toISOString(), now)}
              </div>
            </div>
            <button
              className="backup-cache__share"
              type="button"
              aria-label={`另存 ${file.name}`}
              onClick={() => onShare(file)}
              disabled={busy}
            >
              另存
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
