import type { RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandlers } from "./assistant-tool-family.ts";

/**
 * The git tools' handlers and the only routes they may call. `GIT_ROUTES` is this family's whole
 * reach into PPM's routes (see `assistant-route-call.ts`): declare each route with `allowRoute`
 * and the query keys it takes, and nothing beyond what a tool calls.
 */
export const GIT_ROUTES: readonly RouteRule[] = [];

export const GIT_TOOL_HANDLERS: FamilyHandlers = {};
