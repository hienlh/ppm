import { SESSION_COLLAB_LIMITS } from "../../shared/session-collab-settings.ts";
import {
  CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL, SESSION_STATUS_TOOL,
} from "../../shared/session-collab.ts";

/**
 * The three tools the `ppm-sessions` MCP endpoint serves, and the numbers both providers are
 * configured with. Their descriptions say when each is the right tool, and that every session
 * they create is one the user sees in PPM.
 */

export {
  CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL, SESSION_STATUS_TOOL, SESSION_COLLAB_TOOLS,
  CLAUDE_SESSION_COLLAB_MCP_SERVER, CODEX_SESSION_COLLAB_MCP_SERVER,
} from "../../shared/session-collab.ts";

/** Environment variable the Codex app-server reads the bearer token from. */
export const CODEX_SESSION_COLLAB_MCP_TOKEN_ENV = "PPM_SESSIONS_MCP_TOKEN";

/** How long the user has to answer a create, pair-limit or escalation card. */
export const COLLAB_APPROVAL_WAIT_MS = 10 * 60_000;

/**
 * Largest task or message one call may carry, in UTF-8 bytes. The endpoint takes at most 64 KB of
 * JSON per request, and escaping can double a text's size there, so a limit in characters would
 * promise what a request in a three-byte script cannot deliver.
 */
export const MAX_COLLAB_MESSAGE_BYTES = 24 * 1024;

/** Why `text` is too large for one call, in words the AI can act on; null when it fits. */
export function collabTextTooLarge(field: "task" | "message", text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_COLLAB_MESSAGE_BYTES) return null;
  return `\`${field}\` is ${Math.ceil(bytes / 1024)} KB; one call carries at most ${MAX_COLLAB_MESSAGE_BYTES / 1024} KB `
    + "(about 24,000 characters of English, fewer in scripts that take more bytes a character). "
    + "Shorten it, or write the details to a file in the project and send its path.";
}
/** Longest title a created session gets; longer ones are cut. */
export const MAX_COLLAB_TITLE_CHARS = 60;
/** Sessions one `session_status` call reports at most. */
export const MAX_STATUS_SESSIONS = 20;

/**
 * The providers' own timeout for one call. Fixed at the largest wait the settings allow, not at
 * the wait set now: a Claude CLI keeps the MCP timeout it started with for every later turn, so
 * a timeout taken from the current setting would cut a wait the user lengthened since. It also
 * covers the user's time to answer a card before the wait begins, and a margin for the delivery.
 */
export const SESSION_COLLAB_TOOLS_TIMEOUT_MS =
  COLLAB_APPROVAL_WAIT_MS + SESSION_COLLAB_LIMITS.waitTimeoutMinutes.max * 60_000 + 2 * 60_000;

/** How a provider reaches the endpoint for one session; built by `chatService` per turn. */
export interface SessionCollabMcpAccess {
  url: string;
  token: string;
}

const WAIT = {
  type: "boolean",
  description:
    "Block until the other session calls send_to_session back to you, its turn ends without replying, or the "
    + "wait times out (the user's setting, 10 minutes unless changed). The result carries the reply and the "
    + "session's status. Without it the call returns at once, and a later reply arrives as a new message. "
    + "A session showing the user a card (a question or an approval) cannot read your message or answer until "
    + "the user does, so the wait ends at once with reply.reason \"waiting_for_user\" and reply.card naming that "
    + "card; your message stays queued there. Tell the user which card in which session is waiting for them.",
};

export function sessionCollabToolDefinitions() {
  return [
    {
      name: CREATE_SESSION_TOOL,
      title: "Open another PPM session",
      description:
        "Start a new chat session in this project and give it a task. It is an ordinary PPM session, not a hidden "
        + "subagent: the user sees it in the session list, can open it, watch it work, write into it and stop it. Use "
        + "it to hand off a self-contained piece of work that can run beside yours (one session per independent "
        + "part), or work that needs its own long context. Write the task so it stands on its own: the new session "
        + "sees your session and current turn as a link it can read with read_session_turns, but nothing else of "
        + "this conversation. It runs with your permission mode, never more. Unless the user switched it off, PPM "
        + "asks them before the session is created. Prefer wait: true when you need the result before going on; "
        + "the session replies by calling send_to_session.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: `A short title for the new session (at most ${MAX_COLLAB_TITLE_CHARS} characters), shown in the user's session list.` },
          task: { type: "string", description: `The task, complete enough to work from without this conversation (required, except with \`manager\`). Say what to send back, and that the reply goes through send_to_session. At most ${MAX_COLLAB_MESSAGE_BYTES / 1024} KB; put longer material in a file and give its path.` },
          provider: { type: "string", enum: ["claude", "codex"], description: "The AI to run it on; yours by default." },
          model: { type: "string", description: "The model; the same as yours by default." },
          wait: WAIT,
          project: {
            type: "string",
            description: "A session always creates in its own project: leave this out, or give that project's name. The PPM "
              + "Assistant must name the registered project to open the chat in (see projects_list); its chat starts in "
              + "the provider's default mode and model, and the user is always asked first.",
          },
          manager: {
            type: "boolean",
            description: "PPM Assistant only: create the project's manager chat (Claude, titled \"Manager\" unless you give a "
              + "title). Refused when the project already has one. The user is asked once; after that you message it "
              + "without asking. `task` is optional here.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: SEND_TO_SESSION_TOOL,
      title: "Message another PPM session",
      description:
        "Send a message to another chat session of this project: one you created, the one that created you, or any "
        + "session the user pointed you at. Use it to reply to a session that messaged you (a reply reaches the "
        + "other AI only through this tool: your final answer is not forwarded), to ask a session that already "
        + "holds the context, or to hand a running session more to do. A running session reads the message at its "
        + "next step; an idle one starts a turn. The user sees every message in both sessions. Sending to a session "
        + "with more permissions than yours, and sending many messages back and forth, asks the user first. The PPM "
        + "Assistant may message a chat of any registered project: a project's manager chat without asking (within "
        + "limits), every other chat only after the user allows it on a card.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "The receiving session's id." },
          message: { type: "string", description: `What to say. Plain text; it is shown as a message from your session. At most ${MAX_COLLAB_MESSAGE_BYTES / 1024} KB.` },
          wait: WAIT,
        },
        required: ["session_id", "message"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: SESSION_STATUS_TOOL,
      title: "Check on PPM sessions",
      description:
        "Report on sessions of this project: whether each is running, idle or waiting on the user, its title, AI and "
        + "model, who created it, the opening of its last answer, and how many of its messages to you arrived "
        + "outside a wait. Without session_ids it reports the sessions linked to yours (created by you, your "
        + "creator, and those you exchanged messages with); for the PPM Assistant, every project's manager chat. "
        + "Use it to check progress instead of waiting, or before messaging a session.",
      inputSchema: {
        type: "object",
        properties: {
          session_ids: {
            type: "array", items: { type: "string" }, maxItems: MAX_STATUS_SESSIONS,
            description: "Sessions to report on; your linked sessions by default.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
}
