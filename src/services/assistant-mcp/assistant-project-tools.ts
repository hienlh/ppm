import type { Json } from "../mcp-http-endpoint.ts";
import { PROJECT_REMOVE_TOOL, PROJECT_UPDATE_TOOL } from "../../shared/assistant-project-tool-names.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { allowRoute, type RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandler, FamilyHandlers, ToolContext } from "./assistant-tool-family.ts";
import { projectRemove, projectUpdate, type ProjectToolDeps } from "./assistant-project-write-tools.ts";
import { errorResult } from "./assistant-tool-output.ts";

/**
 * The project tools' handlers and the only routes they may call. `PROJECT_ROUTES` is this family's
 * whole reach into PPM's routes (see `assistant-route-call.ts`, which also keeps the clone, the
 * image upload and the settings of the same router out of reach). The routes announce
 * `projects:changed` themselves, so every open PPM shows the change at once.
 */
export const PROJECT_ROUTES: readonly RouteRule[] = [
  allowRoute("GET", "/api/projects"),
  allowRoute("PATCH", "/api/projects/:name"),
  allowRoute("PATCH", "/api/projects/:name/color"),
  allowRoute("DELETE", "/api/projects/:name"),
];

/**
 * PPM's own answers to "who manages this project" and "is that chat running": the manager table
 * is loaded on use, since it reaches the providers, which import the endpoint this family serves.
 */
export const realProjectToolDeps: ProjectToolDeps = {
  managerSession: async (projectPath) => {
    const { managerChats } = await import("../assistant-managers/manager-chats.service.ts");
    return managerChats.managerFor(projectPath)?.sessionId ?? null;
  },
  isRunning: (sessionId) => chatControl()?.liveState(sessionId)?.running === true,
};

type DepsHandler = (ctx: ToolContext, args: Record<string, unknown>, deps: ProjectToolDeps) => Promise<Json>;

/** A handler bound to `deps`, answering an unexpected failure as a tool error rather than a 500. */
const bind = (run: DepsHandler, deps: ProjectToolDeps): FamilyHandler => async (ctx, args) => {
  try {
    return await run(ctx, args, deps);
  } catch (e) {
    return errorResult(`The project tool failed: ${(e as Error).message}. Nothing more was done.`);
  }
};

/** The handlers over given dependencies; tests pass their own. */
export function createProjectToolHandlers(deps: ProjectToolDeps = realProjectToolDeps): FamilyHandlers {
  return {
    [PROJECT_UPDATE_TOOL]: bind(projectUpdate, deps),
    [PROJECT_REMOVE_TOOL]: bind(projectRemove, deps),
  };
}

export const PROJECT_TOOL_HANDLERS: FamilyHandlers = createProjectToolHandlers();
