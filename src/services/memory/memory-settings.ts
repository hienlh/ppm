/**
 * How the stored `ai.memory` settings resolve: whether memory runs at all, which embedder makes
 * its vectors, and what a browser may see of them. Every server path reads memory settings here.
 */
import type { AIConfig, MemoryEmbeddingSource } from "../../types/config.ts";
import { anyPpmToolOn } from "../../shared/ppm-tools.ts";
import { MEMORY_TOOLS } from "../../shared/memory-tools.ts";
import type { Embedder } from "./embedding/embedder.ts";
import { ApiEmbedder } from "./embedding/api-embedder.ts";
import { LocalEmbedder } from "./embedding/local-embedder.ts";
import { embedInstallDir } from "./memory-paths.ts";

export type MemoryAi = Pick<AIConfig, "share_provider_context" | "tab_tools" | "ppm_tools" | "memory">;

/**
 * Memory rides on the shared provider context, so it is off whenever that is. Otherwise an
 * explicit `enabled` decides; unset, it follows the memory tools (so answering the feature intro
 * turns on the store and the tools together, and no answer changes nothing).
 */
export function memoryEnabled(ai: MemoryAi): boolean {
  if (ai.share_provider_context === false) return false;
  const enabled = ai.memory?.enabled;
  if (typeof enabled === "boolean") return enabled;
  return anyPpmToolOn(ai, MEMORY_TOOLS);
}

let cached: { key: string; embedder: Embedder } | null = null;

/**
 * The embedder the settings name, or null for Off, no settings, or an API source missing its URL
 * or model. The same settings return the same instance (a local host stays warm); changed
 * settings build a new one and close a local host the old one ran.
 */
export function currentEmbedder(ai: MemoryAi): Embedder | null {
  const emb = ai.memory?.embedding;
  let key: string;
  let build: () => Embedder;
  if (emb?.source === "local") {
    const installDir = embedInstallDir();
    key = JSON.stringify(["local", installDir]);
    build = () => new LocalEmbedder({ installDir });
  } else if (emb?.source === "api" && emb.api_url && emb.api_model) {
    const { api_url: url, api_model: model, api_key: apiKey } = emb;
    key = JSON.stringify(["api", url, model, apiKey ?? ""]);
    build = () => new ApiEmbedder({ url, model, apiKey: apiKey || undefined });
  } else {
    return null;
  }
  if (cached?.key === key) return cached.embedder;
  const previous = cached?.embedder;
  if (previous instanceof LocalEmbedder) void previous.close().catch(() => {});
  cached = { key, embedder: build() };
  return cached.embedder;
}

export interface PublicMemorySettings {
  enabled: boolean;
  embedding: {
    source: MemoryEmbeddingSource;
    api_url?: string;
    api_model?: string;
    has_api_key: boolean;
  };
}

/** The memory settings as a browser may see them: whether a key is set, never the key (9.3). */
export function publicMemorySettings(ai: MemoryAi): PublicMemorySettings {
  const emb = ai.memory?.embedding;
  const embedding: PublicMemorySettings["embedding"] = { source: emb?.source ?? "off", has_api_key: !!emb?.api_key };
  if (emb?.api_url !== undefined) embedding.api_url = emb.api_url;
  if (emb?.api_model !== undefined) embedding.api_model = emb.api_model;
  return { enabled: memoryEnabled(ai), embedding };
}
