import { inAiChat } from "../../services/ai-chat-env.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { fail } from "./chat-cmd-request.ts";

/**
 * How every `ppm group-chat` command reaches PPM: `/api/group-chat` on the running PPM that holds
 * the database — the routes the group chat panel calls. With no PPM running, the routes that only
 * change the database run here after the direct-write notice; posting, stopping and resuming need
 * the running PPM, where the turns run (`serverOnly`).
 */

export const GROUP_TURNS_SERVER_ONLY = "A group chat's turns run in the running PPM.";

export function groupRequest<T>(method: string, sub: string, body?: unknown, serverOnly = false): Promise<T> {
  return ppmApiRequest<T>(method, `/group-chat${sub}`, body, serverOnly ? { serverOnly: GROUP_TURNS_SERVER_ONLY } : {});
}

/**
 * `create`, `members add`, `message` and `resume` start, or add to, AI-to-AI turns nobody started,
 * so they are refused from an AI chat. Advisory, like every check keyed on the AI-chat mark: the
 * shell's approval card is the control.
 */
export function refuseGroupChatInAiChat(command: string): void {
  if (!inAiChat()) return;
  fail(`ppm group-chat ${command} is refused here from an AI chat: a group chat runs AI agents talking to each other, in turns nobody started. `
    + "Give the user the command, or ask them to do it in the group chat panel.");
}

export const groupPart = (id: string) => `/${encodeURIComponent(id)}`;
