/**
 * POC: Codex via official @openai/codex-sdk (Approach B).
 * Logs every streamed event with relative timestamps to evaluate
 * token-by-token streaming granularity + feature surface.
 *
 * Run AFTER login (see brainstorm guidance):
 *   bun codex-sdk-poc.ts "your prompt here"
 */
import { Codex } from "@openai/codex-sdk";

const prompt =
  process.argv[2] ??
  "Count from 1 to 5, one number per line, with a short sentence each. Then create a file poc-out.txt containing the word DONE.";

const t0 = Date.now();
const ms = () => `+${String(Date.now() - t0).padStart(5, " ")}ms`;

async function main() {
  const codex = new Codex({
    // Force full access to mirror PPM's chosen sandbox for parity with Claude bypassPermissions
    config: { sandbox_mode: "danger-full-access" },
  });

  const thread = codex.startThread({
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
  });

  console.log(`[${ms()}] startThread -> thread.id =`, (thread as any).id ?? "(unset until first run)");

  const { events } = await thread.runStreamed(prompt);

  let eventCount = 0;
  for await (const event of events) {
    eventCount++;
    const e = event as any;
    // Compact view: type + key fields; full dump for unknown shapes
    const summary: Record<string, unknown> = { type: e.type };
    if (e.item) summary.item = { type: e.item.type, ...trimText(e.item) };
    if (e.delta !== undefined) summary.delta = e.delta;
    if (e.usage) summary.usage = e.usage;
    console.log(`[${ms()}] #${eventCount}`, JSON.stringify(summary));
  }

  console.log(`[${ms()}] DONE. total events=${eventCount}, thread.id=`, (thread as any).id);
}

function trimText(item: any) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(item)) {
    if (k === "type") continue;
    const v = item[k];
    out[k] = typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v;
  }
  return out;
}

main().catch((err) => {
  console.error("POC error:", err);
  process.exit(1);
});
