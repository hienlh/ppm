/**
 * Runs the real extension host worker under plain `bun`, has one extension leave a rejection and
 * a timer throw unhandled, then asks the host to run another command. Prints one JSON line.
 *
 * It exists as a separate process because `bun test` reports a worker's unhandled errors itself
 * and ends the worker whatever handlers the worker installed, so the host's guard can only be
 * observed outside the test runner, the way it runs in production. Touches no PPM directory or
 * database: the worker is driven directly over its RPC channel.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { RpcChannel } from "../../src/services/extension-rpc.ts";
import type { RpcMessage } from "../../src/types/extension.ts";

const dir = mkdtempSync(resolve(tmpdir(), "ppm-host-survival-"));
const entry = resolve(dir, "index.js");
writeFileSync(entry, `
  exports.activate = function (context, vscode) {
    context.subscriptions.push(
      vscode.commands.registerCommand("probe.leak", () => {
        Promise.reject(new Error("a forgotten catch"));
        setTimeout(() => { throw new Error("a throw nobody catches"); }, 0);
        return "leaked";
      }),
      vscode.commands.registerCommand("probe.echo", (value) => ({ echo: value })),
    );
  };
`);

const worker = new Worker(new URL("../../src/services/extension-host-worker.ts", import.meta.url).href, { type: "module" });
let closed = false;
let workerErrors = 0;
worker.addEventListener("close", () => { closed = true; });
worker.addEventListener("error", () => { workerErrors++; });

const quiet = { debug() {}, warn() {}, error() {} };
const rpc = new RpcChannel((msg) => worker.postMessage(msg), quiet);
const logs: string[] = [];
rpc.onEvent("log", (data) => { logs.push(String((data as { text?: unknown } | undefined)?.text ?? "")); });
const ready = new Promise<void>((done) => rpc.onEvent("worker:ready", () => done()));
worker.addEventListener("message", (event: MessageEvent<RpcMessage>) => { void rpc.handleMessage(event.data); });

let result: Record<string, unknown>;
try {
  await ready;
  const activated = await rpc.sendRequest("ext:activate", "probe-ext", entry, dir, {});
  const leak = await rpc.sendRequest("ext:command:execute", "probe.leak");
  await Bun.sleep(300);
  let echo: unknown;
  try {
    echo = await rpc.sendRequestWithTimeout("ext:command:execute", 3_000, ["probe.echo", "still here"]);
  } catch (e) {
    echo = { failed: e instanceof Error ? e.message : String(e) };
  }
  result = {
    activated, leak, echo, closed, workerErrors,
    guardLogged: logs.some((line) => line.includes("swallowed to keep the host alive")),
  };
} catch (e) {
  result = { setupFailed: e instanceof Error ? e.message : String(e), closed, workerErrors };
}

console.log(JSON.stringify(result));
worker.terminate();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
