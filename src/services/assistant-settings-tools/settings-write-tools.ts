import type { Json } from "../mcp-http-endpoint.ts";
import { errorResult, jsonResult, notApprovedResult } from "../assistant-mcp/assistant-tool-output.ts";
import type { ToolContext } from "../assistant-mcp/assistant-tool-family.ts";
import { SETTINGS_SET_TOOL, SETTINGS_UNDO_TOOL } from "../../shared/assistant-settings-tool-names.ts";
import type { SettingChangeOrigin, SettingsToolChange, SettingsToolResult } from "../../shared/assistant-settings-changes.ts";
import { lookupSetting, settingsLinkPath } from "./settings-catalog.ts";
import { checkValue, formatValue, sameValue } from "./settings-catalog-types.ts";
import { alwaysAskReason, settingsChangeSummary, type PlannedChange } from "./settings-approval-summary.ts";
import { recordSettingChange, getSettingChange } from "./settings-change-log.ts";
import { routeError, undoBlockFor, undoBlockText, undoSettingChange, writeSetting } from "./settings-apply.ts";

/**
 * `settings_set` and `settings_undo`. One card covers a whole call: Full mode skips it when every
 * change is `direct` (and the turn is the user's), any `card` setting makes it show. After Allow
 * every value is read again; if one moved while the card waited, nothing is written (`stale`).
 */

const MAX_CHANGES = 10;

export const originOf = (ctx: ToolContext): SettingChangeOrigin => (ctx.provenanceAtCall?.startedBy === "user_telegram" ? "telegram" : "ppm");

const result = (r: SettingsToolResult): Json => jsonResult(r as unknown as Record<string, unknown>);

export async function settingsSet(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const raw = args.changes;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHANGES) return errorResult(`\`changes\` must be a list of 1 to ${MAX_CHANGES} { key, value }.`);
  const planned: PlannedChange[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || typeof (item as { key?: unknown }).key !== "string") return errorResult("Each change is { key, value }.");
    const { key, value } = item as { key: string; value: unknown };
    if (seen.has(key)) return errorResult(`"${key.slice(0, 60)}" is named twice.`);
    seen.add(key);
    const found = lookupSetting(key);
    if (found.kind === "refused") {
      return errorResult(`"${key}" is not changed by the Assistant: ${found.refused.reason}${found.refused.useInstead ? "" : ` Point the user to ${settingsLinkPath(found.refused.category)}.`} Nothing was changed.`);
    }
    if (found.kind === "unknown") return errorResult(`"${key.slice(0, 60)}" is not a setting the Assistant changes. Call settings_get to see the keys. Nothing was changed.`);
    const checked = checkValue(found.entry, value);
    if (!checked.ok) return errorResult(`${checked.error}. Nothing was changed.`);
    const before = await found.entry.read();
    if (!sameValue(before, checked.value)) planned.push({ entry: found.entry, before, after: checked.value });
  }
  if (!planned.length) return result({ outcome: "unchanged", changes: [], note: "Every setting already has that value." });

  const reason = alwaysAskReason(planned);
  const verdict = await ctx.ask({
    tool: SETTINGS_SET_TOOL,
    input: { changes: planned.map((p) => ({ key: p.entry.key, value: p.after })) },
    summary: settingsChangeSummary(planned),
    ...(reason ? { alwaysAsk: reason } : {}),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`change ${planned.map((p) => p.entry.label).join(", ")}`, verdict);

  // The card may have waited: write only what is still as it was shown.
  for (const p of planned) {
    const now = await p.entry.read();
    if (!sameValue(now, p.before)) {
      return result({ outcome: "stale", changes: [], note: `${p.entry.label} changed while the card waited (now ${formatValue(p.entry, now)}), so nothing was changed. Do not retry unless the user asks.` });
    }
  }
  const approval = verdict.auto ? "full" : "card";
  const done: SettingsToolChange[] = [];
  for (const p of planned) {
    const r = await writeSetting(ctx.callRoute, p.entry, p.after);
    if (!r.ok) {
      const applied = done.length ? ` Already changed: ${done.map((d) => d.label).join(", ")}.` : "";
      return errorResult(`${p.entry.label} was not changed: ${routeError(r)}.${applied}`);
    }
    const row = recordSettingChange({
      sessionId: ctx.sessionId, origin: originOf(ctx), approval, kind: "setting", key: p.entry.key, label: p.entry.label,
      before: p.before, after: p.after, beforeText: formatValue(p.entry, p.before), afterText: formatValue(p.entry, p.after),
    });
    done.push({ changeId: row.id, key: row.key, label: row.label, before: row.beforeText, after: row.afterText });
  }
  return result({ outcome: "changed", approval, changes: done, note: "Each change can be undone with settings_undo and its changeId, or from the card's Undo." });
}

export async function settingsUndo(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const id = args.changeId;
  if (!Number.isInteger(id) || (id as number) < 1) return errorResult("`changeId` must be the id settings_set or settings_history gave.");
  const row = getSettingChange(id as number);
  if (!row) return errorResult("There is no such change.");
  const block = await undoBlockFor(row);
  if (block) return errorResult(`${undoBlockText(block)} Nothing was changed.`);
  const found = lookupSetting(row.key);
  if (found.kind !== "setting") return errorResult("This setting can no longer be changed from here.");
  const planned: PlannedChange[] = [{ entry: found.entry, before: row.after, after: row.before }];
  const reason = alwaysAskReason(planned);
  const verdict = await ctx.ask({
    tool: SETTINGS_UNDO_TOOL, input: { changeId: row.id, key: row.key, value: row.before },
    summary: settingsChangeSummary(planned, true), ...(reason ? { alwaysAsk: reason } : {}),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`undo the change to ${row.label}`, verdict);
  const out = await undoSettingChange(row.id, { callRoute: ctx.callRoute, approval: verdict.auto ? "full" : "card", origin: originOf(ctx), sessionId: ctx.sessionId });
  if (!out.ok) return out.block ? result({ outcome: "stale", changes: [], note: `${out.error} Nothing was changed.` }) : errorResult(out.error);
  return result({
    outcome: "undone", approval: verdict.auto ? "full" : "card",
    changes: [{ changeId: out.row.id, key: out.row.key, label: out.row.label, before: out.row.beforeText, after: out.row.afterText }],
  });
}
