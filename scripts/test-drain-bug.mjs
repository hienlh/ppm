#!/usr/bin/env node
/**
 * Reproduces the stdin backpressure bug that causes SDK to hang on Windows.
 *
 * The issue: ProcessTransport.write() calls stdin.write() but ignores the
 * return value (false = buffer full). Without awaiting 'drain', the subprocess
 * may never receive the data — causing a hang.
 *
 * This script simulates the scenario with a slow-reading subprocess.
 * On macOS/Linux the OS pipe buffer is larger (64KB+), so we write enough
 * to overflow it. On Windows + Bun, even small writes can trigger this.
 *
 * Usage: node scripts/test-drain-bug.mjs
 */

import { spawn } from "node:child_process";

// Subprocess that reads stdin slowly (simulates claude CLI processing)
const slowReader = spawn("node", [
  "-e",
  `
  // Read stdin 1 byte at a time with delays to create backpressure
  process.stdin.setEncoding("utf8");
  let total = 0;
  process.stdin.on("data", (chunk) => {
    total += chunk.length;
    // Pause stdin to simulate slow processing (like claude thinking)
    process.stdin.pause();
    setTimeout(() => process.stdin.resume(), 50);
  });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ received: total }));
  });
  `,
]);

const CHUNK = "x".repeat(1024); // 1KB chunk
const TOTAL_WRITES = 256; // 256KB total — enough to overflow pipe buffer

// ── Test 1: WITHOUT drain (current SDK behavior) ──
console.log("=== Test 1: Write WITHOUT drain (current SDK bug) ===");
let writesFailed = 0;
let writesOk = 0;

for (let i = 0; i < TOTAL_WRITES; i++) {
  const ok = slowReader.stdin.write(CHUNK);
  if (!ok) writesFailed++;
  else writesOk++;
}
slowReader.stdin.end();

let output = "";
slowReader.stdout.on("data", (d) => (output += d));

await new Promise((resolve) => slowReader.on("close", resolve));
const result1 = JSON.parse(output || '{"received":0}');

console.log(`  Writes OK:     ${writesOk}`);
console.log(`  Writes FULL:   ${writesFailed} (buffer was full, SDK just logs & continues)`);
console.log(`  Data sent:     ${TOTAL_WRITES * 1024} bytes`);
console.log(`  Data received: ${result1.received} bytes`);
console.log(
  `  Lost data:     ${writesFailed > 0 ? "POSSIBLE — depends on OS buffer behavior" : "none (buffer was big enough)"}`,
);

// ── Test 2: WITH drain (patched behavior) ──
console.log("\n=== Test 2: Write WITH drain (patched SDK) ===");

const slowReader2 = spawn("node", [
  "-e",
  `
  process.stdin.setEncoding("utf8");
  let total = 0;
  process.stdin.on("data", (chunk) => {
    total += chunk.length;
    process.stdin.pause();
    setTimeout(() => process.stdin.resume(), 50);
  });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ received: total }));
  });
  `,
]);

let drainWaits = 0;
const start = Date.now();

for (let i = 0; i < TOTAL_WRITES; i++) {
  const ok = slowReader2.stdin.write(CHUNK);
  if (!ok) {
    drainWaits++;
    await new Promise((r) => slowReader2.stdin.once("drain", r));
  }
}
slowReader2.stdin.end();

let output2 = "";
slowReader2.stdout.on("data", (d) => (output2 += d));
await new Promise((resolve) => slowReader2.on("close", resolve));
const result2 = JSON.parse(output2 || '{"received":0}');
const elapsed = Date.now() - start;

console.log(`  Drain waits:   ${drainWaits}`);
console.log(`  Data sent:     ${TOTAL_WRITES * 1024} bytes`);
console.log(`  Data received: ${result2.received} bytes`);
console.log(`  Match:         ${result2.received === TOTAL_WRITES * 1024 ? "YES — all data delivered" : "NO — data lost!"}`);
console.log(`  Time:          ${elapsed}ms (slower due to drain waits, but reliable)`);

// ── Summary ──
console.log("\n=== Summary ===");
if (writesFailed > 0) {
  console.log(
    `Buffer overflowed ${writesFailed}x in Test 1 (no drain).`,
  );
  console.log(
    "On Windows + Bun, this causes the SDK subprocess to hang indefinitely.",
  );
  console.log(
    "The patch adds 'await drain' to prevent data loss → fixes the hang.",
  );
} else {
  console.log(
    "Buffer did NOT overflow on this OS (macOS/Linux has large pipe buffers).",
  );
  console.log(
    "On Windows + Bun, pipe buffers are smaller → overflow happens even with small prompts.",
  );
  console.log(
    "The patch is still correct: it's a no-op when write() returns true.",
  );
}
