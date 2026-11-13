import type { Json } from "../mcp-http-endpoint.ts";
import { MANAGER_ASSIGN_TOOL, MANAGER_UNASSIGN_TOOL } from "../../shared/assistant-manager-tool-names.ts";
import { MANAGER_CLAUDE_ONLY, MANAGER_PROVIDER_ID } from "../../shared/assistant-managers.ts";
import { UNATTENDED_TURN_REFUSAL } from "../chat-control/chat-control.ts";
import { managerAssignSummary, managerUnassignSummary } from "./assistant-approval-summary-manager.ts";
import { resolveAssistantProject, type AssistantProject, type AssistantSessionTarget, type Scoped } from "./assistant-project-scope.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * `manager_assign` and `manager_unassign`: find the project and the chat, refuse what must not
 * happen before asking, build the card from PPM's records, ask, read again (the answer can come
 * much later), and only then change the role — through `managerChats`, the service the session
 * list's "Set as manager chat" and "Unset manager chat" call, so the rules files, the
 * `assistant:managers_changed` broadcast and the session lists' badges are exactly the screen's.
 */

export interface ManagerToolDeps {
  projects(): AssistantProject[];
  /** The chat proven to belong to `project`; Assistant sessions are refused here. */
  target(project: AssistantProject, sessionId: unknown, providerId?: unknown): Scoped<AssistantSessionTarget>;
  title(sessionId: string, providerId: string, projectPath: string): Promise<string | null>;
  /** When the chat last wrote to its transcript (ms), or null when PPM cannot tell. */
  lastActivity(sessionId: string, providerId: string, projectPath: string): number | null;
  /** The permission mode the chat runs in. */
  mode(sessionId: string): string;
  /** The project's manager chat, or null. */
  managerOf(projectPath: string): { sessionId: string; providerId: string } | null;
  /** The service's own check (design chat, stored project, provider); throws its refusal. Writes nothing. */
  checkAssign(projectName: string, sessionId: string): Promise<{ sessionId: string }>;
  /** Assigns as the session list does; `onlyIfNone` refuses in the same step when a manager appeared. */
  assign(projectName: string, sessionId: string, onlyIfNone: boolean): Promise<{ replaced: string | null }>;
  unassign(projectName: string): boolean;
  /** The Assistant's own turn was started by PPM (a watch report) and nobody has written in it since. */
  unattended(assistantSessionId: string): boolean;
}

type Chat = AssistantSessionTarget & { title: string | null };

async function chatIn(project: AssistantProject, sessionId: unknown, providerId: unknown, deps: ManagerToolDeps): Promise<Scoped<Chat>> {
  const target = deps.target(project, sessionId, providerId);
  if (!target.ok) return target;
  if (target.value.providerId !== MANAGER_PROVIDER_ID) return { ok: false, error: `${MANAGER_CLAUDE_ONLY}; that chat runs on Codex.` };
  try {
    await deps.checkAssign(project.name, target.value.sessionId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, value: { ...target.value, title: await deps.title(target.value.sessionId, target.value.providerId, project.path) } };
}

const label = (title: string | null, sessionId: string) => (title ? `"${title}" (session ${sessionId})` : `session ${sessionId}`);

export async function managerAssign(ctx: ToolContext, args: Record<string, unknown>, deps: ManagerToolDeps): Promise<Json> {
  if (deps.unattended(ctx.sessionId)) return errorResult(UNATTENDED_TURN_REFUSAL);
  const project = resolveAssistantProject(args.project, () => deps.projects());
  if (!project.ok) return errorResult(project.error);
  if (args.providerId !== undefined && args.providerId !== MANAGER_PROVIDER_ID) return errorResult(`Not assigned: ${MANAGER_CLAUDE_ONLY}.`);
  if (args.replace !== undefined && typeof args.replace !== "boolean") return errorResult("`replace`, when given, must be true or false.");
  const replace = args.replace === true;
  const p = project.value;
  const found = await chatIn(p, args.sessionId, args.providerId, deps);
  if (!found.ok) return errorResult(`Not assigned: ${found.error}`);
  const chat = found.value;

  const current = deps.managerOf(p.path);
  if (current?.sessionId === chat.sessionId) return errorResult(`${label(chat.title, chat.sessionId)} already is the manager chat of "${p.name}"; nothing to do.`);
  let replaces: { sessionId: string; title: string | null } | null = null;
  if (current) {
    const title = await deps.title(current.sessionId, current.providerId, p.path);
    if (!replace) {
      return errorResult(`Not assigned: "${p.name}" already has a manager chat, ${label(title, current.sessionId)}. `
        + "Unassign it first with manager_unassign, or call again with `replace: true` if the user wants this chat to take its place.");
    }
    replaces = { sessionId: current.sessionId, title };
  }

  const verdict = await ctx.ask({
    tool: MANAGER_ASSIGN_TOOL,
    input: { project: p.name, sessionId: chat.sessionId, ...(replaces ? { replace: true } : {}) },
    summary: managerAssignSummary({
      project: p.name,
      chat: { sessionId: chat.sessionId, title: chat.title, providerId: chat.providerId, lastActivity: deps.lastActivity(chat.sessionId, chat.providerId, p.path) },
      permissionMode: deps.mode(chat.sessionId),
      replaces,
    }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(MANAGER_ASSIGN_TOOL, verdict, { project: p.name, sessionId: chat.sessionId });

  // The card showed the chat and the project's manager as they stood: either may have changed since.
  const again = await chatIn(p, chat.sessionId, chat.providerId, deps);
  if (!again.ok) return errorResult(`Not assigned (stale): ${again.error}`);
  const now = deps.managerOf(p.path);
  if ((now?.sessionId ?? null) !== (current?.sessionId ?? null)) {
    return errorResult(`Not assigned (stale): the manager chat of "${p.name}" changed while the card waited${now ? ` (it is session ${now.sessionId} now)` : ""}. Nothing was changed; ask again if this chat should still be the manager.`);
  }
  try {
    const { replaced } = await deps.assign(p.name, chat.sessionId, replaces === null);
    return jsonResult({
      outcome: "assigned", project: p.name, sessionId: chat.sessionId, ...(replaced ? { replaced } : {}),
      note: "Message it with send_to_session. Its manager tools arrive the next time it starts.",
    });
  } catch (e) {
    return errorResult(`Not assigned: ${(e as Error).message}`);
  }
}

export async function managerUnassign(ctx: ToolContext, args: Record<string, unknown>, deps: ManagerToolDeps): Promise<Json> {
  if (deps.unattended(ctx.sessionId)) return errorResult(UNATTENDED_TURN_REFUSAL);
  const project = resolveAssistantProject(args.project, () => deps.projects());
  if (!project.ok) return errorResult(project.error);
  const p = project.value;
  const current = deps.managerOf(p.path);
  if (!current) return errorResult(`"${p.name}" has no manager chat; there is nothing to unassign.`);
  const title = await deps.title(current.sessionId, current.providerId, p.path);

  const verdict = await ctx.ask({
    tool: MANAGER_UNASSIGN_TOOL,
    input: { project: p.name },
    summary: managerUnassignSummary({ project: p.name, chat: { sessionId: current.sessionId, title } }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(MANAGER_UNASSIGN_TOOL, verdict, { project: p.name });

  const now = deps.managerOf(p.path);
  if (now?.sessionId !== current.sessionId) {
    return errorResult(`Not unassigned (stale): the manager chat of "${p.name}" changed while the card waited. Nothing was changed; read the managers again and ask the user.`);
  }
  if (!deps.unassign(p.name)) return errorResult(`"${p.name}" had no manager chat by the time it was unassigned; nothing was changed.`);
  return jsonResult({ outcome: "unassigned", project: p.name, sessionId: current.sessionId, note: "The chat is kept; it is no longer the manager." });
}
