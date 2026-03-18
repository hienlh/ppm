/**
 * Minimal SDK test — run on Windows to diagnose Bun + SDK issue.
 *
 * Usage:
 *   bun test-sdk.mjs
 *   node --experimental-strip-types test-sdk.mjs
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// Remove CLAUDECODE to avoid nested session error
delete process.env.CLAUDECODE;

const cwd = homedir();

console.log("=== SDK Test ===");
console.log(`Platform: ${process.platform}`);
console.log(`Runtime:  ${typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`}`);
console.log(`CWD:      ${cwd}`);
console.log(`API_KEY:  ${process.env.ANTHROPIC_API_KEY ? "SET" : "unset"}`);

// Test 1: claude --version
console.log("\n--- Test 1: claude --version ---");
try {
  const ver = spawnSync("claude", ["--version"], { encoding: "utf-8", timeout: 10000 });
  console.log(`exit=${ver.status} stdout="${ver.stdout?.trim()}" stderr="${ver.stderr?.trim()}"`);
} catch (e) {
  console.log(`FAILED: ${e.message}`);
}

// Test 2: claude -p (direct CLI)
console.log("\n--- Test 2: claude -p (direct spawn) ---");
try {
  const direct = spawnSync("claude", ["-p", "say ok", "--output-format", "text", "--max-turns", "1"], {
    encoding: "utf-8",
    timeout: 30000,
    cwd,
    env: process.env,
  });
  console.log(`exit=${direct.status}`);
  console.log(`stdout="${direct.stdout?.trim().slice(0, 200)}"`);
  if (direct.stderr?.trim()) console.log(`stderr="${direct.stderr.trim().slice(0, 200)}"`);
} catch (e) {
  console.log(`FAILED: ${e.message}`);
}

// Test 3: SDK query()
console.log("\n--- Test 3: SDK query() ---");
const startTime = Date.now();
const TIMEOUT = 15000;
let gotEvent = false;

try {
  const q = query({
    prompt: "say ok",
    options: {
      cwd,
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "custom", custom: "Reply only with: ok" },
    },
  });

  // Race first event against timeout
  const iterator = q[Symbol.asyncIterator]();
  const result = await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), TIMEOUT)),
  ]);

  if (result === "TIMEOUT") {
    console.log(`TIMEOUT: no events after ${TIMEOUT / 1000}s`);
    console.log(">>> This confirms the Bun + Windows SDK issue <<<");
    try { q.close(); } catch {}
  } else {
    gotEvent = true;
    const elapsed = Date.now() - startTime;
    const msg = result.value;
    console.log(`First event in ${elapsed}ms: type=${msg?.type} subtype=${msg?.subtype ?? "none"}`);

    // Read remaining events
    let count = 1;
    for await (const ev of { [Symbol.asyncIterator]: () => iterator }) {
      count++;
      if (ev.type === "assistant") {
        const text = ev.message?.content?.find((b) => b.type === "text")?.text ?? "";
        console.log(`Event #${count}: assistant text="${text.slice(0, 100)}"`);
      } else if (ev.type === "result") {
        console.log(`Event #${count}: result subtype=${ev.subtype}`);
        break;
      } else {
        console.log(`Event #${count}: ${ev.type}`);
      }
      if (count > 20) { console.log("(stopping after 20 events)"); break; }
    }
    console.log(`\nSUCCESS: SDK works! Total events: ${count}`);
  }
} catch (e) {
  console.log(`ERROR: ${e.message}`);
  if (e.stack) console.log(e.stack);
}

console.log(`\nTotal time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
process.exit(gotEvent ? 0 : 1);
