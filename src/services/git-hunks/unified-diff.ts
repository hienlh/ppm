/**
 * Unified-diff parsing and selective patch building, for staging or discarding
 * part of a file rather than all of it.
 *
 * Staging a subset of lines is not a matter of copying lines out of the diff:
 * the `@@` header counts and the new-file start line both have to be recomputed,
 * and an unselected deletion has to survive as *context* rather than vanish —
 * otherwise the patch describes a file that never existed and `git apply`
 * rejects it. That arithmetic lives here so it can be tested without a
 * repository.
 */

import { createHash } from "node:crypto";

export type DiffLineKind = " " | "+" | "-";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content without the leading +/-/space. */
  text: string;
  /**
   * True when git emitted "\ No newline at end of file" directly after this
   * line. It travels with the line it belongs to.
   */
  noNewline?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the closing `@@`, usually the enclosing function. */
  heading: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  /** Everything before the first `@@`: `diff --git`, `index`, `---`, `+++`. */
  header: string[];
  hunks: DiffHunk[];
  /** True for a diff git refused to express as text. */
  binary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const header: string[] = [];
  const hunks: DiffHunk[] = [];
  let binary = false;
  let current: DiffHunk | null = null;

  // A trailing "\n" produces one empty element that is not part of the diff.
  const lines = diffText.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    const match = HUNK_HEADER.exec(line);
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        heading: match[5] ?? "",
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        binary = true;
      }
      header.push(line);
      continue;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — belongs to the line just before it.
      const previous = current.lines[current.lines.length - 1];
      if (previous) previous.noNewline = true;
      continue;
    }

    const kind = line[0];
    if (kind === " " || kind === "+" || kind === "-") {
      current.lines.push({ kind, text: line.slice(1) });
    } else if (line === "") {
      // git writes a bare empty line for an empty context line.
      current.lines.push({ kind: " ", text: "" });
    }
    // Anything else (a stray "diff --git" for the next file) is ignored: callers
    // pass one file's diff at a time.
  }

  return { header, hunks, binary };
}

/**
 * Which lines of which hunks to include.
 * A hunk mapped to `"all"` is taken whole; a set selects individual lines by
 * their index within `hunk.lines`. Context lines are always kept regardless.
 */
export type HunkSelection = Map<number, "all" | Set<number>>;

export interface BuildPatchOptions {
  /**
   * Build the patch so it can be applied in reverse (`git apply --reverse`),
   * which is how a staged hunk is unstaged or a working-tree hunk discarded.
   *
   * The patch text is identical; what changes is which side is treated as
   * unselected. When reversing, an unselected *addition* must become context
   * (it stays in the file) and an unselected deletion is dropped — the mirror of
   * the forward case.
   */
  reverse?: boolean;
}

/**
 * Render the selected hunks as a patch, or null when the selection is empty.
 */
export function buildPatch(
  parsed: ParsedDiff,
  selection: HunkSelection,
  options: BuildPatchOptions = {},
): string | null {
  if (parsed.binary) throw new Error("A binary file cannot be staged by hunk.");

  const reverse = options.reverse === true;
  const out: string[] = [];
  // Totals over the hunks that actually make it into the patch, which is what
  // decides whether a "whole file" header is still true of it.
  let oldTotal = 0;
  let newTotal = 0;
  // Running difference between the new and old side of the hunks included so
  // far. Skipping a hunk means later hunks start at a different new-file line
  // than the original diff said.
  let offset = 0;

  for (let h = 0; h < parsed.hunks.length; h++) {
    const hunk = parsed.hunks[h]!;
    const picked = selection.get(h);
    if (picked === undefined) continue;

    const isPicked = (index: number) => picked === "all" || picked.has(index);

    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i]!;
      const suffix = line.noNewline ? "\n\\ No newline at end of file" : "";

      if (line.kind === " ") {
        body.push(` ${line.text}${suffix}`);
        oldCount++;
        newCount++;
        continue;
      }

      const selected = isPicked(i);
      // An unselected change has to be represented as whatever the *source*
      // side of this patch already contains, so the patch still applies.
      const keepAsContext = reverse
        ? (line.kind === "+" && !selected)
        : (line.kind === "-" && !selected);
      const drop = reverse
        ? (line.kind === "-" && !selected)
        : (line.kind === "+" && !selected);

      if (drop) continue;
      if (keepAsContext) {
        body.push(` ${line.text}${suffix}`);
        oldCount++;
        newCount++;
        continue;
      }

      body.push(`${line.kind}${line.text}${suffix}`);
      if (line.kind === "-") oldCount++;
      else newCount++;
    }

    // Nothing but context left: including it would be a no-op hunk, which some
    // git versions reject.
    if (!body.some((l) => l.startsWith("+") || l.startsWith("-"))) continue;

    // An insertion-only hunk numbers its old side as "after line N", so the new
    // side starts at N+1. A new file is the extreme case: git writes `-0,0`,
    // and its content begins at line 1.
    const newStartBase = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    // And once a narrowed selection gives that old side real content — the
    // lines that were not picked, kept as context — "after line 0" has to
    // become "from line 1", or the patch names a line that cannot exist.
    const oldStartBase = hunk.oldLines === 0 && oldCount > 0 ? hunk.oldStart + 1 : hunk.oldStart;
    out.push(formatHunkHeader(oldStartBase, oldCount, newStartBase + offset, newCount, hunk.heading));
    out.push(...body);
    offset += newCount - oldCount;
    oldTotal += oldCount;
    newTotal += newCount;
  }

  if (out.length === 0) return null;
  return [...narrowedHeader(parsed.header, oldTotal, newTotal), ...out, ""].join("\n");
}

/**
 * Downgrade a whole-file header that a partial selection has made untrue.
 *
 * `new file mode` says the other side of this patch is empty, and taking only
 * some of a new file's lines stops that being so: the lines left behind become
 * context, and git refuses the patch with "new file X depends on old contents"
 * — which reads as a bug in the file rather than in the patch. `deleted file
 * mode` is the same claim mirrored, and breaks the same way when only some of a
 * deletion is staged. Either becomes an ordinary modification of the one path
 * the header already names.
 *
 * The `index` line goes with them: its hashes describe the whole-file change,
 * not this narrowed one. A patch without one applies the same way.
 */
function narrowedHeader(header: string[], oldTotal: number, newTotal: number): string[] {
  const creates = header.some((line) => line.startsWith("new file mode")) && oldTotal > 0;
  const deletes = header.some((line) => line.startsWith("deleted file mode")) && newTotal > 0;
  if (!creates && !deletes) return header;

  const named = header.find((line) => creates ? line.startsWith("+++ b/") : line.startsWith("--- a/"));
  // Without a path to name, leaving the header alone is the honest failure:
  // git rejects the patch rather than applying it to something unintended.
  if (!named) return header;
  const path = named.slice("+++ b/".length);

  return header.flatMap((line) => {
    if (line.startsWith("new file mode") || line.startsWith("deleted file mode")) return [];
    if (line.startsWith("index ")) return [];
    if (line === "--- /dev/null") return [`--- a/${path}`];
    if (line === "+++ /dev/null") return [`+++ b/${path}`];
    return [line];
  });
}

function formatHunkHeader(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  heading: string,
): string {
  // The two sides are numbered differently once a range is empty.
  //
  // `oldStart` comes straight from git, which already wrote an empty old range
  // as "the line after which content is inserted" (`-0,0` for a new file), so it
  // is emitted verbatim. `newStart` is computed here as the first content line,
  // so an empty new range has to step back one to mean the same thing.
  const oldRange = oldLines === 1 ? `${oldStart}` : `${oldStart},${oldLines}`;
  const newRange = newLines === 1
    ? `${newStart}`
    : `${newLines === 0 ? Math.max(0, newStart - 1) : newStart},${newLines}`;
  return `@@ -${oldRange} +${newRange} @@${heading ? ` ${heading}` : ""}`;
}

/** Select every hunk whole — the "stage this file" case expressed as a patch. */
export function selectAll(parsed: ParsedDiff): HunkSelection {
  const selection: HunkSelection = new Map();
  for (let i = 0; i < parsed.hunks.length; i++) selection.set(i, "all");
  return selection;
}

/**
 * Build a selection from the shape the HTTP layer receives: a list of hunk
 * indexes, each optionally narrowed to specific line indexes.
 */
export function selectionFromRequest(
  parsed: ParsedDiff,
  requested: { hunk: number; lines?: number[] }[],
): HunkSelection {
  const selection: HunkSelection = new Map();
  for (const entry of requested) {
    const index = entry.hunk;
    if (!Number.isInteger(index) || index < 0 || index >= parsed.hunks.length) {
      throw new Error(`No hunk at index ${index}.`);
    }
    if (!entry.lines) {
      selection.set(index, "all");
      continue;
    }
    const hunk = parsed.hunks[index]!;
    const lines = new Set<number>();
    for (const line of entry.lines) {
      if (!Number.isInteger(line) || line < 0 || line >= hunk.lines.length) {
        throw new Error(`No line at index ${line} in hunk ${index}.`);
      }
      lines.add(line);
    }
    selection.set(index, lines);
  }
  return selection;
}

/**
 * A content address for one hunk: everything the user was shown, and nothing
 * about where it sat.
 *
 * Positions are deliberately excluded. An edit somewhere else in the file
 * renumbers every later hunk and shifts its index in the list, but the hunk the
 * user ticked is still the same change — matching on content lets that benign
 * case through while a hunk whose own text moved on no longer matches anything.
 *
 * Computed over the bytes git emitted (see `runGit`'s latin1 decode), so it does
 * not depend on the file's encoding being valid UTF-8.
 */
export function hunkFingerprint(hunk: DiffHunk): string {
  const body = hunk.lines
    .map((line) => `${line.kind}${line.noNewline ? "\\" : ""}${line.text}`)
    .join("\n");
  return createHash("sha256")
    .update(`${hunk.oldLines} ${hunk.newLines} ${hunk.heading}\n${body}`, "latin1")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Resolve each requested hunk to its position in `parsed` by content, refusing
 * anything that is no longer there.
 *
 * Returns the requests rewritten onto current indexes. A caller that skipped
 * this and trusted the incoming index would be resolving a position from one
 * diff against a different diff — which is exactly how the wrong lines get
 * staged without anything failing.
 */
export function resolveRequestedHunks(
  parsed: ParsedDiff,
  requested: { hunk: number; id: string; lines?: number[] }[],
): { hunk: number; lines?: number[] }[] {
  const fingerprints = parsed.hunks.map(hunkFingerprint);
  const taken = new Set<number>();
  return requested.map((entry) => {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error("This selection is from an older client that cannot be verified — reload and try again.");
    }
    const candidates: number[] = [];
    for (let i = 0; i < fingerprints.length; i++) {
      if (fingerprints[i] === entry.id && !taken.has(i)) candidates.push(i);
    }
    if (candidates.length === 0) {
      throw new Error(
        "The file changed since these hunks were listed, so this selection no longer describes it. Reload and try again.",
      );
    }
    // The same edit can appear twice in one file; prefer the position the
    // client actually saw it at before falling back to the first free match.
    const index = candidates.includes(entry.hunk) ? entry.hunk : candidates[0]!;
    taken.add(index);
    return entry.lines ? { hunk: index, lines: entry.lines } : { hunk: index };
  });
}
