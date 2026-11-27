import { describe, expect, it } from "bun:test";
import {
  ageText, DESK_LIST_MAX, DESK_TABS_MAX, drawDesk, EMPTY_DESK_HTML, sortEntries, TOO_LONG_ON_DESK, type DeskEntry, type DeskKeyMaker,
} from "../../../../src/services/assistant-telegram/assistant-telegram-cards-desk-draw.ts";
import type { InlineKeyboardButton } from "../../../../src/services/telegram/telegram-types.ts";
import { stripTelegramHtml } from "../../../../src/services/telegram/telegram-html-format.ts";

const NOW = 10 * 60 * 60_000;
const allow: InlineKeyboardButton = { text: "Allow", callback_data: "a:allow" };
const deny: InlineKeyboardButton = { text: "Deny", callback_data: "a:deny" };

function entry(n: number, over: Partial<DeskEntry> = {}): DeskEntry {
  return {
    key: `card:${n}`, icon: "🔐", project: "nxsys", title: `Card ${n}`, since: NOW - n * 60_000, messageId: 100 + n,
    stillWaiting: () => true, view: () => ({ html: `<b>Card ${n} in full</b>`, rows: [[allow, deny]] }), groups: [`g${n}`],
    ...over,
  };
}

/** The desk's own buttons, readable: their press as JSON. */
const key: DeskKeyMaker = (text, press) => ({ text, callback_data: JSON.stringify(press) });
const texts = (rows: InlineKeyboardButton[][]) => rows.map((r) => r.map((b) => b.text));

describe("drawDesk", () => {
  it("lists every card, shows the current one whole with its own buttons, and numbers them", () => {
    const list = sortEntries([entry(1), entry(3), entry(2)]);
    const d = drawDesk(list, "card:2", 0, NOW, key);
    const text = stripTelegramHtml(d.html);
    expect(text).toContain("Waiting for you (3)");
    // Oldest first: the card that has waited longest is at the top.
    expect(text.indexOf("Card 3")).toBeLessThan(text.indexOf("Card 2"));
    expect(text).toContain("▸ 2. 🔐 nxsys · Card 2 2m");
    expect(text).toContain("Card 2 in full");
    expect(text).not.toContain("Card 1 in full");
    expect(d.current?.key).toBe("card:2");
    // The card's own buttons first, untouched, then the numbers, then the way to its message.
    expect(d.rows[0]).toEqual([allow, deny]);
    expect(texts(d.rows.slice(1))).toEqual([["1", "• 2 •", "3"], ["↩ Go to the card's message"]]);
    expect(JSON.parse(d.rows[1]![2]!.callback_data!)).toEqual({ op: "show", key: "card:1" });
  });

  it("puts an urgent card first and falls back to the card in the same place when the current one is gone", () => {
    const list = sortEntries([entry(5), entry(1, { urgent: true, icon: "⚠️" }), entry(3)]);
    expect(list.map((e) => e.key)).toEqual(["card:1", "card:5", "card:3"]);
    const d = drawDesk(list, "card:gone", 1, NOW, key);
    expect(d.current?.key).toBe("card:5");
    expect(drawDesk(list, null, 9, NOW, key).current?.key).toBe("card:3");
  });

  it("pages with ‹ n / N › past the number buttons, and counts lines past the list", () => {
    const many = sortEntries(Array.from({ length: DESK_LIST_MAX + 2 }, (_, i) => entry(i + 1)));
    expect(many.length).toBeGreaterThan(DESK_TABS_MAX);
    const last = many[many.length - 1]!;
    const d = drawDesk(many, last.key, 0, NOW, key);
    const text = stripTelegramHtml(d.html);
    expect(text).toContain("…and 2 more");
    // The current card past the visible list still gets its marked line.
    expect(text).toContain(`▸ ${many.length}.`);
    expect(texts(d.rows.slice(1, 2))).toEqual([["‹", `${many.length} / ${many.length}`, "›"]]);
  });

  it("splits up to eight numbers over two rows, and shows no numbers for one card", () => {
    const six = sortEntries(Array.from({ length: 6 }, (_, i) => entry(i + 1)));
    const d = drawDesk(six, null, 0, NOW, key);
    expect(texts(d.rows.slice(1, 3))).toEqual([["• 1 •", "2", "3"], ["4", "5", "6"]]);
    const one = drawDesk([entry(1)], null, 0, NOW, key);
    expect(texts(one.rows)).toEqual([["Allow", "Deny"], ["↩ Go to the card's message"]]);
    expect(texts(drawDesk([entry(1, { messageId: null })], null, 0, NOW, key).rows)).toEqual([["Allow", "Deny"]]);
  });

  it("shrinks the list to a count when card and list would not fit, and never shows buttons for a card it cannot show", () => {
    const big = "x".repeat(4_030);
    const list = sortEntries([entry(1, { view: () => ({ html: big, rows: [[allow, deny]] }) }), entry(2)]);
    const d = drawDesk(list, "card:1", 0, NOW, key);
    expect(stripTelegramHtml(d.html).length).toBeLessThanOrEqual(4096);
    expect(stripTelegramHtml(d.html)).toStartWith("🔔 Waiting for you · 2 of 2");
    expect(d.html).toContain(big);
    expect(d.rows[0]).toEqual([allow, deny]);

    const huge = sortEntries([entry(1, { view: () => ({ html: "y".repeat(4_090), rows: [[allow, deny]] }) }), entry(2)]);
    const h = drawDesk(huge, "card:1", 0, NOW, key);
    expect(stripTelegramHtml(h.html)).toContain(TOO_LONG_ON_DESK);
    expect(h.rows.flat().some((b) => b === allow || b === deny)).toBe(false);
  });

  it("escapes and redacts what a manager or a chat wrote in a title", () => {
    const d = drawDesk([entry(1, { title: "<b>a & b</b> token ghp_123456789012345678901234567890123456", project: "p<1>" })], null, 0, NOW, key);
    expect(d.html).toContain("&lt;b&gt;a &amp; b&lt;/b&gt;");
    expect(d.html).toContain("p&lt;1&gt;");
    expect(d.html).not.toContain("ghp_123456789012345678901234567890123456");
  });

  it("says nothing is waiting when the list is empty", () => {
    expect(drawDesk([], null, 0, NOW, key)).toEqual({ html: EMPTY_DESK_HTML, rows: [], current: null, full: false });
  });
});

describe("ageText", () => {
  it("reads like a clock", () => {
    expect(ageText(10_000)).toBe("now");
    expect(ageText(12 * 60_000)).toBe("12m");
    expect(ageText(3 * 60 * 60_000)).toBe("3h");
    expect(ageText(50 * 60 * 60_000)).toBe("2d");
  });
});
