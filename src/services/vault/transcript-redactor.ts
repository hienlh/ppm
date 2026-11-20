import { closeSync, existsSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileChunks } from "../file-chunks.ts";
import { createLogger } from "../logger.ts";
import { HOLD_MS, secretFragments } from "./turn-secret-scrubber.ts";

/**
 * After a turn in which an AI was handed secure or sealed values, rewrites the provider's history
 * files on this machine so those values no longer sit in them: Claude's session transcript (and its
 * subagents' transcripts) and Codex's rollout. Each value becomes `[vault:<item name>]`.
 *
 * The values stay noted for the scrubber's hold, and every later turn of that chat is checked too:
 * the AI keeps them in its context and repeating one in a later turn writes it to the same files.
 *
 * Only the files change. The running CLI or app-server is left alone, so its prompt cache stays
 * warm — and it still holds the value in memory until the chat is reopened. What was already sent
 * to Anthropic or OpenAI is beyond PPM's reach.
 *
 * Safety of the rewrite:
 * - it starts only after the turn ended and the file has stopped growing;
 * - only lines holding a value are touched; each is parsed and every string inside it rewritten,
 *   then stringified again, so the line stays one JSON record and fields like `parentUuid` that
 *   hold no value are never changed; every other line is copied byte for byte;
 * - the result goes to a temporary file beside the original and replaces it by rename, and only if
 *   the original has not changed size or time meanwhile; otherwise it is tried again later.
 *
 * Logging names sessions, files and counts, never a value.
 */

const log = createLogger("vault");

export const VAULT_HIDDEN = (name: string) => `[vault:${name}]`;
/** How long after a turn ends before the files are looked at, and the gap a file must stay still. */
const SETTLE_MS = 3_000;
const STABLE_MS = 1_000;
const MAX_TRIES = 8;

interface Item { name: string; patterns: RegExp[] }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A value matched as given or with its whitespace changed (an AI re-spacing it). */
function loosePattern(value: string): RegExp {
  return new RegExp([...value.replace(/\s+/g, "")].map(escape).join("\\s*"), "gi");
}

function itemOf(name: string, value: string): Item | null {
  if (value.replace(/\s+/g, "").length < 4) return null;
  // The whole value, then each distinctive line of a multi-line one (an AI repeating one line).
  // The raw line holds the JSON-escaped form; a value with a quote, a backslash or a newline
  // only matches there in that form.
  const forms = secretFragments(value).flatMap((v) => {
    const jsonForm = JSON.stringify(v).slice(1, -1);
    return jsonForm === v ? [v] : [v, jsonForm];
  });
  return { name, patterns: forms.map(loosePattern) };
}

function rewriteStrings(v: unknown, items: Item[], depth = 0): unknown {
  if (typeof v === "string") {
    let out = v;
    for (const it of items) for (const p of it.patterns) out = out.replace(p, () => VAULT_HIDDEN(it.name));
    return out;
  }
  if (!v || typeof v !== "object" || depth > 64) return v;
  if (Array.isArray(v)) return v.map((c) => rewriteStrings(c, items, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(v as Record<string, unknown>)) out[k] = rewriteStrings(c, items, depth + 1);
  return out;
}

const mentions = (line: string, items: Item[]) =>
  items.some((it) => it.patterns.some((p) => { p.lastIndex = 0; const hit = p.test(line); p.lastIndex = 0; return hit; }));

export type RedactOutcome = "changed" | "clean" | "busy" | "missing";

/** Rewrites one JSONL file. "busy" when it moved while being read or could not be replaced. */
export async function redactJsonlFile(path: string, values: readonly { name: string; value: string }[]): Promise<RedactOutcome> {
  const items = values.map((v) => itemOf(v.name, v.value)).filter((i): i is Item => !!i);
  if (!items.length) return "clean";
  if (!existsSync(path)) return "missing";
  const before = statSync(path);
  const tmp = join(dirname(path), `.${basename(path)}.vault-${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  let changedLines = 0;
  let unparsable = 0;
  try {
    const decoder = new TextDecoder();
    let rest = "";
    const emit = (line: string, newline: boolean, cr = "") => {
      let out = line;
      if (line && mentions(line, items)) {
        try {
          out = JSON.stringify(rewriteStrings(JSON.parse(line), items));
          if (out !== line) changedLines++;
        } catch {
          unparsable++;
        }
      }
      writeSync(fd, out + cr + (newline ? "\n" : ""));
    };
    for await (const chunk of readFileChunks(path, { toByte: before.size })) {
      rest += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        if (line.endsWith("\r")) emit(line.slice(0, -1), true, "\r");
        else emit(line, true);
      }
    }
    rest += decoder.decode();
    if (rest) emit(rest, false);
  } finally {
    closeSync(fd);
  }
  if (unparsable) log.warn(`redact ${basename(path)}: ${unparsable} line(s) held a vault value but were not JSON; left as they were`);
  if (changedLines === 0) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return "clean";
  }
  const after = statSync(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return "busy";
  }
  try {
    renameSync(tmp, path);
  } catch {
    // Windows refuses to replace a file another process holds open for writing.
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return "busy";
  }
  log.info(`redacted ${changedLines} line(s) in ${basename(path)}`);
  return "changed";
}

/** Whether the bytes of `path` from `fromByte` to its end mention any of `values`. */
async function tailMentions(path: string, fromByte: number, values: readonly { name: string; value: string }[]): Promise<boolean> {
  const items = values.map((v) => itemOf(v.name, v.value)).filter((i): i is Item => !!i);
  if (!items.length || !existsSync(path)) return false;
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of readFileChunks(path, { fromByte })) {
    rest += decoder.decode(chunk, { stream: true });
    const nl = rest.lastIndexOf("\n");
    if (nl < 0) continue;
    if (mentions(rest.slice(0, nl), items)) return true;
    rest = rest.slice(nl + 1);
  }
  return mentions(rest + decoder.decode(), items);
}

export interface RedactorDeps {
  /** The history files of a session: its transcript or rollout, and its subagents'. */
  files: (providerId: string, sessionId: string) => Promise<string[]>;
  /** Whether the session has a turn running again (its files are being written). */
  running?: (sessionId: string) => boolean;
  canonical?: (sessionId: string) => string;
  settleMs?: number;
  stableMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * A session's values are kept for the scrubber's hold (24 h after the last one was handed out), not
 * dropped after the first pass: the AI still has them in its context and may repeat one in any
 * later turn, which the CLI writes to the same files. A later pass reads only what was appended
 * since the last one and rewrites the file only when that holds a value; a pass right after a value
 * was handed out reads the whole file, as the first one always did.
 */
interface Pending { values: Map<string, string>; until: number; fresh: boolean }

export function createTranscriptRedactor(deps: RedactorDeps) {
  const canonical = deps.canonical ?? ((id: string) => id);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const pending = new Map<string, Pending>(); // session → its values (value → name)
  /** Per file, the size up to which it was last left with no value in it. */
  const checkedTo = new Map<string, number>();
  const working = new Set<string>();
  /** Sessions whose turn ended while a pass was already running: that pass runs once more. */
  const again = new Set<string>();

  async function stable(path: string): Promise<boolean> {
    if (!existsSync(path)) return true;
    const a = statSync(path);
    await sleep(deps.stableMs ?? STABLE_MS);
    if (!existsSync(path)) return true;
    const b = statSync(path);
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
  }

  /** Redacts every file of the session; true when all are done (nothing left busy). */
  async function runOnce(providerId: string, sessionId: string): Promise<boolean> {
    const entry = pending.get(sessionId);
    const values = [...(entry?.values ?? new Map<string, string>()).entries()].map(([value, name]) => ({ name, value }));
    if (!entry || !values.length) return true;
    if (deps.running?.(sessionId)) return false;
    const full = entry.fresh;
    const files = await deps.files(providerId, sessionId);
    let allDone = true;
    for (const f of files) {
      if (!(await stable(f))) { allDone = false; continue; }
      if (deps.running?.(sessionId)) return false;
      const size = existsSync(f) ? statSync(f).size : 0;
      const from = checkedTo.get(f);
      // Nothing appended since the last pass, or nothing appended that holds a value: left as it is.
      if (!full && from !== undefined && from <= size && (from === size || !(await tailMentions(f, from, values)))) {
        checkedTo.set(f, size);
        continue;
      }
      const r = await redactJsonlFile(f, values);
      if (r === "busy") { allDone = false; continue; }
      if (existsSync(f)) checkedTo.set(f, statSync(f).size);
    }
    if (allDone) entry.fresh = false;
    return allDone;
  }

  return {
    /** Values handed to the AI of `sessionId`: its history files are kept clear of them for the hold. */
    note(sessionId: string, items: readonly { name: string; value: string }[]): void {
      const id = canonical(sessionId);
      const entry = pending.get(id) ?? { values: new Map<string, string>(), until: 0, fresh: true };
      for (const it of items) {
        if (!entry.values.has(it.value)) entry.fresh = true;
        entry.values.set(it.value, it.name);
      }
      entry.until = now() + HOLD_MS;
      pending.set(id, entry);
    },

    /** The session's turn ended: redact its files once they settle, retrying while they are busy. */
    async turnEnded(providerId: string, asked: string): Promise<void> {
      const sessionId = canonical(asked);
      const entry = pending.get(sessionId);
      if (!entry) return;
      if (entry.until <= now()) { pending.delete(sessionId); return; }
      if (working.has(sessionId)) { again.add(sessionId); return; }
      working.add(sessionId);
      try {
        await sleep(deps.settleMs ?? SETTLE_MS);
        for (let i = 0; i < MAX_TRIES; i++) {
          let done = false;
          try {
            done = await runOnce(providerId, sessionId);
          } catch (e) {
            log.warn(`redacting history of session=${sessionId} failed: ${(e as Error)?.name ?? "error"}`);
          }
          // Done, unless another turn ended meanwhile; a turn running again redacts at its own end.
          if (done && !again.delete(sessionId)) return;
          if (deps.running?.(sessionId)) return;
          await sleep((deps.settleMs ?? SETTLE_MS) * (done ? 1 : i + 1));
        }
        log.warn(`history of session=${sessionId} still busy after ${MAX_TRIES} tries; will try after its next turn`);
      } finally {
        working.delete(sessionId);
      }
    },

    forget(sessionId: string): void { pending.delete(canonical(sessionId)); },
    pendingSessions: (): string[] => [...pending.keys()],
  };
}

export type TranscriptRedactor = ReturnType<typeof createTranscriptRedactor>;

/** Claude's transcript and its subagents', or Codex's rollout, for a session. */
async function historyFiles(providerId: string, sessionId: string): Promise<string[]> {
  if (providerId === "codex") {
    const { codexSessionsDirs } = await import("../../providers/codex-app-server/codex-provider.ts");
    const { findRolloutByThreadId } = await import("../../providers/codex-app-server/codex-history.ts");
    for (const dir of codexSessionsDirs(sessionId)) {
      const found = findRolloutByThreadId(dir, sessionId);
      if (found) return [found];
    }
    return [];
  }
  const { resolveSessionDir } = await import("../subagent-transcript-merger.ts");
  const { getSessionProjectPath } = await import("../db.service.ts");
  const dir = resolveSessionDir(sessionId, getSessionProjectPath(sessionId));
  if (!dir) return [];
  const files = [`${dir}.jsonl`];
  const sub = join(dir, "subagents");
  try {
    for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) files.push(join(sub, f));
  } catch { /* no subagents */ }
  return files;
}

let resolveSession: (id: string) => string = (id) => id;
let isRunning: (id: string) => boolean = () => false;
/** `ws/chat.ts` tells the redactor how to follow a renamed session and whether a turn runs. */
export function setRedactorSessionHooks(canonical: (id: string) => string, running: (id: string) => boolean): void {
  resolveSession = canonical;
  isRunning = running;
}

export const transcriptRedactor = createTranscriptRedactor({
  files: historyFiles,
  canonical: (id) => resolveSession(id),
  running: (id) => isRunning(id),
});
