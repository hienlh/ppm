/**
 * Cutting one multi-file `git diff` into per-file sections, while it streams.
 *
 * The whole working tree is diffed in one run per side rather than one run per
 * file, so the output has to be split back up by path. Two things make that
 * less obvious than splitting at `diff --git`:
 *
 * - The path in that header is C-quoted when it holds a quote, a backslash, a
 *   control character or (by default) any non-ASCII byte, and is *not* quoted
 *   when it merely holds spaces — so `diff --git a/x b/y b/x b/y` is a real
 *   header for the file `x b/y`. Every diff here runs with `--no-renames`, so
 *   both sides name the same path and the header can be read by symmetry.
 * - The output can be arbitrarily large: one generated file can produce
 *   hundreds of megabytes. Text is therefore kept per section only up to a cap;
 *   past it the section is still counted, so it can be offered as one block.
 *
 * Input is latin1-decoded (one char per byte), as `runGit` produces, so paths
 * and text here are byte strings: a chunk boundary can never split a character.
 */

export interface DiffSection {
  /** As git printed it, unquoted, still one char per byte. */
  path: string;
  /** The section's text, or null once it outgrew the cap. */
  text: string | null;
  added: number;
  removed: number;
  /** `@@` lines seen. */
  hunks: number;
  binary: boolean;
  newFile: boolean;
  deletedFile: boolean;
  oldMode?: string;
  newMode?: string;
  /** The mode on an `index` line, which git writes when the mode did not change. */
  indexMode?: string;
}

export interface SplitterLimits {
  /** Text kept for one section. */
  maxSectionBytes: number;
  /** Text kept across all sections of one run. */
  maxTotalBytes: number;
}

const DIFF_GIT = "diff --git ";

/** Read a C-quoted string starting at `start` (the opening quote). */
function readQuoted(s: string, start: number): { value: string; end: number } | null {
  let out = "";
  let i = start + 1;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\"") return { value: out, end: i + 1 };
    if (ch !== "\\") { out += ch; i++; continue; }
    const next = s[i + 1];
    if (next === undefined) return null;
    if (next >= "0" && next <= "7") {
      const digits = s.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(digits)) return null;
      out += String.fromCharCode(parseInt(digits, 8));
      i += 4;
      continue;
    }
    const simple: Record<string, string> = {
      a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", "\"": "\"", "\\": "\\",
    };
    const mapped = simple[next];
    if (mapped === undefined) return null;
    out += mapped;
    i += 2;
  }
  return null;
}

/**
 * The path a `diff --git` header names, or null when it cannot be read.
 *
 * Only correct for a header whose two sides are the same path, which
 * `--no-renames` guarantees.
 */
export function parseDiffGitPath(line: string): string | null {
  if (!line.startsWith(DIFF_GIT)) return null;
  const rest = line.slice(DIFF_GIT.length);

  if (rest.startsWith("\"")) {
    const first = readQuoted(rest, 0);
    if (!first || !first.value.startsWith("a/")) return null;
    return first.value.slice(2);
  }

  // `a/P b/P`: the two halves are the same length, which is what lets a path
  // containing " b/" be read at all.
  if (rest.startsWith("a/") && (rest.length - 5) % 2 === 0) {
    const n = (rest.length - 5) / 2;
    const left = rest.slice(2, 2 + n);
    if (rest.slice(2 + n, 5 + n) === " b/" && rest.slice(5 + n) === left) return left;
  }
  return null;
}

interface OpenSection {
  section: DiffSection;
  parts: string[];
  bytes: number;
  inHeader: boolean;
}

/**
 * Feed latin1 chunks of `git diff` output with `push`, then call `end`.
 *
 * A combined diff (`diff --cc`, written for an unmerged path) is skipped, as is
 * the `* Unmerged path` notice `git diff --cached` prints for one: a conflicted
 * file has no blocks until it is resolved.
 */
export class DiffSectionSplitter {
  private readonly sections: DiffSection[] = [];
  private current: OpenSection | null = null;
  private carry = "";
  private keptBytes = 0;

  constructor(private readonly limits: SplitterLimits) {}

  push(chunk: string): void {
    const text = this.carry + chunk;
    let from = 0;
    for (;;) {
      const nl = text.indexOf("\n", from);
      if (nl === -1) break;
      this.line(text.slice(from, nl));
      from = nl + 1;
    }
    this.carry = text.slice(from);
  }

  end(): DiffSection[] {
    if (this.carry) this.line(this.carry);
    this.carry = "";
    this.close();
    return this.sections;
  }

  private close(): void {
    const open = this.current;
    if (!open) return;
    this.current = null;
    if (open.section.text !== null) open.section.text = open.parts.length ? `${open.parts.join("\n")}\n` : "";
    this.sections.push(open.section);
  }

  private line(line: string): void {
    if (line.startsWith(DIFF_GIT)) {
      this.close();
      const path = parseDiffGitPath(line);
      if (path === null) return;
      this.current = {
        section: {
          path, text: "", added: 0, removed: 0, hunks: 0, binary: false, newFile: false, deletedFile: false,
        },
        parts: [],
        bytes: 0,
        inHeader: true,
      };
      this.keep(line);
      return;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      this.close();
      return;
    }
    if (line.startsWith("* Unmerged path ")) return;

    const open = this.current;
    if (!open) return;
    const section = open.section;

    if (line.startsWith("@@")) {
      open.inHeader = false;
      section.hunks++;
    } else if (open.inHeader) {
      if (line.startsWith("new file mode ")) {
        section.newFile = true;
        section.newMode = line.slice(14);
      } else if (line.startsWith("deleted file mode ")) {
        section.deletedFile = true;
        section.oldMode = line.slice(18);
      } else if (line.startsWith("old mode ")) {
        section.oldMode = line.slice(9);
      } else if (line.startsWith("new mode ")) {
        section.newMode = line.slice(9);
      } else if (line.startsWith("index ")) {
        const mode = line.split(" ")[2];
        if (mode) section.indexMode = mode;
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        section.binary = true;
      }
    } else if (line[0] === "+") {
      section.added++;
    } else if (line[0] === "-") {
      section.removed++;
    }
    this.keep(line);
  }

  private keep(line: string): void {
    const open = this.current!;
    if (open.section.text === null) return;
    const size = line.length + 1;
    if (open.bytes + size > this.limits.maxSectionBytes || this.keptBytes + size > this.limits.maxTotalBytes) {
      this.keptBytes -= open.bytes;
      open.section.text = null;
      open.parts = [];
      open.bytes = 0;
      return;
    }
    open.parts.push(line);
    open.bytes += size;
    this.keptBytes += size;
  }
}

/** Convenience for whole outputs, mostly for tests. */
export function splitDiffSections(output: string, limits: SplitterLimits = {
  maxSectionBytes: Number.POSITIVE_INFINITY,
  maxTotalBytes: Number.POSITIVE_INFINITY,
}): DiffSection[] {
  const splitter = new DiffSectionSplitter(limits);
  splitter.push(output);
  return splitter.end();
}
