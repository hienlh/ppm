import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import { exactFact } from "../assistant-mcp/assistant-approval-summary.ts";
import { formatValue, type SettingEntry } from "./settings-catalog-types.ts";

/**
 * The cards the settings tools show, built from the catalog and the values PPM read — never from
 * the agent's wording. A fact is never cut: a setting's name and both values are what the user
 * decides on. A long text value (instructions, a persona) goes into the body, whole.
 */

export interface PlannedChange {
  entry: SettingEntry;
  before: unknown;
  after: unknown;
}

/** Text values longer than this are shown in the body rather than as a fact. */
const INLINE_TEXT_MAX = 160;

const isLongText = (c: PlannedChange) => c.entry.value.type === "text" && (String(c.after ?? "").length > INLINE_TEXT_MAX || /\n/.test(String(c.after ?? "")));

/** Why the whole call asks even in Full mode, or undefined when every change is `direct`. */
export function alwaysAskReason(changes: readonly PlannedChange[]): string | undefined {
  const reasons = [...new Set(changes.filter((c) => c.entry.tier === "card").map((c) => c.entry.cardReason ?? "It changes a protected setting"))];
  return reasons.length ? `${reasons.join("; ")} — asks even in Full mode` : undefined;
}

export function settingsChangeSummary(changes: readonly PlannedChange[], undo = false): ApprovalSummary {
  const facts: ApprovalFact[] = [];
  const bodies: string[] = [];
  for (const c of changes) {
    const before = formatValue(c.entry, c.before);
    if (isLongText(c)) {
      facts.push(exactFact(c.entry.label, "new text below"));
      bodies.push(changes.length > 1 ? `${c.entry.label}:\n${String(c.after)}` : String(c.after));
    } else {
      facts.push(exactFact(c.entry.label, `${before} → ${formatValue(c.entry, c.after)}`, c.entry.tier === "card" ? "warning" : undefined));
    }
    if (c.entry.note) facts.push(exactFact("Note", c.entry.note));
  }
  const warnings = changes.map((c) => c.entry.warn?.(c.after) ?? null).filter((w): w is string => !!w);
  const reason = alwaysAskReason(changes);
  if (reason) facts.push(exactFact("Asks because", reason, "warning"));
  const count = changes.length === 1 ? "a setting" : `${changes.length} settings`;
  return {
    headline: undo ? `Undo a change to ${changes[0]?.entry.label ?? "a setting"}` : `Change ${count} in PPM's Settings`,
    facts,
    ...(bodies.length ? { body: { label: "New text", text: bodies.join("\n\n"), format: "text" as const } } : {}),
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

export function installSummary(label: string, action: "install" | "uninstall", optionLabel: string | null, facts: ApprovalFact[]): ApprovalSummary {
  const what = optionLabel ? `${label} — ${optionLabel}` : label;
  return {
    headline: action === "install" ? `Download and install ${what}` : `Remove ${what}`,
    facts: [
      ...facts.map((f) => exactFact(f.label, f.value, f.tone)),
      exactFact("Asks because", action === "install"
        ? "It downloads and runs a program on this machine — asks even in Full mode"
        : "It deletes a program PPM installed, with no copy kept — asks even in Full mode", "warning"),
    ],
  };
}
