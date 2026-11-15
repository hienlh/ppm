import { turnSecretScrubber, type TurnSecretScrubber } from "./turn-secret-scrubber.ts";

/**
 * What the session trace keeps of the vault. A `vault_read` result carrying secure or sealed
 * values (its text starts "Vault items (") is stored as `{ withheld: true, tier, items }` with the
 * item names only; a `vault_propose` call keeps its name, kind and tier but never the value the
 * AI filled in; and every other record — the AI's own text included — goes through the turn's
 * scrubber, so a value the AI repeats is stored as `[vault:<name>]`. Public results are kept as
 * they are: that tier is not protected.
 */

// Anywhere in the output: a provider may wrap an MCP result (Codex hands back its JSON).
const LOCKED_RESULT = /Vault items \((secure|sealed) tier\)/;

type Rec = Record<string, unknown>;

function lockedResult(output: string): { tier: string; items: string[] } | null {
  const m = LOCKED_RESULT.exec(output);
  if (!m) return null;
  const items = output.replace(/\\n/g, "\n").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).replace(/ \([^)]*\):.*$/, ""));
  return { tier: m[1]!, items };
}

/** The record as the trace may store it. */
export function filterVaultTraceRecord(sessionId: string | null, payload: unknown, scrubber: TurnSecretScrubber = turnSecretScrubber): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Rec;
  if (p.type === "tool_result" && typeof p.output === "string") {
    const locked = lockedResult(p.output);
    if (locked) {
      const { output: _output, ...rest } = p;
      return { ...rest, withheld: true, tier: locked.tier, items: locked.items };
    }
  }
  if (p.type === "tool_use" && typeof p.tool === "string" && /vault_propose$/.test(p.tool) && p.input && typeof p.input === "object") {
    const { value, ...input } = p.input as Rec;
    return { ...p, input: value === undefined ? input : { ...input, value: "[withheld]" } };
  }
  if (!scrubber.any()) return payload;
  // Anything else: scrub every string the record holds, wherever it sits.
  const json = JSON.stringify(payload);
  const scrubbed = sessionId ? scrubber.scrub(json, sessionId) : scrubber.scrub(json);
  if (scrubbed === json) return payload;
  try { return JSON.parse(scrubbed); } catch { return { type: p.type, withheld: true }; }
}
