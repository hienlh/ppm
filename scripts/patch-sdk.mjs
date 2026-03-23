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

// Original write() — sync, ignores backpressure
const oldWrite =
  'write(Q){if(this.abortController.signal.aborted)throw new T0("Operation aborted");if(!this.ready||!this.processStdin)throw Error("ProcessTransport is not ready for writing");if(this.process?.killed||this.process?.exitCode!==null)throw Error("Cannot write to terminated process");if(this.exitError)throw Error(`Cannot write to process that exited with error: ${this.exitError.message}`);i0(`[ProcessTransport] Writing to stdin: ${Q.substring(0,100)}`);try{if(!this.processStdin.write(Q))i0("[ProcessTransport] Write buffer full, data queued")}catch(X){throw this.ready=!1,Error(`Failed to write to process stdin: ${X.message}`)}}';

// Patched write() — async, awaits drain when buffer full
const newWrite =
  'async write(Q){if(this.abortController.signal.aborted)throw new T0("Operation aborted");if(!this.ready||!this.processStdin)throw Error("ProcessTransport is not ready for writing");if(this.process?.killed||this.process?.exitCode!==null)throw Error("Cannot write to terminated process");if(this.exitError)throw Error(`Cannot write to process that exited with error: ${this.exitError.message}`);i0(`[ProcessTransport] Writing to stdin: ${Q.substring(0,100)}`);try{if(!this.processStdin.write(Q)){i0("[ProcessTransport] Write buffer full, waiting for drain");await new Promise(r=>this.processStdin.once("drain",r))}}catch(X){throw this.ready=!1,Error(`Failed to write to process stdin: ${X.message}`)}}';

if (!content.includes(oldWrite)) {
  if (content.includes("waiting for drain")) {
    console.log("[patch-sdk] Already patched, skipping");
  } else {
    console.warn(
      "[patch-sdk] WARNING: Could not find write() method to patch — SDK version may have changed",
    );
  }
  process.exit(0);
}

const patched = content.replace(oldWrite, newWrite);
writeFileSync(sdkPath, patched, "utf8");
console.log(
  "[patch-sdk] Patched ProcessTransport.write() with drain handling",
);
