/**
 * A mirrored card that cannot be answered off its chat is refused on the server, whatever a
 * screen sends: one still queued behind another card (its chat's provider was not even asked
 * yet), a Design chat's card and an MCP sign-in. The chat is never touched.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { answerCard } from "../../../src/services/assistant-cards/assistant-card-actions.ts";
import type { ChatControl } from "../../../src/services/chat-control/chat-control.ts";
import type { AssistantCardPayload } from "../../../src/shared/assistant-cards.ts";

const cards = createAssistantCards({ now: () => 1, projects: () => [{ name: "api", path: "/p/api" }], announce: () => {} });
let answered = 0;
const control = { answerApproval: () => { answered++; return "answered"; } } as unknown as ChatControl;
const deps = { cards, control: () => control, now: () => 1 };
const approval = (payload: AssistantCardPayload) => cards.create({
  kind: "approval", projectName: "api", projectPath: "/p/api", sessionId: "chat-1", title: "Open a chat",
  payload: { requestId: "r1", deciding: { kind: "create", title: "Open a chat", facts: [], text: "", complete: true }, ...payload },
});

beforeEach(() => {
  getDb().run("DELETE FROM assistant_cards");
  answered = 0;
});

describe("cards answered only in their chat", () => {
  it("refuses a card queued behind another of its chat", () => {
    const r = answerCard(approval({ queued: true }).id, { decision: "allow" }, deps);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(answered).toBe(0);
  });

  it("refuses a Design chat's card and an MCP sign-in, saying where to answer", () => {
    const design = answerCard(approval({ answerInPpm: "design", design: { slug: "landing" } }).id, { decision: "deny" }, deps);
    expect(design).toMatchObject({ ok: false, status: 400 });
    expect(design.ok ? "" : design.error).toContain("design");
    getDb().run("DELETE FROM assistant_cards");
    const mcp = answerCard(approval({ answerInPpm: "mcp_sign_in", mcpServer: "vanta" }).id, { decision: "allow" }, deps);
    expect(mcp).toMatchObject({ ok: false, status: 400 });
    expect(answered).toBe(0);
  });
});
