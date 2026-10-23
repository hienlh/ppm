import { getExtensionMcpToolsetJson, saveExtensionMcpToolsetJson } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import {
  EXTENSION_TOOLSET_STARTING, exposedToolName, normaliseToolResult, splitToolsetKey, toolsetKey, validateToolset,
  type ExtensionMcpToolDefinition, type ExtensionMcpToolResult, type ExtensionMcpToolset,
} from "../../shared/extension-mcp.ts";

/**
 * The toolsets extensions have registered with `ppm.mcp.registerToolset`, keyed
 * `<extensionId>:<toolsetId>`. Lives on the main thread; each entry carries the function that
 * forwards a call to the worker that registered it.
 *
 * A live Claude query lists its tools once, so each registration's definitions are also saved
 * to the database: a chat that starts while the extension is down (PPM starting, the host being
 * rebuilt) is still told the tools' names, and a call made before the extension is back gets
 * a "starting" error instead of an unknown tool.
 *
 * Every extension shares one worker and names itself on each call, so the main thread cannot
 * tell which extension really sent a registration. A key that is live is never replaced — the
 * first registration holds until it is disposed or its extension stops — which keeps one
 * extension from taking over another's running toolset, though not from claiming an id first.
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

const dbToolsetStore: ExtensionToolsetStore = {
  load(extensionId, toolsetId) {
    const json = getExtensionMcpToolsetJson(extensionId, toolsetId);
    if (!json) return null;
    try {
      return validateToolset({ id: toolsetId, title: toolsetId, tools: JSON.parse(json) }).tools;
    } catch (e) {
      log.warn(`ignoring unreadable saved tools of ${toolsetKey(extensionId, toolsetId)}: ${(e as Error).message}`);
      return null;
    }
  },
  save(extensionId, toolset) {
    saveExtensionMcpToolsetJson(extensionId, toolset.id, JSON.stringify(toolset.tools));
  },
};

interface LiveToolset {
  extensionId: string;
  toolset: ExtensionMcpToolset;
  invoke: ExtensionToolInvoker;
  /** Which worker generation registered it; only that one may dispose it. */
  owner: number;
}

const failure = (text: string): ExtensionMcpToolResult => ({ text, isError: true });

export class ExtensionMcpRegistry {
  private live = new Map<string, LiveToolset>();

  constructor(private store: ExtensionToolsetStore = dbToolsetStore) {}

  /** Validates and adds a toolset; throws when the definition is bad or the key is taken. */
  register(extensionId: string, raw: unknown, invoke: ExtensionToolInvoker, owner = 0): ExtensionMcpToolset {
    const toolset = validateToolset(raw);
    const key = toolsetKey(extensionId, toolset.id);
    if (this.live.has(key)) throw new Error(`Toolset "${toolset.id}" is already registered; dispose it first`);
    this.live.set(key, { extensionId, toolset, invoke, owner });
    try {
      this.store.save(extensionId, toolset);
    } catch (e) {
      // The live registration still serves; only a chat started before the next one misses it.
      log.warn(`could not save the tools of ${key}: ${(e as Error).message}`);
    }
    return toolset;
  }

  /** Drops one toolset; `owner`, when given, must be the generation that registered it. */
  unregister(extensionId: string, toolsetId: string, owner?: number): boolean {
    const key = toolsetKey(extensionId, toolsetId);
    const entry = this.live.get(key);
    if (!entry || (owner !== undefined && entry.owner !== owner)) return false;
    return this.live.delete(key);
  }

  /** Drops every toolset of an extension (deactivated, failed to activate, or removed). */
  unregisterExtension(extensionId: string): number {
    let dropped = 0;
    for (const [key, entry] of this.live) {
      if (entry.extensionId === extensionId && this.live.delete(key)) dropped++;
    }
    return dropped;
  }

  /** Drops everything: the worker that served every toolset is gone. */
  clear(): void {
    this.live.clear();
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
      return known?.some((t) => t.name === name) ? failure(EXTENSION_TOOLSET_STARTING) : failure(`Unknown tool: ${name.slice(0, 60)}`);
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
