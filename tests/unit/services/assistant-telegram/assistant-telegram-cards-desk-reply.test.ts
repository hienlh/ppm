import { describe, expect, it } from "bun:test";
import {
  DESK_REPLY_SETTLE_MS, DESK_REPLY_UNSURE, deskReplyFor, type ShownCard,
} from "../../../../src/services/assistant-telegram/assistant-telegram-cards-desk-reply.ts";

const FROM = 1_000_500; // shown half a second into a second
const shown = (over: Partial<ShownCard> = {}): ShownCard => ({ key: "card:a", from: FROM, byPress: false, full: true, ...over });
const unsure = { refuse: DESK_REPLY_UNSURE };

describe("which card a reply to the desk answers", () => {
  it("is the card shown, once it has been up long enough after a change nobody pressed for", () => {
    expect(deskReplyFor(shown(), 42, FROM + DESK_REPLY_SETTLE_MS)).toEqual({ to: 42 });
    expect(deskReplyFor(shown(), 42, FROM + 5_000)).toEqual(unsure);
  });

  it("is the card shown at once when the user moved the desk there by pressing on it", () => {
    expect(deskReplyFor(shown({ byPress: true }), 42, FROM + 1_000)).toEqual({ to: 42 });
    // Telegram dates to the second: a reply in the second the card came up counts.
    expect(deskReplyFor(shown({ byPress: true }), 42, 1_000_000)).toEqual({ to: 42 });
  });

  it("is refused when written before the card came up, when nothing was confirmed shown, or the card was not whole", () => {
    expect(deskReplyFor(shown({ byPress: true }), 42, 999_000)).toEqual(unsure);
    expect(deskReplyFor(null, 42, FROM + DESK_REPLY_SETTLE_MS)).toEqual(unsure);
    expect(deskReplyFor(shown(), null, FROM + DESK_REPLY_SETTLE_MS)).toEqual(unsure);
    expect(deskReplyFor(shown({ full: false }), 42, FROM + DESK_REPLY_SETTLE_MS)).toEqual(unsure);
  });
});
