#!/usr/bin/env node
/**
 * Postinstall patch for @anthropic-ai/claude-agent-sdk
 *
 * Fixes Windows stdin pipe buffering issue by:
 * 1. Adding drain() handling to ProcessTransport.write()
 * 2. Awaiting the initial prompt write in query() entry point
 *
 * Without these fixes, stdin.write() can return false (buffer full) but
 * the SDK never waits for the drain event, causing the CLI subprocess to
 * hang on Windows + Bun.
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

let content = readFileSync(sdkPath, "utf8");
let patches = 0;

// ── Patch 1: ProcessTransport.write() — add drain handling ──

if (content.includes("waiting for drain")) {
  console.log("[patch-sdk] Patch 1 (drain): already applied");
} else {
  // Surgical approach: find the backpressure line and patch it
  const drainPattern =
    /if\(!this\.processStdin\.write\(([A-Za-z_$][A-Za-z0-9_$]*)\)\)([A-Za-z_$][A-Za-z0-9_$]*)\("\[ProcessTransport\] Write buffer full, data queued"\)/;
  const drainMatch = content.match(drainPattern);

  if (!drainMatch) {
    console.warn("[patch-sdk] Patch 1 (drain): pattern not found, skipping");
  } else {
    const oldLine = drainMatch[0];
    const arg = drainMatch[1];
    const logger = drainMatch[2];

    // Replace backpressure line: await drain instead of just logging
    const newLine =
      `if(!this.processStdin.write(${arg})){` +
      `${logger}("[ProcessTransport] Write buffer full, waiting for drain");` +
      `await new Promise(_dr=>this.processStdin.once("drain",_dr))}`;

    content = content.replace(oldLine, newLine);

    // Make the method async
    const writeIdx = content.indexOf(newLine);
    const oldDecl = `write(${arg}){`;
    const declIdx = content.lastIndexOf(oldDecl, writeIdx);
    if (declIdx >= 0) {
      content =
        content.substring(0, declIdx) +
        `async write(${arg}){` +
        content.substring(declIdx + oldDecl.length);
    }

    patches++;
    console.log("[patch-sdk] Patch 1 (drain): applied");
  }
}

// ── Patch 2: Await initial prompt write in query() entry point ──
// The query() function writes the user prompt to transport.write() without
// awaiting. Since write() is now async (returns Promise on backpressure),
// the prompt data can be lost on Windows where pipe buffers are small.
//
// Pattern (minified):
//   if(typeof Q==="string")TRANSPORT.write(SERIALIZE({type:"user",...})+"\n");
//   else QUERY.streamInput(Q);
//
// We need to await the write and make the surrounding context async-compatible.
// Since write is fire-and-forget here (the Promise is dropped), we wrap it.

if (content.includes("__ppm_await_write__")) {
  console.log("[patch-sdk] Patch 2 (await prompt): already applied");
} else {
  // Match: TRANSPORT.write(SERIALIZE({type:"user",...})+`\n`);
  // The newline delimiter can be either `\n` (template literal) or "\n" (string).
  // Anchor on stable string literals: type:"user",session_id:"",message:{role:"user"
  const promptWritePattern =
    /([A-Za-z_$][A-Za-z0-9_$]*)\.write\(([A-Za-z_$][A-Za-z0-9_$]*)\(\{type:"user",session_id:"",message:\{role:"user",content:\[\{type:"text",text:([A-Za-z_$][A-Za-z0-9_$]*)\}\]\},parent_tool_use_id:null\}\)\+(?:`\n`|"\\n")\)/;
  const promptMatch = content.match(promptWritePattern);

  if (!promptMatch) {
    console.warn(
      "[patch-sdk] Patch 2 (await prompt): pattern not found, skipping",
    );
  } else {
    const oldPromptWrite = promptMatch[0];
    // Wrap in an async IIFE to await the (now async) write
    // Add marker __ppm_await_write__ for idempotency detection
    const newPromptWrite =
      `/*__ppm_await_write__*/await ${oldPromptWrite.replace(".write(", ".write(")}`;

    content = content.replace(oldPromptWrite, newPromptWrite);

    // The containing function must be async. Find the function that contains this code.
    // It's typically: function FUNCNAME(Q,...){...if(typeof Q==="string")TRANSPORT.write...}
    // We need to find "function" before this write and make it "async function"
    const promptIdx = content.indexOf(newPromptWrite);
    // Search backwards for the function declaration
    const beforePrompt = content.substring(
      Math.max(0, promptIdx - 5000),
      promptIdx,
    );
    // Find last "function " that starts a function declaration (not inside another call)
    const funcMatches = [...beforePrompt.matchAll(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)];
    if (funcMatches.length > 0) {
      const lastFunc = funcMatches[funcMatches.length - 1];
      const funcStart = beforePrompt.lastIndexOf(lastFunc[0]);
      const absIdx = Math.max(0, promptIdx - 5000) + funcStart;

      // Only add async if not already async
      const prefix = content.substring(Math.max(0, absIdx - 10), absIdx);
      if (!prefix.includes("async")) {
        content =
          content.substring(0, absIdx) +
          "async " +
          content.substring(absIdx);
      }
    }

    patches++;
    console.log("[patch-sdk] Patch 2 (await prompt): applied");
  }
}

if (patches > 0) {
  writeFileSync(sdkPath, content, "utf8");
  console.log(`[patch-sdk] Done — ${patches} patch(es) written`);
} else {
  console.log("[patch-sdk] No patches needed");
}
