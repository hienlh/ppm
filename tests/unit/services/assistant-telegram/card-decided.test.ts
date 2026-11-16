/**
 * Which closed cards still take more words from Telegram: one answered only in words (a reply) is
 * a conversation with its manager going on; one settled by a decision is not.
 */
import { describe, expect, it } from "bun:test";
import { cardDecided } from "../../../../src/services/assistant-telegram/assistant-telegram-card-replies.ts";

const at = 1;
describe("cardDecided", () => {
  it("a card still waiting, or a report that never waits, is not decided", () => {
    expect(cardDecided({ status: "open", answer: null })).toBe(false);
    expect(cardDecided({ status: "info", answer: null })).toBe(false);
  });
  it("a card answered only in words is not decided", () => {
    expect(cardDecided({ status: "answered", answer: { by: "user", channel: "telegram", at, note: "You replied on Telegram" } })).toBe(false);
  });
  it("an OK, a choice, an Allow or Deny, a dismissal, a resolution or a card gone is decided", () => {
    expect(cardDecided({ status: "answered", answer: { by: "user", channel: "ppm", at, ok: true } })).toBe(true);
    expect(cardDecided({ status: "answered", answer: { by: "user", channel: "ppm", at, choice: { id: "a", label: "A" } } })).toBe(true);
    expect(cardDecided({ status: "answered", answer: { by: "user", channel: "ppm", at, approved: false } })).toBe(true);
    expect(cardDecided({ status: "dismissed", answer: { by: "user", channel: "ppm", at } })).toBe(true);
    expect(cardDecided({ status: "resolved", answer: null })).toBe(true);
    expect(cardDecided({ status: "gone", answer: null })).toBe(true);
  });
});
