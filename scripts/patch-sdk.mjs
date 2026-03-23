#!/usr/bin/env node
/**
 * Postinstall patch for @anthropic-ai/claude-agent-sdk
 *
 * Fixes Windows stdin pipe buffering issue by adding drain() handling
 * to ProcessTransport.write(). Without this, stdin.write() can return
 * false (buffer full) but the SDK never waits for the drain event,
 * causing the CLI subprocess to hang on Windows + Bun.
 *
 * Tracking issues:
 *   - TS SDK #44: https://github.com/anthropics/claude-agent-sdk-typescript/issues/44
 *   - TS SDK #64: https://github.com/anthropics/claude-agent-sdk-typescript/issues/64
 *
 * Remove this patch when upstream fixes land.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const sdkPath = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "sdk.mjs",
);

if (!existsSync(sdkPath)) {
  console.log("[patch-sdk] SDK not found, skipping patch");
  process.exit(0);
}

const content = readFileSync(sdkPath, "utf8");

// Already patched?
if (content.includes("waiting for drain")) {
  console.log("[patch-sdk] Already patched, skipping");
  process.exit(0);
}

// Match the write() method using regex to handle different minified variable names.
// Pattern anchors on stable string literals that won't change between builds:
//   "Operation aborted", "ProcessTransport is not ready for writing",
//   "Cannot write to terminated process", "Write buffer full, data queued"
const writePattern = new RegExp(
  // method signature: write(V){
  "write\\(([A-Za-z_$][A-Za-z0-9_$]*)\\)\\{" +
  // body up to and including the processStdin.write(V) backpressure check
  "(?:(?!\\bwrite\\s*\\().)+" +       // non-greedy body (no nested write( method)
  'if\\(!this\\.processStdin\\.write\\(\\1\\)\\)' +  // stdin.write(V) returns false
  '([A-Za-z_$][A-Za-z0-9_$]*)\\(' +   // logger call: fn(
  '"\\[ProcessTransport\\] Write buffer full, data queued"\\)' +
  // rest of the catch block
  "\\}catch\\(([A-Za-z_$][A-Za-z0-9_$]*)\\)\\{" +
  "throw this\\.ready=!1," +
  "Error\\(`Failed to write to process stdin: \\$\\{\\3\\.message\\}`\\)" +
  "\\}\\}"
);

const match = content.match(writePattern);

if (!match) {
  // Fallback: try finding just the critical line and patch it surgically
  const simplePattern =
    /if\(!this\.processStdin\.write\(([A-Za-z_$][A-Za-z0-9_$]*)\)\)([A-Za-z_$][A-Za-z0-9_$]*)\("\[ProcessTransport\] Write buffer full, data queued"\)/;
  const simpleMatch = content.match(simplePattern);

  if (!simpleMatch) {
    console.warn(
      "[patch-sdk] WARNING: Could not find write() pattern to patch — SDK version may have changed",
    );
    process.exit(0);
  }

  // Surgical patch: replace just the backpressure line
  // Old: if(!this.processStdin.write(V))logger("...buffer full, data queued")
  // New: if(!this.processStdin.write(V)){logger("...waiting for drain");await new Promise(_r=>this.processStdin.once("drain",_r))}
  const oldLine = simpleMatch[0];
  const arg = simpleMatch[1];
  const logger = simpleMatch[2];
  const newLine =
    `if(!this.processStdin.write(${arg})){` +
    `${logger}("[ProcessTransport] Write buffer full, waiting for drain");` +
    `await new Promise(_r=>this.processStdin.once("drain",_r))}`;

  let patched = content.replace(oldLine, newLine);

  // Also make the method async — find "write(V){" just before this location
  const writeIdx = content.indexOf(oldLine);
  // Search backwards for the method declaration: write(X){
  const before = content.substring(Math.max(0, writeIdx - 2000), writeIdx);
  const methodDeclPattern = new RegExp(
    `write\\(${arg}\\)\\{(?!.*write\\(${arg}\\)\\{)`,
  );
  const methodMatch = before.match(methodDeclPattern);

  if (methodMatch) {
    const oldDecl = `write(${arg}){`;
    const newDecl = `async write(${arg}){`;
    // Replace only the first occurrence near the backpressure code
    const declAbsIdx = content.lastIndexOf(oldDecl, writeIdx);
    if (declAbsIdx >= 0) {
      patched =
        patched.substring(0, declAbsIdx) +
        newDecl +
        patched.substring(declAbsIdx + oldDecl.length);
    }
  }

  writeFileSync(sdkPath, patched, "utf8");
  console.log(
    "[patch-sdk] Patched ProcessTransport.write() with drain handling (surgical)",
  );
  process.exit(0);
}

// Full pattern matched — replace the entire write() method
const oldMethod = match[0];
const arg = match[1];
const logger = match[2];
const catchVar = match[3];

const newMethod = oldMethod
  // Make async
  .replace(`write(${arg}){`, `async write(${arg}){`)
  // Replace the backpressure line: log + await drain instead of just log
  .replace(
    `if(!this.processStdin.write(${arg}))${logger}("[ProcessTransport] Write buffer full, data queued")`,
    `if(!this.processStdin.write(${arg})){${logger}("[ProcessTransport] Write buffer full, waiting for drain");await new Promise(_r=>this.processStdin.once("drain",_r))}`,
  );

const patched = content.replace(oldMethod, newMethod);
writeFileSync(sdkPath, patched, "utf8");
console.log(
  "[patch-sdk] Patched ProcessTransport.write() with drain handling",
);
