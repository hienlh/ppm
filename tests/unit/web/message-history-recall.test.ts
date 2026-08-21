/**
 * message-history-recall — index math for ArrowUp/ArrowDown recall in the composer.
 *
 * History arrives oldest-first; index 0 is the NEWEST message, so the reversal
 * is the easy thing to get wrong. -1 means "back to the draft".
 */
import { describe, it, expect } from "bun:test";

import { stepHistory } from "../../../src/web/components/chat/message-history-recall";

const HISTORY = ["oldest", "middle", "newest"];

describe("stepHistory", () => {
  it("first ArrowUp from a draft recalls the newest message", () => {
    expect(stepHistory(HISTORY, -1, 1)).toEqual({ index: 0, text: "newest" });
  });

  it("walks backwards through the transcript", () => {
    expect(stepHistory(HISTORY, 0, 1)).toEqual({ index: 1, text: "middle" });
    expect(stepHistory(HISTORY, 1, 1)).toEqual({ index: 2, text: "oldest" });
  });

  it("stops at the oldest message", () => {
    expect(stepHistory(HISTORY, 2, 1)).toBeNull();
  });

  it("ArrowDown walks back toward the newest", () => {
    expect(stepHistory(HISTORY, 2, -1)).toEqual({ index: 1, text: "middle" });
  });

  it("ArrowDown past the newest clears the input", () => {
    expect(stepHistory(HISTORY, 0, -1)).toEqual({ index: -1, text: "" });
  });

  it("stops below the draft position", () => {
    expect(stepHistory(HISTORY, -1, -1)).toBeNull();
  });

  it("does nothing when the session has no user messages", () => {
    expect(stepHistory([], -1, 1)).toBeNull();
  });

  it("handles a single-message session", () => {
    expect(stepHistory(["only"], -1, 1)).toEqual({ index: 0, text: "only" });
    expect(stepHistory(["only"], 0, 1)).toBeNull();
  });
});
