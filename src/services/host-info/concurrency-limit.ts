/** Runs `fn` over `items` with at most `limit` in flight at once — a minimal
 *  worker-pool, not a dependency. Used to bound fs probes (e.g. Windows drive
 *  letters) so a handful of hung mapped/network paths can't park libuv's
 *  whole threadpool and stall unrelated fs work in the process. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
