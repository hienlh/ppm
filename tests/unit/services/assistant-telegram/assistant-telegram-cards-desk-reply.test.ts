/**
 * Which card a reply to the pinned card list answers, from the versions of the list the user could
 * have seen while writing — never from the list as it is when the reply arrives.
 */
import { describe, expect, it } from "bun:test";
import {
  DESK_REPLY_LOOKBACK_MS, resolveDeskReply, seenVersions, type DeskSnapshot, type DeskWaitingCard,
} from "../../../../src/services/assistant-telegram/assistant-telegram-cards-desk-reply.ts";

const T = 1_700_000_000_000;
const line = (key: string, text: string) => ({ key, text });

function snap(from: number, shown: string | null, keys: string[], over: Partial<DeskSnapshot> = {}): DeskSnapshot {
  return {
    messageId: 900, from, shown, byPress: false,
    lines: keys.map((k, i) => line(k, `${i + 1}. 🔐 nxsys · Card ${k.toUpperCase()}`)),
    shownText: shown ? `Waiting for you\n🔐 Allow the ${shown.toUpperCase()} command?` : "Nothing is waiting",
    ...over,
  };
}
const waiting = (...keys: string[]): DeskWaitingCard[] => keys.map((key) => ({ key }));

describe("the versions a reply may have been written against", () => {
  it("are every version up at some moment in the lookback before it was sent, from the latest press on", () => {
    const history = [snap(T - 10 * 60_000, "a", ["a"]), snap(T - 60_000, "b", ["b"]), snap(T + 5_000, "c", ["c"])];
    expect(seenVersions(history, T).map((s) => s.shown)).toEqual(["a", "b"]);
    expect(seenVersions(history, T + DESK_REPLY_LOOKBACK_MS + 10 * 60_000).map((s) => s.shown)).toEqual(["c"]);
    const pressed = [snap(T - 60_000, "a", ["a", "b"]), snap(T - 30_000, "b", ["a", "b"], { byPress: true })];
    expect(seenVersions(pressed, T).map((s) => s.shown)).toEqual(["b"]);
  });
});

describe("resolveDeskReply", () => {
  it("answers the card shown the whole time the user may have been writing", () => {
    const history = [snap(T - 10 * 60_000, "a", ["a", "b"]), snap(T - 60_000, "a", ["a", "b", "c"])];
    expect(resolveDeskReply(history, waiting("a", "b", "c"), { sentAt: T, text: "ship it" })).toEqual({ to: "a", why: "one card shown" });
  });

  it("asks — keeping the words — when the list moved to another card while the user was writing (the 15:35 case)", () => {
    // A was on the list; A was answered in PPM and the list moved to B; the reply, written for A, comes 5 s later.
    const history = [snap(T - 5 * 60_000, "a", ["a", "b", "c", "d", "e"]), snap(T - 5_000, "b", ["b", "c", "d", "e"])];
    expect(resolveDeskReply(history, waiting("b", "c", "d", "e"), { sentAt: T, text: "use the staging db" }))
      .toEqual({ ask: ["b", "c", "d", "e"], ended: ["a"] });
  });

  it("goes to the card a quote from the list names, line or text", () => {
    const history = [snap(T - 60_000, "a", ["a", "b"]), snap(T - 5_000, "b", ["a", "b"])];
    expect(resolveDeskReply(history, waiting("a", "b"), { sentAt: T, text: "no", quote: "Card A" })).toEqual({ to: "a", why: "quote" });
    expect(resolveDeskReply(history, waiting("a", "b"), { sentAt: T, text: "no", quote: "allow the B command" })).toEqual({ to: "b", why: "quote" });
  });

  it("goes to the one card left when the user saw it, and asks when they never did", () => {
    // The list was empty, then one card came: the only card, and the user saw it.
    const history = [snap(T - 60_000, null, []), snap(T - 5_000, "b", ["b"])];
    expect(resolveDeskReply(history, waiting("b"), { sentAt: T, text: "yes" })).toEqual({ to: "b", why: "one card left" });
    // A was shown and answered meanwhile: "yes" may have been meant for A, so it is asked about.
    const moved = [snap(T - 60_000, "a", ["a", "b"]), snap(T - 5_000, "b", ["b"])];
    expect(resolveDeskReply(moved, waiting("b"), { sentAt: T, text: "yes" })).toEqual({ ask: ["b"], ended: ["a"] });
    // A card that arrived after the reply was sent was never seen: it is only reached by a press.
    const late = [snap(T - 60_000, "a", ["a"]), snap(T - 5_000, "b", ["b"]), snap(T + 3_000, "c", ["c"])];
    expect(resolveDeskReply(late, waiting("c"), { sentAt: T, text: "yes" })).toEqual({ ask: ["c"], ended: ["a", "b"] });
  });

  it("goes to the one card the words are a choice of", () => {
    const history = [snap(T - 60_000, "a", ["a", "b"]), snap(T - 5_000, "b", ["a", "b"])];
    const cards: DeskWaitingCard[] = [{ key: "a", answers: ["Staging", "Prod"] }, { key: "b", answers: ["Yes", "No"] }];
    expect(resolveDeskReply(history, cards, { sentAt: T, text: " staging " })).toEqual({ to: "a", why: "one card's choice" });
    expect(resolveDeskReply(history, cards, { sentAt: T, text: "maybe later" })).toEqual({ ask: ["a", "b"], ended: [] });
  });

  it("asks when nothing was seen at all (a restart), listing what waits", () => {
    expect(resolveDeskReply([], waiting("a", "b"), { sentAt: T, text: "ok" })).toEqual({ ask: ["a", "b"], ended: [] });
  });

  it("counts a version that went up in the same second the reply was sent", () => {
    const history = [snap(T - 60_000, "a", ["a", "b"]), snap(T + 400, "b", ["a", "b"])];
    expect(resolveDeskReply(history, waiting("a", "b"), { sentAt: T, text: "ok" })).toEqual({ ask: ["a", "b"], ended: [] });
  });
});
