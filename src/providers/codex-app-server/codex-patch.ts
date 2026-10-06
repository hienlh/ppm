import type { ChatEvent } from "../provider.interface.ts";

export interface PatchChange {
  path: string;
  op: "add" | "update" | "delete";
  oldString: string;
  newString: string;
  /** The update as codex wrote it (`@@` hunks), kept for working out the file it replaced. */
  unifiedDiff?: string;
  /** Where an update moved the file to, if it did. */
  movePath?: string;
}

/** Split +/- lines (apply-patch or unified-diff body) into old/new text. */
function splitPlusMinus(lines: string[]): { oldString: string; newString: string } {
  const oldL: string[] = [];
  const newL: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) newL.push(line.slice(1));
    else if (line.startsWith("-")) oldL.push(line.slice(1));
    else if (line.startsWith(" ")) { oldL.push(line.slice(1)); newL.push(line.slice(1)); }
  }
  return { oldString: oldL.join("\n"), newString: newL.join("\n") };
}

/** Parse codex `apply_patch` input (`*** Begin Patch` … `*** End Patch`) → changes. */
export function parseApplyPatch(input: string): PatchChange[] {
  const out: PatchChange[] = [];
  let path = ""; let op: PatchChange["op"] | null = null; let body: string[] = [];
  const flush = () => {
    if (op && path) { const { oldString, newString } = splitPlusMinus(body); out.push({ path, op, oldString, newString }); }
    op = null; path = ""; body = [];
  };
  for (const line of input.split("\n")) {
    if (line.startsWith("*** Add File: ")) { flush(); op = "add"; path = line.slice(14).trim(); }
    else if (line.startsWith("*** Update File: ")) { flush(); op = "update"; path = line.slice(17).trim(); }
    else if (line.startsWith("*** Delete File: ")) { flush(); op = "delete"; path = line.slice(17).trim(); }
    else if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) { continue; }
    else if (op) body.push(line);
  }
  flush();
  return out;
}

/** Unified diff (live FileUpdateChange.diff) → old/new text. */
export function diffToOldNew(diff: string): { oldString: string; newString: string } {
  return splitPlusMinus((diff || "").split("\n"));
}

/** An update's diff, without the "Moved to:" note codex appends to a moved file's. */
function updateDiff(diff: string): string {
  const moved = diff.indexOf("\n\nMoved to: ");
  return moved < 0 ? diff : diff.slice(0, moved);
}

/** One change from codex's `kind`/`diff` pair (live) or `type`/`content` pair (rollout). */
function toPatchChange(path: string, type: unknown, text: string, movePath: unknown): PatchChange | null {
  if (!path) return null;
  const move = typeof movePath === "string" && movePath ? { movePath } : {};
  // An added or deleted file arrives as its whole content, with no +/- prefixes: read as a
  // diff, it kept only the lines that happened to start with a space. A version that does
  // send hunks for one is still read as hunks.
  if (type === "add") {
    return { path, op: "add", oldString: "", newString: text.startsWith("@@") ? diffToOldNew(text).newString : text };
  }
  if (type === "delete") {
    return { path, op: "delete", oldString: text.startsWith("@@") ? diffToOldNew(text).oldString : text, newString: "" };
  }
  const unifiedDiff = updateDiff(text);
  return { path, op: "update", ...diffToOldNew(unifiedDiff), unifiedDiff, ...move };
}

/** Live `fileChange.changes` (app-server v2): `[{ path, kind: { type, move_path }, diff }]`. */
export function fileUpdateChanges(raw: unknown): PatchChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const ch = (c ?? {}) as { path?: unknown; kind?: { type?: unknown; move_path?: unknown }; diff?: unknown };
    const change = toPatchChange(String(ch.path ?? ""), ch.kind?.type ?? "update", String(ch.diff ?? ""), ch.kind?.move_path);
    return change ? [change] : [];
  });
}

/** Rollout `FileChange.changes` (`item_completed`): `{ [path]: { type, content | unified_diff, move_path } }`. */
export function rolloutFileChanges(raw: unknown): PatchChange[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([path, v]) => {
    const ch = (v ?? {}) as { type?: unknown; content?: unknown; unified_diff?: unknown; move_path?: unknown };
    const text = String((ch.type === "update" ? ch.unified_diff : ch.content) ?? "");
    const change = toPatchChange(path, ch.type ?? "update", text, ch.move_path);
    return change ? [change] : [];
  });
}

/**
 * A patch → PPM Write/Edit tool_use (renders like Claude's Edit/Write).
 *
 * The card shows the first file. A patch touching several files also lists every one of
 * them under `files`, which is what the turn's change rollup and the session's review read:
 * with only the first, a five-file patch was counted as one file.
 */
export function changeToToolUse(change: PatchChange, toolUseId?: string, all: PatchChange[] = [change]): ChatEvent {
  const files = all.length > 1
    ? {
        files: all.map((c) => ({
          file_path: c.path,
          op: c.op,
          old_string: c.oldString,
          new_string: c.op === "delete" ? "" : c.newString,
        })),
      }
    : {};
  if (change.op === "add") {
    return { type: "tool_use", tool: "Write", input: { file_path: change.path, content: change.newString, ...files }, toolUseId };
  }
  return {
    type: "tool_use",
    tool: "Edit",
    input: { file_path: change.path, old_string: change.oldString, new_string: change.op === "delete" ? "" : change.newString, ...files },
    toolUseId,
  };
}
