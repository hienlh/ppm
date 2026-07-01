/**
 * POC: Codex via raw CLI `codex exec --json` (Approach A — fits CliProvider base).
 * Spawns the local @openai/codex binary, streams NDJSON, logs each event with
 * relative timestamps to evaluate token-by-token streaming + session-id capture.
 *
 * Prompt is sent via stdin to avoid shell quoting issues.
 *
 * Run AFTER login (see brainstorm guidance):
 *   bun codex-cli-poc.ts "your prompt here"
 */
import { spawn } from "node:child_process";

const prompt =
  process.argv[2] ??
  "Count from 1 to 5, one number per line, with a short sentence each. Then create a file poc-out.txt containing the word DONE.";

// Local binary shim created by bun/npm install.
const bin =
  process.platform === "win32"
    ? "node_modules\\.bin\\codex.cmd"
    : "node_modules/.bin/codex";

const t0 = Date.now();
const ms = () => `+${String(Date.now() - t0).padStart(5, " ")}ms`;

const args = [
  "exec",
  "--json",
  "--skip-git-repo-check",
  "-s",
  "danger-full-access",
  "-", // read prompt from stdin
];

console.log(`[${ms()}] spawn: codex ${args.join(" ")}`);

const proc = spawn(bin, args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32", // .cmd shim needs shell on Windows
});

proc.stdin.write(prompt);
proc.stdin.end();

let buf = "";
let count = 0;
proc.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    count++;
    try {
      const ev = JSON.parse(line);
      const summary: Record<string, unknown> = { type: ev.type };
      if (ev.thread_id) summary.thread_id = ev.thread_id;
      if (ev.session_id) summary.session_id = ev.session_id;
      if (ev.item) summary.item = { type: ev.item?.type, keys: Object.keys(ev.item ?? {}) };
      if (ev.delta !== undefined) summary.delta = ev.delta;
      if (ev.usage) summary.usage = ev.usage;
      console.log(`[${ms()}] #${count}`, JSON.stringify(summary));
    } catch {
      console.log(`[${ms()}] #${count} (raw)`, line.slice(0, 200));
    }
  }
});

proc.stderr.on("data", (c: Buffer) => {
  const s = c.toString().trim();
  if (s) console.error(`[${ms()}] stderr:`, s.slice(0, 200));
});

proc.on("close", (code) => {
  console.log(`[${ms()}] CLOSED code=${code}, total lines=${count}`);
});
