/**
 * The file a unified diff was made from, given the file it produced.
 *
 * Codex reports a patch only once it is on disk, so its "before" cannot be read the way a
 * Claude tool's is (a hook that runs first). What it does report is the patch as a unified
 * diff (`@@ -a,b +c,d @@`, one line of context), and running that backwards over the file now
 * on disk gives the file before the patch exactly — provided nothing else wrote the file in
 * between. That is checked rather than assumed: every line the diff says the new file holds
 * must be where it says, or the answer is null and the review falls back to git.
 */

interface Hunk {
  oldCount: number;
  newStart: number;
  newCount: number;
  oldLines: string[];
  newLines: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function reverseUnifiedDiff(after: string, diff: string): string | null {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let last: "old" | "new" | "both" | null = null;
  let oldNoEol = false;
  let newNoEol = false;
  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = {
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        oldLines: [],
        newLines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" describes the line just before it.
      if (last === "old" || last === "both") oldNoEol = true;
      if (last === "new" || last === "both") newNoEol = true;
      continue;
    }
    const body = line.slice(1);
    if (line.startsWith("+")) { hunk.newLines.push(body); last = "new"; }
    else if (line.startsWith("-")) { hunk.oldLines.push(body); last = "old"; }
    else if (line.startsWith(" ") || line === "") {
      // A blank context line can lose its leading space on the way through.
      if (line === "" && hunk.oldLines.length + hunk.newLines.length === 0) continue;
      hunk.oldLines.push(body);
      hunk.newLines.push(body);
      last = "both";
    } else {
      return null;
    }
  }
  if (hunks.length === 0) return null;

  const afterEol = after.endsWith("\n");
  const lines = after.split("\n");
  if (afterEol) lines.pop();

  // Bottom-up, so a hunk's line numbers are still those of the file it was written against.
  for (const h of [...hunks].reverse()) {
    // Trailing blank context lines are an artefact of splitting the diff text on "\n".
    while (h.newLines.length > h.newCount && h.oldLines.length > h.oldCount && h.newLines.at(-1) === "" && h.oldLines.at(-1) === "") {
      h.newLines.pop();
      h.oldLines.pop();
    }
    if (h.newLines.length !== h.newCount || h.oldLines.length !== h.oldCount) return null;
    // A count of 0 names the line *after which* the old lines stood.
    const at = h.newCount === 0 ? h.newStart : h.newStart - 1;
    if (at < 0 || at + h.newCount > lines.length) return null;
    for (let i = 0; i < h.newCount; i++) if (lines[at + i] !== h.newLines[i]) return null;
    lines.splice(at, h.newCount, ...h.oldLines);
  }

  const beforeEol = oldNoEol ? false : newNoEol ? true : afterEol;
  const body = lines.join("\n");
  return beforeEol && lines.length > 0 ? `${body}\n` : body;
}
