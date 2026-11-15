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
import { VAULT_NOTICE_HTML } from "../../../../src/services/assistant-telegram/assistant-telegram-db-notices.ts";

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
      expect(VAULT_NOTICE_HTML).not.toMatch(/secure|sealed|NI|passport/i);
    } finally {
      fake.stop();
      if (saved === undefined) delete process.env[TELEGRAM_API_BASE_ENV];
      else process.env[TELEGRAM_API_BASE_ENV] = saved;
    }
  });
});
