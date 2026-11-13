import type { RpcClient } from "./types.ts";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The main thread's timeout when none is given; keep in step with `process:spawn` there. */
const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
/** The main thread kills a process after at most this long, whatever it is asked for. Mirrors
 *  `MAX_SPAWN_TIMEOUT_MS` in `src/services/extension-rpc-handlers.ts`, which this package
 *  cannot import. */
export const MAX_SPAWN_TIMEOUT_MS = 15 * 60_000;
const SPAWN_REPLY_MARGIN_MS = 30_000;

export interface SpawnOptions {
  /** Kill the process after this long, in ms. Default 30 s; the main thread caps it at 15 min. */
  timeout?: number;
  env?: Record<string, string>;
}

/** Process namespace — spawn subprocesses via RPC to main process */
export class ProcessService {
  private rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.rpc = rpc;
  }

  /**
   * The wait outlasts the process's own timeout by 30 s, so the main thread's answer (the
   * output, or the kill at its timeout) always arrives before this side gives up. The RPC
   * default of 10 s would cut off any command allowed to run longer than that.
   *
   * The timeout is capped where the main thread caps it. Uncapped, a huge value ("never time
   * out") overflows the timer, which then fires at once: the call failed with an RPC timeout
   * while the process went on running for up to 15 minutes with nobody to read its output.
   */
  async spawn(cmd: string, args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    const requested = options?.timeout;
    const timeout = typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_SPAWN_TIMEOUT_MS)
      : DEFAULT_SPAWN_TIMEOUT_MS;
    return this.rpc.requestWithTimeout<SpawnResult>("process:spawn", timeout + SPAWN_REPLY_MARGIN_MS, cmd, args, cwd, options);
  }
}
