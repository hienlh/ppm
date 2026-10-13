/**
 * Renaming and deleting a chat, as `PATCH`/`DELETE /chat/sessions/:id` do them, for the routes
 * and for callers inside the server (a script schedule's `ctx.ai.chat`), so both leave the same
 * rows behind.
 */
import { renameSession as sdkRenameSession } from "@anthropic-ai/claude-agent-sdk";
import { chatService } from "./chat.service.ts";
import { deleteSessionMapping, deleteSessionMetadata, deleteSessionTitle, getSessionProvider, setSessionTitle, unpinSession } from "./db.service.ts";
import { draftService } from "./draft.service.ts";
import { deleteSessionBaselines } from "./session-file-baselines/session-file-baselines.service.ts";
import { deleteBranchesFor } from "./session-branch.service.ts";
import { setSessionTag } from "./tag.service.ts";

/** PPM's title table is the authoritative title; Claude's transcript gets it too, so the CLI agrees. */
export async function renameChatSession(id: string, title: string, projectPath: string): Promise<void> {
  setSessionTitle(id, title);
  // Codex owns its rollout title and has no Claude SDK session to rename.
  if (getSessionProvider(id) !== "codex") {
    await sdkRenameSession(id, title, { dir: projectPath });
  }
  const session = chatService.getSession(id);
  if (session) session.title = title;
}

/** The provider's own cleanup (transcript, process), then every row PPM keeps about the chat. */
export async function deleteChatSession(providerId: string, id: string, projectPath: string): Promise<void> {
  await chatService.deleteSession(providerId, id);
  deleteSessionMapping(id); // legacy cleanup
  setSessionTag(id, null, projectPath);
  deleteSessionMetadata(id);
  deleteSessionTitle(id);
  unpinSession(id);
  deleteBranchesFor(id);
  deleteSessionBaselines(id);
  try { draftService.delete(projectPath, id); } catch { /* ignore */ }
}
