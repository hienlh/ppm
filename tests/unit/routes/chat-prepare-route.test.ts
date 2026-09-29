import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { accountSelector } from "../../../src/services/account-selector.service.ts";
import { accountService } from "../../../src/services/account.service.ts";
import * as slashModule from "../../../src/services/slash-items-for-provider.ts";
import * as codexAccountService from "../../../src/services/codex-account.service.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

const PROJ = "/tmp/chat-prepare-route-test";

function app() {
  const hono = new Hono<Env>();
  hono.use("/*", async (c, next) => {
    c.set("projectPath", PROJ);
    c.set("projectName", "chat-prepare-route-test");
    await next();
  });
  hono.route("/chat", chatRoutes);
  return hono;
}

async function post(body: unknown) {
  return app().request("/chat/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let slashSpy: ReturnType<typeof spyOn<typeof slashModule, "listSlashItemsForProvider">>;

beforeEach(() => {
  setDb(openTestDb());
  accountSelector.setStrategy("round-robin");
  accountSelector.setMaxRetry(0);
  // The real path spawns a codex/claude subprocess to enumerate slash items — nothing this
  // route test needs, and slow/flaky without a real provider installed. Individual tests
  // override this when they need to exercise the slash budget itself.
  slashSpy = spyOn(slashModule, "listSlashItemsForProvider").mockResolvedValue([]);
});

afterEach(() => {
  slashSpy.mockRestore();
});

describe("POST /chat/prepare", () => {
  it("returns every part of the contract", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    const data = json.data;
    expect(data.resolvedProviderId).toBe("claude");
    expect(data.providerId).toBe("claude");
    expect(data.settings.default_provider).toBe("claude");
    expect(Array.isArray(data.providers)).toBe(true);
    expect(data.providers.some((p: { id: string }) => p.id === "claude")).toBe(true);
    // No accounts configured — nothing to pick, and no usage to read for it.
    expect(data.pickedAccount).toBeNull();
    expect(data.usage).toBeNull();
    // No draft saved yet for this project's __new__ slot.
    expect(data.draft).toBeNull();
    expect(data.tags).toEqual({ tags: [], counts: {}, defaultTagId: null });
    expect(data.slash).toEqual({ items: [], recentNames: [] });
  });

  it("no secret provider fields or account credentials leak through", async () => {
    accountService.add({ email: "a@example.com", accessToken: "tok", refreshToken: "ref", expiresAt: 9999999999, label: "Account A" });
    const res = await post({ providerId: "claude" });
    const json = await res.json() as any;
    const raw = JSON.stringify(json.data);
    expect(raw).not.toContain("api_key_env");
    expect(raw).not.toContain("accessToken");
    expect(raw).not.toContain("refreshToken");
    expect(json.data.pickedAccount).toEqual({ id: expect.any(String), label: "Account A" });
  });

  it("skipPick does not pick — the round-robin cursor never advances", async () => {
    accountService.add({ email: "a@example.com", accessToken: "tok", refreshToken: "ref", expiresAt: 9999999999 });
    const nextSpy = spyOn(accountSelector, "next");
    try {
      const res = await post({ providerId: "claude", skipPick: true });
      const json = await res.json() as any;
      expect(json.data.pickedAccount).toBe("skipped");
      expect(json.data.usage).toBeNull();
      expect(nextSpy).not.toHaveBeenCalled();
    } finally {
      nextSpy.mockRestore();
    }
  });

  it("rejects an unknown provider with 400", async () => {
    const res = await post({ providerId: "does-not-exist" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("a hanging part yields null within its budget, not the request timeout", async () => {
    slashSpy.mockReturnValue(new Promise(() => {})); // never resolves
    const started = Date.now();
    const res = await post({});
    const elapsed = Date.now() - started;
    const json = await res.json() as any;
    expect(json.data.slash).toBeNull();
    // The slash budget is 400ms; anything well under a second proves the request did not
    // wait for the part that hung.
    expect(elapsed).toBeLessThan(1500);
  }, 5_000);

  it("a Codex usage overrun times out without consuming the round-robin pick", async () => {
    const fakeCodexProvider = { id: "codex", name: "Codex", listSkills: async () => [] } as any;
    const getSpy = spyOn(providerRegistry, "get").mockReturnValue(fakeCodexProvider);
    const listSpy = spyOn(codexAccountService, "listCodexAccounts").mockReturnValue([
      { id: "codex-1", label: "Codex 1", type: "chatgpt", home: "/tmp/codex-home", status: "active", dailyGuardEnabled: false, addedAt: "" } as any,
    ]);
    // Never resolves — the pick must give up after its own budget rather than wait forever.
    const usagesSpy = spyOn(codexAccountService, "getAllCodexUsages").mockReturnValue(new Promise(() => {}));
    const selectSpy = spyOn(codexAccountService, "selectCodexAccount");
    try {
      const res = await post({ providerId: "codex" });
      const json = await res.json() as any;
      expect(json.data.pickedAccount).toBe("timeout");
      expect(json.data.usage).toBeNull();
      // The whole point of the budget: a slow usage fetch must never let selection run and
      // consume a pick nobody will use.
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      listSpy.mockRestore();
      usagesSpy.mockRestore();
      selectSpy.mockRestore();
    }
  }, 10_000);

  it("starts the account pick alongside the slash part, not after its budget", async () => {
    const fakeCodexProvider = { id: "codex", name: "Codex", listSkills: async () => [] } as any;
    const getSpy = spyOn(providerRegistry, "get").mockReturnValue(fakeCodexProvider);
    const listSpy = spyOn(codexAccountService, "listCodexAccounts").mockReturnValue([
      { id: "codex-1", label: "Codex 1", type: "chatgpt", home: "/tmp/codex-home", status: "active", dailyGuardEnabled: false, addedAt: "" } as any,
    ]);
    let slashAskedAt = 0;
    let usageAskedAt = 0;
    slashSpy.mockImplementation(() => { slashAskedAt = Date.now(); return new Promise(() => {}); });
    const usagesSpy = spyOn(codexAccountService, "getAllCodexUsages").mockImplementation(() => {
      usageAskedAt = Date.now();
      return Promise.resolve({});
    });
    try {
      const res = await post({ providerId: "codex" });
      const json = await res.json() as any;
      expect(json.data.slash).toBeNull();
      expect(usageAskedAt).toBeGreaterThan(0);
      // Sequential, the pick would only start once the hung slash part used up its 400 ms.
      expect(usageAskedAt - slashAskedAt).toBeLessThan(200);
    } finally {
      getSpy.mockRestore();
      listSpy.mockRestore();
      usagesSpy.mockRestore();
    }
  }, 10_000);
});
