/**
 * What each compaction in a transcript cost and saved.
 *
 * Compaction is the largest single thing that happens to a chat and the only one the
 * transcript records without the UI ever saying so: a session silently loses most of
 * its history, the next turn's prefix collapses, and the only visible trace is a long
 * summary message. This reads the figures back out so the divider above that summary
 * can state them.
 *
 * The link between a boundary and the message it introduces is `parentUuid`. Claude
 * Code writes the `compact_boundary` record with `parentUuid: null` — it is the root
 * of the post-compaction segment — and the summary immediately after it carries the
 * boundary's uuid as its parent. Keying the result by that summary's uuid is what
 * lets both message readers stamp it on without either of them knowing the layout,
 * since `parseSessionMessage` already uses the record uuid as `ChatMessage.id`.
 */

import { existsSync } from "node:fs";
import type { CompactionInfo } from "../types/chat.ts";
import { readLines } from "./read-lines.ts";

/**
 * Cheap test for the only two lines per compaction worth parsing.
 *
 * A transcript reaches tens of megabytes and `JSON.parse` on every line of one is the
 * dominant cost of reading it at all — but a compaction leaves two records in a file
 * that holds thousands, so a substring check keeps this a scan rather than a parse.
 */
const BOUNDARY_MARKER = '"compact_boundary"';

/**
 * Map of compact-summary message uuid → that compaction's figures.
 *
 * Answers an empty map for a missing or unreadable file: a transcript that cannot be
 * read still has messages worth showing, and a divider is not worth failing a history
 * load over.
 */
export async function readCompactions(jsonlPath: string): Promise<Map<string, CompactionInfo>> {
  const byMessageId = new Map<string, CompactionInfo>();
  if (!existsSync(jsonlPath)) return byMessageId;

  // The boundary is read one line before the summary that claims it, so it waits here
  // until a record names it as parent. Held rather than assumed adjacent: the pairing
  // is by uuid, so a record written between the two cannot mis-attach the figures.
  let pending: { uuid: string; info: CompactionInfo } | null = null;

  try {
    for await (const line of readLines(jsonlPath)) {
      if (line.includes(BOUNDARY_MARKER)) {
        const info = parseBoundary(line);
        pending = info ? { uuid: info.uuid, info: info.compaction } : null;
        continue;
      }
      if (!pending) continue;
      // Only lines that could be the child are parsed — the uuid of the boundary is a
      // full uuid, so this substring test has no realistic false positive.
      if (!line.includes(pending.uuid)) continue;
      const child = parseChild(line);
      if (child?.parentUuid === pending.uuid) {
        byMessageId.set(child.uuid, pending.info);
        pending = null;
      }
    }
  } catch {
    // Truncated or mid-write — keep whatever pairs were already complete.
  }
  return byMessageId;
}

/** The boundary's own uuid and figures, or null when the record is not one we can use. */
function parseBoundary(line: string): { uuid: string; compaction: CompactionInfo } | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry?.type !== "system" || entry.subtype !== "compact_boundary") return null;
  const meta = entry.compactMetadata;
  if (typeof entry.uuid !== "string" || !meta) return null;

  const preTokens = numberOr(meta.preTokens, 0);
  const postTokens = numberOr(meta.postTokens, 0);
  // A boundary with no `preTokens` is a record shape this cannot describe — a zero
  // saving would render as a confident "saved 0", which is worse than no divider.
  if (preTokens <= 0) return null;

  return {
    uuid: entry.uuid,
    compaction: {
      trigger: meta.trigger === "manual" ? "manual" : "auto",
      preTokens,
      postTokens,
      // Clamped: `postTokens` is absent on older records, and a summary that somehow
      // measured larger than its input must not report a negative saving.
      savedTokens: Math.max(0, preTokens - postTokens),
      ...(typeof meta.durationMs === "number" ? { durationMs: meta.durationMs } : {}),
    },
  };
}

/** The uuid/parentUuid pair of a candidate child record. */
function parseChild(line: string): { uuid: string; parentUuid: string } | null {
  try {
    const entry = JSON.parse(line);
    if (typeof entry?.uuid !== "string" || typeof entry.parentUuid !== "string") return null;
    return { uuid: entry.uuid, parentUuid: entry.parentUuid };
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Stamp each compaction onto the message that opens its segment. */
export function applyCompactions(
  messages: { id: string; compaction?: CompactionInfo }[],
  byMessageId: Map<string, CompactionInfo>,
): void {
  if (byMessageId.size === 0) return;
  for (const msg of messages) {
    const info = byMessageId.get(msg.id);
    if (info) msg.compaction = info;
  }
}
