/**
 * `/status`: the ten most urgent chats in the order chats_attention ranks them, names cleaned and
 * linked only when Telegram can open the link, and the cards that wait listed for relaying.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { buildStatus, STATUS_MAX_ITEMS } from "../../../../src/services/assistant-telegram/assistant-telegram-status.ts";
import type { ChatsAttention } from "../../../../src/services/assistant-hub/chat-attention.service.ts";
import type { LiveApprovalCard } from "../../../../src/services/chat-control/chat-control.ts";
import { parseTelegramHtml } from "../../../helpers/fake-telegram-bot-api.ts";

const empty = (): ChatsAttention => ({
  since: "", needsDecision: [], running: [], lostCards: [], stopped: [], finishedUnread: [], finishedRead: [], more: {},
});
const chat = (n: number, title: string | null = `Chat ${n}`) => ({ sessionId: `s-${n}`, project: "api", providerId: "claude", title });
const card = (id: string): LiveApprovalCard => ({ requestId: id, tool: "Bash", input: { command: "rm -rf dist" }, isQuestion: false });
const localLinks = { link: async () => "http://localhost:8080/project/api", homeLink: async () => "http://localhost:8080/" };

describe("/status", () => {
  it("says so when nothing needs the user", async () => {
    const reply = await buildStatus({ attention: empty, ...localLinks });
    expect(reply.html).toContain("Nothing needs you today");
    expect(reply.cards).toEqual([]);
  });

  it("lists the most urgent first, at most ten, and counts the rest", async () => {
    const a = empty();
    a.needsDecision = [{ ...chat(1), card: {} as never, queuedCards: 2 }];
    a.running = Array.from({ length: 6 }, (_, i) => ({ ...chat(10 + i), phase: "streaming" }));
    a.stopped = [{ ...chat(20), endedAt: "", error: "Rate limited\nretry later", unread: true }];
    a.finishedUnread = Array.from({ length: 5 }, (_, i) => chat(30 + i));
    a.more = { finishedRead: 4 };
    const reply = await buildStatus({ attention: () => a, liveCard: (id) => (id === "s-1" ? card("r1") : null), ...localLinks });
    const lines = reply.html.split("\n").filter((l) => /^\S+ <b>/.test(l));
    expect(lines).toHaveLength(STATUS_MAX_ITEMS);
    expect(lines[0]).toBe("🔐 <b>Chat 1</b> · api — waiting for your decision (+2 more)");
    expect(lines[7]).toBe("⛔ <b>Chat 20</b> · api — stopped: Rate limited");
    // 13 listed, 10 shown, plus the 4 the overview itself held back.
    expect(reply.html).toContain("<i>7 more in PPM.</i>");
    // No link Telegram could open on a name: one plain line instead.
    expect(reply.html).toContain("Open in PPM: http://localhost:8080/");
    expect(reply.cards).toEqual([{ targetSessionId: "s-1", targetProject: "api", targetProvider: "claude", targetTitle: "Chat 1", card: card("r1") }]);
    expect("error" in parseTelegramHtml(reply.html)).toBe(false);
  });

  it("links a name only over public https, and cleans what it shows", async () => {
    const a = empty();
    a.running = [{ ...chat(1, "Fix <b>bug</b> with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), phase: "streaming" }];
    a.finishedUnread = [chat(2, null)];
    const reply = await buildStatus({ attention: () => a, link: async (_p, _pr, id) => `https://ppm.example.com/project/api?openChat=claude/${id}` });
    expect(reply.html).toContain('<a href="https://ppm.example.com/project/api?openChat=claude/s-1">Fix &lt;b&gt;bug&lt;/b&gt; with');
    expect(reply.html).not.toContain("sk-ant-api03-AAAA");
    expect(reply.html).toContain(">Session s-2</a>");
    expect(reply.html).not.toContain("Open in PPM:");
    expect("error" in parseTelegramHtml(reply.html)).toBe(false);
  });

  it("lists a waiting chat whose card is already gone without relaying anything", async () => {
    const a = empty();
    a.needsDecision = [{ ...chat(1), card: {} as never, queuedCards: 0 }];
    const reply = await buildStatus({ attention: () => a, liveCard: () => null, ...localLinks });
    expect(reply.html).toContain("waiting for your decision");
    expect(reply.cards).toEqual([]);
  });
});
