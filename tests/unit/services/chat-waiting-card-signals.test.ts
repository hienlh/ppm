/**
 * The cards a chat waits on, as the Assistant mirrors them: one queued behind another card has
 * nothing to press until it reaches the front (then the same card becomes answerable, no second
 * is made), one left unanswered too long says since when, a Design chat's is a link to its design,
 * and an MCP server that stopped working mid-session gets one sign-in card per project.
 */
import { describe, expect, it } from "bun:test";
import {
  markOverdueCard, mcpSignInRequestId, mirrorCardInput, mirrorQueuedCard, promoteQueuedCard, raiseMcpSignInCards,
  type CardOwner, type WaitingCardDeps,
} from "../../../src/services/assistant-cards/chat-waiting-card-signals.ts";
import type { CardRow } from "../../../src/services/assistant-cards/assistant-cards-db.ts";
import type { NewCard } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import type { AssistantCardPayload } from "../../../src/shared/assistant-cards.ts";
import { SESSION_COLLAB_APPROVAL } from "../../../src/shared/session-collab.ts";

function harness() {
  const rows = new Map<string, CardRow>();
  const created: NewCard[] = [];
  const patched: Array<{ id: string; patch: Partial<AssistantCardPayload>; change: string }> = [];
  const deps: WaitingCardDeps = {
    cards: {
      create: (input) => {
        created.push(input);
        const id = `card-${created.length}`;
        const row = { id, kind: input.kind, payload: input.payload ?? {}, status: "open" } as unknown as CardRow;
        rows.set(String(input.payload?.requestId), row);
        return { id } as never;
      },
      patchPayload: (id, patch, change) => {
        patched.push({ id, patch, change });
        for (const row of rows.values()) if (row.id === id) row.payload = { ...row.payload, ...patch };
        return null;
      },
    },
    openRequestCard: (requestId) => rows.get(requestId) ?? null,
  };
  return { deps, created, patched };
}

const owner: CardOwner = {
  projectName: "Nxsys", projectPath: "D:/Projects/nxsys", sessionId: "pic", chat: { title: "PIC", providerId: "claude" },
};
const createCard = {
  requestId: "req-1", tool: SESSION_COLLAB_APPROVAL, isQuestion: false,
  input: { kind: "create", title: "Debug NX-1", providerId: "claude", task: "Look into it", depth: 1 },
};
const place = { sessionId: "pic", projectName: "Nxsys", providerId: "claude" };

describe("a card queued behind another of its chat", () => {
  it("is mirrored with nothing to press, then made answerable in place when it reaches the front", () => {
    const h = harness();
    mirrorQueuedCard(owner, { ...place, card: createCard }, h.deps);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.payload).toMatchObject({ requestId: "req-1", queued: true, chat: { title: "PIC" } });
    expect(promoteQueuedCard({ ...place, card: createCard }, h.deps)).toBe(true);
    expect(h.patched).toEqual([{ id: "card-1", patch: { queued: undefined }, change: "shown" }]);
    expect(h.created).toHaveLength(1);
  });

  it("is mirrored once, however often it is told", () => {
    const h = harness();
    mirrorQueuedCard(owner, { ...place, card: createCard }, h.deps);
    mirrorQueuedCard(owner, { ...place, card: createCard }, h.deps);
    expect(h.created).toHaveLength(1);
  });

  it("leaves a card that never was queued for the caller to create", () => {
    const h = harness();
    expect(promoteQueuedCard({ ...place, card: createCard }, h.deps)).toBe(false);
  });
});

describe("a card left unanswered too long", () => {
  it("says since when, once, and names a schedule's turn", () => {
    const h = harness();
    h.deps.cards.create(mirrorCardInput(owner, createCard, "pic", h.deps));
    markOverdueCard({ ...place, requestId: "req-1", shownAt: 1000, scheduled: true }, h.deps);
    markOverdueCard({ ...place, requestId: "req-1", shownAt: 1000, scheduled: true }, h.deps);
    expect(h.patched).toEqual([{ id: "card-1", patch: { waitingSince: 1000, scheduledTurn: true }, change: "overdue" }]);
  });
});

describe("a Design chat's card", () => {
  it("is a link to its design, with nothing to answer off it", () => {
    const input = mirrorCardInput({ ...owner, design: { slug: "landing" } }, createCard, "pic", {});
    expect(input.payload).toMatchObject({ answerInPpm: "design", design: { slug: "landing" } });
  });
});

describe("an MCP server that stopped working mid-session", () => {
  it("gets one sign-in card per project and server", () => {
    const h = harness();
    raiseMcpSignInCards(owner, { ...place, servers: ["vanta", "linear"] }, h.deps);
    raiseMcpSignInCards(owner, { ...place, servers: ["vanta"] }, h.deps);
    expect(h.created.map((c) => c.payload?.mcpServer)).toEqual(["vanta", "linear"]);
    expect(h.created[0]!.payload).toMatchObject({
      requestId: mcpSignInRequestId("D:/Projects/nxsys", "vanta"), answerInPpm: "mcp_sign_in", chat: { title: "PIC" },
    });
  });

  it("gets none for a chat whose cards nobody mirrors", () => {
    const h = harness();
    raiseMcpSignInCards(null, { ...place, servers: ["vanta"] }, h.deps);
    expect(h.created).toEqual([]);
  });
});
