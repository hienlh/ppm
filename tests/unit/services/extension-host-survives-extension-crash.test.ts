import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Every extension shares one host thread, so an exception one of them lets escape — from a
 * timer, from a promise nobody awaited — must be logged there and not end the thread.
 *
 * Driven in a child `bun` process (`tests/fixtures/extension-host-crash-driver.ts`) rather
 * than in this one: under `bun test` the runner reports a worker's uncaught exception itself
 * and ends the worker whatever the worker's own handlers do, so the real behaviour — the one
 * the server sees — only shows under `bun run`. Measured on Bun 1.3.13.
 */
const DRIVER = resolve(import.meta.dir, "../../fixtures/extension-host-crash-driver.ts");

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** An extension that activates fine and then lets a throw and a rejection escape. */
function writeCrashingExtension(): string {
  scratch = mkdtempSync(resolve(tmpdir(), "ppm-crashing-ext-"));
  const dir = resolve(scratch, "throws-after-activate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "index.js"), [
    "export function activate() {",
    "  setTimeout(() => { throw new Error('boom from a timer'); }, 10);",
    "  setTimeout(() => { Promise.reject(new Error('boom from a promise')); }, 20);",
    "}",
    "",
  ].join("\n"));
  return dir;
}

describe("extension host with a crashing extension", () => {
  it("keeps serving after an extension throws from a timer and rejects a promise nobody awaited", async () => {
    const extensionDir = writeCrashingExtension();
    const proc = Bun.spawn(["bun", DRIVER, extensionDir], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (!line) throw new Error(`driver printed no result\nstdout: ${stdout}\nstderr: ${stderr}`);
    const result = JSON.parse(line) as { activated: boolean; closed: boolean; closeCode: number | null; pong: string | null; swallowed: string[] };

    expect(result.activated).toBe(true);
    // The host is still there and still answers, and it said what it swallowed — both escapes.
    expect({ closed: result.closed, pong: result.pong }).toEqual({ closed: false, pong: "pong" });
    expect(result.swallowed.some((t) => t.includes("uncaught error"))).toBe(true);
    expect(result.swallowed.some((t) => t.includes("unhandled rejection"))).toBe(true);
  }, 30_000);
});
