/**
 * The Telegram messages about a chat waiting on a card that carry no buttons: a Design chat's
 * card, an MCP sign-in, and the reminder that a card has stood so long its chat did nothing since.
 * Every name is escaped: a chat title is the user's text, and Telegram refuses a message whose
 * HTML does not parse.
 */
import { describe, expect, it } from "bun:test";
import { isLinkOnlyCard, waitingNoticeHtml } from "../../../src/services/assistant-telegram/assistant-telegram-waiting-notices.ts";
import type { AssistantCard } from "../../../src/shared/assistant-cards.ts";

const base: AssistantCard = {
  id: "c1", kind: "approval", projectName: "api", projectKey: "/p/api", sessionId: "chat-1",
  title: "Open a chat <debug>", body: "", status: "open", answer: null, provenance: null,
  payload: { requestId: "r1", chat: { title: "PIC & prod", providerId: "claude" } },
  createdAt: 0, updatedAt: 0,
};
const clock = (ms: number) => `T${ms}`;

describe("waiting notices on Telegram", () => {
  it("tells a Design chat's card and an MCP sign-in apart from a card with buttons", () => {
    expect(isLinkOnlyCard({ ...base, payload: { ...base.payload, answerInPpm: "design" } })).toBe(true);
    expect(isLinkOnlyCard({ ...base, payload: { ...base.payload, answerInPpm: "mcp_sign_in" } })).toBe(true);
    expect(isLinkOnlyCard({ ...base, payload: { ...base.payload, answerInPpm: "db_execute" } })).toBe(false);
    expect(isLinkOnlyCard(base)).toBe(false);
  });

  it("escapes the chat's name and the card's title", () => {
    const html = waitingNoticeHtml({ ...base, payload: { ...base.payload, answerInPpm: "design" } }, "design", clock);
    expect(html).toContain("PIC &amp; prod");
    expect(html).toContain("Open a chat &lt;debug&gt;");
  });

  it("says since when a card has kept its chat waiting, naming a scheduled run", () => {
    const html = waitingNoticeHtml({ ...base, payload: { ...base.payload, waitingSince: 42, scheduledTurn: true } }, "overdue", clock);
    expect(html).toContain("since T42");
    expect(html).toContain("a scheduled run");
  });

  it("names the server an MCP sign-in card is for", () => {
    const html = waitingNoticeHtml({ ...base, payload: { ...base.payload, answerInPpm: "mcp_sign_in", mcpServer: "vanta" } }, "mcp_sign_in", clock);
    expect(html).toContain("vanta needs a sign-in");
  });
});
