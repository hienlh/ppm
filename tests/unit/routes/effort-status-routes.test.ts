/**
 * The two places the browser asks what overrides the effort before any CLI has answered: the
 * new-chat composer (per project) and Settings (machine-wide, so no project's files count).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import type { EffortStatus } from "../../../src/shared/effort-status.ts";

const STATUS: EffortStatus = { env: { value: "max", source: "userSettings", file: "~/.claude/settings.json" } };

const chat = new Hono<any>();
chat.use("*", async (c, next) => {
  c.set("projectName", "proj");
  c.set("projectPath", "/tmp/proj");
  await next();
});
chat.route("/", chatRoutes);
const settings = new Hono().route("/settings", settingsRoutes);

const restore: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of restore.splice(0)) spy.mockRestore(); });

/** Stand in for a provider whose effort settings can override the pick, recording what it was asked. */
function overridable() {
  const asked: Array<[string | undefined, string | undefined]> = [];
  const provider = { id: "claude", estimateEffortStatus: (path?: string, model?: string) => { asked.push([path, model]); return STATUS; } };
  restore.push(spyOn(providerRegistry, "get").mockImplementation(((id: string) => (id === "claude" ? provider : id === "codex" ? { id } : undefined)) as never));
  return asked;
}

describe("GET /chat/providers/:id/effort-status", () => {
  it("answers from the project's files, for the model the new chat will use", async () => {
    const asked = overridable();
    const res = await chat.request("/providers/claude/effort-status?model=claude-opus-5-5");
    expect(await res.json()).toEqual({ ok: true, data: { status: STATUS } });
    expect(asked).toEqual([["/tmp/proj", "claude-opus-5-5"]]);
  });

  it("answers null for a provider nothing overrides, and 404 for one that does not exist", async () => {
    overridable();
    expect(await (await chat.request("/providers/codex/effort-status")).json()).toEqual({ ok: true, data: { status: null } });
    expect((await chat.request("/providers/nope/effort-status")).status).toBe(404);
  });
});

describe("GET /settings/ai/providers/:id/effort-status", () => {
  it("answers for every project at once, so no project's files are read", async () => {
    const asked = overridable();
    const res = await settings.request("/settings/ai/providers/claude/effort-status?model=claude-opus-5-5");
    expect(await res.json()).toEqual({ ok: true, data: { status: STATUS } });
    expect(asked).toEqual([[undefined, "claude-opus-5-5"]]);
    expect(await (await settings.request("/settings/ai/providers/codex/effort-status")).json()).toEqual({ ok: true, data: { status: null } });
    expect((await settings.request("/settings/ai/providers/nope/effort-status")).status).toBe(404);
  });
});
