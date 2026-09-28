import { isDesignKind, type DesignKind } from "../../shared/design-types.ts";

/**
 * `designs/<slug>/design.json`. The agent edits this file too (it declares `tweaks` there),
 * so parsing is tolerant: known fields are validated and fall back to defaults one by one,
 * and every field this module does not own is carried through verbatim, so a rename never
 * drops what the agent or a later feature wrote.
 */

export const MANIFEST_FILE = "design.json";
export const DEFAULT_ENTRY = "index.html";
export const MAX_TITLE_LENGTH = 120;

export interface DesignManifest {
  title: string;
  kind: DesignKind;
  entry: string;
  createdAt: string;
  updatedAt: string;
  /** Every other top-level field, `tweaks` included, kept as found. */
  extra: Record<string, unknown>;
}

const OWN_FIELDS = new Set(["title", "kind", "entry", "createdAt", "updatedAt"]);

/** Trimmed, control characters removed, at most {@link MAX_TITLE_LENGTH}; null when empty. */
export function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return Array.from(title).slice(0, MAX_TITLE_LENGTH).join("");
}

/**
 * An entry is a relative `.html`/`.htm` path inside the design, built from plain segments.
 * No `..`, no leading dot segment (that would reach `.design/`), no separators other than `/`.
 */
export function isSafeEntry(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200) return false;
  if (!/\.html?$/i.test(value)) return false;
  return value.split("/").every((seg) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(seg));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

export interface ParsedManifest {
  manifest: DesignManifest;
  /** False when the file was missing, not JSON, or not an object; the manifest is then all defaults. */
  valid: boolean;
}

export function parseManifest(raw: string | null, fallback: { slug: string; now: string }): ParsedManifest {
  let data: unknown = null;
  if (raw !== null) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const valid = typeof data === "object" && data !== null && !Array.isArray(data);
  const obj: Record<string, unknown> = valid ? (data as Record<string, unknown>) : {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!OWN_FIELDS.has(key)) extra[key] = value;
  }
  const createdAt = isIsoDate(obj.createdAt) ? obj.createdAt : fallback.now;
  return {
    valid,
    manifest: {
      title: normalizeTitle(obj.title) ?? fallback.slug,
      kind: isDesignKind(obj.kind) ? obj.kind : "page",
      entry: isSafeEntry(obj.entry) ? obj.entry : DEFAULT_ENTRY,
      createdAt,
      updatedAt: isIsoDate(obj.updatedAt) ? obj.updatedAt : createdAt,
      extra,
    },
  };
}

export function serializeManifest(manifest: DesignManifest): string {
  const { extra, ...own } = manifest;
  return `${JSON.stringify({ ...own, ...withoutOwnFields(extra) }, null, 2)}\n`;
}

function withoutOwnFields(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) if (!OWN_FIELDS.has(key)) out[key] = value;
  return out;
}
