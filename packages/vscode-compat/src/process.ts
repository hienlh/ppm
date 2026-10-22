import type { RpcClient } from "./types.ts";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The main thread's timeout when none is given; keep in step with `process:spawn` there. */
const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
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
   */
  async spawn(cmd: string, args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    const requested = options?.timeout;
    const timeout = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SPAWN_TIMEOUT_MS;
    return this.rpc.requestWithTimeout<SpawnResult>("process:spawn", timeout + SPAWN_REPLY_MARGIN_MS, cmd, args, cwd, options);
  }
}
