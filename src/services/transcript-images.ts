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
 * Only images inside tool results are touched. An image the user attached to a message may
 * no longer exist anywhere else, whereas a tool result can be produced again by re-reading
 * the file it came from.
 *
 * The payload lives at `message.content[].content[]`. A record also carries an image-shaped
 * echo at the top-level `toolUseResult` field, but that one holds no base64 and is not part
 * of an API request, so it is left as the CLI wrote it.
 */

/** Per-image dimension cap the API applies once a request carries several images. */
export const MANY_IMAGE_DIMENSION_LIMIT = 2000;

/** Base64 characters decoded to inspect a header — a JPEG frame can sit behind EXIF. */
const HEADER_CHARS = 4096;

export type StripMode = "oversized" | "all";

export interface TranscriptImageAudit {
  /** Images found in tool results. */
  total: number;
  /** How many exceed the dimension cap and are therefore already being dropped. */
  oversized: number;
  /** Decoded size of all of them. */
  bytes: number;
  /** Decoded size of the oversized ones. */
  oversizedBytes: number;
  /** Longest side seen, or 0 when no dimensions could be read. */
  largestSide: number;
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

/** Images carried by tool results only — attachments on user messages are left alone. */
function visitToolResultImages(record: unknown, visit: Visitor): void {
  const content = (record as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if ((block as { type?: unknown } | null)?.type !== "tool_result") continue;
    visitImages((block as { content?: unknown }).content, visit);
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

export function auditTranscriptImages(text: string): TranscriptImageAudit {
  const audit: TranscriptImageAudit = {
    total: 0,
    oversized: 0,
    bytes: 0,
    oversizedBytes: 0,
    largestSide: 0,
  };

  for (const line of text.split("\n")) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    visitToolResultImages(record, (image) => {
      const data = imageData(image);
      const bytes = base64ByteLength(data);
      const side = longestSide(data);
      audit.total++;
      audit.bytes += bytes;
      if (side > audit.largestSide) audit.largestSide = side;
      if (side > MANY_IMAGE_DIMENSION_LIMIT) {
        audit.oversized++;
        audit.oversizedBytes += bytes;
      }
    });
  }

  return audit;
}

/**
 * Replace image payloads with the standard placeholder text.
 *
 * `oversized` leaves an image whose dimensions cannot be read, since removing something
 * that may well be within the cap would lose context for no benefit.
 */
export function stripTranscriptImages(text: string, mode: StripMode): StripResult {
  let removed = 0;
  let bytesFreed = 0;
  let changed = false;

  const lines = text.split("\n").map((line) => {
    if (!line) return line;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A line that does not parse is left byte-for-byte as it was found.
      return line;
    }

    let touched = false;
    visitToolResultImages(record, (image, replace) => {
      const data = imageData(image);
      if (mode === "oversized" && longestSide(data) <= MANY_IMAGE_DIMENSION_LIMIT) return;
      const bytes = base64ByteLength(data);
      replace({ type: "text", text: imagePlaceholderText(bytes || undefined) });
      removed++;
      bytesFreed += bytes;
      touched = true;
    });

    if (!touched) return line;
    changed = true;
    return JSON.stringify(record);
  });

  return { text: changed ? lines.join("\n") : text, removed, bytesFreed };
}
