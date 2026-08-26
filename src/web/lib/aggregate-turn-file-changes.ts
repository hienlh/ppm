/**
 * Aggregate the file mutations of a single assistant turn.
 *
 * Feeds the change tray (see turn-change-pill.tsx). Pure — no I/O, no React — so it
 * works identically on live-streamed events and on messages parsed back from a JSONL
 * transcript.
 *
 * Note on diffs: Edit's `old_string`/`new_string` are disjoint *fragments* at unknown
 * offsets, so per-file edits cannot be composed into one whole-file diff. Each
 * fragment is kept separate and rendered on its own.
 */
import { diffLines } from "diff";
import type { ChatEvent, ChatMessage } from "../../types/chat";

export type FileChangeOp = "create" | "write" | "edit" | "notebook";

/** Tools whose input mutates a file. Kept in one place so it stays greppable. */
export const FILE_MUTATION_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Rank for resolving `op` when several tools touch the same file in one turn. */
const OP_RANK: Record<FileChangeOp, number> = { create: 3, write: 2, notebook: 2, edit: 1 };

export interface FileEditFragment {
  /** "" for Write/NotebookEdit — the prior content is not in the tool input. */
  oldStr: string;
  newStr: string;
  toolUseId?: string;
  /** Index within this tool call's edits (always 0 except MultiEdit). */
  editIndex: number;
  /** Anchor key matching `data-edit-ref` on the tool card. */
  editRef?: string;
  viaSubagent: boolean;
}

export interface TurnFileChange {
  filePath: string;
  op: FileChangeOp;
  editCount: number;
  linesAdded: number;
  linesRemoved: number;
  edits: FileEditFragment[];
  /** True when *any* edit to this file came from a spawned sub-agent. */
  viaSubagent: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function countLines(oldStr: string, newStr: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldStr, newStr)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/**
 * Write's input looks identical whether the file existed or not — only the tool
 * result distinguishes them. Absent during streaming, hence the "write" default.
 */
function writeOp(output: string | undefined): FileChangeOp {
  return output && /created successfully/i.test(output) ? "create" : "write";
}

type RawChange = { filePath: string; op: FileChangeOp; fragments: Array<{ oldStr: string; newStr: string }> };

function extractChange(tool: string, input: Record<string, unknown>, result?: string): RawChange | null {
  switch (tool) {
    case "Write": {
      const filePath = str(input.file_path);
      if (!filePath) return null;
      return { filePath, op: writeOp(result), fragments: [{ oldStr: "", newStr: str(input.content) }] };
    }
    case "Edit": {
      const filePath = str(input.file_path);
      if (!filePath) return null;
      return {
        filePath,
        op: "edit",
        fragments: [{ oldStr: str(input.old_string), newStr: str(input.new_string) }],
      };
    }
    case "MultiEdit": {
      const filePath = str(input.file_path);
      if (!filePath || !Array.isArray(input.edits)) return null;
      const fragments = (input.edits as unknown[])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({ oldStr: str(e.old_string), newStr: str(e.new_string) }));
      if (fragments.length === 0) return null;
      return { filePath, op: "edit", fragments };
    }
    case "NotebookEdit": {
      // Real param is `notebook_path`; file_path accepted because callers vary.
      const filePath = str(input.notebook_path) || str(input.file_path);
      if (!filePath) return null;
      return { filePath, op: "notebook", fragments: [{ oldStr: "", newStr: str(input.new_source) }] };
    }
    default:
      return null;
  }
}

/** Index tool_result output by toolUseId, recursing into sub-agent children. */
function collectResults(events: ChatEvent[] | undefined, out: Map<string, string>): void {
  if (!events) return;
  for (const ev of events) {
    if (ev.type === "tool_result" && ev.toolUseId) out.set(ev.toolUseId, ev.output ?? "");
    if (ev.type === "tool_use") {
      // The WS layer also embeds the result onto the tool_use for reconnect replay.
      const embedded = (ev as { result?: { output?: string } }).result;
      if (ev.toolUseId && embedded?.output != null && !out.has(ev.toolUseId)) {
        out.set(ev.toolUseId, embedded.output);
      }
      collectResults(ev.children, out);
    }
  }
}

function walk(
  events: ChatEvent[] | undefined,
  viaSubagent: boolean,
  files: Map<string, TurnFileChange>,
  results: Map<string, string>,
): void {
  if (!events) return;
  for (const ev of events) {
    if (ev.type !== "tool_use") continue;
    // Agent/Task wrap their own event stream — everything inside is sub-agent work.
    if (ev.children?.length) walk(ev.children, true, files, results);
    if (!FILE_MUTATION_TOOLS.has(ev.tool)) continue;

    const input = ev.input && typeof ev.input === "object" ? (ev.input as Record<string, unknown>) : null;
    if (!input) continue;
    const raw = extractChange(ev.tool, input, ev.toolUseId ? results.get(ev.toolUseId) : undefined);
    if (!raw) continue;

    let entry = files.get(raw.filePath);
    if (!entry) {
      // Map insertion order gives first-touched ordering for free.
      entry = {
        filePath: raw.filePath,
        op: raw.op,
        editCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        edits: [],
        viaSubagent: false,
      };
      files.set(raw.filePath, entry);
    }
    if (OP_RANK[raw.op] > OP_RANK[entry.op]) entry.op = raw.op;
    if (viaSubagent) entry.viaSubagent = true;

    raw.fragments.forEach((frag, editIndex) => {
      const { added, removed } = countLines(frag.oldStr, frag.newStr);
      entry!.linesAdded += added;
      entry!.linesRemoved += removed;
      entry!.editCount += 1;
      entry!.edits.push({
        ...frag,
        toolUseId: ev.toolUseId,
        editIndex,
        editRef: ev.toolUseId ? `${ev.toolUseId}-${editIndex}` : undefined,
        viaSubagent,
      });
    });
  }
}

/** Files mutated by one turn, in the order the turn first touched them. */
export function aggregateTurnFileChanges(messages: ChatMessage[]): TurnFileChange[] {
  const results = new Map<string, string>();
  for (const msg of messages) collectResults(msg.events, results);

  const files = new Map<string, TurnFileChange>();
  for (const msg of messages) walk(msg.events, false, files, results);
  return [...files.values()];
}

/**
 * A turn spans every consecutive assistant message ending at `lastAssistantIndex`
 * (text and tool segments arrive as separate messages).
 */
export function collectTurnMessages(messages: ChatMessage[], lastAssistantIndex: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = lastAssistantIndex; i >= 0 && messages[i]?.role === "assistant"; i--) {
    out.unshift(messages[i]!);
  }
  return out;
}
