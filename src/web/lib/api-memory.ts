/**
 * `/api/memory` — Settings → Memory: what PPM's memory store holds, where it was copied from,
 * Sync now and the on/off switch. Changes arrive as `memory:changed` on `/ws/global`, which
 * `use-global-events.ts` re-dispatches on `window`.
 */
import { api } from "./api-client";

export const MEMORY_CHANGED_EVENT = "memory:changed";
export const MEMORY_EMBED_INSTALL_EVENT = "memory:embed-install";

export type MemoryProviderId = "claude" | "codex" | "antigravity";

export interface MemoryProviderStatus {
  count: number;
  syncedAt: string | null;
  error: string | null;
  skipped: string[];
  redacted: number;
}

export interface MemoryStatus {
  enabled: boolean;
  /** The folder memories live in, as the server spells it. */
  root: string;
  counts: { project: number; global: number; archived: number };
  providers: Record<MemoryProviderId, MemoryProviderStatus>;
  /** The embedding source and its progress; shown by the Search by meaning block. */
  embedding: Record<string, unknown>;
}

export interface MemorySettingsResponse {
  enabled: boolean;
  embedding: Record<string, unknown>;
}

/** The store's status; the counts and provider rows are for `project` when given. */
export function getMemoryStatus(project?: string): Promise<MemoryStatus> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  return api.get<MemoryStatus>(`/api/memory/status${query}`);
}

/** Syncs every project now. */
export function syncMemoryNow(): Promise<unknown> {
  return api.post("/api/memory/sync");
}

export function updateMemorySettings(patch: { enabled?: boolean }): Promise<MemorySettingsResponse> {
  return api.put<MemorySettingsResponse>("/api/memory/settings", patch);
}
