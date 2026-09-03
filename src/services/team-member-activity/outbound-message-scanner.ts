/**
 * Recover the replies teammates send back, which the inboxes do not hold.
 *
 * A team inbox only ever contains what was sent *to* that handle, and in
 * practice that is just the lead's task assignments. A teammate's own reports
 * ("phase 3 done, commit 5344b74", "blocked, need file ownership") are
 * `SendMessage` tool calls inside its transcript, addressed to the orchestrator.
 * Reading them here is what turns the activity panel from a one-way task list
 * into the actual conversation.
 *
 * Transcripts are append-only, so each is scanned incrementally: only bytes
 * added since the last scan are read, which keeps a 6 MB transcript from being
 * re-parsed on every poll.
 */

import { open, stat } from "node:fs/promises";

export interface OutboundTeamMessage {
  /** Teammate handle that sent it. */
  from: string;
  /** Recipient as addressed by the agent — often `main` for the orchestrator. */
  to: string;
  /** Raw message body; may itself be a JSON protocol payload. */
  text: string;
  /** Author-supplied one-line label, when given. */
  summary?: string;
  /** ISO timestamp of the record carrying the call. */
  timestamp: string;
}

interface ScanState {
  /** Byte offset of the first unscanned byte. */
  offset: number;
  messages: OutboundTeamMessage[];
}

/** Per-transcript incremental scan state, keyed by absolute path. */
const scanCache = new Map<string, ScanState>();

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Extract SendMessage calls from one transcript record. */
function collectFromRecord(rec: Record<string, unknown>, from: string, into: OutboundTeamMessage[]): void {
  const content = (rec.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return;
  const timestamp = str(rec.timestamp);
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type !== "tool_use" || block.name !== "SendMessage") continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    // Canonical schema is `{ to, message }`; older team prompts taught
    // `{ recipient, content }` and agents still emit both shapes.
    const to = str(input.to) || str(input.recipient);
    const message = input.message ?? input.content;
    const text = typeof message === "string" ? message : message == null ? "" : JSON.stringify(message);
    if (!to && !text) continue;
    const summary = str(input.summary);
    into.push({ from, to: to || "main", text, timestamp, ...(summary ? { summary } : {}) });
  }
}

/**
 * Messages a teammate sent out, from its transcript.
 *
 * @param path Absolute transcript path.
 * @param from Teammate handle to attribute the messages to.
 */
export async function scanOutboundMessages(path: string, from: string): Promise<OutboundTeamMessage[]> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return [];
  }

  const cached = scanCache.get(path);
  // A shrunk file was rewritten, not appended — the cached offset is meaningless.
  const state: ScanState = cached && cached.offset <= size ? cached : { offset: 0, messages: [] };
  scanCache.set(path, state);
  if (state.offset >= size) return state.messages;

  const length = size - state.offset;
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return state.messages;
  }
  let chunk = "";
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, state.offset);
    chunk = buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return state.messages;
  } finally {
    await handle.close().catch(() => {});
  }

  // Advance only past the last complete line; a partial trailing record is
  // re-read on the next scan once the writer has finished it.
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline < 0) return state.messages;
  const complete = chunk.slice(0, lastNewline);
  state.offset += Buffer.byteLength(complete, "utf8") + 1;

  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("SendMessage")) continue;
    try {
      collectFromRecord(JSON.parse(trimmed), from, state.messages);
    } catch {
      /* malformed record */
    }
  }
  return state.messages;
}

/** Drop cached scan state (used by tests and when a team is deleted). */
export function clearOutboundScanCache(): void {
  scanCache.clear();
}
