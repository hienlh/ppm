/**
 * The pure halves of the clean-up's context: what a chat message, a CLAUDE.md and a file index
 * each contribute, already cut to size. Nothing here reads a file or a database.
 */
import { promptTextOf } from "../../shared/user-prompt-kind.ts";
import { splitVoiceMessage } from "../../shared/voice-message.ts";
import type { ChatMessage } from "../../types/chat.ts";

export const CONTEXT_LIMITS = {
  /** Last chat messages handed over, each cut to `messageChars`. */
  messages: 8,
  messageChars: 400,
  typedChars: 2_000,
  instructionsChars: 3_000,
  memoryChars: 3_000,
  fileNames: 400,
  /** Most of a file index read for names: the walk is depth-first, so the top of a tree is first. */
  indexBytes: 4 * 1024 * 1024,
  notebookChars: 3_000,
  projectNames: 200,
} as const;

/** `text` on one line, at most `max` characters. */
export function flat(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** At most `max` characters, cut at a line break when one is near. */
export function cutBlock(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trim();
}

/**
 * One message as the clean-up reads it: what the person said (a voice message by its transcript)
 * or what the assistant wrote. Tool calls, their output and thinking are left out on purpose: they
 * are long, and nothing in them is what the person is about to say.
 */
export function contextLineOf(msg: ChatMessage): string | null {
  if (msg.synthetic) return null;
  if (msg.role === "user") {
    const prompt = promptTextOf(msg.content);
    if (prompt === null) return null;
    const { before, voice } = splitVoiceMessage(prompt);
    const said = [before, voice?.transcript ?? ""].filter(Boolean).join("\n");
    return said.trim() ? `User: ${flat(said, CONTEXT_LIMITS.messageChars)}` : null;
  }
  if (msg.role === "assistant") {
    const top = (msg.events ?? []).filter((ev) => !("parentToolUseId" in ev && ev.parentToolUseId));
    const text = top.some((ev) => ev.type === "text" || ev.type === "tool_use")
      ? top.map((ev) => (ev.type === "text" ? ev.content : "")).join("")
      : msg.content;
    return text.trim() ? `Assistant: ${flat(text, CONTEXT_LIMITS.messageChars)}` : null;
  }
  return null;
}

/** Items joined with `sep`, stopping before the one that would pass `max` characters. */
export function joinWithin(items: readonly string[], sep: string, max: number): string {
  let out = "";
  for (const item of items) {
    const next = out ? `${out}${sep}${item}` : item;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/**
 * A CLAUDE.md reduced to the words it is likely to be spoken with: its headings and every
 * `backticked` term (identifiers, commands, file names), each once. The prose itself is left out
 * — it is long, and it is instructions to an agent, not vocabulary.
 */
export function instructionsDigest(markdown: string, max: number = CONTEXT_LIMITS.instructionsChars): string {
  const headings: string[] = [];
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (list: string[], raw: string) => {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || value.length > 80 || seen.has(key)) return;
    seen.add(key);
    list.push(value);
  };
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) add(headings, heading[1]!.replace(/`/g, ""));
    for (const m of line.matchAll(/`([^`\n]{1,80})`/g)) add(terms, m[1]!);
  }
  const headingPart = headings.length ? `Headings: ${joinWithin(headings, "; ", max)}` : "";
  const room = max - headingPart.length - 1;
  const termPart = terms.length && room > 20 ? `Terms: ${joinWithin(terms, ", ", room - 7)}` : "";
  return [headingPart, termPart].filter(Boolean).join("\n");
}

const NAME_RE = /"name":"((?:[^"\\]|\\.)*)","type":"file"(,"isIgnored":true)?/g;

/**
 * File names out of a file index's JSON body (`{ok:true,data:FileEntry[]}`), each once, without
 * parsing the whole body: a large project's index is tens of megabytes, and the first few hold
 * the top of the tree, which is what people talk about. Git-ignored files are skipped.
 */
export function fileNamesFromIndexJson(json: Uint8Array, max: number = CONTEXT_LIMITS.fileNames): string[] {
  const text = new TextDecoder().decode(json.subarray(0, CONTEXT_LIMITS.indexBytes));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(NAME_RE)) {
    if (m[2]) continue;
    let name: string;
    try { name = JSON.parse(`"${m[1]}"`) as string; } catch { continue; }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}
