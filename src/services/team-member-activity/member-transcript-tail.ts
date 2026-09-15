/**
 * Incremental read of one teammate's transcript, for the member window's poll.
 *
 * A teammate transcript reaches several MB, so the window cannot re-download the
 * whole file every few seconds just to learn that three steps were appended. The
 * client keeps the byte offset it has consumed and asks only for what is past
 * it — the same tail mechanism `nested-subagent-spy.ts` uses for live cards,
 * expressed as one stateless call so an HTTP poll can drive it.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { ChatEvent } from "../../types/chat.ts";
import { createAgentTranscriptLineParser } from "../subagent-transcript-merger.ts";

export interface MemberTranscriptSlice {
  /** Events from the requested offset onward, in file order. */
  events: ChatEvent[];
  /** Offset the next poll should resume from — always a line boundary. */
  nextBytes: number;
  /** The caller's offset no longer fits the file; `events` is the whole file. */
  restarted: boolean;
}

/** Read the bytes a caller has not seen yet and parse them into child events. */
export function readMemberTranscriptSlice(filePath: string, sinceBytes: number): MemberTranscriptSlice {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { events: [], nextBytes: sinceBytes, restarted: false };
  }

  // A shrunk file was rotated or rewritten: the offset is meaningless, start over.
  const restarted = sinceBytes > size;
  const start = restarted || sinceBytes < 0 ? 0 : sinceBytes;
  if (start >= size) return { events: [], nextBytes: start, restarted: false };

  let buf: Buffer;
  const fd = openSync(filePath, "r");
  try {
    buf = Buffer.alloc(size - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    if (read < buf.length) buf = buf.subarray(0, read);
  } catch {
    return { events: [], nextBytes: start, restarted: false };
  } finally {
    closeSync(fd);
  }

  // Stop at the last newline: a half-written record must be re-read next poll,
  // and cutting the buffer on a byte boundary keeps split multi-byte chars whole.
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) return { events: [], nextBytes: start, restarted };

  // A resumed read never begins at the spawn prompt, but the parser's skip only
  // ever drops a user record carrying no tool_result — which emits nothing either
  // way — so the same factory is correct at any offset.
  const parser = createAgentTranscriptLineParser();
  const events: ChatEvent[] = [];
  for (const line of buf.subarray(0, lastNewline + 1).toString("utf8").split("\n")) {
    for (const timed of parser.feed(line)) events.push(timed.ev);
  }
  return { events, nextBytes: start + lastNewline + 1, restarted };
}
