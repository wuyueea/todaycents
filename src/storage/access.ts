import type { FolderAccess, StorageAccessState } from './folder';

/** Bounds every bridge stage; a late answer never resumes the expired flow. */
export async function withStorageTimeout<T>(
  work: () => Promise<T>,
  message: string,
  milliseconds = 8000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The native round times out at 120s; allow its rejection to arrive first. */
export async function requestStorageAccess(folder: FolderAccess): Promise<StorageAccessState> {
  const read = () => withStorageTimeout(() => folder.getAccess(), '读取存储权限超时，请重试。');
  let state = await read();
  if (!state.granted) {
    await withStorageTimeout(
      () => folder.requestAccess(), '等待存储权限结果超时，请返回应用后重试。', 125000
    );
    state = await read();
  }
  return state;
}
