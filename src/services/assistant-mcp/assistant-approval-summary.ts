import type { DialectName } from "../../shared/db-types.ts";
import { splitSqlStatements } from "../../shared/split-sql-statements.ts";
import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import type { DecidingInput } from "../chat-control/approval-deciding-input.ts";

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
    ...(bypass ? { warning: BYPASS_WARNING } : {}),
  };
}

/** Where the mode a new chat starts in came from. */
export type NewChatModeSource = "assistant" | "new-chat-default";

const NEW_CHAT_SOURCE_LABELS: Record<NewChatModeSource, string> = {
  assistant: "chosen by the Assistant",
  "new-chat-default": "the mode a new chat gets when you open one in PPM (Settings → AI provider)",
};

const BYPASS_WARNING = "That chat runs every tool without asking: whatever it does after this message will not ask you first.";

export interface ChatStartApproval {
  project: string;
  providerId: string;
  /** The model asked for; null runs the provider's default. */
  model: string | null;
  title: string | null;
  text: string;
  mode: string;
  modeSource: NewChatModeSource;
}

export function chatStartSummary(input: ChatStartApproval): ApprovalSummary {
  const bypass = input.mode === "bypassPermissions";
  return {
    headline: `Start a new ${providerLabel(input.providerId)} chat in "${input.project}" and send it this message; it runs there as if you sent it`,
    facts: [
      fact("Project", input.project),
      fact("Provider", providerLabel(input.providerId)),
      fact("Model", input.model ?? "the provider's default"),
      ...(input.title ? [fact("Title", input.title)] : []),
      fact("Runs in", modeLabel(input.mode), bypass ? "warning" : undefined),
      fact("Mode from", NEW_CHAT_SOURCE_LABELS[input.modeSource]),
    ],
    body: { label: "Message", text: input.text, format: "text" },
    ...(bypass ? { warning: BYPASS_WARNING } : {}),
  };
}

const providerLabel = (providerId: string): string => (providerId === "codex" ? "Codex" : "Claude");

const DECIDING_LABELS: Record<DecidingInput["kind"], string> = {
  command: "Command", web: "Request", write: "Content written", edit: "Changes", notebook: "New cell source",
  patch: "Patch", tool: "Input", endpoint: "Body", question: "Questions",
};

export interface AnswerApprovalApproval {
  project: string;
  sessionId: string;
  sessionTitle: string | null;
  providerId: string;
  /** The waiting card's deciding part, verbatim (`decidingInput`). */
  deciding: DecidingInput;
  decision: "allow" | "deny";
  /** A question card's chosen answers, as question → answer. */
  answers?: Array<{ question: string; answer: string }>;
}

/**
 * The confirmation before the Assistant answers another chat's card. It repeats that card's
 * deciding part verbatim — not cleaned, not shortened — because the user is approving what that
 * card will run, and a cleaned copy (markup stripped from `echo x > ~/.bashrc`) is a different
 * command. Facts naming the target's file, folder or URL are not capped for the same reason.
 */
export function answerApprovalSummary(input: AnswerApprovalApproval): ApprovalSummary {
  const d = input.deciding;
  const chat = input.sessionTitle ? `${input.sessionTitle} (${input.sessionId.slice(0, 8)})` : input.sessionId;
  const question = d.kind === "question";
  const verb = question ? (input.decision === "allow" ? "Answer" : "Skip") : input.decision === "allow" ? "Allow" : "Deny";
  return {
    headline: question
      ? `${verb} a question a ${providerLabel(input.providerId)} chat in "${input.project}" is asking`
      : `${verb} "${d.title}" in a ${providerLabel(input.providerId)} chat in "${input.project}"`,
    facts: [
      fact("Project", input.project),
      fact("Chat", chat),
      { label: "Your answer", value: verb, ...(input.decision === "allow" && !question ? { tone: "warning" as const } : {}) },
      ...(question ? [] : [{ label: "Card", value: d.title }]),
      ...d.facts.map((f) => ({ label: f.label, value: f.value })),
      ...(input.answers ?? []).map((a) => ({ label: a.question, value: a.answer })),
    ],
    ...(d.text ? { body: { label: DECIDING_LABELS[d.kind], text: d.text, format: d.lang === "sql" ? "sql" as const : "text" as const } } : {}),
    ...(input.decision === "allow" && !question ? { warning: "That chat runs this as soon as you allow it." } : {}),
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

/**
 * What `ui_read_tab` would send that only the device or PPM holds, so no read tool's own
 * approval covers it: an editor's unsaved text, a terminal's output, or the SQL and rows a tab
 * shows for a database file opened by path. A saved file itself is read with the agent's own
 * read tool, under that tool's approval.
 */
export interface ReadOutsideApproval {
  kind: "unsaved" | "terminal" | "database";
  /** The file's path, or the folder the terminal runs in, as PPM resolved it. */
  location: string;
  /** The file is in a store of logins or keys, which asks even inside a registered project. */
  privateStore?: boolean;
}

const READ_WHAT: Record<ReadOutsideApproval["kind"], string> = {
  unsaved: "the unsaved text of a file",
  terminal: "the output of a terminal running",
  database: "the SQL and rows of a database file",
};

export function readOutsideSummary({ kind, location, privateStore }: ReadOutsideApproval): ApprovalSummary {
  const what = READ_WHAT[kind];
  return {
    headline: privateStore && kind !== "terminal"
      ? `Read ${what} where logins or keys are kept`
      : `Read ${what} outside every registered project`,
    facts: [fact(kind === "terminal" ? "Folder" : kind === "database" ? "Database file" : "File", location)],
    warning: "What is read is sent to the AI provider as part of this conversation.",
  };
}
