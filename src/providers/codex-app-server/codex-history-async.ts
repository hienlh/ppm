import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate as yieldToRequests } from "node:timers/promises";
import type { ChatMessage } from "../provider.interface.ts";
import { compactCard, readSessionMeta, rolloutMessageSteps, terminalError } from "./codex-history.ts";
import { completeLines, parseLine } from "./codex-rollout-header.ts";
import { finalAssistantText, transcriptToEvents, type SubagentTranscript } from "./codex-subagent-thread.ts";

function normalized(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function rolloutFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await rolloutFiles(path));
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(path);
  }
  return files;
}

export async function parseRolloutJsonlAsync(text: string, loadSubagent?: (id: string) => Promise<SubagentTranscript | null>): Promise<ChatMessage[]> {
  const steps = rolloutMessageSteps(text);
  let step = steps.next();
  let sliceStart = performance.now();
  while (!step.done) {
    const child = step.value && loadSubagent ? await loadSubagent(step.value) : null;
    if (performance.now() - sliceStart >= 4) { await yieldToRequests(); sliceStart = performance.now(); }
    step = steps.next(child);
  }
  return step.value;
}

/** One directory index per history request, shared with its subagent lookups. */
export async function getRolloutMessagesAsync(sessionsDir: string, threadId: string, requestedCwd?: string): Promise<ChatMessage[]> {
  const files = await rolloutFiles(sessionsDir);
  const target = requestedCwd == null ? null : normalized(requestedCwd);
  const headers = new Map<string, ReturnType<typeof readSessionMeta>>();
  const fileId = (file: string) => file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  async function find(id: string): Promise<string | null> {
    const named = (file: string) => fileId(file) === id;
    let sliceStart = performance.now();
    for (const file of [...files.filter(named), ...files.filter((file) => !named(file))]) {
      if (performance.now() - sliceStart >= 4) { await yieldToRequests(); sliceStart = performance.now(); }
      const byName = named(file);
      if (!headers.has(file) && !(byName && target == null)) headers.set(file, readSessionMeta(file));
      const header = headers.get(file);
      if (!byName && header?.id !== id) continue;
      if (target != null && (!header?.cwd || normalized(header.cwd) !== target)) continue;
      return file;
    }
    return null;
  }

  const seen = new Set([threadId]);
  async function parse(text: string, depth: number): Promise<ChatMessage[]> {
    return parseRolloutJsonlAsync(text, async (id) => {
      let child: SubagentTranscript | null = null;
      if (depth > 0 && !seen.has(id)) {
        seen.add(id);
        const file = await find(id);
        if (file) {
          try {
            const childText = await readFile(file, "utf8");
            const messages = await parse(childText, depth - 1);
            const finalText = finalAssistantText(messages) || terminalError(childText);
            const events = transcriptToEvents(messages);
            if (!events.length && finalText) events.push({ type: "text", content: finalText });
            child = { events, finalText };
          } catch { /* Missing/unreadable child does not hide the parent. */ }
        }
      }
      return child;
    });
  }

  const file = await find(threadId);
  if (!file) return [];
  try {
    const text = await readFile(file, "utf8");
    const messages = await parse(text, 2);
    let count = 0;
    let summary = "";
    let sliceStart = performance.now();
    for (const line of completeLines(text)) {
      if (performance.now() - sliceStart >= 4) { await yieldToRequests(); sliceStart = performance.now(); }
      const record = parseLine(line);
      if (record?.type !== "compacted") continue;
      count++;
      summary = typeof record.payload?.message === "string" ? record.payload.message : "";
    }
    if (count) messages.unshift(compactCard(summary, threadId, count, file));
    return messages;
  } catch { return []; }
}
