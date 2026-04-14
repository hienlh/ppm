import type { RpcClient } from "./types.ts";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnOptions {
  timeout?: number;
  env?: Record<string, string>;
}

/** Process namespace — spawn subprocesses via RPC to main process */
export class ProcessService {
  private rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.rpc = rpc;
  }

  async spawn(cmd: string, args: string[], cwd: string, options?: SpawnOptions): Promise<SpawnResult> {
    return this.rpc.request<SpawnResult>("process:spawn", cmd, args, cwd, options);
  }
}
