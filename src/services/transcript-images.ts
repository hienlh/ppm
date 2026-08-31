import { readImageDimensions } from "./image-dimensions.ts";
import { base64ByteLength, imagePlaceholderText } from "../shared/tool-result-content.ts";

/**
 * Auditing and removal of image payloads inside a Claude Code session transcript.
 *
 * A transcript is replayed in full on every resume, so each image it carries is re-sent for
 * the rest of the session's life. Past a few images the API refuses any that exceed
 * MANY_IMAGE_DIMENSION_LIMIT on a side and reports that it removed them — so those payloads
 * cost bandwidth and produce an error while contributing nothing to the model's context.
 *
 * Images live in two places, and they are not equally safe to remove. A tool result can be
 * produced again by re-reading the file it came from, so those are removed by default. An
 * image the user attached to a message usually exists nowhere else, so it is left alone
 * unless the caller opts in — which it must be able to do, because a single oversized
 * attachment is enough to make every later turn of the session fail outright.
 *
 * A tool result's payload sits at `message.content[].content[]`; an attachment sits directly
 * at `message.content[]`. A record also carries an image-shaped echo at the top-level
 * `toolUseResult` field, but that one holds no base64 and is not part of an API request, so
 * it is left as the CLI wrote it.
 */

/**
 * Per-image dimension cap the API applies once a request carries several images.
 *
 * The cap is a maximum, so an image measuring exactly this many pixels is already over it.
 * Comparisons here are `>=` rather than `>` for that reason: treating 2000px as acceptable
 * hides the one image the API is rejecting and makes a cleanup look like a no-op.
 */
export const MANY_IMAGE_DIMENSION_LIMIT = 2000;

/** Base64 characters decoded to inspect a header — a JPEG frame can sit behind EXIF. */
const HEADER_CHARS = 4096;

export type StripMode = "oversized" | "all";

/** Which of the two image locations a scan or strip should cover. */
export interface ImageScopeOpts {
  /**
   * Also cover images the user attached to their own messages. Off by default: the payload
   * in the transcript is typically the only remaining copy, so removing it is lossy in a way
   * removing a tool result is not.
   */
  includeAttachments?: boolean;
}

export interface TranscriptImageAudit {
  /** Images found in scope. */
  total: number;
  /** How many are at or over the dimension cap and are therefore already being rejected. */
  oversized: number;
  /** Decoded size of all of them. */
  bytes: number;
  /** Decoded size of the oversized ones. */
  oversizedBytes: number;
  /** Longest side seen, or 0 when no dimensions could be read. */
  largestSide: number;
  /** Of `total`, how many are user attachments rather than tool results. */
  attachments: number;
  /** Of `oversized`, how many are user attachments — these need `includeAttachments` to clear. */
  oversizedAttachments: number;
}

export interface StripResult {
  text: string;
  removed: number;
  bytesFreed: number;
}

interface ImageBlock {
  source?: { data?: unknown };
}

type Visitor = (image: ImageBlock, replace: (block: unknown) => void) => void;

function isImageBlock(value: unknown): value is ImageBlock {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "image";
}

/** Walk a tool result's content, offering each image block and a way to replace it. */
function visitImages(node: unknown, visit: Visitor): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const child = node[i];
      if (isImageBlock(child)) {
        visit(child, (block) => {
          node[i] = block;
        });
      } else {
        visitImages(child, visit);
      }
    }
    return;
  }
  for (const value of Object.values(node)) visitImages(value, visit);
}

/**
 * Images carried by one record, in whichever of the two locations are in scope.
 *
 * The visitor is told which location an image came from so callers can count and report
 * attachments separately — a user needs to know when the image blocking their session is one
 * only they can authorise removing.
 */
function visitRecordImages(
  record: unknown,
  visit: (image: ImageBlock, replace: (block: unknown) => void, isAttachment: boolean) => void,
): void {
  const content = (record as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if ((block as { type?: unknown } | null)?.type === "tool_result") {
      visitImages((block as { content?: unknown }).content, (img, replace) => visit(img, replace, false));
    } else if (isImageBlock(block)) {
      visit(block, (next) => { content[i] = next; }, true);
    }
  }
}

function imageData(image: ImageBlock): string {
  const data = image.source?.data;
  return typeof data === "string" ? data : "";
}

/** Longest side in pixels, or 0 when the format or header could not be read. */
function longestSide(data: string): number {
  if (!data) return 0;
  const slice = data.slice(0, HEADER_CHARS);
  // Base64 decodes in four-character groups; a partial group would corrupt the tail.
  const whole = slice.slice(0, slice.length - (slice.length % 4));
  const size = readImageDimensions(Buffer.from(whole, "base64"));
  return size ? Math.max(size.w, size.h) : 0;
}

/** A zeroed audit, ready to accumulate records into. */
export function emptyImageAudit(): TranscriptImageAudit {
  return {
    total: 0,
    oversized: 0,
    bytes: 0,
    oversizedBytes: 0,
    largestSide: 0,
    attachments: 0,
    oversizedAttachments: 0,
  };
}

/**
 * Fold one JSONL record into a running audit.
 *
 * Exposed per line so a transcript can be measured while it streams; a session large enough
 * to be worth auditing is exactly the one too large to hold in memory as a single string.
 */
export function auditImageLine(audit: TranscriptImageAudit, line: string): void {
  if (!line) return;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  visitRecordImages(record, (image, _replace, isAttachment) => {
    const data = imageData(image);
    const bytes = base64ByteLength(data);
    const side = longestSide(data);
    audit.total++;
    audit.bytes += bytes;
    if (isAttachment) audit.attachments++;
    if (side > audit.largestSide) audit.largestSide = side;
    if (side >= MANY_IMAGE_DIMENSION_LIMIT) {
      audit.oversized++;
      audit.oversizedBytes += bytes;
      if (isAttachment) audit.oversizedAttachments++;
    }
  });
}

export function auditTranscriptImages(text: string): TranscriptImageAudit {
  const audit = emptyImageAudit();
  for (const line of text.split("\n")) auditImageLine(audit, line);
  return audit;
}

/**
 * Rewrite one JSONL record with its in-scope image payloads replaced by placeholder text.
 *
 * `oversized` keeps an image whose dimensions cannot be read, since removing something that
 * may well be within the cap would lose context for no benefit. Attachments are kept unless
 * `includeAttachments` is set — see the note at the top of this file.
 */
export function stripImageLine(
  line: string,
  mode: StripMode,
  opts: ImageScopeOpts = {},
): { line: string; removed: number; bytesFreed: number } {
  if (!line) return { line, removed: 0, bytesFreed: 0 };
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // A line that does not parse is left byte-for-byte as it was found.
    return { line, removed: 0, bytesFreed: 0 };
  }

  let removed = 0;
  let bytesFreed = 0;
  visitRecordImages(record, (image, replace, isAttachment) => {
    if (isAttachment && !opts.includeAttachments) return;
    const data = imageData(image);
    if (mode === "oversized" && longestSide(data) < MANY_IMAGE_DIMENSION_LIMIT) return;
    const bytes = base64ByteLength(data);
    replace({ type: "text", text: imagePlaceholderText(bytes || undefined) });
    removed++;
    bytesFreed += bytes;
  });

  return removed > 0 ? { line: JSON.stringify(record), removed, bytesFreed } : { line, removed: 0, bytesFreed: 0 };
}

export function stripTranscriptImages(
  text: string,
  mode: StripMode,
  opts: ImageScopeOpts = {},
): StripResult {
  let removed = 0;
  let bytesFreed = 0;
  const lines = text.split("\n").map((line) => {
    const r = stripImageLine(line, mode, opts);
    removed += r.removed;
    bytesFreed += r.bytesFreed;
    return r.line;
  });
  return { text: removed > 0 ? lines.join("\n") : text, removed, bytesFreed };
}
