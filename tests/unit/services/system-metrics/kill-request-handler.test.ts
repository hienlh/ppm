import { describe, test, expect } from "bun:test";
import { handleKillRequest, parseKillRequest, type KillHandlerDeps } from "../../../../src/services/system-metrics/kill-request-handler.ts";
import type { ProcessCollector } from "../../../../src/services/system-metrics/process-collector-types.ts";
import { raw } from "./fixtures/process-fixtures.ts";

// Server 3100, its parent 3000, a child node 3200, a sibling notepad 4000 and svchost 900.
const ROWS = [
  raw(900, 800, "svchost", { startedAt: 5 }),
  raw(3000, 2000, "bun", { startedAt: 10 }),
  raw(3100, 3000, "bun", { startedAt: 11 }),
  raw(3200, 3100, "node", { startedAt: 12 }),
  raw(4000, 1000, "notepad", { startedAt: 20, command: "notepad.exe --token=SECRET" }),
];

function deps(over: Partial<KillHandlerDeps> = {}) {
  const log: string[] = [];
  const executed: Array<[number, boolean]> = [];
  const collector: ProcessCollector = { collect: async () => ({ rows: ROWS, warnings: [] }), stop: () => {} };
  const d: KillHandlerDeps = {
    platform: "win32",
    collector,
    resolveProtected: () => ({ pids: new Set([3100, 3000]), roots: new Set([3100, 3000]), selfPid: 3100 }),
    execute: async (pid, tree) => { executed.push([pid, tree]); return { pid, tree, method: "taskkill", killed: [pid] }; },
    log: (l) => log.push(l),
    ...over,
  };
  return { d, log, executed };
}

describe("parseKillRequest", () => {
  test("accepts the contract shape and defaults tree to false", () => {
    expect(parseKillRequest({ pid: 5, startedAt: 0 })).toEqual({ pid: 5, startedAt: 0, tree: false });
    expect(parseKillRequest({ pid: 5, startedAt: 123, tree: true })).toEqual({ pid: 5, startedAt: 123, tree: true });
  });

  test("rejects anything else", () => {
    for (const bad of [null, "x", {}, { pid: "5", startedAt: 0 }, { pid: 0, startedAt: 0 }, { pid: 1.5, startedAt: 0 },
      { pid: 5 }, { pid: 5, startedAt: -1 }, { pid: 5, startedAt: NaN }, { pid: 5, startedAt: 0, tree: "yes" }]) {
      expect(parseKillRequest(bad)).toBeNull();
    }
  });
});

describe("handleKillRequest", () => {
  test("400 on a malformed body", async () => {
    const { d, executed } = deps();
    const r = await handleKillRequest({ pid: "x" }, d);
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(executed).toHaveLength(0);
  });

  test("404 when the pid is gone at re-query time", async () => {
    const { d } = deps();
    const r = await handleKillRequest({ pid: 77777, startedAt: 0 }, d);
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("77777");
  });

  test("409 when the live startedAt differs from the client's claim beyond tolerance (pid reuse)", async () => {
    const { d, executed } = deps();
    const r = await handleKillRequest({ pid: 4000, startedAt: 999_999 }, d);
    expect(r.status).toBe(409);
    expect(executed).toHaveLength(0);
  });

  test("a claim within 2 s tolerance, or an unknown (0) claim, passes the identity check", async () => {
    const { d } = deps();
    expect((await handleKillRequest({ pid: 4000, startedAt: 20 + 1500 }, d)).status).toBe(200);
    expect((await handleKillRequest({ pid: 4000, startedAt: 0 }, d)).status).toBe(200);
  });

  test("403 for the server, for an OS-critical name and for an ancestor; reason in the body", async () => {
    const { d, log } = deps();
    expect((await handleKillRequest({ pid: 3100, startedAt: 11 }, d)).status).toBe(403);
    expect((await handleKillRequest({ pid: 900, startedAt: 5 }, d)).body.error).toBe("svchost is an OS-critical process");
    expect((await handleKillRequest({ pid: 3000, startedAt: 10, tree: true }, d)).status).toBe(403);
    expect(log.every((l) => l.includes("refused"))).toBe(true);
  });

  test("the guard runs on the FRESH name, not anything the client sent", async () => {
    const { d } = deps();
    const r = await handleKillRequest({ pid: 900, startedAt: 5, name: "notepad" } as unknown, d);
    expect(r.status).toBe(403);
  });

  test("200 executes with the requested tree flag and logs pid + name + result only — never the command line", async () => {
    const { d, log, executed } = deps();
    const r = await handleKillRequest({ pid: 4000, startedAt: 20, tree: true }, d);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, data: { pid: 4000, tree: true, method: "taskkill", killed: [4000] } });
    expect(executed).toEqual([[4000, true]]);
    expect(log.join("\n")).not.toContain("SECRET");
    expect(log.join("\n")).not.toContain("--token");
    expect(log[0]).toContain("pid=4000 name=notepad tree=true");
  });

  test("PPM's own descendant is killable", async () => {
    const { d } = deps();
    expect((await handleKillRequest({ pid: 3200, startedAt: 12 }, d)).status).toBe(200);
  });

  test("500 when the executor throws, with the message in the body", async () => {
    const { d } = deps({ execute: async () => { throw new Error("taskkill: access denied"); } });
    const r = await handleKillRequest({ pid: 4000, startedAt: 20 }, d);
    expect(r.status).toBe(500);
    expect(r.body.error).toContain("access denied");
  });
});
