import type { DialectName } from "../../shared/db-types.ts";
import { splitSqlStatements } from "../../shared/split-sql-statements.ts";
import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";

/**
 * What an Assistant approval card says, built only from input the endpoint has already
 * checked: the connection as PPM stores it, the chat as PPM records it, the tab as the device
 * described it. Nothing the agent wrote about its own request (a reason, a description, a
 * title it chose) ever reaches a card; the one agent-written text shown is the thing that will
 * actually run or be sent — the SQL, the message — in full, as the card's body.
 */

const MAX_FACT_CHARS = 200;
const fact = (label: string, value: string, tone?: "warning"): ApprovalFact => ({
  label,
  value: value.length > MAX_FACT_CHARS ? `${value.slice(0, MAX_FACT_CHARS)}…` : value,
  ...(tone ? { tone } : {}),
});

export interface DbWriteApproval {
  connection: { name: string; type: string; readonly: boolean; folder?: string | null };
  dialect: DialectName;
  sql: string;
}

export function dbWriteSummary({ connection, dialect, sql }: DbWriteApproval): ApprovalSummary {
  const statementCount = Math.max(1, splitSqlStatements(sql, dialect).length);
  const statements = statementCount === 1 ? "1 SQL statement" : `${statementCount} SQL statements`;
  return {
    headline: connection.readonly
      ? `Run ${statements} PPM cannot prove only read, on the read-only connection "${connection.name}"`
      : `Run ${statements} that may change data on "${connection.name}"`,
    facts: [
      fact("Connection", `${connection.name} (${connection.type})`),
      ...(connection.folder ? [fact("Folder", connection.folder)] : []),
      fact("Writes", connection.readonly ? "Refused by the connection (it is read-only)" : "Allowed — this connection is writable", connection.readonly ? undefined : "warning"),
    ],
    body: { label: "SQL", text: sql, format: "sql" },
    statementCount,
  };
}

/** Where the mode a chat message runs in came from. */
export type ModeSource = "running" | "stored" | "live" | "provider-default";

const MODE_LABELS: Record<string, string> = {
  default: "Ask before risky tools (default)",
  acceptEdits: "Accept edits — file edits run without asking",
  plan: "Plan — no changes until a plan is approved",
  bypassPermissions: "Bypass permissions — every tool runs without asking",
};

const SOURCE_LABELS: Record<ModeSource, string> = {
  running: "the mode its running session started in (a message joins that session)",
  stored: "the mode saved for this chat",
  live: "the mode this chat last ran in",
  "provider-default": "the provider's default (Settings), since this chat has no saved mode",
};

export const modeLabel = (mode: string): string => MODE_LABELS[mode] ?? mode;

export interface ChatSendApproval {
  project: string;
  sessionId: string;
  providerId: string;
  /** The chat's title as PPM records it, when it has one. */
  sessionTitle: string | null;
  text: string;
  mode: string;
  modeSource: ModeSource;
}

export function chatSendSummary(input: ChatSendApproval): ApprovalSummary {
  const bypass = input.mode === "bypassPermissions";
  const chat = input.sessionTitle ? `${input.sessionTitle} (${input.sessionId.slice(0, 8)})` : input.sessionId;
  return {
    headline: `Send a message to a ${input.providerId === "codex" ? "Codex" : "Claude"} chat in "${input.project}"; it runs there as if you sent it`,
    facts: [
      fact("Project", input.project),
      fact("Chat", chat),
      fact("Runs in", modeLabel(input.mode), bypass ? "warning" : undefined),
      fact("Mode from", SOURCE_LABELS[input.modeSource]),
    ],
    body: { label: "Message", text: input.text, format: "text" },
    ...(bypass ? { warning: "That chat runs every tool without asking: whatever it does after this message will not ask you first." } : {}),
  };
}

export interface CloseTabApproval {
  tabType: string;
  tabTitle: string;
  project: string | null;
  /** Why closing loses work, as the device said it. */
  reason: string;
}

export function closeTabSummary(input: CloseTabApproval): ApprovalSummary {
  return {
    headline: input.tabType === "terminal" ? "Close a terminal and end what runs in it" : "Close a tab and discard its unsaved work",
    facts: [
      fact("Tab", input.tabTitle || "(untitled)"),
      fact("Type", input.tabType),
      ...(input.project ? [fact("Project", input.project)] : []),
    ],
    warning: input.reason,
  };
}

export interface RunCommandApproval {
  id: string;
  /** The label the device's command registry gives it — the palette row the user would pick. */
  label: string;
  /** The project the device shows, which the command acts in. */
  project: string | null;
  /** An extension's command, which PPM cannot see into. */
  extension: boolean;
}

export function runCommandSummary(input: RunCommandApproval): ApprovalSummary {
  return {
    headline: input.extension
      ? `Run the extension command "${input.label}" on your device`
      : `Run the PPM command "${input.label}" on your device`,
    facts: [
      fact("Command", input.label),
      fact("Id", input.id),
      fact("Project", input.project ?? "(none shown)"),
    ],
    warning: input.extension
      ? "An extension's command runs with the extension's own access; PPM cannot see what it changes."
      : "PPM marks this command as one that changes data or settings.",
  };
}

export interface ReadOutsideApproval {
  kind: "file" | "terminal";
  /** The file's path, or the folder the terminal runs in, as PPM resolved it. */
  location: string;
}

export function readOutsideSummary({ kind, location }: ReadOutsideApproval): ApprovalSummary {
  return {
    headline: kind === "file"
      ? "Read a file outside every registered project"
      : "Read the output of a terminal running outside every registered project",
    facts: [fact(kind === "file" ? "File" : "Folder", location)],
    warning: "What is read is sent to the AI provider as part of this conversation.",
  };
}
