import { describe, expect, it } from "bun:test";
import { nextSummaryState, type DesignSummaryState } from "../../../src/web/components/design/use-design-summary";
import type { DesignSummary } from "../../../src/shared/design-types";

const design: DesignSummary = {
  slug: "landing", title: "Landing", kind: "page", entry: "index.html",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("nextSummaryState", () => {
  it("goes ready on a successful fetch from any prior state", () => {
    for (const previous of [{ status: "loading" }, { status: "missing" }, { status: "error", message: "x" }] as DesignSummaryState[]) {
      expect(nextSummaryState(previous, { ok: true, design })).toEqual({ status: "ready", design });
    }
  });

  it("keeps the last good design on a transient failure after it was already loaded", () => {
    const ready: DesignSummaryState = { status: "ready", design };
    const next = nextSummaryState(ready, { ok: false, notFound: false, message: "network blip" });
    expect(next).toBe(ready); // same reference: no re-render forced by an identical state
  });

  it("goes missing on a 404 even if a design was already loaded", () => {
    const ready: DesignSummaryState = { status: "ready", design };
    expect(nextSummaryState(ready, { ok: false, notFound: true })).toEqual({ status: "missing" });
  });

  it("goes to error on a non-404 failure before anything ever loaded", () => {
    const loading: DesignSummaryState = { status: "loading" };
    expect(nextSummaryState(loading, { ok: false, notFound: false, message: "boom" })).toEqual({ status: "error", message: "boom" });
  });

  it("stays missing on a repeated 404, and errors again on a repeated non-404 failure", () => {
    const missing: DesignSummaryState = { status: "missing" };
    expect(nextSummaryState(missing, { ok: false, notFound: true })).toEqual({ status: "missing" });
    const errored: DesignSummaryState = { status: "error", message: "old" };
    expect(nextSummaryState(errored, { ok: false, notFound: false, message: "new" })).toEqual({ status: "error", message: "new" });
  });
});
