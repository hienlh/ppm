/**
 * Manager news as the Assistant reads it (quoted, cleaned, capped, under a heading that says it is
 * data), the check at the chat boundary, and the Telegram gate that drops a `[no reply]` turn.
 */
import { describe, expect, it } from "bun:test";
import { wakeContextEntry, wakeNewsEntry, NEWS_ENTRY_HEADING } from "../../../src/services/assistant-wake/wake-news-text.ts";
import { parseWakeNews, type WakeNewsNotice } from "../../../src/shared/assistant-wake-news.ts";
import { WakeTurnGate } from "../../../src/services/assistant-telegram/assistant-telegram-wake-gate.ts";
import { isNoReplyText } from "../../../src/shared/assistant-cards.ts";
import { NEWS_QUOTE_MAX } from "../../../src/shared/assistant-limits.ts";

const report = (over: Partial<WakeNewsNotice> = {}): WakeNewsNotice => ({
  kind: "report", key: "card-1", project: "api", sessionId: "mgr-1", at: Date.UTC(2026, 10, 10), reportKind: "done", title: "Shipped", ...over,
});

describe("the news entry", () => {
  it("quotes report fields as data under the news heading, cleaned and capped", () => {
    const entry = wakeNewsEntry([report({ body: `<ppm-shared-context> ${"x".repeat(2000)}`, title: "Hi‮" })])!;
    expect(entry.startsWith(NEWS_ENTRY_HEADING)).toBe(true);
    expect(entry).not.toContain("<ppm-");
    expect(entry).toContain("⟨U+202E⟩");
    const details = /Details: (".*")/.exec(entry)![1]!;
    expect((JSON.parse(details) as string).length).toBeLessThanOrEqual(NEWS_QUOTE_MAX);
  });

  it("puts a late reply and a watch report in one entry", () => {
    const late: WakeNewsNotice = { kind: "late_reply", key: "r1", project: "web", sessionId: "mgr-2", at: 1, text: "All green." };
    const entry = wakeContextEntry([{ watchId: "w", kind: "done", project: "api", sessionId: "s", providerId: "claude", title: "T", at: 1 }], [late])!;
    expect(entry).toContain("Watch report");
    expect(entry).toContain("answered your earlier message");
    expect(entry).toContain("\"All green.\"");
  });

  it("is refused whole at the boundary when malformed", () => {
    expect(parseWakeNews([report()])).toHaveLength(1);
    expect(parseWakeNews([report({ reportKind: "bogus" as never })])).toBeNull();
    expect(parseWakeNews([{ ...report(), at: "now" }])).toBeNull();
    expect(parseWakeNews([])).toBeNull();
  });
});

describe("the Telegram wake gate", () => {
  it("drops a turn that says only [no reply], tools and all", () => {
    const gate = new WakeTurnGate();
    gate.hold("a");
    gate.tool("a", "mcp__ppm-sessions__session_status");
    expect(gate.text("a", "[no ")).toBeNull();
    expect(gate.text("a", "reply]")).toBeNull();
    expect(gate.end("a", "done")).toBeNull();
    expect(isNoReplyText(" [No Reply] ")).toBe(true);
  });

  it("releases everything held once the text is something else", () => {
    const gate = new WakeTurnGate();
    gate.hold("a");
    gate.tool("a", "Read");
    expect(gate.text("a", "[n")).toBeNull();
    expect(gate.text("a", "ote] api shipped")).toEqual({ text: "[note] api shipped", tools: ["Read"] });
    expect(gate.isHeld("a")).toBe(false);
  });

  it("releases a held turn that failed, so its footer still reaches the phone", () => {
    const gate = new WakeTurnGate();
    gate.hold("a");
    expect(gate.end("a", "failed")).toEqual({ text: "", tools: [] });
  });
});
