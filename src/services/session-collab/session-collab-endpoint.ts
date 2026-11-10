import type { Context } from "hono";
import { createMcpHttpHandler, textResult, type Json } from "../mcp-http-endpoint.ts";
import { isPpmTool, ppmToolOffMessage, ppmToolOn } from "../../shared/ppm-tools.ts";
import { CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL, SESSION_STATUS_TOOL } from "../../shared/session-collab.ts";
import { configService } from "../config.service.ts";
import type { CallLimiter } from "../tab-tools-mcp/session-history-rate-limit.ts";
import { collabToolPolicy } from "./collab-caller-policy.ts";
import { resolveCaller, type CollabEnv } from "./collab-context.ts";
import { createSessionTool } from "./collab-create.ts";
import { createCollabLimiter } from "./collab-rate-limit.ts";
import { sendToSessionTool } from "./collab-send.ts";
import { sessionStatusTool } from "./collab-status.ts";
import { sessionCollabToolDefinitions } from "./session-collab-tool.ts";
import { sessionCollabMcpTokens, type SessionCollabTokenBinding } from "./session-collab-tokens.ts";

/**
 * `/api/sessions-mcp` — serves `create_session`, `send_to_session` and `session_status` to one
 * chat session's own agent (the MCP plumbing is `mcp-http-endpoint.ts`). The token names the
 * session; every call is checked against that session's canonical id and its project, and never
 * against an id the model supplied about itself.
 */

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export function createSessionCollabMcpHandler(deps: {
  resolveToken: (token: string | null) => SessionCollabTokenBinding | null;
  env: () => CollabEnv;
  enabled: (tool: string) => boolean;
  limiter?: CallLimiter;
}) {
  const limiter = deps.limiter ?? createCollabLimiter();
  return createMcpHttpHandler<SessionCollabTokenBinding>({
    serverName: "ppm-sessions",
    tokenRequired: "A chat session token is required",
    resolveToken: deps.resolveToken,
    tools: sessionCollabToolDefinitions(),
    unavailable: (name) => (deps.enabled(name) ? null : ppmToolOffMessage(name)),
    callTool: async ({ sessionId }, name, rawArgs, signal) => {
      const env = deps.env();
      const caller = resolveCaller(env, sessionId);
      if (!caller.ok) return textResult(caller.message, true);
      // Decided before anything is asked or delivered: an unattended Assistant turn is refused here.
      const policy = collabToolPolicy(caller.value, name);
      if (!policy.allowed) return textResult(policy.message, true);
      const slot = limiter.acquire(caller.value.sessionId, { exemptFromInFlight: name === SESSION_STATUS_TOOL });
      if (!slot.ok) return textResult(slot.message, true);
      const args = isObj(rawArgs) ? rawArgs : {};
      try {
        if (name === CREATE_SESSION_TOOL) return await createSessionTool(env, caller.value, args, signal);
        if (name === SEND_TO_SESSION_TOOL) return await sendToSessionTool(env, caller.value, args, signal);
        return sessionStatusTool(env, caller.value, args);
      } finally {
        slot.release();
      }
    },
  });
}

/** Loaded on the first call: the environment reaches the chat registry, which loads after this module. */
let collabEnvRef: CollabEnv | null = null;

const handler = createSessionCollabMcpHandler({
  resolveToken: (token) => sessionCollabMcpTokens.resolve(token),
  env: () => {
    if (!collabEnvRef) throw new Error("The session tools are not ready yet");
    return collabEnvRef;
  },
  enabled: (tool) => isPpmTool(tool) && ppmToolOn(configService.get("ai"), tool),
});

/**
 * The endpoint as mounted. A wait can hold the request for many minutes with no byte sent, which
 * Bun's default idle timeout (10 s) would cut; the call's own wait timeout bounds it instead.
 */
export async function sessionCollabMcpHandler(c: Context): Promise<Response> {
  if (!collabEnvRef) collabEnvRef = (await import("./collab-env.ts")).collabEnv;
  (c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, 0);
  return handler(c);
}
