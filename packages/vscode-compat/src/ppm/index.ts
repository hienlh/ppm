import type { RpcClient } from "../types.ts";
import { createPpmChat, type PpmChat } from "./ppm-chat.ts";
import { createPpmAi, type PpmAi } from "./ppm-ai.ts";
import { createPpmUsage, createPpmPresence, type PpmUsage, type PpmPresence } from "./ppm-usage.ts";
import { createPpmMcp, type PpmMcp } from "./ppm-mcp.ts";

/**
 * `api.ppm` — what PPM offers an extension beyond the VSCode API. Each area is a file of its
 * own in this folder, added here; the main thread answers its calls in
 * `src/services/extension-api/`.
 */
export interface PpmNamespace {
  /** Chat sessions driven with nobody watching. */
  chat: PpmChat;
  /** One-shot completions from Claude or Codex, outside any chat. */
  ai: PpmAi;
  /** Quota per provider account — read-only, never forces a refresh. */
  usage: PpmUsage;
  /** Whether a person has touched any PPM tab recently. */
  presence: PpmPresence;
  /** Tools served to the chats the extension bound. */
  mcp: PpmMcp;
}

/** `mcp` is passed in when the caller also needs its host half (the extension host does). */
export function createPpmNamespace(rpc: RpcClient, extensionId: string, mcp: PpmMcp = createPpmMcp(rpc, extensionId).api): PpmNamespace {
  return {
    chat: createPpmChat(rpc, extensionId),
    ai: createPpmAi(rpc, extensionId),
    usage: createPpmUsage(rpc),
    presence: createPpmPresence(rpc),
    mcp,
  };
}
