import type { Json } from "../mcp-http-endpoint.ts";
import { GIT_TOOLS } from "../../shared/assistant-git-tool-names.ts";
import { SCHEDULE_TOOLS } from "../../shared/assistant-schedule-tool-names.ts";
import { TUNNEL_TOOLS } from "../../shared/assistant-tunnel-tool-names.ts";
import type { AskApproval } from "./assistant-approval-broker.ts";
import { createRouteCaller } from "./assistant-route-call.ts";
import type { CallPpmRoute, RouteRule } from "./assistant-route-rules.ts";
import { GIT_ROUTES, GIT_TOOL_HANDLERS } from "./assistant-git-tools.ts";
import { SCHEDULE_ROUTES, SCHEDULE_TOOL_HANDLERS } from "./assistant-schedule-tools.ts";
import { TUNNEL_ROUTES, TUNNEL_TOOL_HANDLERS } from "./assistant-tunnel-tools.ts";

/**
 * The tool families that work through PPM's own routes — git, schedules, tunnels — and how the
 * endpoint reaches them. Each family owns its files (names, definitions, handlers and the routes
 * it may call), so they can grow side by side without editing a shared switch.
 *
 * A family's handler gets a route caller bound to that family's routes alone: a git tool cannot
 * reach a schedule or tunnel route even by building the path itself. Family files take what they
 * need from this module and from `assistant-route-call.ts` as *types only* (`import type`); their
 * runtime imports stay on the leaf `assistant-route-rules.ts`, so no family file can close an
 * import cycle with this dispatcher.
 */

export type ToolFamily = "git" | "schedule" | "tunnel";

/** What one call of a family tool is handed. */
export interface ToolContext {
  sessionId: string;
  /** Asks this session's user; a write runs only on `{ verdict: "approved" }`. Refuses by itself in a watch turn. */
  ask: AskApproval;
  /** Aborts when the provider closes the call. */
  signal?: AbortSignal;
  /** Reaches only the routes this tool's family declared. */
  callRoute: CallPpmRoute;
}

export type FamilyHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<Json>;
export type FamilyHandlers = Readonly<Record<string, FamilyHandler>>;

/**
 * A tool as `tools/list` describes it; family definition files are lists of these. A type alias,
 * not an interface, so it stays assignable to the endpoint's `Json` (an interface has no implicit
 * index signature).
 */
export type AssistantToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};

export interface ToolFamilyEntry {
  family: ToolFamily;
  tools: readonly string[];
  handlers: FamilyHandlers;
  routes: readonly RouteRule[];
}

let families: readonly ToolFamilyEntry[] | null = null;

/**
 * The families, read on first use rather than at module load, so a family module still being
 * evaluated (were a cycle ever to form) is not captured half-built.
 */
export function toolFamilies(): readonly ToolFamilyEntry[] {
  families ??= [
    { family: "git", tools: GIT_TOOLS, handlers: GIT_TOOL_HANDLERS, routes: GIT_ROUTES },
    { family: "schedule", tools: SCHEDULE_TOOLS, handlers: SCHEDULE_TOOL_HANDLERS, routes: SCHEDULE_ROUTES },
    { family: "tunnel", tools: TUNNEL_TOOLS, handlers: TUNNEL_TOOL_HANDLERS, routes: TUNNEL_ROUTES },
  ];
  return families;
}

const callers = new Map<ToolFamily, CallPpmRoute>();

/** The route caller confined to `family`'s declared routes. */
export function routeCallerFor(family: ToolFamily): CallPpmRoute {
  let caller = callers.get(family);
  if (!caller) {
    const entry = toolFamilies().find((f) => f.family === family);
    caller = createRouteCaller(entry?.routes ?? []);
    callers.set(family, caller);
  }
  return caller;
}

/** The family that serves `name`, with its handler; null for any other name. */
export function familyToolHandler(name: string): { family: ToolFamily; handler: FamilyHandler } | null {
  for (const entry of toolFamilies()) {
    // Own properties only: the name comes from the agent, and `constructor` or `__proto__` must
    // not resolve to something on Object.prototype.
    if (Object.hasOwn(entry.handlers, name)) return { family: entry.family, handler: entry.handlers[name]! };
  }
  return null;
}

/**
 * Runs the family tool `name`, or answers null when no family serves it. The handler gets the
 * caller of its own family only.
 */
export function callFamilyTool(
  name: string,
  base: Omit<ToolContext, "callRoute">,
  args: Record<string, unknown>,
  callerFor: (family: ToolFamily) => CallPpmRoute = routeCallerFor,
): Promise<Json> | null {
  const found = familyToolHandler(name);
  return found ? found.handler({ ...base, callRoute: callerFor(found.family) }, args) : null;
}
