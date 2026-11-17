import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceFolder } from '../storage/folder';
import { withStorageTimeout } from '../storage/access';
import type { FolderAccess, FolderStatus } from '../storage/folder';

interface StorageViewProps {
  status: FolderStatus | null;
  available: boolean;
  busy: boolean;
  notice: string | null;
  error: string | null;
  onChoose(): void;
  onOpen(): void;
  onClear(): void;
}

export function StorageView({ status, available, busy, notice, error, onChoose, onOpen, onClear }: StorageViewProps) {
  const folder = status?.folder ?? null;
  return (
    <div className="backup-screen backup-screen--v1 storage-screen">
      <header className="settings-header">
        <Link className="add-back" to="/settings" aria-label="返回设置">‹</Link>
        <h1>存储</h1>
      </header>

      {status === null && error === null ? (
        <p className="backup-note" role="status">正在读取备份目录…</p>
      ) : (
        <>
          <section className="backup-state">
            <p className="backup-state__label">备份与报表目录</p>
            <p className="backup-state__value storage-path">{folder?.name ?? '未设置'}</p>
          </section>
          {status?.needsReselection && (
            <p className="backup-note">原目录授权不可用，请重新选择。已有备份留在原处。</p>
          )}
          <p className="backup-note">
            {folder ? '备份、报表和自动副本优先写入此目录。'
              : '没有可用目录时，手动导出会写入应用缓存并打开系统分享，自动副本只写入缓存。'}
          </p>
          {available && (
            <div className="backup-actions">
              <button className="backup-button backup-button--primary" type="button" onClick={onChoose} disabled={busy}>
                {folder ? '更换文件夹' : '选择文件夹'}
              </button>
              {folder && (
                <button className="backup-button backup-button--secondary" type="button" onClick={onOpen} disabled={busy}>
                  打开文件夹
                </button>
              )}
              {(folder || status?.needsReselection) && (
                <button className="backup-button backup-button--secondary" type="button" onClick={onClear} disabled={busy}>
                  取消目录授权
                </button>
              )}
            </div>
          )}
          {!available && <p className="backup-note">此环境无法选择本机备份目录。</p>}
        </>
      )}
      {notice !== null && <p className="backup-note" role="status">{notice}</p>}
      {error !== null && <p className="backup-note backup-note--error" role="alert">{error}</p>}
    </div>
  );
}

const READ_TIMEOUT = '读取备份目录超时，请重试。';

export default function StorageScreen({ folder = deviceFolder }: { folder?: FolderAccess }) {
  const [status, setStatus] = useState<FolderStatus | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const supported = await withStorageTimeout(() => folder.available(), READ_TIMEOUT);
        if (current) setAvailable(supported);
        const next = await withStorageTimeout(() => folder.status(), READ_TIMEOUT);
        if (current) setStatus(next);
      } catch (reason) {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { current = false; };
  }, [folder]);

  async function perform(action: () => Promise<string | null>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    // The native round expires at 120s and ignores results from earlier rounds.
    const chosen = await withStorageTimeout(
      () => folder.choose(), '等待系统选夹超时，请返回应用后重试。', 125000
    );
    const next = await withStorageTimeout(() => folder.status(), READ_TIMEOUT);
    setStatus(next);
    if (!chosen) return '已取消选择。';
    if (next.folder === null) throw new Error('目录授权不可用，请重新选择。');
    return `已选择「${next.folder.name}」。`;
  }

  async function open() {
    if (await withStorageTimeout(() => folder.open(), '打开文件夹超时，请重试。')) return null;
    const next = await withStorageTimeout(() => folder.status(), READ_TIMEOUT);
    setStatus(next);
    return next.folder
      ? `请在文件管理器中打开「${next.folder.name}」。`
      : '目录不可用，请重新选择。';
  }

  async function clear() {
    await withStorageTimeout(() => folder.clear(), '取消目录授权超时，请重试。');
    setStatus(await withStorageTimeout(() => folder.status(), READ_TIMEOUT));
    return '已取消目录授权。';
  }

  return (
    <StorageView status={status} available={available} busy={busy} notice={notice} error={error}
      onChoose={() => void perform(choose)} onOpen={() => void perform(open)} onClear={() => void perform(clear)} />
  );
}
