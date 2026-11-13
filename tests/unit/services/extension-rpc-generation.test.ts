import { describe, it, expect, afterEach } from "bun:test";
import { openWorkerChannel, type ExtensionWorkerPort } from "../../../src/services/extension-worker-channel.ts";
import { RpcChannel, type RpcLog } from "../../../src/services/extension-rpc.ts";
import { registerVscodeCompatHandlers, spawnTimeoutMs, MAX_SPAWN_TIMEOUT_MS } from "../../../src/services/extension-rpc-handlers.ts";
import { extensionApiDeps } from "../../../src/services/extension-api/index.ts";
import { ExtensionCallRegistry, extensionCallRegistry } from "../../../src/services/extension-api/extension-call-registry.ts";
import { extensionService } from "../../../src/services/extension.service.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

/** A worker as the channel sees it: what the main thread posted, and a way to send back. */
class FakeWorker implements ExtensionWorkerPort {
  posted: RpcMessage[] = [];
  throwOnPost = false;
  private listeners: ((event: MessageEvent<RpcMessage>) => void)[] = [];
  postMessage(msg: RpcMessage): void {
    if (this.throwOnPost) throw new Error("DataCloneError: could not be cloned");
    this.posted.push(msg);
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<RpcMessage>) => void): void {
    this.listeners.push(listener);
  }
  /** The worker thread sends `msg` to the main thread. */
  emit(msg: RpcMessage): void {
    for (const listener of this.listeners) listener({ data: msg } as MessageEvent<RpcMessage>);
  }
}

function recordingLog(): RpcLog & { lines: string[] } {
  const lines: string[] = [];
  const push = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, debug: push, warn: push, error: push };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("main-side channel across a worker rebuild", () => {
  it("never lets the old worker's late reply settle the new worker's request with the same id", async () => {
    const log = recordingLog();
    const old = new FakeWorker();
    const fresh = new FakeWorker();
    let current: FakeWorker = old;

    const oldRpc = openWorkerChannel(old, () => current === old, log);
    const oldCall = oldRpc.sendRequest("ext:ping").catch((e: Error) => e.message);
    // Rebuild: the old worker is replaced and its channel disposed.
    current = fresh;
    oldRpc.dispose();
    expect(await oldCall).toBe("RPC channel disposed");

    const newRpc = openWorkerChannel(fresh, () => current === fresh, log);
    let settled: unknown = "pending";
    const newCall = newRpc.sendRequest<string>("ext:ping").then((v) => { settled = v; });
    expect((old.posted[0] as { id: number }).id).toBe((fresh.posted[0] as { id: number }).id);

    old.emit({ type: "response", id: 1, result: "stale" });
    await tick();
    expect(settled).toBe("pending");

    fresh.emit({ type: "response", id: 1, result: "fresh" });
    await newCall;
    expect(settled).toBe("fresh");
    newRpc.dispose();
  });

  it("drops the answer of a handler that finishes after its worker was replaced", async () => {
    const log = recordingLog();
    const old = new FakeWorker();
    const fresh = new FakeWorker();
    let current: FakeWorker = old;
    const rpc = openWorkerChannel(old, () => current === old, log);
    let release!: () => void;
    rpc.onRequest("slow", () => new Promise<string>((r) => { release = () => r("late"); }));

    old.emit({ type: "request", id: 7, method: "slow", params: [] });
    await tick();
    current = fresh;
    release();
    await tick();

    expect(old.posted).toEqual([]);
    expect(fresh.posted).toEqual([]);
    expect(log.lines.some((l) => l.includes("dropped response #7"))).toBe(true);
  });

  it("does not answer at all once the channel is disposed", async () => {
    const sent: RpcMessage[] = [];
    const rpc = new RpcChannel((msg) => sent.push(msg), recordingLog());
    let release!: () => void;
    rpc.onRequest("slow", () => new Promise<void>((r) => { release = r; }));
    const handled = rpc.handleMessage({ type: "request", id: 1, method: "slow", params: [] });
    rpc.dispose();
    release();
    await handled;
    await rpc.handleMessage({ type: "request", id: 2, method: "slow", params: [] });
    expect(sent).toEqual([]);
    await expect(rpc.sendRequest("x")).rejects.toThrow("disposed");
  });

  it("catches a failing post instead of leaving an unhandled rejection", async () => {
    const log = recordingLog();
    const worker = new FakeWorker();
    const rpc = openWorkerChannel(worker, () => true, log);
    rpc.onRequest("answer", () => "ok");
    worker.throwOnPost = true;
    worker.emit({ type: "request", id: 1, method: "answer", params: [] });
    await tick();
    expect(log.lines.some((l) => l.includes("extension host message failed") && l.includes("DataCloneError"))).toBe(true);
  });
});

describe("process:spawn lifetime", () => {
  async function spawnRequest(rpc: RpcChannel, sent: RpcMessage[], args: string[], options: object): Promise<RpcResponse> {
    await rpc.handleMessage({ type: "request", id: 1, method: "process:spawn", params: ["bun", args, process.cwd(), options] });
    return sent.find((m) => m.type === "response") as RpcResponse;
  }

  it("kills a running spawn when its worker generation ends", async () => {
    const registry = new ExtensionCallRegistry();
    const sent: RpcMessage[] = [];
    const rpc = new RpcChannel((msg) => sent.push(msg), recordingLog());
    registerVscodeCompatHandlers(rpc, extensionApiDeps(5, registry));

    const started = Date.now();
    const pending = spawnRequest(rpc, sent, ["-e", "await Bun.sleep(20000)"], { timeout: 60_000 });
    while (registry.count(5) === 0) {
      if (Date.now() - started > 10_000) throw new Error("spawn never registered");
      await tick();
    }
    expect(registry.endGeneration(5)).toBe(1);
    const response = await pending;

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(response.error).toBeUndefined();
    expect((response.result as { exitCode: number }).exitCode).not.toBe(0);
    expect(registry.count(5)).toBe(0);
  }, 20_000);

  it("refuses to start a spawn for a generation that has already ended", async () => {
    const registry = new ExtensionCallRegistry();
    registry.endGeneration(6);
    const sent: RpcMessage[] = [];
    const rpc = new RpcChannel((msg) => sent.push(msg), recordingLog());
    registerVscodeCompatHandlers(rpc, extensionApiDeps(6, registry));
    const response = await spawnRequest(rpc, sent, ["-e", "console.log(1)"], {});
    expect(response.error).toContain("rebuilt");
  });

  it("caps the timeout at 15 minutes and defaults a missing or nonsense one", () => {
    expect(MAX_SPAWN_TIMEOUT_MS).toBe(15 * 60_000);
    expect(spawnTimeoutMs(undefined)).toBe(30_000);
    expect(spawnTimeoutMs(Number.NaN)).toBe(30_000);
    expect(spawnTimeoutMs(-5)).toBe(30_000);
    expect(spawnTimeoutMs("600000")).toBe(30_000);
    expect(spawnTimeoutMs(120_000)).toBe(120_000);
    expect(spawnTimeoutMs(60 * 60_000)).toBe(MAX_SPAWN_TIMEOUT_MS);
  });
});

/** The service's private lifecycle, reached the way extension-worker-recovery.test.ts does. */
interface WorkerLifecycle {
  ensureWorker(): { worker: Worker };
  terminateWorker(): Promise<void>;
  generation: number;
}

describe("extension service worker generations", () => {
  const svc = extensionService as unknown as WorkerLifecycle;
  afterEach(async () => { await svc.terminateWorker(); });

  it("aborts the calls of the old worker when it is torn down, before a new one starts", async () => {
    svc.ensureWorker();
    const first = svc.generation;
    const call = extensionCallRegistry.begin(first);

    await svc.terminateWorker();
    expect(call.signal.aborted).toBe(true);

    svc.ensureWorker();
    expect(svc.generation).toBe(first + 1);
    const next = extensionCallRegistry.begin(svc.generation);
    expect(next.signal.aborted).toBe(false);
    next.end();
  });
});
