import { turnSecretScrubber, type TurnSecretScrubber } from "./turn-secret-scrubber.ts";
import { listItemRows } from "./vault-db.ts";

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

/** Every item name the vault holds, never a value. A name is not a secret: `vault_list` hands them out. */
function vaultItemNames(): string[] {
  try {
    return listItemRows().map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * The tier and the item names of a locked read. The names are only those that match an item the
 * vault really holds: a value is never taken for a name, however its lines start (a list of
 * recovery codes begins its lines with `- `, as the result's own item lines do).
 */
function lockedResult(output: string, knownNames: () => readonly string[]): { tier: string; items: string[] } | null {
  const m = LOCKED_RESULT.exec(output);
  if (!m) return null;
  const known = new Set(knownNames());
  const items: string[] = [];
  for (const line of output.replace(/\\n/g, "\n").split("\n")) {
    if (!line.startsWith("- ")) continue;
    const name = line.slice(2).replace(/ \([^)]*\):.*$/, "");
    if (known.has(name) && !items.includes(name)) items.push(name);
  }
  return { tier: m[1]!, items };
}

/** The record as the trace may store it. */
export function filterVaultTraceRecord(
  sessionId: string | null, payload: unknown, scrubber: TurnSecretScrubber = turnSecretScrubber, knownNames: () => readonly string[] = vaultItemNames,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Rec;
  if (p.type === "tool_result" && typeof p.output === "string") {
    const locked = lockedResult(p.output, knownNames);
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
  // Anything else: scrub every string the record holds, wherever it sits, one string at a time.
  return scrubber.scrubIn(payload, sessionId ?? undefined);
}
