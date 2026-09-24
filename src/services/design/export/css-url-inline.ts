import { posix } from "node:path";
import { isLocalHref } from "../preview/html-instrument.ts";
import { TOKENS_CSS_REL, type ReadAsset } from "./design-export-asset-reader.ts";

/**
 * Local asset inlining for the standalone-HTML export: CSS `url()`s and `@import`s become
 * `data:` URIs, so the one exported file works offline.
 *
 * A reference resolves against the file it is written in — a stylesheet's `url()` against
 * that stylesheet, not against the HTML — and must stay inside the design folder (the
 * shared `../tokens.css` is the one allowed step out; it sits inside `designs/`). Absolute,
 * scheme and fragment references are left exactly as they are: CDN links are allowed in a
 * design and are not local. Every asset read is charged to one shared {@link InlineBudget};
 * a missing, refused or over-budget asset keeps its original reference and adds a warning,
 * so an export never fails because of one link.
 */

export interface InlineBudget {
  /** Largest single asset, in bytes. */
  perAsset: number;
  /** Bytes still allowed across the whole export; decremented as assets are inlined. */
  remaining: number;
}

export interface InlineContext {
  readAsset: ReadAsset;
  budget: InlineBudget;
  warnings: string[];
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".vtt": "text/vtt",
};

export function mimeForPath(rel: string): string {
  return MIME[posix.extname(rel).toLowerCase()] ?? "application/octet-stream";
}

export function toDataUri(rel: string, bytes: Uint8Array): string {
  return `data:${mimeForPath(rel)};base64,${Buffer.from(bytes).toString("base64")}`;
}

export type ResolvedRef = { rel: string; suffix: string } | { outside: true } | null;

/**
 * A reference written in a file under `baseDir` (design-relative, `""` for the design root),
 * as a design-relative path plus its `#fragment`. Null when it is not a local reference at all.
 */
export function resolveDesignRef(ref: string, baseDir: string): ResolvedRef {
  if (!isLocalHref(ref)) return null;
  const hash = ref.indexOf("#");
  const suffix = hash >= 0 ? ref.slice(hash) : "";
  let path = (hash >= 0 ? ref.slice(0, hash) : ref).split("?")[0]!.trim();
  try {
    path = decodeURIComponent(path);
  } catch {
    return { outside: true };
  }
  if (!path || path.includes("\\") || path.includes("\0")) return { outside: true };
  const rel = posix.normalize(posix.join(baseDir, path));
  if (rel === TOKENS_CSS_REL) return { rel, suffix };
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/") || rel.split("/").some((s) => s.startsWith("."))) {
    return { outside: true };
  }
  return { rel, suffix };
}

const sizeLabel = (bytes: number): string =>
  (bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Reads one asset for inlining, charging the budget; null (with a warning) when it cannot be. */
export async function loadInlineAsset(rel: string, ctx: InlineContext): Promise<Uint8Array | null> {
  const result = await ctx.readAsset(rel, ctx.budget.perAsset);
  if (!result.ok) {
    ctx.warnings.push(result.reason === "missing" ? `${rel}: not found, left linked`
      : result.reason === "too-large" ? `${rel}: larger than ${sizeLabel(ctx.budget.perAsset)}, left linked`
      : `${rel}: not readable from the design folder, left linked`);
    return null;
  }
  if (result.bytes.byteLength > ctx.budget.remaining) {
    ctx.warnings.push(`${rel}: the export's size limit is used up, left linked`);
    return null;
  }
  ctx.budget.remaining -= result.bytes.byteLength;
  return result.bytes;
}

// `@import url(x)` / `@import "x"` first, so the url() of an import is inlined as CSS.
const REF_RE = /@import\s+(?:url\(\s*(["']?)([^"')]*)\1\s*\)|(["'])([^"']*)\3)|url\(\s*(["']?)([^"')]*?)\5\s*\)/gi;
const MAX_IMPORT_DEPTH = 4;

/**
 * `css` with every local `url()` turned into a data URI and every local `@import` replaced
 * by a data URI of the imported sheet, itself inlined against its own folder.
 */
export async function inlineCssUrls(css: string, cssFileDir: string, ctx: InlineContext, depth = 0): Promise<string> {
  const out: string[] = [];
  let cursor = 0;
  for (const m of css.matchAll(REF_RE)) {
    const isImport = m[0].charAt(0) === "@";
    const ref = isImport ? (m[2] ?? m[4] ?? "") : (m[6] ?? "");
    const resolved = resolveDesignRef(ref, cssFileDir);
    if (!resolved) continue;
    if ("outside" in resolved) {
      ctx.warnings.push(`${ref}: outside the design folder, left linked`);
      continue;
    }
    if (isImport && depth >= MAX_IMPORT_DEPTH) {
      ctx.warnings.push(`${resolved.rel}: @import nested too deeply, left linked`);
      continue;
    }
    const bytes = await loadInlineAsset(resolved.rel, ctx);
    if (!bytes) continue;
    let replacement: string;
    if (isImport) {
      const inner = await inlineCssUrls(new TextDecoder().decode(bytes), posix.dirname(resolved.rel), ctx, depth + 1);
      replacement = `@import url("${toDataUri(resolved.rel, new TextEncoder().encode(inner))}")`;
    } else {
      replacement = `url("${toDataUri(resolved.rel, bytes)}${resolved.suffix}")`;
    }
    out.push(css.slice(cursor, m.index), replacement);
    cursor = m.index! + m[0].length;
  }
  out.push(css.slice(cursor));
  return out.join("");
}
