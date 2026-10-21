import { describe, expect, it } from "bun:test";
import { MAX_BACKOFF_MS, nextPollDelay, POLL_MS } from "../../../src/web/design-share-page/use-share-threads";
import { failureFromResponse, retryAfterMs, shareCodeFromPath } from "../../../src/web/design-share-page/share-api";

describe("design share polling", () => {
  it("polls every 10 s while visible and not at all while hidden", () => {
    expect(POLL_MS).toBe(10_000);
    expect(nextPollDelay({ visible: true, failures: 0 })).toBe(10_000);
    expect(nextPollDelay({ visible: false, failures: 0 })).toBeNull();
    expect(nextPollDelay({ visible: false, failures: 3, retryAfterMs: 5000 })).toBeNull();
  });

  it("backs off on failures in a row, up to a minute", () => {
    expect(nextPollDelay({ visible: true, failures: 1 })).toBe(20_000);
    expect(nextPollDelay({ visible: true, failures: 2 })).toBe(40_000);
    expect(nextPollDelay({ visible: true, failures: 10 })).toBe(MAX_BACKOFF_MS);
  });

  it("waits at least as long as the server asked", () => {
    expect(nextPollDelay({ visible: true, failures: 1, retryAfterMs: 90_000 })).toBe(90_000);
    expect(nextPollDelay({ visible: true, failures: 0, retryAfterMs: 3000 })).toBe(10_000);
  });
});

describe("design share responses", () => {
  it("reads a 404 on the link's own reads as a link that stopped opening", () => {
    expect(failureFromResponse(404, { ok: false, error: "This link is no longer valid" }, null, true)).toEqual({ kind: "invalid" });
  });

  it("keeps a 404 on a write as an error with the server's message", () => {
    expect(failureFromResponse(404, { ok: false, error: "Comment not found", code: "ENOENT" }, null, false))
      .toEqual({ kind: "error", status: 404, message: "Comment not found", code: "ENOENT" });
  });

  it("turns 429 into a wait from Retry-After", () => {
    expect(failureFromResponse(429, {}, "7", false)).toEqual({ kind: "rate-limited", retryAfterMs: 7000 });
    expect(retryAfterMs(null)).toBe(10_000);
    expect(retryAfterMs("0.2")).toBe(1000);
    expect(retryAfterMs("soon")).toBe(10_000);
  });

  it("passes the refusal code on, and never an unbounded message", () => {
    const f = failureFromResponse(409, { ok: false, error: "x".repeat(1000), code: "EHASREPLIES" }, null, false);
    expect(f.kind === "error" && f.code).toBe("EHASREPLIES");
    expect(f.kind === "error" && f.message.length).toBe(300);
    expect(failureFromResponse(500, null, null, false)).toEqual({ kind: "error", status: 500, message: "Something went wrong; try again" });
  });

  it("finds the code only in /s/<code>", () => {
    expect(shareCodeFromPath("/s/" + "A".repeat(43))).toBe("A".repeat(43));
    expect(shareCodeFromPath("/s/abc/")).toBeNull();
    expect(shareCodeFromPath("/s/abc/info")).toBeNull();
    expect(shareCodeFromPath("/project/x")).toBeNull();
  });
});
