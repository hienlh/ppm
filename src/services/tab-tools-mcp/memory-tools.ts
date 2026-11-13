/**
 * The memory tools of the tab-tools MCP server: `memory_search`, `memory_read`, `memory_write`
 * and `memory_forget` (requirements 7.1–7.7, 10.3). They work on the session's project store and
 * the global one; a session with no project reaches the global store only. Search answers compact
 * rows, never bodies; a read is cut at `MEMORY_READ_CHARS` with the offset of the rest; a write
 * goes through the store's one write path (redaction, revision check, imported memories refused)
 * and then `written` re-indexes, queues the embeddings and tells the browser. Every failure is an
 * MCP error result, so nothing that failed reads like success.
 */
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { createLogger } from "../logger.ts";
import {
  MEMORY_FORGET_TOOL, MEMORY_READ_TOOL, MEMORY_SEARCH_TOOL, MEMORY_WRITE_TOOL, isMemoryTool,
} from "../../shared/memory-tools.ts";
import type { Embedder } from "../memory/embedding/embedder.ts";
import { memoryEmbedder, memoryWritten } from "../memory/memory-runtime.ts";
import { search as memorySearch, type MemorySearchDeps, type MemorySearchOptions, type MemorySearchResponse } from "../memory/memory-search.ts";
import { memoryStore, MemoryStoreError } from "../memory/memory-store.ts";
import { memorySync } from "../memory/memory-sync.ts";
import { MEMORY_TYPES, type MemoryRecord, type MemoryScope, type MemoryType } from "../memory/memory-types.ts";
import {
  DEFAULT_MEMORY_SEARCH_LIMIT, MAX_MEMORY_SEARCH_LIMIT, MEMORY_READ_CHARS,
} from "./memory-tool-definitions.ts";

export interface MemoryToolsBinding {
  sessionId: string;
  projectPath: string | null;
  projectName?: string | null;
}

export interface MemoryTools {
  call(binding: MemoryToolsBinding, name: string, args: Json): Promise<Json>;
}

export interface MemoryToolsDeps {
  store?: Pick<typeof memoryStore, "read" | "write" | "archive">;
  search?: (opts: MemorySearchOptions, deps: MemorySearchDeps) => Promise<MemorySearchResponse>;
  /** The embedding source a search uses, as the settings name it now. */
  embedder?: () => Embedder | null;
  /** Brings a project's store up to date with the providers' and hand edits; its errors are ignored. */
  ensureSynced?: (projectPath: string) => Promise<unknown>;
  /** After a successful write or forget: re-index, queue embeddings, notify the browser. */
  written?: (scope: MemoryScope, projectPath: string | null) => Promise<void>;
}

const log = createLogger("memory-tools");
const MAX_QUERY_CHARS = 500;
/** Weak results listed when nothing matches clearly. */
const WEAK_SHOWN = 3;
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1_000;
const SCOPES = ["project", "global"] as const;

/** A tool's own refusal: answered as an error result with this message. */
class ToolInputError extends Error {}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();

function scopeArg(args: Json): MemoryScope | undefined {
  const v = args.scope;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(SCOPES as readonly string[]).includes(v)) throw new ToolInputError("`scope` must be \"project\" or \"global\".");
  return v as MemoryScope;
}

function idArg(args: Json, required: boolean): string | undefined {
  const v = args.id;
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError("`id` is required: the memory's id, as memory_search gave it.");
    return undefined;
  }
  if (typeof v !== "string" || !v.trim()) throw new ToolInputError("`id` must be a memory id.");
  return v.trim();
}

const noProject = "This chat has no project, so only the global memory store (scope \"global\") is available.";

export function createMemoryTools(deps: MemoryToolsDeps = {}): MemoryTools {
  const store = deps.store ?? memoryStore;
  const runSearch = deps.search ?? memorySearch;
  const embedder = deps.embedder ?? memoryEmbedder;
  const ensureSynced = deps.ensureSynced ?? ((p: string) => memorySync.ensureSynced(p));
  const written = deps.written ?? memoryWritten;

  async function sync(projectPath: string | null): Promise<void> {
    if (!projectPath) return;
    try {
      await ensureSynced(projectPath);
    } catch (e) {
      log.warn(`sync before a memory tool failed: ${(e as Error).message}`);
    }
  }

  async function afterWrite(scope: MemoryScope, projectPath: string | null): Promise<void> {
    try {
      await written(scope, projectPath);
    } catch (e) {
      log.warn(`after a memory write: ${(e as Error).message}`);
    }
  }

  /** The stores to look in for an id: the one asked for, else this project's then the global one. */
  function storesFor(scope: MemoryScope | undefined, projectPath: string | null): MemoryScope[] {
    if (scope === "project" && !projectPath) throw new ToolInputError(noProject);
    if (scope) return [scope];
    return projectPath ? ["project", "global"] : ["global"];
  }

  async function find(id: string, scope: MemoryScope | undefined, projectPath: string | null): Promise<MemoryRecord | null> {
    for (const s of storesFor(scope, projectPath)) {
      const record = await store.read(id, s, projectPath ?? undefined);
      if (record) return record;
    }
    return null;
  }

  const where = (scope: MemoryScope | undefined, projectPath: string | null) =>
    scope ? `the ${scope} store` : projectPath ? "this project's store or the global one" : "the global store";

  async function search(projectPath: string | null, args: Json): Promise<Json> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || query.length > MAX_QUERY_CHARS) throw new ToolInputError(`\`query\` must be 1 to ${MAX_QUERY_CHARS} characters.`);
    let limit = DEFAULT_MEMORY_SEARCH_LIMIT;
    if (args.limit !== undefined && args.limit !== null) {
      if (!isInt(args.limit) || args.limit < 1 || args.limit > MAX_MEMORY_SEARCH_LIMIT) {
        throw new ToolInputError(`\`limit\` must be a whole number from 1 to ${MAX_MEMORY_SEARCH_LIMIT}.`);
      }
      limit = args.limit;
    }
    let scope: "project" | "global" | "all" = "all";
    if (args.scope !== undefined && args.scope !== null) {
      if (args.scope !== "project" && args.scope !== "global" && args.scope !== "all") {
        throw new ToolInputError("`scope` must be \"project\", \"global\" or \"all\".");
      }
      scope = args.scope;
    }
    if (!projectPath) {
      if (scope === "project") throw new ToolInputError(noProject);
      scope = "global";
    }
    await sync(projectPath);
    const answer = await runSearch({ ...(projectPath ? { projectPath } : {}), query, scope, limit }, { embedder });
    const lines = [
      answer.mode === "hybrid" ? "Search mode: keywords and meaning." : `Search mode: keywords only${answer.reason ? ` (${answer.reason})` : ""}.`,
    ];
    const shownQuery = oneLine(query).slice(0, 80);
    if (!answer.results.length) {
      lines.push(`No memory matches "${shownQuery}".`);
      return textResult(lines.join("\n"));
    }
    const row = (r: (typeof answer.results)[number]) =>
      `- ${r.id} · ${r.scope} · ${r.source} · ${r.score.toFixed(2)} · ${oneLine(r.name)} — ${oneLine(r.description)}`;
    // Only results that hold the query's words or stand out by meaning are answers; the rest are
    // whatever ranked next, and listed as such so they are not taken for one.
    const strong = answer.results.filter((r) => r.match !== "weak");
    if (strong.length) {
      lines.push("Memories (id · scope · source · score · name — description):");
      for (const r of strong) lines.push(row(r));
    } else {
      lines.push(`No memory clearly matches "${shownQuery}". The closest, probably unrelated (id · scope · source · score · name — description):`);
      for (const r of answer.results.slice(0, WEAK_SHOWN)) lines.push(row(r));
    }
    lines.push("Read one with memory_read(id, scope).");
    return textResult(lines.join("\n"));
  }

  async function read(projectPath: string | null, args: Json): Promise<Json> {
    const id = idArg(args, true)!;
    const scope = scopeArg(args);
    let offset = 0;
    if (args.offset !== undefined && args.offset !== null) {
      if (!isInt(args.offset) || args.offset < 0) throw new ToolInputError("`offset` must be a whole number from 0.");
      offset = args.offset;
    }
    storesFor(scope, projectPath);
    await sync(projectPath);
    const record = await find(id, scope, projectPath);
    if (!record) return textResult(`No memory "${id}" in ${where(scope, projectPath)}.`, true);
    const total = record.body.length;
    if (offset > 0 && offset >= total) return textResult(`\`offset\` ${offset} is past the end: the body has ${total} characters.`, true);
    const end = Math.min(total, offset + MEMORY_READ_CHARS);
    const head = [
      `id: ${record.id}`, `scope: ${record.scope}`, `revision: ${record.revision}`,
      `name: ${record.name}`, `description: ${record.description}`, `type: ${record.type}`, `source: ${record.source}`,
      `created: ${record.created}`, `updated: ${record.updated}`,
      ...(record.archived ? ["archived: true"] : []),
      ...(record.origin ? [`origin: ${record.origin}`] : []),
    ];
    const parts = ["---", ...head, "---", record.body.slice(offset, end)];
    if (offset > 0 || end < total) parts.push("", `[Characters ${offset}–${end} of ${total}.]`);
    if (end < total) parts.push(`[The body goes on: call memory_read with offset ${end} to read the rest.]`);
    return textResult(parts.join("\n"));
  }

  async function write(projectPath: string | null, args: Json): Promise<Json> {
    const id = idArg(args, false);
    const asked = scopeArg(args);
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name || name.length > MAX_NAME_CHARS) throw new ToolInputError(`\`name\` must be 1 to ${MAX_NAME_CHARS} characters.`);
    if (typeof args.description !== "string" || args.description.length > MAX_DESCRIPTION_CHARS) {
      throw new ToolInputError(`\`description\` must be a line of at most ${MAX_DESCRIPTION_CHARS} characters.`);
    }
    if (typeof args.type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(args.type)) {
      throw new ToolInputError(`\`type\` must be one of ${MEMORY_TYPES.join(", ")}.`);
    }
    if (typeof args.body !== "string" || !args.body.trim()) throw new ToolInputError("`body` must not be empty.");
    if (args.revision !== undefined && args.revision !== null && typeof args.revision !== "string") {
      throw new ToolInputError("`revision` must be the revision memory_read answered.");
    }
    let scope: MemoryScope;
    if (id === undefined) {
      if (asked === "project" && !projectPath) throw new ToolInputError(noProject);
      scope = asked ?? (projectPath ? "project" : "global");
    } else {
      const existing = await find(id, asked, projectPath);
      if (!existing) return textResult(`No memory "${id}" in ${where(asked, projectPath)}. Omit the id to create one.`, true);
      scope = existing.scope;
    }
    const { record, redacted, created } = await store.write({
      ...(id !== undefined ? { id } : {}),
      scope, projectPath: projectPath ?? undefined,
      name, description: oneLine(args.description), type: args.type as MemoryType, body: args.body,
    }, { caller: "tool", ...(typeof args.revision === "string" ? { expectedRevision: args.revision } : {}) });
    await afterWrite(scope, projectPath);
    return textResult(
      `${created ? "Created" : "Updated"} memory ${record.id} (${scope}) at revision ${record.revision}; `
      + `${redacted} secret${redacted === 1 ? "" : "s"} redacted.`,
    );
  }

  async function forget(projectPath: string | null, args: Json): Promise<Json> {
    const id = idArg(args, true)!;
    const asked = scopeArg(args);
    const existing = await find(id, asked, projectPath);
    if (!existing) return textResult(`No memory "${id}" in ${where(asked, projectPath)}.`, true);
    const { record } = await store.archive(id, existing.scope, projectPath ?? undefined, { caller: "tool" });
    await afterWrite(existing.scope, projectPath);
    return textResult(`Archived memory ${record.id} (${existing.scope}): it no longer appears in lists or searches, and its file is kept.`);
  }

  return {
    async call(binding, name, args) {
      if (!isMemoryTool(name)) return textResult(`Unknown tool: ${name}`, true);
      const projectPath = binding.projectPath ?? null;
      try {
        if (name === MEMORY_SEARCH_TOOL) return await search(projectPath, args);
        if (name === MEMORY_READ_TOOL) return await read(projectPath, args);
        if (name === MEMORY_WRITE_TOOL) return await write(projectPath, args);
        if (name === MEMORY_FORGET_TOOL) return await forget(projectPath, args);
        return textResult(`Unknown tool: ${name}`, true);
      } catch (e) {
        if (e instanceof MemoryStoreError && e.code === "revision-mismatch" && e.currentRevision) {
          return textResult(`${e.message} Current revision: ${e.currentRevision}.`, true);
        }
        if (e instanceof ToolInputError || e instanceof MemoryStoreError) return textResult(e.message, true);
        log.warn(`${name} failed: ${(e as Error).message}`);
        return textResult(`${name} failed: ${(e as Error).message}`, true);
      }
    },
  };
}
