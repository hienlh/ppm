/**
 * All extensions share one host worker, so one extension's forgotten `.catch()` or throw from a
 * timer must not end it. The check runs the real host worker in a child `bun` process
 * (`tests/fixtures/extension-host-survival.ts`): under `bun test` the runner itself ends a worker
 * that reports an unhandled error, whatever handlers the worker installed, so the guard is only
 * observable the way it runs in production.
 */
import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";

describe("extension host worker", () => {
  it("keeps serving after an extension leaves a rejection and a throw unhandled", async () => {
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../fixtures/extension-host-survival.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const last = stdout.trim().split("\n").pop() ?? "";
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(last);
    } catch {
      throw new Error(`no result from the fixture.\nstdout: ${stdout}\nstderr: ${stderr}`);
    }
    expect(result).toEqual({
      activated: { ok: true },
      leak: { ok: true, result: "leaked" },
      echo: { ok: true, result: { echo: "still here" } },
      closed: false,
      workerErrors: 0,
      guardLogged: true,
    });
  }, 20_000);
});
