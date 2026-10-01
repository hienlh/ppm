import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDesignPlatform, type DesignPlatform, type DesignSystemBuiltFrom } from "../../shared/design-types.ts";
import { isValidDesignSlug } from "./design-slug.ts";

/**
 * Paths and `system.json` parsing shared by the systems service, the preview scope alias and
 * the exports. An app is declared by `designs/systems/<id>/system.json`; the id follows the
 * same rules as a design slug. `default` is special: it is never declared on disk (no folder
 * of its own) and its design-system files stay at the legacy `designs/` root so old designs
 * that link `../tokens.css` keep resolving unchanged.
 */

export const DEFAULT_SYSTEM_ID = "default";
export const SYSTEMS_SUBDIR = "systems";
export const SYSTEM_FILE = "system.json";
const MAX_SYSTEM_FILE_BYTES = 64 * 1024;
const MAX_LABEL_LENGTH = 80;

export function isValidSystemId(value: unknown): value is string {
  return isValidDesignSlug(value);
}

/** `designs/systems`, given the already-resolved real `designs/` root. */
export function systemsRoot(designsRootAbs: string): string {
  return join(designsRootAbs, SYSTEMS_SUBDIR);
}

/** Where a declared app's `system.json` (and any set-up files) live: `designs/systems/<id>/`. */
export function systemDeclDir(designsRootAbs: string, id: string): string {
  return join(systemsRoot(designsRootAbs), id);
}

/**
 * Where an app's design-system output (`DESIGN.md`, `tokens.css`, `kit/`) lives. `default`
 * keeps the legacy location at the `designs/` root itself; every other id gets its own
 * `designs/systems/<id>/` folder.
 */
export function systemFilesDir(designsRootAbs: string, id: string): string {
  return id === DEFAULT_SYSTEM_ID ? designsRootAbs : systemDeclDir(designsRootAbs, id);
}

export interface ParsedSystemFile {
  label: string;
  root: string;
  platform: DesignPlatform;
  builtFrom?: DesignSystemBuiltFrom;
}

function normalizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? Array.from(label).slice(0, MAX_LABEL_LENGTH).join("") : fallback;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function normalizeBuiltFrom(value: unknown): DesignSystemBuiltFrom | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { commit, at } = value as Record<string, unknown>;
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/i.test(commit) || !isIsoDate(at)) return undefined;
  return { commit, at };
}

/**
 * A relative path, `.` for the project root itself: no absolute path, no drive letter, no
 * `..` segment and no segment named `.design` (the canvas's own scratch directory), then
 * checked to stay inside `projectRoot` lexically (the app folder need not exist yet).
 * Returns null for anything that fails the guard.
 */
export function normalizeSystemRoot(projectRoot: string, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") return ".";
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return null;
  const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) return ".";
  if (segments.some((s) => s === ".." || s === ".design")) return null;
  const rel = segments.join("/");
  const resolved = resolve(projectRoot, rel);
  const check = relative(projectRoot, resolved);
  if (check === ".." || check.startsWith(`..${sep}`) || isAbsolute(check)) return null;
  return rel;
}

/** Absolute path of an app's real source root, given its (already normalized) `root`. */
export function systemAppRoot(projectRoot: string, root: string): string {
  return resolve(projectRoot, root);
}

/**
 * Tolerant parse of `system.json`, the same style as the design manifest: a field that fails
 * validation falls back rather than the whole file being rejected, since a hand-edited or
 * partially-written file must still identify the app.
 */
export function parseSystemFile(raw: string | null, fallback: { id: string; projectRoot: string }): ParsedSystemFile {
  let data: unknown = null;
  if (raw !== null && raw.length <= MAX_SYSTEM_FILE_BYTES) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const obj: Record<string, unknown> = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const root = normalizeSystemRoot(fallback.projectRoot, obj.root) ?? ".";
  return {
    label: normalizeLabel(obj.label, fallback.id),
    root,
    platform: isDesignPlatform(obj.platform) ? obj.platform : "web",
    builtFrom: normalizeBuiltFrom(obj.builtFrom),
  };
}

export function serializeSystemFile(file: ParsedSystemFile): string {
  const { label, root, platform, builtFrom } = file;
  return `${JSON.stringify({ label, root, platform, ...(builtFrom ? { builtFrom } : {}) }, null, 2)}\n`;
}
