import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createCommandExecuteHandler, type CommandExecuteService } from "../../../src/server/routes/extension-command-execute-route.ts";
import { executeExtensionCommand, type CommandExecutorDeps, type ExecuteOutcome } from "../../../src/services/extension-command-executor.ts";
import {
  EXECUTE_DEFAULT_TIMEOUT_MS, EXECUTE_MAX_BODY_BYTES, EXECUTE_MAX_TIMEOUT_MS, EXECUTE_MIN_TIMEOUT_MS,
  EXIT_CODE_FOR, HTTP_STATUS_FOR, clampExecuteTimeout,
} from "../../../src/shared/extension-command-execute.ts";
import type { ExtensionManifest } from "../../../src/types/extension.ts";

/** A route mounted the way extensions.ts mounts it, over a service that records its calls. */
function mount(answer: (command: string, args: unknown[], timeoutMs: number) => ExecuteOutcome) {
  const calls: Array<{ command: string; args: unknown[]; timeoutMs: number }> = [];
  const service: CommandExecuteService = {
    async executeCommand(command, args, timeoutMs) {
      calls.push({ command, args, timeoutMs });
      return answer(command, args, timeoutMs);
    },
  };
  const app = new Hono();
  app.post("/commands/execute", createCommandExecuteHandler(service));
  const post = (body: string, headers: Record<string, string> = {}) =>
    app.request("/commands/execute", { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });
  return { calls, post };
}

const okOutcome = (result: unknown): ExecuteOutcome => ({ kind: "ok", extensionId: "ppm-midday", result, durationMs: 7 });

describe("POST /commands/execute", () => {
  it("runs the command and answers its result in the envelope", async () => {
    const { calls, post } = mount(() => okOutcome({ items: 3 }));
    const res = await post(JSON.stringify({ command: "midday.cli", args: [["list", "--json"]] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { command: "midday.cli", extensionId: "ppm-midday", result: { items: 3 }, durationMs: 7 },
    });
    expect(calls).toEqual([{ command: "midday.cli", args: [["list", "--json"]], timeoutMs: EXECUTE_DEFAULT_TIMEOUT_MS }]);
  });

  it("answers null for a handler that returned undefined", async () => {
    const { post } = mount(() => okOutcome(undefined));
    const res = await post(JSON.stringify({ command: "a.b" }));
    expect((await res.json()).data.result).toBeNull();
  });

  it("defaults args to an empty array and clamps the timeout", async () => {
    const { calls, post } = mount(() => okOutcome(1));
    await post(JSON.stringify({ command: "a.b", timeoutMs: 5 }));
    await post(JSON.stringify({ command: "a.b", timeoutMs: 99_999_999 }));
    expect(calls.map((c) => c.timeoutMs)).toEqual([EXECUTE_MIN_TIMEOUT_MS, EXECUTE_MAX_TIMEOUT_MS]);
    expect(calls[0]!.args).toEqual([]);
  });

  it("refuses any request carrying an Origin with 403 ORIGIN_REFUSED, before running anything", async () => {
    const { calls, post } = mount(() => okOutcome(1));
    const res = await post(JSON.stringify({ command: "a.b" }), { Origin: "http://evil.test" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: "ORIGIN_REFUSED" });
    expect(calls).toHaveLength(0);
  });

  for (const [label, body] of [
    ["a body that is not JSON", "{nope"],
    ["a missing command", JSON.stringify({ args: [] })],
    ["an empty command", JSON.stringify({ command: "" })],
    ["a command over 200 characters", JSON.stringify({ command: "x".repeat(201) })],
    ["args that are not an array", JSON.stringify({ command: "a.b", args: { a: 1 } })],
    ["a JSON array body", JSON.stringify([1, 2])],
  ] as const) {
    it(`answers 400 BAD_REQUEST for ${label}`, async () => {
      const { calls, post } = mount(() => okOutcome(1));
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, code: "BAD_REQUEST" });
      expect(calls).toHaveLength(0);
    });
  }

  it("answers 400 for a body over 256 KB, whatever Content-Length claims", async () => {
    const { post } = mount(() => okOutcome(1));
    const big = JSON.stringify({ command: "a.b", args: ["x".repeat(EXECUTE_MAX_BODY_BYTES)] });
    const res = await post(big);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("BAD_REQUEST");
  });

  for (const code of ["NOT_FOUND", "NOT_ACTIVE", "HOST_NOT_READY", "COMMAND_FAILED", "TIMEOUT"] as const) {
    it(`maps ${code} to HTTP ${HTTP_STATUS_FOR[code]} with the message`, async () => {
      const { post } = mount(() => ({ kind: "error", code, message: `why ${code}`, durationMs: 1 }));
      const res = await post(JSON.stringify({ command: "a.b" }));
      expect(res.status).toBe(HTTP_STATUS_FOR[code]);
      expect(await res.json()).toEqual({ ok: false, error: `why ${code}`, code });
    });
  }
});

describe("execute codes", () => {
  it("map to the contract's HTTP statuses and CLI exit codes", () => {
    expect(HTTP_STATUS_FOR).toEqual({
      BAD_REQUEST: 400, ORIGIN_REFUSED: 403, NOT_ACTIVE: 403, NOT_FOUND: 404,
      HOST_NOT_READY: 503, COMMAND_FAILED: 500, TIMEOUT: 504,
    });
    expect(EXIT_CODE_FOR).toEqual({
      BAD_REQUEST: 2, ORIGIN_REFUSED: 2, NOT_ACTIVE: 2, NOT_FOUND: 2,
      HOST_NOT_READY: 2, COMMAND_FAILED: 3, TIMEOUT: 3,
    });
  });

  it("clampExecuteTimeout uses the default for a non-integer", () => {
    expect(clampExecuteTimeout(undefined)).toBe(EXECUTE_DEFAULT_TIMEOUT_MS);
    expect(clampExecuteTimeout("5000")).toBe(EXECUTE_DEFAULT_TIMEOUT_MS);
    expect(clampExecuteTimeout(1500.5)).toBe(EXECUTE_DEFAULT_TIMEOUT_MS);
    expect(clampExecuteTimeout(2_000)).toBe(2_000);
  });
});

describe("executeExtensionCommand", () => {
  const manifest = (commands: string[]): ExtensionManifest =>
    ({ id: "x", version: "1.0.0", main: "i.js", contributes: { commands: commands.map((command) => ({ command, title: command })) } });

  function deps(over: Partial<CommandExecutorDeps> = {}): CommandExecutorDeps {
    return {
      isHostReady: () => true,
      activeCommands: () => [{ command: "midday.cli", extId: "ppm-midday" }],
      installedManifests: () => [
        { id: "ppm-midday", enabled: true, manifest: manifest(["midday.cli"]) },
        { id: "ppm-off", enabled: false, manifest: manifest(["off.cmd"]) },
        { id: "ppm-broken", enabled: true, manifest: manifest(["broken.cmd"]) },
        { id: "ppm-starting", enabled: true, manifest: manifest(["starting.cmd"]) },
      ],
      activationError: (id) => (id === "ppm-broken" ? "Entry point not found" : undefined),
      send: async () => ({ ok: true, result: "done" }),
      ...over,
    };
  }

  it("HOST_NOT_READY before the worker said it is ready, without sending", async () => {
    let sent = false;
    const out = await executeExtensionCommand(deps({ isHostReady: () => false, send: async () => { sent = true; return { ok: true }; } }), "midday.cli", [], 1000);
    expect(out).toMatchObject({ kind: "error", code: "HOST_NOT_READY" });
    expect(sent).toBe(false);
  });

  it("NOT_ACTIVE when only a disabled or failed extension declares it", async () => {
    expect(await executeExtensionCommand(deps(), "off.cmd", [], 1000))
      .toMatchObject({ kind: "error", code: "NOT_ACTIVE", extensionId: "ppm-off" });
    const broken = await executeExtensionCommand(deps(), "broken.cmd", [], 1000);
    expect(broken).toMatchObject({ kind: "error", code: "NOT_ACTIVE", extensionId: "ppm-broken" });
    expect((broken as { message: string }).message).toContain("Entry point not found");
  });

  it("HOST_NOT_READY for an enabled extension whose activation has not run yet (PPM starting)", async () => {
    expect(await executeExtensionCommand(deps(), "starting.cmd", [], 1000))
      .toMatchObject({ kind: "error", code: "HOST_NOT_READY", extensionId: "ppm-starting" });
  });

  it("NOT_FOUND when nothing declares it", async () => {
    expect(await executeExtensionCommand(deps(), "nope", [], 1000)).toMatchObject({ kind: "error", code: "NOT_FOUND" });
  });

  it("NOT_FOUND when declared but the worker has no handler", async () => {
    const out = await executeExtensionCommand(deps({ send: async () => ({ ok: false, error: "Command not found: midday.cli", code: "NOT_FOUND" }) }), "midday.cli", [], 1000);
    expect(out).toMatchObject({ kind: "error", code: "NOT_FOUND", extensionId: "ppm-midday" });
  });

  it("COMMAND_FAILED with the thrown message", async () => {
    const out = await executeExtensionCommand(deps({ send: async () => ({ ok: false, error: "boom" }) }), "midday.cli", [], 1000);
    expect(out).toMatchObject({ kind: "error", code: "COMMAND_FAILED", message: "boom" });
  });

  it("TIMEOUT when the RPC channel gives up", async () => {
    const out = await executeExtensionCommand(deps({ send: async () => { throw new Error("RPC timeout: ext:command:execute (1000ms)"); } }), "midday.cli", [], 1000);
    expect(out).toMatchObject({ kind: "error", code: "TIMEOUT" });
  });

  it("passes the command, its arguments and the timeout through, and reports the duration", async () => {
    let seen: unknown;
    let t = 100;
    const out = await executeExtensionCommand(deps({
      send: async (command, args, ms) => { seen = { command, args, ms }; t += 40; return { ok: true }; },
      now: () => t,
    }), "midday.cli", [["list"]], 5000);
    expect(seen).toEqual({ command: "midday.cli", args: [["list"]], ms: 5000 });
    expect(out).toEqual({ kind: "ok", extensionId: "ppm-midday", result: null, durationMs: 40 });
  });
});
