import type { Json } from "../mcp-http-endpoint.ts";
import { isUnattendedTurn } from "../chat-control/chat-control.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { assistantNotes, type AssistantNotes, type NoteResult } from "../assistant-notes/assistant-notes.service.ts";
import { errorResult, jsonResult } from "./assistant-tool-output.ts";

/**
 * The Assistant's notebook tools (definitions in `assistant-notebook-tool-definitions.ts`): write
 * down, correct or drop a short fact it must not forget in a long session. They never ask and run
 * in every Assistant turn. In a turn nobody started (a watch or report wake) a line is stored
 * unverified, and an edit there marks the line unverified; a line the user wrote is refused to
 * edit and delete. The notebook reaches the model as a shared-context entry
 * (`assistant-notes-entry.ts`), which is where the ids come from.
 */

export interface NotebookToolDeps {
  notes?: AssistantNotes;
  unattended?: (sessionId: string) => boolean;
}

/**
 * Whether the call comes from a turn nobody started. Asked under the id the token was minted for
 * and the one the session goes by now: either saying so is enough, since being wrong this way only
 * labels a line unverified.
 */
function unattended(sessionId: string, deps: NotebookToolDeps): boolean {
  const check = deps.unattended ?? isUnattendedTurn;
  return check(sessionId) || check(resolveMigratedSession(sessionId));
}

const idArg = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER ? value : null;

function answer(result: NoteResult, verb: string): Json {
  if (!result.ok) return errorResult(result.error);
  const { id, source, unverified } = result.note;
  return jsonResult({
    [verb]: true, id, source, unverified,
    ...(unverified ? { note: "Stored as unverified: written in a turn the user did not start. The user sees it labelled so." } : {}),
  });
}

/** `notebook_add`, for the Assistant session `sessionId`. */
export function notebookAddTool(sessionId: string, args: Record<string, unknown>, deps: NotebookToolDeps = {}): Json {
  if (typeof args.text !== "string") return errorResult("`text` is required: one short line.");
  const result = (deps.notes ?? assistantNotes).add(args.text, { by: "assistant", unattended: unattended(sessionId, deps) });
  return answer(result, "added");
}

/** `notebook_edit`. */
export function notebookEditTool(sessionId: string, args: Record<string, unknown>, deps: NotebookToolDeps = {}): Json {
  const id = idArg(args.id);
  if (id === null) return errorResult("`id` is required: the number after # in your notebook.");
  if (typeof args.text !== "string") return errorResult("`text` is required: the line's new text.");
  const result = (deps.notes ?? assistantNotes).edit(id, args.text, { by: "assistant", unattended: unattended(sessionId, deps) });
  return answer(result, "edited");
}

/** `notebook_delete`. */
export function notebookDeleteTool(sessionId: string, args: Record<string, unknown>, deps: NotebookToolDeps = {}): Json {
  const id = idArg(args.id);
  if (id === null) return errorResult("`id` is required: the number after # in your notebook.");
  const result = (deps.notes ?? assistantNotes).remove(id, { by: "assistant", unattended: unattended(sessionId, deps) });
  if (!result.ok) return errorResult(result.error);
  return jsonResult({ deleted: true, id });
}
