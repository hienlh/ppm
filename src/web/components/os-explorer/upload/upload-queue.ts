/**
 * Bounded-concurrency runner for a batch of uploads, aggregating byte-level progress across
 * every in-flight job (not just completed ones) so one large file streaming for a while does
 * not make the overall percentage look stuck.
 *
 * Pure and DOM-free on purpose — `job.run` is the only place XHR/fetch appears, so this file
 * is unit-testable without a browser.
 */

export interface UploadJob<T> {
  id: string;
  /** Byte size, for weighting this job's share of the aggregate progress. */
  size: number;
  run(onProgress: (bytesLoaded: number) => void): Promise<T>;
}

export interface UploadQueueProgress {
  completed: number;
  total: number;
  bytesLoaded: number;
  bytesTotal: number;
}

export interface UploadQueueResult<T> {
  id: string;
  ok: boolean;
  value?: T;
  error?: unknown;
}

/**
 * Runs `jobs` with at most `concurrency` in flight at once. Results are returned in the same
 * order as `jobs`, regardless of which finished first — callers that report per-file outcomes
 * need that order to line up with what they queued.
 */
export async function runUploadQueue<T>(
  jobs: UploadJob<T>[],
  concurrency: number,
  onProgress: (progress: UploadQueueProgress) => void,
): Promise<UploadQueueResult<T>[]> {
  const bytesTotal = jobs.reduce((sum, job) => sum + job.size, 0);
  const loaded = new Array<number>(jobs.length).fill(0);
  const results = new Array<UploadQueueResult<T>>(jobs.length);
  let completed = 0;

  const report = () => {
    onProgress({
      completed,
      total: jobs.length,
      bytesLoaded: loaded.reduce((sum, n) => sum + n, 0),
      bytesTotal,
    });
  };

  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= jobs.length) return;
      const job = jobs[index]!;
      try {
        const value = await job.run((bytesLoaded) => {
          loaded[index] = bytesLoaded;
          report();
        });
        results[index] = { id: job.id, ok: true, value };
      } catch (error) {
        results[index] = { id: job.id, ok: false, error };
      }
      loaded[index] = job.size;
      completed++;
      report();
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
