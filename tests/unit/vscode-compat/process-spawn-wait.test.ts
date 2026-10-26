import { describe, it, expect } from "bun:test";
import { ProcessService, MAX_SPAWN_TIMEOUT_MS } from "../../../packages/vscode-compat/src/process.ts";
import { MAX_SPAWN_TIMEOUT_MS as MAIN_THREAD_CAP } from "../../../src/services/extension-rpc-handlers.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

/** Records how long the worker side would wait for `process:spawn`. */
function recordingRpc(): { rpc: RpcClient; waits: number[] } {
  const waits: number[] = [];
  const rpc: RpcClient = {
    request: async () => { throw new Error("spawn must not use the default timeout"); },
    requestWithTimeout: async <T,>(_method: string, timeoutMs: number) => {
      waits.push(timeoutMs);
      return { stdout: "", stderr: "", exitCode: 0 } as T;
    },
    notify: () => {},
  };
  return { rpc, waits };
}

/** Node's and Bun's timers hold at most a signed 32-bit number of milliseconds. */
const LARGEST_TIMER_MS = 2 ** 31 - 1;

describe("process.spawn wait on the worker side", () => {
  it("caps the wait where the main thread caps the process, plus the reply margin", async () => {
    const { rpc, waits } = recordingRpc();
    await new ProcessService(rpc).spawn("git", ["log"], "/repo", { timeout: 3e9 });
    expect(waits).toEqual([15 * 60_000 + 30_000]);
    expect(waits[0]!).toBeLessThanOrEqual(LARGEST_TIMER_MS);
  });

  it("keeps the requested timeout when it is under the cap", async () => {
    const { rpc, waits } = recordingRpc();
    await new ProcessService(rpc).spawn("git", ["log"], "/repo", { timeout: 120_000 });
    expect(waits).toEqual([150_000]);
  });

  it("uses the 30 s default for a missing or nonsense timeout", async () => {
    const { rpc, waits } = recordingRpc();
    const service = new ProcessService(rpc);
    await service.spawn("git", [], "/repo");
    await service.spawn("git", [], "/repo", { timeout: -1 });
    await service.spawn("git", [], "/repo", { timeout: Number.POSITIVE_INFINITY });
    expect(waits).toEqual([60_000, 60_000, 60_000]);
  });

  it("uses the same cap as the main thread", () => {
    expect(MAX_SPAWN_TIMEOUT_MS).toBe(MAIN_THREAD_CAP);
  });

  it("does not answer before the main thread could have finished, for a huge timeout", async () => {
    let gaveUpAfter = -1;
    const rpc: RpcClient = {
      request: async () => undefined as never,
      // Mirrors the worker's RPC channel: a real timer of the requested length.
      requestWithTimeout: <T,>(_method: string, timeoutMs: number) => new Promise<T>((_, reject) => {
        const started = Date.now();
        const timer = setTimeout(() => { gaveUpAfter = Date.now() - started; reject(new Error("RPC timeout")); }, timeoutMs);
        setTimeout(() => { clearTimeout(timer); reject(new Error("still waiting")); }, 200);
      }),
      notify: () => {},
    };
    await expect(new ProcessService(rpc).spawn("git", [], "/repo", { timeout: 3e9 })).rejects.toThrow("still waiting");
    expect(gaveUpAfter).toBe(-1);
  });
});
