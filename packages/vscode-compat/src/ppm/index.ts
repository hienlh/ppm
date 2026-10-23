import type { RpcClient } from "../types.ts";
import { createPpmChat, type PpmChat } from "./ppm-chat.ts";

/**
 * `api.ppm` — what PPM offers an extension beyond the VSCode API. Each area is a file of its
 * own in this folder, added here; the main thread answers its calls in
 * `src/services/extension-api/`.
 */
export interface PpmNamespace {
  /** Chat sessions driven with nobody watching. */
  chat: PpmChat;
}

export function createPpmNamespace(rpc: RpcClient, extensionId: string): PpmNamespace {
  return { chat: createPpmChat(rpc, extensionId) };
}
