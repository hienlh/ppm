import type { ChatEvent } from "../provider.interface.ts";

export interface PatchChange {
  path: string;
  op: "add" | "update" | "delete";
  oldString: string;
  newString: string;
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

/** One file change → PPM Write/Edit tool_use (renders like Claude's Edit/Write). */
export function changeToToolUse(change: PatchChange, toolUseId?: string): ChatEvent {
  if (change.op === "add") {
    return { type: "tool_use", tool: "Write", input: { file_path: change.path, content: change.newString }, toolUseId };
  }
  return {
    type: "tool_use",
    tool: "Edit",
    input: { file_path: change.path, old_string: change.oldString, new_string: change.op === "delete" ? "" : change.newString },
    toolUseId,
  };
}
