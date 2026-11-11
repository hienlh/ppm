/**
 * Replace in the search host (`ppm __search__`), never on the server's main thread.
 *
 * Stateless: the browser sends exactly the matches it shows (file, line, column,
 * matched text, replacement already computed by the search engine). Each file is
 * checked, read, and every match verified at its line/column before anything is
 * written; one match no longer where it was skips the whole file (`changed`)
 * rather than replace something else. Every column refers to the file as read,
 * so the rewrite never shifts a later match.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import type { ReplaceMatch, ReplaceReport, ReplaceRequest } from "./search-options.ts";

/** Folders a replace never writes into, whatever the search listed. */
const REFUSED_SEGMENTS = new Set([".git", "node_modules"]);

/** The path of `child` inside `root`, or null when it is the root itself or outside it. */
function inside(root: string, child: string): string | null {
  const rel = relative(root, child);
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return null;
  return rel;
}

const hasRefusedSegment = (rel: string) => rel.split(/[\\/]/).some((s) => REFUSED_SEGMENTS.has(s));

/** Resolves a listed file to the real path to write, or throws with the reason. */
async function checkedPath(projectPath: string, realProject: string, file: string): Promise<string> {
  const resolved = resolve(projectPath, file);
  const rel = inside(projectPath, resolved);
  if (rel === null) throw new Error("outside the project");
  if (hasRefusedSegment(rel)) throw new Error("inside .git or node_modules");
  if (isCredentialPath(resolved)) throw new Error("access denied");

  let real: string;
  try {
    real = await realpath(resolved);
  } catch (e) {
    throw new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : (e as Error).message);
  }
  const realRel = inside(realProject, real);
  if (realRel === null) throw new Error("outside the project");
  if (hasRefusedSegment(realRel)) throw new Error("inside .git or node_modules");
  if (isCredentialPath(real)) throw new Error("access denied");
  return real;
}

/** Offset of each line's first character; line 1 starts after a BOM, as ripgrep reports it. */
function lineStarts(text: string): number[] {
  const starts = [text.charCodeAt(0) === 0xfeff ? 1 : 0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

type Located = { start: number; end: number; replacement: string };

/** Each match's absolute range, or null when any is no longer where the search found it. */
function locate(text: string, matches: ReplaceMatch[]): Located[] | null {
  const starts = lineStarts(text);
  const located: Located[] = [];
  for (const match of matches) {
    const lineStart = starts[match.line - 1];
    if (lineStart === undefined || match.column < 0) return null;
    const nextLine = starts[match.line];
    const lineEnd = nextLine === undefined ? text.length : nextLine - 1;
    const start = lineStart + match.column;
    const end = start + match.text.length;
    if (end > lineEnd || !text.startsWith(match.text, start)) return null;
    located.push({ start, end, replacement: match.replacement });
  }
  located.sort((a, b) => a.start - b.start);
  for (let i = 1; i < located.length; i++) {
    if (located[i]!.start < located[i - 1]!.end) return null;
  }
  return located;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function runReplace(projectPath: string, req: ReplaceRequest): Promise<ReplaceReport> {
  const report: ReplaceReport = { replaced: 0, files: 0, skipped: [], failed: [] };
  const root = resolve(projectPath);
  let realProject: string;
  try {
    realProject = await realpath(root);
  } catch (e) {
    for (const { file } of req.files) report.failed.push({ file, reason: `project not found: ${(e as Error).message}` });
    return report;
  }

  for (const { file, matches } of req.files) {
    if (matches.length === 0) continue;
    try {
      const path = await checkedPath(root, realProject, file);
      let text: string;
      try {
        text = utf8.decode(await readFile(path));
      } catch (e) {
        if (e instanceof TypeError) throw new Error("not UTF-8 text");
        throw e;
      }
      const located = locate(text, matches);
      if (!located) {
        report.skipped.push({ file, reason: "changed" });
        continue;
      }
      // Spliced in one pass: ranges were checked against the text as read and do not overlap.
      const parts: string[] = [];
      let at = 0;
      for (const { start, end, replacement } of located) {
        parts.push(text.slice(at, start), replacement);
        at = end;
      }
      parts.push(text.slice(at));
      await writeFile(path, parts.join(""));
      report.replaced += located.length;
      report.files += 1;
    } catch (e) {
      report.failed.push({ file, reason: (e as Error).message });
    }
  }
  return report;
}
