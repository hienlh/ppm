import { isAbsolute, relative, resolve, sep } from "node:path";
import { DesignError } from "../design-error.ts";

/**
 * Which page of a design `GET …/export/html?entry=` may export.
 *
 * Checked on the already-decoded query value, and deliberately stricter than a path join:
 * a small character set (so `%`, `\`, `:` and NUL — the usual smuggling tools, including a
 * second round of percent-encoding — are refused outright), no `..` and no segment starting
 * with `.` (which rules out the design's own `.design/` working data), an `.html`/`.htm`
 * name, and a result that still resolves inside the design folder. Pure: nothing touches
 * the disk here; the export reads the file through the safe reader afterwards.
 */

export const EXPORT_ENTRY_RE = /^[A-Za-z0-9._/-]{1,200}\.html?$/;

export interface ExportEntry {
  /** `/`-separated, relative to the design folder. */
  rel: string;
  abs: string;
}

const bad = (): DesignError => new DesignError(400, "EBADENTRY", "Invalid entry: expected an .html file inside the design");

export function validateExportEntry(raw: unknown, designDir: string): ExportEntry {
  if (typeof raw !== "string" || !EXPORT_ENTRY_RE.test(raw)) throw bad();
  const segments = raw.split("/");
  if (segments.some((s) => s === "" || s === ".." || s.startsWith("."))) throw bad();
  const abs = resolve(designDir, ...segments);
  const rel = relative(designDir, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw bad();
  return { rel: rel.split(sep).join("/"), abs };
}
