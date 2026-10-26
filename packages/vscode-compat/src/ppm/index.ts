import type { RpcClient } from "../types.ts";
import { createPpmNotify, type PpmNotify } from "./ppm-notify.ts";

/**
 * `api.ppm`: what PPM offers an extension beyond the VSCode API. Each area is a file of its own
 * in this folder, added here; the main thread answers its calls in `src/services/extension-api/`.
 * Detect it with `typeof api.ppm?.notify === "function"`, since an older PPM has no `ppm`.
 */
export interface PpmNamespace {
  /** Tell the person through PPM's own fan-out (push, Telegram, ntfy). */
  notify: PpmNotify;
}

export function createPpmNamespace(rpc: RpcClient, extensionId: string): PpmNamespace {
  return {
    notify: createPpmNotify(rpc, extensionId),
  };
}
