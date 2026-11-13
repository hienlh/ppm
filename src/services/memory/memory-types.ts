/** The kinds of memory every provider agrees on (Claude's four types). */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Who wrote a memory: imported from a provider's own store, or written in PPM. */
export const MEMORY_SOURCES = ["claude", "codex", "antigravity", "ppm"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** A project's own folder, or the one shared by every project. */
export type MemoryScope = "project" | "global";

/** One Markdown file of PPM's memory store. The id is the file name without `.md`. */
export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  name: string;
  description: string;
  type: MemoryType;
  source: MemorySource;
  created: string;
  updated: string;
  archived?: boolean;
  /** Where an imported memory came from: a path, or e.g. `codex:<threadId>`. */
  origin?: string;
  /** Hash of the original item, so a sync rewrites the copy only when the original moved. */
  originHash?: string;
  body: string;
  /** First 12 hex of the sha256 of the whole file. */
  revision: string;
}

/** One memory as an importer reads it from a provider's store, before it is written to PPM's. */
export interface NativeMemory {
  id: string;
  scope: MemoryScope;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  origin: string;
  originHash: string;
  /** When the provider last changed it (ISO); the copy's `updated`, so "newest first" means the source's order. */
  sourceUpdated?: string;
}
