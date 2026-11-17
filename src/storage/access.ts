/** Bounds bridge stages; a late answer never resumes the expired flow. */
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
