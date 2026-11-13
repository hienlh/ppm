import { createLogger } from "../logger.ts";
import {
  EXTENSION_TOOLSET_OFF, EXTENSION_TOOLSET_STARTING, exposedToolName, normaliseToolResult, splitToolsetKey, toolsetKey, validateToolset,
  type ExtensionMcpToolDefinition, type ExtensionMcpToolResult, type ExtensionMcpToolset,
} from "../../shared/extension-mcp.ts";
import { dbToolsetStore } from "./extension-mcp-toolset-store.ts";

/**
 * The toolsets extensions have registered with `ppm.mcp.registerToolset`, keyed
 * `<extensionId>:<toolsetId>`. Each registration's definitions are also saved to the database,
 * since a live Claude query lists tools once: a chat started while the extension is down still
 * gets the tool names, and a call made then gets "starting" (or "turned off", once the user
 * disabled it) instead of an unknown tool.
 *
 * Every extension shares one worker and names itself on each call, so the main thread cannot tell
 * which one really sent a request. A live key is never replaced, and only the opaque handle its
 * own registration received back may dispose or replace it — another extension naming the same
 * extension and toolset id cannot drop or take it over. It can still claim an id first, or read
 * another extension's raw `postMessage` traffic; closing that needs one worker per extension. Only
 * the first registration since the extension's current run is persisted — one that follows a
 * plain dispose (which may be another extension reusing the freed key) is served but never saved,
 * so a forged definition cannot outlive the process that sent it.
 */

const log = createLogger("extension-mcp");

export interface ExtensionToolCallContext {
  sessionId: string;
  /** Which door the session's current turn came through (`ws`: a person typed it). */
  turnOrigin: string;
}

/** Forwards one call to the registering extension; resolves to its raw answer. */
export type ExtensionToolInvoker = (
  name: string, args: Record<string, unknown>, ctx: ExtensionToolCallContext, signal: AbortSignal,
) => Promise<unknown>;

export interface ExtensionToolsetStore {
  load(extensionId: string, toolsetId: string): ExtensionMcpToolDefinition[] | null;
  save(extensionId: string, toolset: ExtensionMcpToolset): void;
  /** Whether the user left this extension on; an unknown extension counts as off. */
  isEnabled(extensionId: string): boolean;
}

export interface ExtensionToolsetInfo {
  key: string;
  extensionId: string;
  toolsetId: string;
  title: string;
  /** Exposed names, `<toolset>_<tool>`. */
  tools: string[];
}

/** An MCP `tools/list` entry. */
export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What `register` hands back: the clean toolset, and the handle that alone may dispose it. */
export interface ExtensionToolsetRegistration {
  toolset: ExtensionMcpToolset;
  handle: string;
}

interface LiveToolset {
  extensionId: string;
  toolset: ExtensionMcpToolset;
  invoke: ExtensionToolInvoker;
  /** Only an unregister naming this exact value may drop this entry. */
  handle: string;
}

const failure = (text: string): ExtensionMcpToolResult => ({ text, isError: true });

export class ExtensionMcpRegistry {
  private live = new Map<string, LiveToolset>();
  /** Keys that already used their one save-to-database since the extension's current run started. */
  private saved = new Set<string>();

  constructor(private store: ExtensionToolsetStore = dbToolsetStore) {}

  /** Validates and adds a toolset; throws when the definition is bad or the key is taken. */
  register(extensionId: string, raw: unknown, invoke: ExtensionToolInvoker): ExtensionToolsetRegistration {
    const toolset = validateToolset(raw);
    const key = toolsetKey(extensionId, toolset.id);
    if (this.live.has(key)) throw new Error(`Toolset "${toolset.id}" is already registered; dispose it first`);
    const handle = crypto.randomUUID();
    this.live.set(key, { extensionId, toolset, invoke, handle });
    if (!this.saved.has(key)) {
      this.saved.add(key);
      try {
        this.store.save(extensionId, toolset);
      } catch (e) {
        // The live registration still serves; only a chat started before the next one misses it.
        log.warn(`could not save the tools of ${key}: ${(e as Error).message}`);
      }
    }
    return { toolset, handle };
  }

  /** Drops one toolset; `handle` must be the exact value its own registration returned. */
  unregister(extensionId: string, toolsetId: string, handle: string): boolean {
    const key = toolsetKey(extensionId, toolsetId);
    const entry = this.live.get(key);
    if (!entry || !handle || entry.handle !== handle) return false;
    return this.live.delete(key);
  }

  /**
   * Drops every toolset of an extension (deactivated, failed or timed out activating, or about
   * to activate again) and lets its next registration save fresh, since this is a genuinely new
   * run rather than a replacement inside the one that is ending.
   */
  unregisterExtension(extensionId: string): number {
    let dropped = 0;
    for (const [key, entry] of this.live) {
      if (entry.extensionId !== extensionId) continue;
      this.live.delete(key);
      this.saved.delete(key);
      dropped++;
    }
    return dropped;
  }

  /** Drops everything: the worker that served every toolset is gone. */
  clear(): void {
    this.live.clear();
    this.saved.clear();
  }

  isLive(key: string): boolean {
    return this.live.has(key);
  }

  list(): ExtensionToolsetInfo[] {
    return [...this.live.entries()].map(([key, { extensionId, toolset }]) => ({
      key, extensionId, toolsetId: toolset.id, title: toolset.title,
      tools: toolset.tools.map((t) => exposedToolName(toolset.id, t.name)),
    }));
  }

  /** A toolset's live definitions, else the ones it last registered, else null. */
  private definitions(key: string): ExtensionMcpToolDefinition[] | null {
    const entry = this.live.get(key);
    if (entry) return entry.toolset.tools;
    const parts = splitToolsetKey(key);
    return parts ? this.store.load(parts.extensionId, parts.toolsetId) : null;
  }

  /** The tools of these toolsets as MCP lists them, under their exposed names. */
  toolsFor(keys: readonly string[]): McpToolListing[] {
    return keys.flatMap((key) => {
      const parts = splitToolsetKey(key);
      if (!parts) return [];
      return (this.definitions(key) ?? []).map((tool) => ({
        name: exposedToolName(parts.toolsetId, tool.name), description: tool.description, inputSchema: tool.inputSchema,
      }));
    });
  }

  /** Runs one tool (its own name, not the exposed one). Never throws: a failure is an error result. */
  async call(
    key: string, name: string, args: unknown, ctx: ExtensionToolCallContext, signal: AbortSignal = new AbortController().signal,
  ): Promise<ExtensionMcpToolResult> {
    const entry = this.live.get(key);
    if (!entry) {
      const known = this.definitions(key);
      if (!known?.some((t) => t.name === name)) return failure(`Unknown tool: ${name.slice(0, 60)}`);
      const parts = splitToolsetKey(key);
      if (parts && !this.store.isEnabled(parts.extensionId)) return failure(EXTENSION_TOOLSET_OFF);
      return failure(EXTENSION_TOOLSET_STARTING);
    }
    if (!entry.toolset.tools.some((t) => t.name === name)) return failure(`Unknown tool: ${name.slice(0, 60)}`);
    const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
    try {
      return normaliseToolResult(await entry.invoke(name, input, ctx, signal));
    } catch (e) {
      return failure(`The extension's tool failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The registry the RPC handlers, the extension service and the MCP endpoint share. */
export const extensionMcpRegistry = new ExtensionMcpRegistry();

/** Every live extension toolset, for a host other than a bound chat (e.g. an assistant). */
export function listExtensionToolsets(): ExtensionToolsetInfo[] {
  return extensionMcpRegistry.list();
}

/** Calls one tool of a live toolset by key; see {@link ExtensionMcpRegistry.call}. */
export function callExtensionTool(
  key: string, name: string, args: unknown, ctx: ExtensionToolCallContext, signal?: AbortSignal,
): Promise<ExtensionMcpToolResult> {
  return extensionMcpRegistry.call(key, name, args, ctx, signal);
}
