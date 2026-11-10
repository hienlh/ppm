import { CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL, SESSION_STATUS_TOOL } from "../../shared/session-collab.ts";
import { UNATTENDED_TURN_REFUSAL } from "../chat-control/chat-control.ts";
import type { CollabCaller } from "./collab-context.ts";

/**
 * Which session tools a caller may use, and whether the user is asked first, by the kind of chat
 * calling. Decided before anything is delivered or created.
 *
 * - An ordinary session uses all three tools in its own project, asked only when the settings or
 *   the limits say so (`collab-create.ts`, `collab-send.ts`).
 * - The PPM Assistant may create and message chats in any registered project, but every create
 *   and every message is shown to the user on a card first, whatever the settings say. Its cards
 *   are answered once, never "for this session".
 * - In an unattended Assistant turn (PPM started it, nobody has written in it since) nothing that
 *   would show a card runs, and nothing is asked: such a turn carries other chats' words, and a
 *   card in it is the shortest path from injected text to an action.
 */

export type CollabToolPolicy =
  | { allowed: true; ask: "settings" | "always" }
  | { allowed: false; message: string };

/** What `tool` may do for `caller` (see the module comment). */
export function collabToolPolicy(caller: Pick<CollabCaller, "kind" | "unattended">, tool: string): CollabToolPolicy {
  if (tool === SESSION_STATUS_TOOL) return { allowed: true, ask: "settings" };
  if (tool !== CREATE_SESSION_TOOL && tool !== SEND_TO_SESSION_TOOL) {
    return { allowed: false, message: `Unknown session tool: ${tool.slice(0, 60)}` };
  }
  if (caller.kind !== "assistant") return { allowed: true, ask: "settings" };
  if (caller.unattended) return { allowed: false, message: UNATTENDED_TURN_REFUSAL };
  return { allowed: true, ask: "always" };
}
