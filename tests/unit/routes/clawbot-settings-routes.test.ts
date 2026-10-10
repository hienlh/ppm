/**
 * The `/api/settings/clawbot` contract the Settings pane builds on (the `clawbot` name is PPMBot's,
 * kept so existing setups carry over): three settings and none of PPMBot's old fields, revoking a
 * chat forgets it in the bridge too, and PPMBot's memories are listed read-only.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { getDb, isPairedChat, upsertApprovedPairing } from "../../../src/services/db.service.ts";
import { getTelegramBinding, setTelegramBinding } from "../../../src/services/assistant-hub/assistant-hub-db.ts";
import { assistantTelegramBridge } from "../../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { PPMBOT_MIGRATED_KEY } from "../../../src/services/assistant-telegram/ppmbot-migration.ts";
import { setPPMBotBot } from "../../../src/services/telegram-bots.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { assistantSettingsRoutes } from "../../../src/server/routes/assistant-settings.ts";

const original = configService.get("clawbot");
afterAll(async () => {
  await assistantTelegramBridge.stop();
  configService.set("clawbot", original!);
  setPPMBotBot({ bot_token: "" });
  getDb().query("DELETE FROM config WHERE key = ?").run(PPMBOT_MIGRATED_KEY);
});

const app = new Hono().route("/api/settings", settingsRoutes).route("/api/assistant", assistantSettingsRoutes);
async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`http://localhost${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() as { ok: boolean; data?: any; error?: string } };
}

beforeEach(() => {
  // No bot: switching the bridge on must not reach Telegram from a unit test.
  setPPMBotBot({ bot_token: "" });
  getDb().query("DELETE FROM config WHERE key = ?").run(PPMBOT_MIGRATED_KEY);
});

describe("GET/PUT /api/settings/clawbot", () => {
  it("answers the three settings only, whatever an old PPMBot row holds", async () => {
    configService.set("clawbot", {
      enabled: false, default_provider: "codex", system_prompt: "", show_tool_calls: false, show_thinking: true,
      permission_mode: "bypassPermissions", debounce_ms: 900,
    } as never);
    const res = await call("GET", "/api/settings/clawbot");
    expect(res.json.data).toEqual({ enabled: false, show_tool_calls: false, debounce_ms: 900 });
  });

  it("saves a subset, ignores PPMBot's old fields, and stores nothing else", async () => {
    configService.set("clawbot", { enabled: false, show_tool_calls: true, debounce_ms: 2000 });
    const res = await call("PUT", "/api/settings/clawbot", { debounce_ms: 500, permission_mode: "bypassPermissions", default_provider: "x", show_thinking: true });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ enabled: false, show_tool_calls: true, debounce_ms: 500 });
    expect(configService.get("clawbot")).toEqual({ enabled: false, show_tool_calls: true, debounce_ms: 500 });
  });

  it("refuses values of the wrong kind", async () => {
    expect((await call("PUT", "/api/settings/clawbot", { debounce_ms: 30001 })).status).toBe(400);
    expect((await call("PUT", "/api/settings/clawbot", { debounce_ms: 1.5 })).status).toBe(400);
    expect((await call("PUT", "/api/settings/clawbot", { enabled: "yes" })).status).toBe(400);
    expect((await call("PUT", "/api/settings/clawbot", "not json")).status).toBe(400);
    expect((await call("PUT", "/api/settings/clawbot", [1])).status).toBe(400);
  });

  it("switches the bridge on only when there is a bot to read", async () => {
    const res = await call("PUT", "/api/settings/clawbot", { enabled: true });
    expect(res.json.data.enabled).toBe(true);
    expect(assistantTelegramBridge.running).toBe(false);
    expect((await call("GET", "/api/settings/clawbot/telegram")).json.data).toMatchObject({ enabled: true, running: false });
    await call("PUT", "/api/settings/clawbot", { enabled: false });
  });

  it("carries an old system prompt over before rewriting the row without it", async () => {
    configService.set("assistant", { ...configService.get("assistant")!, instructions: "" });
    configService.set("clawbot", { enabled: false, show_tool_calls: true, debounce_ms: 2000, system_prompt: "Be brief." } as never);
    await call("PUT", "/api/settings/clawbot", { show_tool_calls: false });
    expect(configService.get("assistant")!.instructions).toContain("Be brief.");
    expect(configService.get("clawbot")).toEqual({ enabled: false, show_tool_calls: false, debounce_ms: 2000 });
  });
});

describe("DELETE /api/settings/clawbot/paired/:chatId", () => {
  it("revokes the chat and forgets its conversation", async () => {
    upsertApprovedPairing("5551234", "5551234", "Phone");
    setTelegramBinding("5551234", "asst-session", "claude");
    const res = await call("DELETE", "/api/settings/clawbot/paired/5551234");
    expect(res.json.data).toEqual({ revoked: true });
    expect(isPairedChat("5551234")).toBe(false);
    expect(getTelegramBinding("5551234")).toBeNull();
  });

  it("refuses something that is not a chat id", async () => {
    expect((await call("DELETE", "/api/settings/clawbot/paired/abc")).status).toBe(400);
  });
});

/** A memory row as PPMBot wrote them; nothing in PPM writes that table any more. */
function insertMemory(project: string, content: string, category: string): number {
  const result = getDb().query("INSERT INTO clawbot_memories (project, content, category) VALUES (?, ?, ?)").run(project, content, category);
  return Number(result.lastInsertRowid);
}

describe("GET /api/assistant/telegram/legacy-memories", () => {
  it("lists PPMBot's live memories newest first, with times in milliseconds", async () => {
    getDb().query("DELETE FROM clawbot_memories").run();
    const old = insertMemory("_global", "Prefers short answers", "preference");
    const replaced = insertMemory("api", "Deploys on Fridays", "fact");
    const newer = insertMemory("api", "Deploys on Mondays", "fact");
    getDb().query("UPDATE clawbot_memories SET created_at = 1700000000 WHERE id = ?").run(old);
    getDb().query("UPDATE clawbot_memories SET superseded_by = ? WHERE id = ?").run(newer, replaced);
    const res = await call("GET", "/api/assistant/telegram/legacy-memories");
    expect(res.json.data.memories.map((m: { id: number }) => m.id)).toEqual([newer, old]);
    expect(res.json.data.memories[1]).toEqual({ id: old, project: "_global", category: "preference", content: "Prefers short answers", createdAt: 1_700_000_000_000 });
  });

  it("is an empty list when PPMBot remembered nothing", async () => {
    getDb().query("DELETE FROM clawbot_memories").run();
    expect((await call("GET", "/api/assistant/telegram/legacy-memories")).json.data).toEqual({ memories: [] });
  });
});
