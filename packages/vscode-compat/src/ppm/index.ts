import type { RpcClient } from "../types.ts";

/**
 * `api.ppm` — what PPM offers an extension beyond the VSCode API. Each area is a file of its
 * own in this folder, added here; the main thread answers its calls in
 * `src/services/extension-api/`.
 */
/** Empty until the first area is added. */
export interface PpmNamespace {}

export function createPpmNamespace(_rpc: RpcClient, _extensionId: string): PpmNamespace {
  return {};
}
