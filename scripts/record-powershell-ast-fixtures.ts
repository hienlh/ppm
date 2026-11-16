/**
 * Records the parsed tree of every script in the PowerShell read-only corpus, so the judge's
 * tests run on any platform without PowerShell:
 *
 *   bun scripts/record-powershell-ast-fixtures.ts
 *
 * Runs the same long-lived parser helper the server uses, against the same PowerShell it would
 * pick, and writes `tests/unit/services/readonly-shell/fixtures/powershell-asts/corpus.json` —
 * one line per script, so a change in the corpus or the parser reads as a reviewable diff.
 *
 * Touches no PPM state: it imports the helper and the corpus (fixed text) and nothing that opens
 * PPM's database or writes into its folder.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { POWERSHELL_CORPUS } from "../tests/unit/services/readonly-shell/adversarial-powershell-corpus.ts";
import { PowerShellAstHelper, findPowerShellExecutable } from "../src/services/assistant/readonly-shell/powershell-ast-helper.ts";
import type { PsParseReply } from "../src/services/assistant/readonly-shell/powershell-ast-types.ts";

const OUT = join(import.meta.dir, "..", "tests", "unit", "services", "readonly-shell", "fixtures", "powershell-asts", "corpus.json");
const quiet = { debug() {}, info() {}, warn: console.warn, error: console.error, fatal: console.error, enabled: () => false } as never;

async function main(): Promise<void> {
  const exe = findPowerShellExecutable();
  if (!exe) throw new Error("no PowerShell found; record the fixtures on a Windows host (or one with pwsh)");
  const helper = new PowerShellAstHelper({ requestTimeoutMs: 30_000, log: quiet });
  const replies: [string, PsParseReply][] = [];
  let psVersion = "";
  try {
    for (const script of new Set(POWERSHELL_CORPUS.map((c) => c.script))) {
      const reply = await helper.parse(script);
      // A parse error is a result worth recording; anything else is the helper failing.
      if (!reply.ok && !reply.error.startsWith("parse error:")) throw new Error(`the helper failed on ${JSON.stringify(script)}: ${reply.error}`);
      if (reply.ok) psVersion = reply.psVersion;
      replies.push([script, reply]);
    }
  } finally {
    helper.stop();
  }
  const lines = replies.map(([script, reply]) => `    ${JSON.stringify(script)}: ${JSON.stringify(reply)}`);
  const body = `{\n  "recordedWith": ${JSON.stringify(`${exe} ${psVersion}`)},\n  "psVersion": ${JSON.stringify(psVersion)},\n  "replies": {\n${lines.join(",\n")}\n  }\n}\n`;
  writeFileSync(OUT, body);
  console.log(`recorded ${replies.length} scripts with PowerShell ${psVersion} → ${OUT}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
