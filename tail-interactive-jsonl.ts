/**
 * Diagnostic: can PPM render a LIVE interactive Claude Code session by tailing its
 * JSONL transcript? Measures the granularity + latency of what gets written.
 *
 * CONTEXT: A human runs `claude` interactively in a terminal (billed as interactive
 * subscription usage). Claude Code persists that session to
 *   ~/.claude/projects/<cwd-hash>/<session-id>.jsonl
 * If PPM tails that file, it can mirror the session in its web UI WITHOUT driving the
 * CLI itself — i.e. a read-only viewer over a genuinely human-driven session. This is
 * ToS-safe (no impersonation; PPM never sends prompts). The open question this script
 * answers: is the JSONL written incrementally enough to feel like "streaming", or only
 * one complete message per turn (no token-by-token deltas)?
 *
 * Run:   bun tail-interactive-jsonl.ts [optional/path/to/session.jsonl]
 * Then:  in a SEPARATE terminal run `claude`, ask something with a long answer, and
 *        watch what this prints. (No args → auto-picks the most recently modified
 *        JSONL under ~/.claude/projects updated in the last 10 min.)
 */

import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { existsSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";

const PROJECTS_DIR = resolve(homedir(), ".claude/projects");
const POLL_MS = 200;

/** Read the last non-empty line of a file (scans up to last 4KB). */
function lastLine(path: string): string {
  const size = statSync(path).size;
  const from = Math.max(0, size - 4096);
  const txt = readFrom(path, from, size);
  const lines = txt.split("\n").filter((l) => l.trim());
  return lines[lines.length - 1] ?? "";
}

/** entrypoint of a session: "sdk-ts" (programmatic, e.g. PPM/this session) vs "cli" (interactive TUI). */
function entrypointOf(path: string): string {
  try { return JSON.parse(lastLine(path))?.entrypoint ?? "?"; } catch { return "?"; }
}

/**
 * Pick the JSONL to follow. Prefer the newest INTERACTIVE session (entrypoint !== "sdk-ts")
 * so we don't accidentally tail this very SDK session. Falls back to plain newest.
 */
function pickTarget(preferInteractive = true): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  const all: Array<{ path: string; mtime: number }> = [];
  for (const dir of readdirSync(PROJECTS_DIR)) {
    const full = join(PROJECTS_DIR, dir);
    let entries: string[];
    try { entries = readdirSync(full); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(full, f);
      all.push({ path: p, mtime: statSync(p).mtimeMs });
    }
  }
  all.sort((a, b) => b.mtime - a.mtime);
  if (preferInteractive) {
    const interactive = all.find((c) => Date.now() - c.mtime < 10 * 60_000 && entrypointOf(c.path) !== "sdk-ts");
    if (interactive) return interactive.path;
  }
  return all[0]?.path ?? null;
}

const explicit = process.argv[2];
let target = explicit ?? pickTarget();
if (!target || !existsSync(target)) {
  console.error("No JSONL found. Pass a path, or run an interactive `claude` first.");
  process.exit(1);
}
console.log(`[tail] watching ${target}  (entrypoint=${entrypointOf(target)})`);
console.log(`[tail] run \`claude\` interactively in another terminal, ask for a LONG answer (e.g. "count to 30 with a sentence each").`);
console.log(`[tail] auto-switches to a newer INTERACTIVE session if one starts.\n`);

// Start at current EOF — only show NEW activity.
let offset = statSync(target).size;
let carry = "";
let lastEventAt = 0;
let lastRescan = Date.now();

/** Read bytes [offset, size) and return decoded string. */
function readFrom(path: string, from: number, to: number): string {
  const fd = openSync(path, "r");
  try {
    const len = to - from;
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function summarize(line: string) {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return; }
  const now = Date.now();
  const dt = lastEventAt ? `+${now - lastEventAt}ms` : "first";
  lastEventAt = now;

  const type = obj.type ?? "?";
  let detail = "";
  const content = obj.message?.content;
  if (Array.isArray(content)) {
    const parts = content.map((b: any) => {
      if (b.type === "text") return `text(${b.text?.length ?? 0} chars)`;
      if (b.type === "tool_use") return `tool_use:${b.name}`;
      if (b.type === "tool_result") return `tool_result`;
      if (b.type === "thinking") return `thinking(${b.thinking?.length ?? 0})`;
      return b.type;
    });
    detail = parts.join(", ");
  } else if (typeof content === "string") {
    detail = `text(${content.length} chars)`;
  } else if (obj.type === "attachment") {
    detail = `attachment:${obj.attachment?.type ?? "?"}`;
  } else if (obj.subtype) {
    detail = `subtype=${obj.subtype}`;
  }
  const role = obj.message?.role ? `/${obj.message.role}` : "";
  console.log(`[${dt.padStart(8)}] ${type}${role}  ${detail}`);
}

function poll() {
  // Every 1s, if an explicit path wasn't given, see if a newer interactive session started.
  if (!explicit && Date.now() - lastRescan > 1000) {
    lastRescan = Date.now();
    const next = pickTarget();
    if (next && next !== target) {
      console.log(`\n[tail] >>> switching to new interactive session: ${next}\n`);
      target = next;
      offset = 0; // read the new file from the start to capture the whole turn
      carry = "";
      lastEventAt = 0;
    }
  }

  let size: number;
  try { size = statSync(target!).size; } catch { return; }
  if (size < offset) { offset = 0; carry = ""; } // file truncated/rotated
  if (size > offset) {
    const chunk = carry + readFrom(target!, offset, size);
    offset = size;
    const lines = chunk.split("\n");
    carry = lines.pop() ?? ""; // last partial line (not yet newline-terminated)
    for (const ln of lines) if (ln.trim()) summarize(ln);
  }
}

setInterval(poll, POLL_MS);
console.log("[tail] polling every 200ms. Ctrl+C to stop.\n");
