import { describe, expect, it } from "bun:test";
import {
  autoSent, INITIAL_AUTO_CHECK_ROUNDS, MAX_AUTO_CHECK_ROUNDS, mayAutoSend, turnStarted,
} from "../../../src/web/lib/design/design-auto-check-rounds.ts";

describe("automatic canvas check rounds", () => {
  it("allows two automatic messages per user message", () => {
    expect(MAX_AUTO_CHECK_ROUNDS).toBe(2);
    let s = turnStarted(INITIAL_AUTO_CHECK_ROUNDS); // the user's own turn
    expect(mayAutoSend(s)).toBe(true);
    s = turnStarted(autoSent(s)); // first automatic round's turn
    expect(s).toEqual({ rounds: 1, awaitingAutoTurn: false });
    s = turnStarted(autoSent(s)); // second
    expect(mayAutoSend(s)).toBe(false);
  });

  it("resets when a turn starts that was not ours", () => {
    const exhausted = { rounds: 2, awaitingAutoTurn: false };
    expect(turnStarted(exhausted)).toEqual(INITIAL_AUTO_CHECK_ROUNDS);
  });
});
