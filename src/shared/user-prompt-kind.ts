/**
 * Whether a user record — a Claude transcript line, a Codex user message, or a `ChatMessage` the
 * chat holds — is a prompt the person actually sent, i.e. the start of a turn.
 *
 * One predicate for the server's turn index and the browser's turn list, so the two can never
 * number a session differently. A transcript holds far more user records than prompts: tool
 * results, task notifications, the CLI's own "Continue from where you left off." after an
 * interrupted turn, compaction summaries, image companions, teammate messages, and the copies a
 * Codex compaction writes back into history. None of those start a turn. A typed slash command
 * does, because the person typed it.
 *
 * The content rules reuse `parseUserMessage` — the decomposition the chat bubble renders — so a
 * message counts as a prompt exactly when the bubble would show the person something they typed.
 */
import { parseUserMessage, toComposerDraft } from "./user-message-parse.ts";
import { stripSharedContext } from "./provider-context.ts";
import { decodeMessageBlocks } from "./chat-message-blocks.ts";

/**
 * What PPM sends to resume a turn a crash or a transient error cut short. The CLI writes it as an
 * ordinary prompt record; it is not one the person typed, so it never opens a turn.
 */
export const CONTINUE_NUDGE = "Continue from where you left off.";

/** The CLI's own markers for an interrupted turn, written as user text. */
const INTERRUPT_MARKER_RE = /^\[Request interrupted by user[^\]]*\]$/;
/** Output a CLI-local command (`/login`, `!ls`) printed, recorded as a user record of its own. */
const LOCAL_OUTPUT_RE = /^(?:\s*<(local-command-(?:stdout|stderr)|bash-(?:stdout|stderr))>[\s\S]*?<\/\1>\s*)+$/;

/** A Claude transcript record, as far as the decision needs it. */
export interface ClaudePromptRecord {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  queueTranscriptOnly?: unknown;
  turnOrigin?: unknown;
  origin?: unknown;
  message?: unknown;
}

/** A message the chat holds, as far as the decision needs it. */
export interface PromptMessageLike {
  role: string;
  content: string;
  compaction?: unknown;
  synthetic?: boolean;
  notPrompt?: boolean;
}

/**
 * The prompt as the person typed it — a command in its `/name args` form, the terminal blocks, or
 * "N attached files" when that is all there was — or null when the text is not a prompt at all.
 */
export function promptTextOf(content: string): string | null {
  const stripped = stripSharedContext(content);
  // Another session's AI sent this through PPM: it opens a turn exactly as a typed prompt does,
  // whatever its body looks like, since only the server can write the block that says so.
  const fromSession = decodeMessageBlocks(stripped).fromSession;
  if (fromSession) {
    const parsed = parseUserMessage(stripped);
    return toComposerDraft(stripped).text || parsed.terminalBlocks.join("\n\n") || `Message from ${fromSession.title}`;
  }
  const trimmed = stripped.trim();
  if (!trimmed || trimmed === CONTINUE_NUDGE || INTERRUPT_MARKER_RE.test(trimmed)) return null;
  if (LOCAL_OUTPUT_RE.test(trimmed) || trimmed.includes("<teammate-message")) return null;
  const parsed = parseUserMessage(stripped);
  if (!parsed.text && !parsed.command && !parsed.files.length && !parsed.terminalBlocks.length) return null;
  return toComposerDraft(stripped).text
    || parsed.terminalBlocks.join("\n\n")
    || `${parsed.files.length} attached file${parsed.files.length === 1 ? "" : "s"}`;
}

/** The plain text of a Claude `message.content`, or null when it carries a tool result. */
function claudeRecordText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "tool_result") return null;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

function originKind(origin: unknown): unknown {
  return origin && typeof origin === "object" ? (origin as { kind?: unknown }).kind : undefined;
}

/**
 * A Claude user record its own flags mark as the CLI's rather than the person's, whatever its
 * text says: meta, a sidechain, a compaction summary, a transcript-only copy, a task notification.
 */
export function isFlaggedNonPromptRecord(record: ClaudePromptRecord): boolean {
  if (record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) return true;
  if (record.isVisibleInTranscriptOnly === true || record.queueTranscriptOnly === true) return true;
  return record.turnOrigin === "task_notification" || originKind(record.origin) === "task-notification";
}

/** A Claude transcript record that opened a turn. */
export function isRealPromptRecord(record: ClaudePromptRecord): boolean {
  if (record.type !== "user" || isFlaggedNonPromptRecord(record)) return false;
  const text = claudeRecordText(record.message);
  return text !== null && promptTextOf(text) !== null;
}

/** A message the chat or the history route holds that opened a turn. */
export function isRealPromptMessage(msg: PromptMessageLike): boolean {
  if (msg.role !== "user" || msg.compaction || msg.synthetic || msg.notPrompt) return false;
  return promptTextOf(msg.content) !== null;
}

/** Either shape: a `ChatMessage`-like value has a `role`, a transcript record a `type`. */
export function isRealPrompt(value: PromptMessageLike | ClaudePromptRecord): boolean {
  return "role" in value && typeof value.role === "string"
    ? isRealPromptMessage(value as PromptMessageLike)
    : isRealPromptRecord(value as ClaudePromptRecord);
}

/** First line of a prompt, at most `max` characters, for a turn's one-line label. */
export function promptFirstLine(prompt: string, max = 200): string {
  const line = prompt.trim().split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
