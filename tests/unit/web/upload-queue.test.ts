import { describe, it, expect } from "bun:test";
import { runUploadQueue, type UploadJob, type UploadQueueProgress } from "../../../src/web/components/os-explorer/upload/upload-queue.ts";

/** A job that resolves after `delayMs`, reporting one progress tick partway through. */
function delayedJob(id: string, size: number, delayMs: number): UploadJob<string> {
  return {
    id,
    size,
    run: (onProgress) =>
      new Promise((resolve) => {
        onProgress(Math.floor(size / 2));
        setTimeout(() => {
          onProgress(size);
          resolve(id);
        }, delayMs);
      }),
  };
}

function failingJob(id: string, size: number): UploadJob<string> {
  return { id, size, run: () => Promise.reject(new Error(`${id} failed`)) };
}

describe("runUploadQueue", () => {
  it("returns results in the original job order regardless of finish order", async () => {
    // Job 0 is the slowest, job 2 the fastest — if results followed completion order this
    // would come back [2, 1, 0], not [0, 1, 2].
    const jobs = [delayedJob("0", 10, 30), delayedJob("1", 10, 15), delayedJob("2", 10, 5)];
    const results = await runUploadQueue(jobs, 3, () => {});
    expect(results.map((r) => r.id)).toEqual(["0", "1", "2"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("never runs more than `concurrency` jobs at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const jobs: UploadJob<void>[] = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      size: 1,
      run: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      },
    }));
    await runUploadQueue(jobs, 2, () => {});
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("records a per-job failure without aborting the rest of the batch", async () => {
    const jobs = [delayedJob("ok-1", 5, 1), failingJob("bad", 5), delayedJob("ok-2", 5, 1)];
    const results = await runUploadQueue(jobs, 3, () => {});
    expect(results.find((r) => r.id === "bad")?.ok).toBe(false);
    expect(results.filter((r) => r.ok).map((r) => r.id).sort()).toEqual(["ok-1", "ok-2"]);
  });

  it("a job cancelled before it starts rejects immediately without blocking the rest of the queue", async () => {
    // Mirrors how `explorer-actions-upload.ts` cancels a still-queued file: the job's own
    // `run` checks an already-aborted signal and rejects synchronously, instead of ever
    // reaching `uploadFileXhr` — the queue must not stall waiting on it.
    const controller = new AbortController();
    controller.abort();
    const jobs: UploadJob<string>[] = [
      {
        id: "cancelled",
        size: 10,
        run: () => {
          if (controller.signal.aborted) return Promise.reject(new DOMException("Upload aborted", "AbortError"));
          return Promise.resolve("should not run");
        },
      },
      delayedJob("ok", 10, 5),
    ];
    const results = await runUploadQueue(jobs, 2, () => {});
    const cancelled = results.find((r) => r.id === "cancelled");
    expect(cancelled?.ok).toBe(false);
    expect(cancelled?.error).toBeInstanceOf(DOMException);
    expect((cancelled?.error as DOMException).name).toBe("AbortError");
    expect(results.find((r) => r.id === "ok")?.ok).toBe(true);
  });

  it("aggregates byte progress across every in-flight job, and reaches full total at the end", async () => {
    const jobs = [delayedJob("a", 100, 20), delayedJob("b", 100, 5)];
    const snapshots: UploadQueueProgress[] = [];
    await runUploadQueue(jobs, 2, (p) => snapshots.push(p));
    expect(snapshots.length).toBeGreaterThan(0);
    const last = snapshots[snapshots.length - 1]!;
    expect(last.completed).toBe(2);
    expect(last.bytesLoaded).toBe(200);
    expect(last.bytesTotal).toBe(200);
    // Byte totals reported along the way must never exceed the batch total.
    expect(snapshots.every((p) => p.bytesLoaded <= p.bytesTotal)).toBe(true);
  });
});
