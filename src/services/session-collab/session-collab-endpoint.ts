import type { Context } from "hono";
import { createMcpHttpHandler, textResult, type Json } from "../mcp-http-endpoint.ts";
import { isPpmTool, ppmToolOffMessage, ppmToolOn } from "../../shared/ppm-tools.ts";
import {
  CREATE_SESSION_TOOL, DESIGN_SCREENSHOT_TOOL, REPORT_TO_ASSISTANT_TOOL, SEND_TO_SESSION_TOOL, SESSION_STATUS_TOOL,
} from "../../shared/session-collab.ts";
import {
  isSessionScheduleTool, SESSION_SCHEDULE_PROPOSE_SCRIPT_TOOL, SESSION_SCHEDULE_SET_ENABLED_TOOL,
} from "../../shared/session-schedule-tools.ts";
import { liveScheduleProposalToolEnv, scheduleProposalToolCall, type ScheduleProposalToolEnv } from "./collab-schedule-proposals.ts";
import { configService } from "../config.service.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { isReportingManager, NOT_A_MANAGER, reportToAssistantCall } from "../assistant-cards/manager-report-env.ts";
import type { CallLimiter } from "../tab-tools-mcp/session-history-rate-limit.ts";
import { collabToolPolicy } from "./collab-caller-policy.ts";
import { isVaultTool } from "../../shared/vault.ts";
import { boundToExtension, vaultTools } from "../vault/vault-tools.ts";
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";
import { resolveCaller, type CollabEnv } from "./collab-context.ts";
import { createSessionTool } from "./collab-create.ts";
import { designShotTool } from "./collab-design-shot.ts";
import { createCollabLimiter } from "./collab-rate-limit.ts";
import { sendToSessionTool } from "./collab-send.ts";
import { sessionStatusTool } from "./collab-status.ts";
import { liveSessionScheduleToolEnv, sessionScheduleToolCall, type SessionScheduleToolEnv } from "./collab-schedules.ts";
import { sessionServerToolDefinitions } from "./session-server-tool-list.ts";
import { sessionCollabMcpTokens, type SessionCollabTokenBinding } from "./session-collab-tokens.ts";
import { isPpmTaskTool } from "../../shared/ppm-task-tools.ts";
import { callPpmTaskTool, livePpmTaskToolsEnv, type PpmTaskToolsEnv } from "../ppm-tasks/tools/ppm-task-tools.ts";
import { ppmTaskToolOffReason } from "../ppm-tasks/tools/ppm-task-tool-caller.ts";

/**
 * `/api/sessions-mcp` — serves `create_session`, `send_to_session` and `session_status`, and the
 * `session_schedule_*` tools for the caller's own chat, to one chat session's own agent (the MCP
 * plumbing is `mcp-http-endpoint.ts`). The token names the
 * session; every call is checked against that session's canonical id and its project, and never
 * against an id the model supplied about itself.
 */

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export function createSessionCollabMcpHandler(deps: {
  resolveToken: (token: string | null) => SessionCollabTokenBinding | null;
  env: () => CollabEnv;
  /** Whether the tool is on for the chat the token names. */
  enabled: (tool: string, sessionId: string) => boolean;
  limiter?: CallLimiter;
  /** `report_to_assistant`, for the chat the token names (the live one by default). */
  report?: (sessionId: string, args: unknown) => Json;
  /** What the schedule tools save through (the live database by default). */
  schedules?: SessionScheduleToolEnv;
  /** What the script-proposal and pause tools ask and save through (the live ones by default). */
  scheduleProposals?: () => ScheduleProposalToolEnv;
  /** What the task tools act through (the live task store by default). */
  tasks?: PpmTaskToolsEnv;
  /** Why a task tool is off for the chat; Settings → Tools' message by default. */
  taskOff?: (tool: string, sessionId: string) => string | null;
}) {
  const limiter = deps.limiter ?? createCollabLimiter();
  const report = deps.report ?? reportToAssistantCall;
  const schedules = deps.schedules ?? liveSessionScheduleToolEnv;
  const tasks = deps.tasks ?? livePpmTaskToolsEnv();
  return createMcpHttpHandler<SessionCollabTokenBinding>({
    serverName: "ppm-sessions",
    tokenRequired: "A chat session token is required",
    resolveToken: deps.resolveToken,
    tools: sessionServerToolDefinitions(),
    unavailable: (name, { sessionId }) => {
      if (deps.enabled(name, sessionId)) return null;
      if (name === REPORT_TO_ASSISTANT_TOOL) return NOT_A_MANAGER;
      if (isPpmTaskTool(name)) return deps.taskOff?.(name, sessionId) ?? ppmToolOffMessage(name);
      return ppmToolOffMessage(name);
    },
    callTool: async ({ sessionId }, name, rawArgs, signal) => {
      // A value of the vault's locked tiers read in any chat never leaves it: not in a message to
      // another chat, a new chat's prompt, a report or a scheduled prompt.
      if (!isVaultTool(name)) {
        const leaked = turnSecretScrubber.findIn(rawArgs);
        if (leaked) return textResult(`Refused: this contains the value of the vault item "${leaked}". Vault values never go to another chat, a report or a schedule; refer to the item by name instead.`, true);
      }
      // The caller's own chat only, delivering nothing to anyone: the send policy, its rate limit
      // and the session registry have no say here.
      // Proposing a script and pausing or turning on a schedule wait on a card in this chat.
      if (name === SESSION_SCHEDULE_PROPOSE_SCRIPT_TOOL || name === SESSION_SCHEDULE_SET_ENABLED_TOOL) {
        const env = deps.scheduleProposals ? deps.scheduleProposals() : await liveScheduleProposalToolEnv();
        return scheduleProposalToolCall(env, sessionId, name === SESSION_SCHEDULE_PROPOSE_SCRIPT_TOOL ? "propose" : "set_enabled", rawArgs, signal);
      }
      if (isSessionScheduleTool(name)) return sessionScheduleToolCall(schedules, sessionId, name, rawArgs);
      const env = deps.env();
      const caller = resolveCaller(env, sessionId);
      if (!caller.ok) return textResult(caller.message, true);
      // A manager's report: no card, no delivery, so none of the send policy applies. The PPM
      // Assistant is never a manager chat, and the report checks the live table again itself.
      if (name === REPORT_TO_ASSISTANT_TOOL) {
        if (caller.value.kind === "assistant") return textResult(NOT_A_MANAGER, true);
        return report(caller.value.sessionId, rawArgs);
      }
      // The vault decides by itself who may open what (the turn's origin, one card per chat).
      if (isVaultTool(name)) {
        return vaultTools.call({ sessionId: caller.value.sessionId, title: caller.value.title ?? null, assistant: caller.value.kind === "assistant" }, name, rawArgs, signal);
      }
      // The task store decides by itself what each caller may reach (its own project; the
      // Assistant any project with Tasks on) and signs every change with the caller.
      if (isPpmTaskTool(name)) return callPpmTaskTool(tasks, caller.value, name, rawArgs);
      // Decided before anything is asked or delivered: an unattended Assistant turn is refused here.
      const policy = collabToolPolicy(caller.value, name);
      if (!policy.allowed) return textResult(policy.message, true);
      const slot = limiter.acquire(caller.value.sessionId, { exemptFromInFlight: name === SESSION_STATUS_TOOL });
      if (!slot.ok) return textResult(slot.message, true);
      const args = isObj(rawArgs) ? rawArgs : {};
      try {
        if (name === CREATE_SESSION_TOOL) return await createSessionTool(env, caller.value, args, signal);
        if (name === SEND_TO_SESSION_TOOL) return await sendToSessionTool(env, caller.value, args, signal);
        if (name === DESIGN_SCREENSHOT_TOOL) return await designShotTool(env, caller.value, args);
        return sessionStatusTool(env, caller.value, args);
      } finally {
        slot.release();
      }
    },
  });
}

/** Loaded on the first call: the environment reaches the chat registry, which loads after this module. */
let collabEnvRef: CollabEnv | null = null;

/**
 * Whether the tool is on for the chat the token names: the user's Settings → Tools switches, for a
 * manager chat as for any other. `report_to_assistant` is the exception: on for a project's current
 * manager chat whatever the switches say (it is how the manager reaches the user), off for every
 * other chat. A manager chat always has the server attached.
 */
export function sessionToolOnFor(tool: string, sessionId: string): boolean {
  if (tool === REPORT_TO_ASSISTANT_TOOL) return isReportingManager(sessionId);
  // Settings → Tools for every chat, the Assistant and manager chats included, then the project's switch.
  if (isPpmTaskTool(tool)) return liveTaskOffReason(tool, sessionId) === null;
  // The PPM Assistant keeps to its own schedule tools, which show the user a card first.
  if (isSessionScheduleTool(tool) && isAssistantSession(sessionId)) return false;
  // The Assistant always has the vault; an ordinary chat only while the user turned it on; a chat
  // an extension bound never, whatever its policy says.
  if (isVaultTool(tool) && isAssistantSession(sessionId)) return true;
  if (isVaultTool(tool) && boundToExtension(sessionId)) return false;
  return isPpmTool(tool) && ppmToolOn(configService.get("ai"), tool);
}

/** Why a task tool is off for the chat now, from the live settings, sessions and task store. */
function liveTaskOffReason(tool: string, sessionId: string): string | null {
  if (!isPpmTaskTool(tool)) return null;
  try {
    return ppmTaskToolOffReason(tool, sessionId, {
      ai: () => configService.get("ai"),
      isAssistantSession: (id) => isAssistantSession(id),
      boundToExtension,
    });
  } catch {
    // A failed read takes the task tools away, never the whole tool list with them.
    return `${tool} did nothing: PPM could not read the task store.`;
  }
}

const handler = createSessionCollabMcpHandler({
  resolveToken: (token) => sessionCollabMcpTokens.resolve(token),
  taskOff: liveTaskOffReason,
  env: () => {
    if (!collabEnvRef) throw new Error("The session tools are not ready yet");
    return collabEnvRef;
  },
  enabled: sessionToolOnFor,
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
