import { describe, expect, it } from "bun:test";
import {
  beginPreviewLoad, endPreviewLoads, finishPreviewLoad, latestPreviewLoad, previewKey, waitForPreviewLoad,
  type PreviewCheck,
} from "../../../src/web/lib/html-preview-loads.ts";

const check: PreviewCheck = async () => { throw new Error("not used"); };
let n = 0;
const freshKey = () => previewKey("project", `page-${++n}.html`);

describe("HTML preview loads", () => {
  it("keys a file by project, so two projects' index.html are different previews", () => {
    expect(previewKey("a", "index.html")).not.toBe(previewKey("b", "index.html"));
    expect(previewKey(undefined, "/tmp/x.html")).toBe(previewKey(null, "/tmp/x.html"));
  });

  it("hands a waiter the first load past the one it saw, once that load has finished", async () => {
    const key = freshKey();
    const first = beginPreviewLoad(key, check);
    finishPreviewLoad(key, first);
    const seen = latestPreviewLoad(key);
    expect(seen).toBe(first);
    const waiting = waitForPreviewLoad(key, seen, 1000);
    const second = beginPreviewLoad(key, check);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishPreviewLoad(key, second);
    const load = await waiting;
    expect(load?.seq).toBe(second);
    expect(load?.loaded).toBe(true);
  });

  it("answers at once when a newer load has already finished", async () => {
    const key = freshKey();
    const seq = beginPreviewLoad(key, check);
    finishPreviewLoad(key, seq);
    expect((await waitForPreviewLoad(key, seq - 1, 1000))?.seq).toBe(seq);
  });

  it("ignores the finish of a load that was already replaced", async () => {
    const key = freshKey();
    const stale = beginPreviewLoad(key, check);
    const current = beginPreviewLoad(key, check);
    finishPreviewLoad(key, stale);
    const load = await waitForPreviewLoad(key, 0, 20);
    // Timed out on a load that only started: the stale finish did not count for it.
    expect(load?.seq).toBe(current);
    expect(load?.loaded).toBe(false);
  });

  it("gives up with null when no load began, and forgets a preview that unmounted", async () => {
    const key = freshKey();
    expect(await waitForPreviewLoad(key, 0, 10)).toBeNull();
    const seq = beginPreviewLoad(key, check);
    endPreviewLoads(key, seq);
    expect(latestPreviewLoad(key)).toBe(0);
    // A preview mounted again later still counts as newer than anything seen before.
    const again = beginPreviewLoad(key, check);
    expect(again).toBeGreaterThan(seq);
  });

  it("does not let an older unmount remove a newer load", () => {
    const key = freshKey();
    const old = beginPreviewLoad(key, check);
    const current = beginPreviewLoad(key, check);
    endPreviewLoads(key, old);
    expect(latestPreviewLoad(key)).toBe(current);
  });
});
