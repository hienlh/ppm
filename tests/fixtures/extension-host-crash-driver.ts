/**
 * Starts the real extension host worker, activates the extension at argv[2] in it, lets its
 * escapes fire, then asks the host whether it is still there. Prints one JSON line.
 *
 * Run with `bun`, never under `bun test`: the test runner reports a worker's uncaught
 * exception itself and ends the worker whatever handlers the worker installed, so a worker
 * that survives in the server dies in a test. Measured on Bun 1.3.13, which is why the test
 * that reads this output spawns it as a process.
 */
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openWorkerChannel } from "../../src/services/extension-worker-channel.ts";

const extensionPath = process.argv[2];
if (!extensionPath) throw new Error("usage: bun extension-host-crash-driver.ts <extension dir>");
const extId = process.argv[3] ?? "@probe/throws-after-activate";
const silent = { debug() {}, warn() {}, error() {} };

const worker = new Worker(new URL("../../src/services/extension-host-worker.ts", import.meta.url).href, { type: "module" });
const result = { activated: false, closed: false, closeCode: null as number | null, pong: null as string | null, swallowed: [] as string[] };
worker.addEventListener("close", (event) => {
  result.closed = true;
  result.closeCode = (event as Event & { code?: number }).code ?? null;
});
const rpc = openWorkerChannel(worker, () => true, silent);
rpc.onEvent("log", (data) => {
  const text = (data as { text?: unknown })?.text;
  if (typeof text === "string" && text.includes("swallowed to keep the host alive")) result.swallowed.push(text.slice(0, 120));
});
await new Promise<void>((ready) => rpc.onEvent("worker:ready", () => ready()));

const dataDir = mkdtempSync(resolve(tmpdir(), "ppm-ext-crash-"));
const activation = await rpc.sendRequest<{ ok: boolean; error?: string }>(
  "ext:activate", extId, resolve(extensionPath, "index.js"), extensionPath, { global: {}, workspace: {} }, undefined, undefined, dataDir,
);
result.activated = activation.ok;
// Both escapes in the extension fire within 20 ms of activation.
await new Promise((r) => setTimeout(r, 300));
try {
  result.pong = result.closed ? null : await rpc.sendRequest<string>("ext:ping");
} catch {
  result.pong = null;
}
console.log(JSON.stringify(result));
worker.terminate();
process.exit(0);
