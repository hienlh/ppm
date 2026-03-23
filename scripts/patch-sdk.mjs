#!/usr/bin/env node
/**
 * Postinstall patch for @anthropic-ai/claude-agent-sdk
 *
 * Fixes Windows + Bun subprocess pipe issues:
 * 1. Adding drain() handling to ProcessTransport.write()
 * 2. Awaiting the initial prompt write in query() entry point
 * 3. Replacing readline async iterator with manual line reader in readMessages()
 *
 * Bun on Windows has broken: stdin pipe backpressure, unawaited async writes,
 * and readline.createInterface() async iterator (Symbol.asyncIterator).
 *
 * Tracking issues:
 *   - TS SDK #44: https://github.com/anthropics/claude-agent-sdk-typescript/issues/44
 *   - TS SDK #64: https://github.com/anthropics/claude-agent-sdk-typescript/issues/64
 *
 * Remove this patch when upstream fixes land.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export function patchSdk(sdkPath) {
  if (!existsSync(sdkPath)) {
    console.log("[patch-sdk] SDK not found, skipping patch");
    return;
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
    // Wrap in async IIFE — keeps query() sync so callers don't need `await query()`
    const newPromptWrite =
      `/*__ppm_await_write__*/(async()=>{await ${oldPromptWrite}})()`;

    content = content.replace(oldPromptWrite, newPromptWrite);
    patches++;
    console.log("[patch-sdk] Patch 2 (await prompt): applied");
  }
}

// ── Patch 3: Replace readline async iterator in readMessages() ──
// Bun on Windows doesn't implement Symbol.asyncIterator for
// readline.createInterface(), causing "undefined is not a function"
// when the SDK does `for await (let X of readlineInterface)`.
//
// Replace with a manual line reader using raw stream 'data' events.

if (content.includes("__ppm_manual_readline__")) {
  console.log("[patch-sdk] Patch 3 (readline): already applied");
} else {
  // Match the readMessages method by anchoring on the stable error string
  const readMsgPattern =
    /async\s?\*\s?readMessages\(\)\{if\(!this\.processStdout\)throw Error\("ProcessTransport output stream not available"\);let ([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*)\(\{input:this\.processStdout\}\);try\{for await\(let ([A-Za-z_$][A-Za-z0-9_$]*) of \1\)if\(\3\.trim\(\)\)try\{yield ([A-Za-z_$][A-Za-z0-9_$]*)\(\3\)\}catch\(([A-Za-z_$][A-Za-z0-9_$]*)\)\{throw ([A-Za-z_$][A-Za-z0-9_$]*)\(`Non-JSON stdout: \$\{\3\}`\),Error\(`CLI output was not valid JSON\. This may indicate an error during startup\. Output: \$\{\3\.slice\(0,200\)\}\$\{\3\.length>200\?"\.\.\.":""\}`\)\}await this\.waitForExit\(\)\}catch\(\3\)\{throw \3\}finally\{\1\.close\(\)\}\}/;
  const readMsgMatch = content.match(readMsgPattern);

  if (!readMsgMatch) {
    console.warn(
      "[patch-sdk] Patch 3 (readline): pattern not found, skipping",
    );
  } else {
    const oldReadMsg = readMsgMatch[0];
    const rlVar = readMsgMatch[1];     // Q (readline interface)
    const createRL = readMsgMatch[2];   // DU (createInterface)
    const lineVar = readMsgMatch[3];    // X (line variable)
    const parseJSON = readMsgMatch[4];  // O1 (JSON parser)
    const errVar = readMsgMatch[5];     // Y (error variable)
    const logger = readMsgMatch[6];     // i0 (logger)

    // Manual line reader: use stream 'data' events + buffer splitting
    // This avoids readline's broken async iterator on Bun/Windows
    const newReadMsg =
      `/*__ppm_manual_readline__*/async*readMessages(){` +
      `if(!this.processStdout)throw Error("ProcessTransport output stream not available");` +
      // Create a manual async line iterator using stream events
      `let _buf="";` +
      `const _lines=[];` +
      `let _done=false;` +
      `let _err=null;` +
      `let _resolve=null;` +
      `const _notify=()=>{if(_resolve){const r=_resolve;_resolve=null;r()}};` +
      `this.processStdout.setEncoding("utf8");` +
      `this.processStdout.on("data",(chunk)=>{` +
        `_buf+=chunk;` +
        `let nl;` +
        `while((nl=_buf.indexOf("\\n"))!==-1){` +
          `_lines.push(_buf.slice(0,nl));` +
          `_buf=_buf.slice(nl+1)` +
        `}` +
        `_notify()` +
      `});` +
      `this.processStdout.on("end",()=>{` +
        `if(_buf.trim())_lines.push(_buf);` +
        `_buf="";_done=true;_notify()` +
      `});` +
      `this.processStdout.on("error",(e)=>{_err=e;_done=true;_notify()});` +
      `try{` +
        `while(true){` +
          `while(_lines.length>0){` +
            `const ${lineVar}=_lines.shift();` +
            `if(${lineVar}.trim())` +
              `try{yield ${parseJSON}(${lineVar})}` +
              `catch(${errVar}){` +
                `throw ${logger}(\`Non-JSON stdout: \${${lineVar}}\`),` +
                `Error(\`CLI output was not valid JSON. This may indicate an error during startup. Output: \${${lineVar}.slice(0,200)}\${${lineVar}.length>200?"...":""}\`)` +
              `}` +
          `}` +
          `if(_err)throw _err;` +
          `if(_done)break;` +
          `await new Promise(r=>{_resolve=r})` +
        `}` +
        `await this.waitForExit()` +
      `}catch(${lineVar}){throw ${lineVar}}}`;

    content = content.replace(oldReadMsg, newReadMsg);
    patches++;
    console.log("[patch-sdk] Patch 3 (readline): applied");
  }
}

  if (patches > 0) {
    writeFileSync(sdkPath, content, "utf8");
    console.log(`[patch-sdk] Done — ${patches} patch(es) written`);
  } else {
    console.log("[patch-sdk] No patches needed");
  }
}

// Auto-run when executed directly (postinstall)
if (process.argv[1]?.endsWith("patch-sdk.mjs")) {
  const sdkPath = join(
    import.meta.dirname,
    "..",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "sdk.mjs",
  );
  patchSdk(sdkPath);
}
