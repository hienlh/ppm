import { describe, expect, it } from "bun:test";
import { createCanvasCheckBroker, NO_CANVAS_MESSAGE } from "../../../src/services/design/check/design-canvas-check-broker.ts";
import type { CanvasCheckReport } from "../../../src/shared/design-canvas-check.ts";

const report: CanvasCheckReport = {
  viewport: { width: 1, height: 1 }, page: { width: 1, height: 1 }, findings: [], counts: {}, file: "index.html", gen: null, frame: "Desktop",
};

function broker(opts: { timeoutMs?: number; maxPending?: number } = {}) {
  const asked: Array<{ projectPath: string; slug: string; requestId: string; screenshot: boolean }> = [];
  const b = createCanvasCheckBroker({ ...opts, announce: (projectPath, slug, requestId, screenshot) => asked.push({ projectPath, slug, requestId, screenshot }) });
  return { b, asked };
}

describe("canvas check broker", () => {
  it("announces the request and settles with the first matching answer", async () => {
    const { b, asked } = broker();
    const outcome = b.request("/p", "home", { screenshot: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ projectPath: "/p", slug: "home", screenshot: true });
    expect(asked[0]!.requestId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(b.resolveCheck("/p", "home", asked[0]!.requestId, report)).toBe(true);
    expect(await outcome).toEqual({ ok: true, report });
    // Answered once: a second client's answer finds nothing to settle.
    expect(b.resolveCheck("/p", "home", asked[0]!.requestId, report)).toBe(false);
    expect(b.pendingCount()).toBe(0);
  });

  it("refuses an answer for another design, another project, or an unknown id", async () => {
    const { b, asked } = broker({ timeoutMs: 30 });
    const outcome = b.request("/p", "home", { screenshot: false });
    const id = asked[0]!.requestId;
    expect(b.resolveCheck("/p", "other", id, report)).toBe(false);
    expect(b.resolveCheck("/q", "home", id, report)).toBe(false);
    expect(b.resolveCheck("/p", "home", "notTheRequestId1", report)).toBe(false);
    expect(await outcome).toEqual({ ok: false, error: NO_CANVAS_MESSAGE });
  });

  it("times out and removes the entry", async () => {
    const { b } = broker({ timeoutMs: 20 });
    const outcome = await b.request("/p", "home", { screenshot: false });
    expect(outcome.ok).toBe(false);
    expect(b.pendingCount()).toBe(0);
  });

  it("is bounded", async () => {
    const { b } = broker({ timeoutMs: 50, maxPending: 2 });
    const first = b.request("/p", "a", { screenshot: false });
    const second = b.request("/p", "b", { screenshot: false });
    const third = await b.request("/p", "c", { screenshot: false });
    expect(third.ok).toBe(false);
    expect(b.pendingCount()).toBe(2);
    await Promise.all([first, second]);
    expect(b.pendingCount()).toBe(0);
  });
});
