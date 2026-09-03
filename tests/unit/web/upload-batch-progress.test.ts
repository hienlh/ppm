import { describe, it, expect } from "bun:test";
import { summarizeBatch } from "../../../src/web/components/os-explorer/upload/upload-batch-progress.ts";
import type { UploadItem } from "../../../src/web/components/os-explorer/upload/upload-store.ts";

function item(overrides: Partial<UploadItem>): UploadItem {
  return { id: "0", name: "f", relativePath: "f", size: 100, bytesLoaded: 0, state: "queued", ...overrides };
}

describe("summarizeBatch", () => {
  it("counts an in-flight item's partial bytes, not its full size", () => {
    const summary = summarizeBatch([
      item({ id: "0", size: 100, bytesLoaded: 40, state: "uploading" }),
      item({ id: "1", size: 100, bytesLoaded: 0, state: "queued" }),
    ]);
    expect(summary.bytesLoaded).toBe(40);
    expect(summary.bytesTotal).toBe(200);
    expect(summary.doneCount).toBe(0);
  });

  it("treats done and skipped as complete (full size, counted as done)", () => {
    const summary = summarizeBatch([
      item({ id: "0", size: 100, bytesLoaded: 100, state: "done" }),
      item({ id: "1", size: 50, bytesLoaded: 0, state: "skipped" }),
    ]);
    expect(summary.bytesLoaded).toBe(150);
    expect(summary.doneCount).toBe(2);
    expect(summary.failedCount).toBe(0);
  });

  it("counts failed and cancelled toward failedCount, not doneCount", () => {
    const summary = summarizeBatch([
      item({ id: "0", size: 100, state: "failed", errorMessage: "Not allowed here" }),
      item({ id: "1", size: 100, state: "cancelled" }),
    ]);
    expect(summary.failedCount).toBe(2);
    expect(summary.doneCount).toBe(0);
    expect(summary.totalCount).toBe(2);
  });

  it("never lets bytesLoaded exceed the item's own size even if a stray tick overshoots", () => {
    const summary = summarizeBatch([item({ id: "0", size: 100, bytesLoaded: 999, state: "uploading" })]);
    expect(summary.bytesLoaded).toBe(100);
  });
});
