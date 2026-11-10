import { MANAGER_CLAUDE_ONLY, MANAGER_PROVIDER_ID } from "../../shared/assistant-managers.ts";
import type { CreateSessionResult, SessionCollabCreateApproval } from "../../shared/session-collab.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import type { CollabCaller, CollabEnv } from "./collab-context.ts";
import { deliverAndWait } from "./collab-deliver.ts";
import { jsonResult, noteAiTextRead, statusOf } from "./collab-status.ts";

/**
 * `create_session` with `manager: true`, from the PPM Assistant: a new Claude chat in the named
 * project, made that project's manager chat. One card, in a turn the user started only, and only
 * for a project with no manager yet. The card states the mode the chat will run in (Settings →
 * PPM Assistant's default for manager chats) and the consequence: from then on the Assistant
 * messages it without asking, also while the user is away.
 *
 * On Allow the chat is created as one the user opens there, assigned (by the Assistant) — which
 * writes its rules files — and given the task, if there is one. If the assignment fails the chat
 * stays an ordinary chat, and the result says so. A manager chat is the user's own chat: not
 * AI-created, so it neither counts against nor waits for the running limit.
 */

export const DEFAULT_MANAGER_TITLE = "Manager";

export async function createManagerSessionTool(
  env: CollabEnv, caller: CollabCaller,
  input: { title: string | null; task: string; project: { name: string; path: string }; provider: unknown; model: unknown; wait: boolean },
  signal: AbortSignal,
): Promise<Json> {
  if (caller.kind !== "assistant" || !env.assignManager || !env.managerOf) {
    return textResult("Only PPM Assistant creates manager chats; leave out `manager`.", true);
  }
  if (input.provider !== undefined && input.provider !== MANAGER_PROVIDER_ID) return textResult(`${MANAGER_CLAUDE_ONLY}.`, true);
  if (input.model !== undefined) return textResult("A manager chat starts on the provider's default model; leave out `model`.", true);
  const { project } = input;
  const existing = env.managerOf(project.path);
  if (existing) {
    return textResult(`${project.name} already has a manager chat (session ${existing}): message it with send_to_session.`, true);
  }
  const title = input.title ?? DEFAULT_MANAGER_TITLE;
  const permissionMode = env.managerDefaultMode?.() ?? "default";
  const card: SessionCollabCreateApproval = {
    kind: "create", manager: true, askedBy: "assistant", title, providerId: MANAGER_PROVIDER_ID, model: null,
    task: input.task, depth: 0, projectName: project.name, permissionMode,
  };
  const answer = await env.approve(caller.sessionId, card, signal);
  if (!answer.allowed) return textResult(`The manager chat was not created. ${answer.message}`, true);
  // Time passed while the user read the card: someone may have set a manager meanwhile.
  const now = env.managerOf(project.path);
  if (now) return textResult(`${project.name} got a manager chat meanwhile (session ${now}), so none was created.`, true);
  if (signal.aborted) return textResult("The call was cancelled, so no chat was created.", true);

  let childId: string;
  try {
    childId = env.canonical(await env.createSession(MANAGER_PROVIDER_ID, {
      projectName: project.name, projectPath: project.path, title, asUserChat: true,
    }));
  } catch (e) {
    return textResult(`The chat could not be created: ${(e as Error).message}`, true);
  }
  env.persistChild(childId, { title, permissionMode, model: null, projectName: project.name, projectPath: project.path });
  env.announceCreated({
    sessionId: childId, providerId: MANAGER_PROVIDER_ID, projectName: project.name, title, spawnedBy: null, depth: 0,
    createdAt: new Date().toISOString(),
  });
  let assignError: string | null = null;
  try {
    await env.assignManager(project.name, childId);
  } catch (e) {
    assignError = (e as Error).message;
  }

  const target = { sessionId: childId, providerId: MANAGER_PROVIDER_ID, title, projectName: project.name, projectPath: project.path } as const;
  let reply: CreateSessionResult["reply"];
  let taskNote: string | null = null;
  if (input.task.trim()) {
    // The task goes to the manager like any Assistant message to it: with the turn's provenance.
    const provenance = assignError === null ? env.turnProvenance?.(caller.sessionId) : undefined;
    const out = await deliverAndWait(env, {
      caller, target, body: input.task, wait: input.wait, signal, permissionMode, ...(provenance ? { provenance } : {}),
    });
    if (out.ok) {
      env.nameInProvider(childId, MANAGER_PROVIDER_ID, title, project.path, out.clientMessageId);
      reply = out.reply;
      // The manager's answer to its task, when nothing waited for it, comes back as wake news.
      const claimed = reply && (reply.replied || reply.reason === "turn_ended_without_reply");
      if (assignError === null && !claimed) env.managerAsked?.(caller.sessionId, childId, project.name, false);
    } else {
      taskNote = `Its task was not delivered: ${out.message} Send it again with send_to_session.`;
    }
  }
  const result: CreateSessionResult & { project: string; manager: boolean; note?: string } = {
    sessionId: childId, title, providerId: MANAGER_PROVIDER_ID, model: null,
    status: statusOf(env, childId, MANAGER_PROVIDER_ID, caller.sessionId, !!reply),
    ...(reply ? { reply } : {}),
    project: project.name,
    manager: assignError === null,
    ...(assignError || taskNote ? {
      note: [assignError ? `The chat was created but is not the manager chat: ${assignError} It stays an ordinary chat.` : "", taskNote ?? ""]
        .filter(Boolean).join(" "),
    } : {}),
  };
  noteAiTextRead(env, caller, [result.status], reply);
  return jsonResult(result, assignError !== null);
}
