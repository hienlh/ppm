/**
 * Where a locked-tier value must not go once an AI has read it: the session trace (withheld or
 * scrubbed), the Assistant's notebook, another chat through the session tools, and Telegram.
 * Public values are not protected and pass through.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { createTurnSecretScrubber, turnSecretScrubber } from "../../../../src/services/vault/turn-secret-scrubber.ts";
import { filterVaultTraceRecord } from "../../../../src/services/vault/vault-trace-filter.ts";
import { notebookAddTool, notebookEditTool } from "../../../../src/services/assistant-mcp/assistant-notebook-tools.ts";
import { createSessionCollabMcpHandler } from "../../../../src/services/session-collab/session-collab-endpoint.ts";
import { Hono } from "hono";
import { TelegramBotClient } from "../../../../src/services/telegram/telegram-bot-client.ts";
import { TELEGRAM_API_BASE_ENV } from "../../../../src/services/telegram/telegram-api-base.ts";
import { startFakeTelegram } from "../../../helpers/fake-telegram-bot-api.ts";
import { quoteCard, quoteTelegramMessage } from "../../../../src/services/assistant-telegram/assistant-telegram-reply-quote.ts";
import { vaultNoticeHtml } from "../../../../src/services/assistant-telegram/assistant-telegram-db-notices.ts";
import { deliverCardFollowup } from "../../../../src/services/assistant-cards/card-reply-followup.ts";

afterEach(() => turnSecretScrubber.clear());

describe("turn scrubber", () => {
  it("matches a value as given and loosely, per chat, and forgets it after the hold", () => {
    let t = 0;
    const s = createTurnSecretScrubber({ now: () => t });
    s.hold("a", [{ name: "NI", value: "QQ 12 34 56 C" }]);
    expect(s.scrub("yours is qq123456c ok", "a")).toBe("yours is [vault:NI] ok");
    expect(s.scrub("QQ 12 34 56 C", "b")).toBe("QQ 12 34 56 C");
    expect(s.scrub("QQ 12 34 56 C")).toBe("[vault:NI]");
    expect(s.find("q q 1 2 3 4 5 6 c")).toBe("NI");
    t += 24 * 60 * 60_000 + 1;
    expect(s.find("QQ123456C")).toBeNull();
  });

  it("catches a multi-line value inside an object, its HTML-escaped form, and keeps $& in a name literal", () => {
    const s = createTurnSecretScrubber();
    s.hold("a", [{ name: "Home", value: "1 High St\nLondon" }, { name: "X$&", value: "QQ123456C" }, { name: "Q", value: "a<b&c>d" }]);
    expect(s.findIn({ message: "my address is 1 High St\nLondon", nested: [1] })).toBe("Home");
    expect(s.scrubIn({ t: "1 High St\nLondon" })).toEqual({ t: "[vault:Home]" });
    expect(s.scrub("QQ123456C")).toBe("[vault:X$&]");
    expect(s.find("a&lt;b&amp;c&gt;d")).toBe("Q");
  });

  it("ignores values too short to tell from ordinary text", () => {
    const s = createTurnSecretScrubber();
    s.hold("a", [{ name: "x", value: "ab" }]);
    expect(s.any()).toBe(false);
  });
});

describe("session trace", () => {
  it("withholds a locked vault_read result, keeps a public one, and drops a proposal's value", () => {
    const locked = filterVaultTraceRecord("s", { type: "tool_result", toolUseId: "t1", output: "Vault items (secure tier). Use them only...\n- NI (NI number): CANARY-T2-x\n- Address (Address): CANARY-T2-y" }) as Record<string, unknown>;
    expect(JSON.stringify(locked)).not.toContain("CANARY");
    expect(locked).toMatchObject({ withheld: true, tier: "secure", items: ["NI", "Address"] });
    const wrapped = filterVaultTraceRecord("s", { type: "tool_result", output: JSON.stringify({ content: [{ type: "text", text: "Vault items (sealed tier). x\n- P (Passport): CANARY-T3-z" }] }) });
    expect(JSON.stringify(wrapped)).not.toContain("CANARY");
    const pub = { type: "tool_result", output: "Public vault items:\n- Co (Other): CANARY-T1-co" };
    expect(filterVaultTraceRecord("s", pub)).toEqual(pub);
    const proposal = filterVaultTraceRecord("s", { type: "tool_use", tool: "mcp__ppm-sessions__vault_propose", input: { name: "NI", kind: "ni_number", value: "CANARY-T2-p" } });
    expect(JSON.stringify(proposal)).not.toContain("CANARY");
  });

  it("scrubs a value the AI repeats in its text", () => {
    turnSecretScrubber.hold("s", [{ name: "NI", value: "CANARY-T2-repeat" }]);
    const out = filterVaultTraceRecord("s", { type: "text", content: "Your NI is CANARY-T2-repeat." });
    expect(out).toEqual({ type: "text", content: "Your NI is [vault:NI]." });
  });
});

describe("notebook and other chats", () => {
  it("refuses a notebook line holding a value just read", () => {
    turnSecretScrubber.hold("other-session", [{ name: "NI", value: "CANARY-T2-note" }]);
    const added = notebookAddTool("s", { text: "User NI is CANARY-T2-note" }, { notes: { add: () => { throw new Error("must not write"); } } as never, unattended: () => false });
    expect(JSON.stringify(added)).toContain("vault item");
    const edited = notebookEditTool("s", { id: 1, text: "canary-t2-NOTE" }, { notes: { edit: () => { throw new Error("must not write"); } } as never, unattended: () => false });
    expect(JSON.stringify(edited)).toContain("vault item");
  });

  it("refuses a session tool call carrying a held value before anything is resolved", async () => {
    turnSecretScrubber.hold("s1", [{ name: "NI", value: "CANARY-T2-send" }]);
    const handler = createSessionCollabMcpHandler({
      resolveToken: (token) => (token ? { sessionId: token } : null),
      env: () => { throw new Error("must not reach the env"); },
      enabled: () => true,
    });
    const app = new Hono();
    app.post("/mcp", handler);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer s1", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_to_session", arguments: { session_id: "x", message: "the NI is CANARY-T2-send" } } }),
    });
    const body = await res.text();
    expect(body).toContain("Refused");
    expect(body).not.toContain("must not reach");
  });
});

describe("Telegram reply quotes", () => {
  it("a quoted bot message or card body reaches the Assistant without a held value, even when cut", () => {
    turnSecretScrubber.hold("s1", [{ name: "NI", value: "CANARY-T2-quote" }]);
    const long = `${"line\n".repeat(7)}NI CANARY-T2-quote and more`;
    const q = quoteTelegramMessage("42", { message_id: 7, date: 1, chat: { id: 42, type: "private" }, from: { id: 1, is_bot: true, first_name: "bot" }, text: long } as never);
    expect(q.quote).not.toContain("CANARY");
    const c = quoteCard({ id: "c1", kind: "report", projectName: "p", status: "open", title: "t", body: "Your NI is CANARY-T2-quote", createdAt: 1 } as never);
    expect(c.quote).not.toContain("CANARY");
    expect(c.quote).toContain("[vault:NI]");
  });
});

describe("Telegram", () => {
  it("scrubs held values from every message sent, and the vault notice names nothing", async () => {
    const fake = startFakeTelegram();
    const saved = process.env[TELEGRAM_API_BASE_ENV];
    process.env[TELEGRAM_API_BASE_ENV] = fake.url;
    try {
      turnSecretScrubber.hold("s1", [{ name: "NI", value: "CANARY-T2-tg" }]);
      const client = new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async () => {} });
      await client.sendMessage(4242, "Your NI: CANARY-T2-tg");
      const texts = JSON.stringify(fake.sent(4242));
      expect(texts).not.toContain("CANARY");
      expect(texts).toContain("[vault:NI]");
      // A card body sent as HTML, a photo's caption and an album caption go through the same filter.
      await client.sendMessage(4242, "<b>Card</b>\nNI: <code>CANARY-T2-tg</code>");
      await client.sendPhotos(4242, [{ bytes: new Uint8Array([137, 80, 78, 71]), filename: "a.png", caption: "Shot of CANARY-T2-tg" }]);
      await client.sendPhotos(4242, [
        { bytes: new Uint8Array([137, 80, 78, 71]), filename: "a.png", caption: "first CANARY-T2-tg" },
        { bytes: new Uint8Array([137, 80, 78, 71]), filename: "b.png" },
      ]);
      const all = JSON.stringify(fake.sent(4242));
      expect(all).not.toContain("CANARY");
      expect(all.match(/\[vault:NI\]/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
      // The vault's own notice names the item and the tier, never the AI's purpose (its own text).
      const notice = vaultNoticeHtml({ project: "p", providerId: "claude", title: "Visa" }, {
        kind: "read-sealed", requester: { sessionTitle: "Visa", assistant: false, fromTelegram: false },
        purpose: "fill the form with CANARY-T2-purpose", item: { id: "i1", name: "Passport", kind: "passport" },
        allowGiveToAi: true, attemptsLeft: 5, lockedUntil: 0,
      });
      expect(notice).toContain("Passport");
      expect(notice).toContain("Sealed");
      expect(notice).not.toContain("CANARY");
    } finally {
      fake.stop();
      if (saved === undefined) delete process.env[TELEGRAM_API_BASE_ENV];
      else process.env[TELEGRAM_API_BASE_ENV] = saved;
    }
  });
});

describe("card follow-ups", () => {
  it("keep a value the manager repeats out of the card's stored answer and what is handed on", () => {
    turnSecretScrubber.hold("m1", [{ name: "NI", value: "CANARY-T2-followup" }]);
    let stored: unknown = null;
    let handed: unknown = null;
    const card = { id: "c1", status: "answered" } as never;
    deliverCardFollowup({
      cards: { get: () => card, setFollowUp: (_id, f) => { stored = f; return true; } },
      now: () => 1,
      sink: () => ({ send: (d) => { handed = d; } }),
    }, { cardId: "c1", origin: { channel: "telegram", chatId: "1" }, sessionId: "m1", text: "Submitted with NI CANARY-T2-followup.", overflow: false, newCards: [], repliedAt: 1 });
    expect(JSON.stringify(stored)).not.toContain("CANARY");
    expect(JSON.stringify(stored)).toContain("[vault:NI]");
    expect(JSON.stringify(handed)).not.toContain("CANARY");
  });

  it("keep a value out of the user's reply kept beside the answer, and never hand the reply on", () => {
    turnSecretScrubber.hold("m1", [{ name: "NI", value: "CANARY-T2-reply" }]);
    let stored: unknown = null;
    let handed: unknown = null;
    const card = { id: "c1", status: "answered" } as never;
    deliverCardFollowup({
      cards: { get: () => card, setFollowUp: (_id, f) => { stored = f; return true; } },
      now: () => 1,
      sink: () => ({ send: (d) => { handed = d; } }),
    }, {
      cardId: "c1", origin: { channel: "telegram", chatId: "1" }, sessionId: "m1", text: "Done.", overflow: false, newCards: [], repliedAt: 1,
      reply: "Use NI CANARY-T2-reply for the filing",
    });
    expect(JSON.stringify(stored)).not.toContain("CANARY");
    expect(stored).toMatchObject({ reply: "Use NI [vault:NI] for the filing" });
    expect(JSON.stringify(handed)).not.toContain("CANARY");
    // The words as typed stay behind; only the card's scrubbed copy travels with it.
    expect((handed as { reply?: string }).reply).toBeUndefined();
  });

  it("keep a value out of the title of a new card the manager answered with, stored and handed on", () => {
    turnSecretScrubber.hold("m1", [{ name: "NI", value: "CANARY-T2-newcard" }]);
    let stored: unknown = null;
    let handed: unknown = null;
    const card = { id: "c1", status: "answered" } as never;
    deliverCardFollowup({
      cards: { get: () => card, setFollowUp: (_id, f) => { stored = f; return true; } },
      now: () => 1,
      sink: () => ({ send: (d) => { handed = d; } }),
    }, {
      cardId: "c1", origin: { channel: "telegram", chatId: "1" }, sessionId: "m1", overflow: false, repliedAt: 1,
      text: "Opened a card for NI CANARY-T2-newcard.", newCards: [{ id: "n1", title: "Submit for NI CANARY-T2-newcard?" }],
    });
    expect(JSON.stringify(stored)).not.toContain("CANARY");
    expect(stored).toMatchObject({ text: "", newCards: [{ id: "n1", title: "Submit for NI [vault:NI]?" }] });
    expect(JSON.stringify(handed)).not.toContain("CANARY");
  });
});

describe("the line naming a new card that never reached the phone", () => {
  it("carries no vault value from the card's title", async () => {
    const { AssistantTelegramManagerCards } = await import("../../../../src/services/assistant-telegram/assistant-telegram-manager-cards.ts");
    const { AssistantTelegramSendQueue } = await import("../../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts");
    const { createAssistantCards } = await import("../../../../src/services/assistant-cards/assistant-cards.service.ts");
    const fake = startFakeTelegram();
    process.env[TELEGRAM_API_BASE_ENV] = fake.url;
    try {
      const CHAT = 8_700_001;
      const { connectChat } = await import("../assistant-telegram/bridge-test-kit.ts");
      connectChat(CHAT);
      turnSecretScrubber.hold("mgr", [{ name: "NI", value: "CANARY-T2-pointer" }]);
      const client = new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async () => {} });
      const queue = new AssistantTelegramSendQueue(client, { canSend: () => true, scaleDelay: () => 0 });
      const cards = new AssistantTelegramManagerCards({
        queue, codes: { mint: () => "c", dropGroup: () => {} } as never, chatLink: async () => "", sessionLink: async () => "",
        relayCard: () => {}, isShowing: () => false, detailOf: () => "full", recipients: () => [String(CHAT)],
        answering: () => [{ origin: { channel: "telegram", chatId: String(CHAT), messageId: 42 }, repliedAt: 0 }], now: () => 1,
      });
      const store = createAssistantCards({ now: () => 1, projects: () => [], announce: () => {} });
      const made = store.create({ kind: "needs_decision", sessionId: "mgr", title: "Submit for NI CANARY-T2-pointer?" });
      fake.failNext("sendMessage", { code: 400, description: "Bad Request: REPLY_MARKUP_TOO_LONG" });
      cards.send([made]);
      // The follow-up counted on the card, so its refusal sends the one line naming it.
      expect(cards.threadedIn(made.id, String(CHAT))).toBe(true);
      await fake.waitFor(() => fake.sent(CHAT).find((m) => !m.failed));
      await queue.whenIdle();
      const sent = fake.sent(CHAT).filter((m) => !m.failed);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).not.toContain("CANARY");
      expect(sent[0]!.text).toContain("[vault:NI]");
    } finally {
      fake.stop();
      delete process.env[TELEGRAM_API_BASE_ENV];
    }
  });
});
