import { createHash } from "node:crypto";
import { readDesignFileSafe } from "../design-safe-walk.ts";
import { writeFileAtomic } from "../design-fs.ts";
import { DesignError } from "../design-error.ts";

/**
 * A design source file (HTML or CSS) as text, plus its `gen`.
 *
 * Everything that addresses a position in a design file — `data-ppm-id` start-tag offsets,
 * style-attribute spans, `:root` declarations — addresses the text *after* a leading BOM is
 * removed, and the gen hashes that same text. The BOM has to go before parsing, not after:
 * parse5 reads U+FEFF as body text, which silently drops the source location of an explicit
 * `<html>`, `<head>` and `<body>`. It is remembered and written back, so a round trip never
 * changes a byte the user did not ask to change.
 */

const BOM = "﻿";
/** Largest source file read as text at all; far above anything an agent writes. */
export const MAX_DESIGN_SOURCE_BYTES = 64 * 1024 * 1024;

export interface DesignSource {
  text: string;
  bom: boolean;
  gen: string;
}

/** 16 hex chars of SHA-256 over the BOM-less text: a staleness check, not a secret. */
export function computeGen(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Bytes to text. `lossy` is for serving only: an invalid sequence becomes U+FFFD, which
 * would corrupt the file if it were ever written back, so write paths use the strict form.
 */
export function decodeDesignText(bytes: Uint8Array, opts: { lossy?: boolean } = {}): DesignSource {
  let raw: string;
  try {
    // ignoreBOM keeps U+FEFF in the output, so it is detected here instead of vanishing.
    raw = new TextDecoder("utf-8", { fatal: !opts.lossy, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new DesignError(422, "ENOTUTF8", "Design file is not valid UTF-8");
  }
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(BOM.length) : raw;
  return { text, bom, gen: computeGen(text) };
}

export async function readDesignSource(
  abs: string,
  opts: { lossy?: boolean; maxBytes?: number } = {},
): Promise<DesignSource> {
  const bytes = await readDesignFileSafe(abs, opts.maxBytes ?? MAX_DESIGN_SOURCE_BYTES);
  return decodeDesignText(bytes, opts);
}

/** Atomic write that restores the BOM the file was read with. Returns the new gen. */
export async function writeDesignSource(abs: string, text: string, opts: { bom: boolean }): Promise<string> {
  if (text.startsWith(BOM)) throw new DesignError(400, "EBOM", "Source text must not start with a BOM");
  await writeFileAtomic(abs, opts.bom ? BOM + text : text);
  return computeGen(text);
}
