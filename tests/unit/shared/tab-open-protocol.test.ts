import { describe, expect, it } from "bun:test";
import { MAX_TAB_OPEN_ERROR_CHARS, parseTabOpenResult } from "../../../src/shared/tab-open-protocol.ts";

const ID = "abcdefghijklmnop";
const REPORT = { viewport: { width: 10, height: 10 }, page: { width: 10, height: 10 }, findings: [], counts: {}, file: "a.html", gen: null, frame: "Desktop" };

describe("tab open results", () => {
  it("keeps a well-formed answer", () => {
    expect(parseTabOpenResult({ type: "tab_open_result", requestId: ID, opened: true, report: REPORT, extra: 1 }))
      .toEqual({ type: "tab_open_result", requestId: ID, opened: true, report: { ...REPORT } });
  });

  it("rejects an answer with the wrong type, id or flag", () => {
    for (const raw of [null, [], "x", { type: "tab_open", requestId: ID, opened: true }, { type: "tab_open_result", requestId: "short", opened: true },
      { type: "tab_open_result", requestId: ID }, { type: "tab_open_result", requestId: ID, opened: "yes" }]) {
      expect(parseTabOpenResult(raw)).toBeNull();
    }
  });

  it("caps the error and drops a report that does not validate", () => {
    const result = parseTabOpenResult({ type: "tab_open_result", requestId: ID, opened: true, error: "e".repeat(1000), report: { findings: "all" } });
    expect(result!.error!.length).toBe(MAX_TAB_OPEN_ERROR_CHARS);
    expect(result!.report).toBeUndefined();
  });
});
