import { describe, it, expect } from "bun:test";
import "../../test-setup.ts";
import { tryClaimHeadlessTurn, releaseHeadlessClaim } from "../../../src/server/ws/chat-headless-turn.ts";

/**
 * The synchronous claim alone — the race it closes (two calls before
 * `entry.isStreamingActive` flips) is covered end to end by the route's
 * integration test; this isolates the primitive itself.
 */
describe("headless turn claim flag", () => {
  it("first claim succeeds, a second claim on the same session fails", () => {
    const sessionId = crypto.randomUUID();
    expect(tryClaimHeadlessTurn(sessionId)).toBe(true);
    expect(tryClaimHeadlessTurn(sessionId)).toBe(false);
    releaseHeadlessClaim(sessionId);
  });

  it("releasing a claim allows it to be taken again", () => {
    const sessionId = crypto.randomUUID();
    expect(tryClaimHeadlessTurn(sessionId)).toBe(true);
    releaseHeadlessClaim(sessionId);
    expect(tryClaimHeadlessTurn(sessionId)).toBe(true);
    releaseHeadlessClaim(sessionId);
  });

  it("releasing a claim that was never taken is a no-op", () => {
    const sessionId = crypto.randomUUID();
    expect(() => releaseHeadlessClaim(sessionId)).not.toThrow();
    expect(tryClaimHeadlessTurn(sessionId)).toBe(true);
    releaseHeadlessClaim(sessionId);
  });

  it("claims for different sessions are independent", () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect(tryClaimHeadlessTurn(a)).toBe(true);
    expect(tryClaimHeadlessTurn(b)).toBe(true);
    releaseHeadlessClaim(a);
    releaseHeadlessClaim(b);
  });
});
