import type { SessionCollabApprovalInput, SessionCollabModeSource } from "../../shared/session-collab.ts";
import { modeLabel } from "../assistant-mcp/assistant-approval-summary.ts";

/**
 * The deciding part of a session-tool card (`ppm:session_collab`), for the surfaces that show a
 * card away from PPM's own card component (Telegram). Built from the card's input, which the
 * server checked before asking: the whole message or task is the body, and the chat, project and
 * the mode it will run in are facts, the bypass mode called out as a warning.
 */

export interface CollabDecidingParts {
  title: string;
  facts: Array<{ label: string; value: string }>;
  text: string;
  label?: string;
}

const SOURCE_LABELS: Record<SessionCollabModeSource, string> = {
  running: "the mode its running session started in",
  stored: "the mode saved for this chat",
  live: "the mode this chat last ran in",
  "provider-default": "the provider's default (Settings)",
};

const BYPASS_WARNING = "That chat runs every tool without asking: whatever it does after this message will not ask you first.";
const providerLabel = (id: string): string => (id === "codex" ? "Codex" : id === "claude" ? "Claude" : id);

function modeFacts(mode: string | undefined, source: SessionCollabModeSource | undefined): Array<{ label: string; value: string }> {
  if (!mode) return [];
  return [
    { label: "Runs in", value: modeLabel(mode) },
    ...(source ? [{ label: "Mode from", value: SOURCE_LABELS[source] }] : []),
    ...(mode === "bypassPermissions" ? [{ label: "Warning", value: BYPASS_WARNING }] : []),
  ];
}

export function collabDecidingParts(input: SessionCollabApprovalInput): CollabDecidingParts {
  if (input.kind === "message") {
    return {
      title: `Send a message to a ${providerLabel(input.providerId)} chat in "${input.projectName}"; it runs there as if you sent it`,
      facts: [
        { label: "Project", value: input.projectName },
        { label: "Chat", value: `${input.targetTitle} (${input.targetSessionId})` },
        ...modeFacts(input.permissionMode, input.modeSource),
      ],
      text: input.message,
      label: "Message",
    };
  }
  if (input.kind === "create") {
    return {
      title: input.projectName
        ? `Open a new ${providerLabel(input.providerId)} chat in "${input.projectName}" and give it this task`
        : `Open a new ${providerLabel(input.providerId)} session and give it this task`,
      facts: [
        ...(input.projectName ? [{ label: "Project", value: input.projectName }] : []),
        { label: "Title", value: input.title },
        { label: "Model", value: input.model ?? "the provider's default" },
        ...modeFacts(input.permissionMode, input.modeSource),
      ],
      text: input.task,
      label: "Task",
    };
  }
  if (input.kind === "escalation") {
    return {
      title: "Message a session that runs with more rights",
      facts: [
        { label: "Chat", value: `${input.targetTitle} (${input.targetSessionId})` },
        { label: "Its mode", value: modeLabel(input.targetMode) },
        { label: "Sender's mode", value: modeLabel(input.senderMode) },
      ],
      text: input.message,
      label: "Message",
    };
  }
  return {
    title: "Two sessions reached their limit of automatic messages",
    facts: [
      { label: "Chat", value: `${input.targetTitle} (${input.targetSessionId})` },
      { label: "Sent", value: `${input.sent} of ${input.limit}` },
      { label: "Allowing grants", value: `${input.grant} more` },
    ],
    text: "",
  };
}
