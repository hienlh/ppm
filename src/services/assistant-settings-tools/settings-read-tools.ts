import type { Json } from "../mcp-http-endpoint.ts";
import { errorResult, jsonResult } from "../assistant-mcp/assistant-tool-output.ts";
import type { ToolContext } from "../assistant-mcp/assistant-tool-family.ts";
import { allSettings, lookupSetting, settingsLinkPath } from "./settings-catalog.ts";
import { REFUSED_SETTINGS, UNCOVERED_CATEGORIES } from "./settings-catalog-refused.ts";
import { enumValues, formatValue, type RefusedSetting, type SettingEntry } from "./settings-catalog-types.ts";
import { listSettingChanges } from "./settings-change-log.ts";
import { undoBlockFor, undoBlockText } from "./settings-apply.ts";
import { INSTALL_COMPONENTS } from "./settings-installs.ts";

/**
 * `settings_get` and `settings_history`: reads only, never a card. A secret is answered as
 * `{ set: true|false }` and the link to its field, never its value.
 */

const MAX_KEYS = 40;

function allowed(entry: SettingEntry): unknown {
  const v = entry.value;
  switch (v.type) {
    case "enum": return { oneOf: enumValues(v), ...(v.labels ? { labels: v.labels } : {}) };
    case "int": return { wholeNumber: { min: v.min, max: v.max, ...(v.unit ? { unit: v.unit } : {}) } };
    case "text": return { text: { maxLength: v.maxLength, multiline: v.multiline === true } };
    case "string_list": return { listOfStrings: { maxItems: v.maxItems } };
    case "id_list": return { listOfIds: { maxItems: v.maxItems } };
    default: return v.type;
  }
}

async function describe(entry: SettingEntry): Promise<Record<string, unknown>> {
  const value = await entry.read();
  return {
    key: entry.key, label: entry.label, value, shown: formatValue(entry, value), allowed: allowed(entry),
    changes: entry.tier === "direct" ? "without a card in Full mode, with one in Ask mode" : `always with a card (${entry.cardReason})`,
    ...(entry.note ? { note: entry.note } : {}),
  };
}

function describeRefused(r: RefusedSetting): Record<string, unknown> {
  return {
    key: r.key, label: r.label, refused: r.reason,
    ...(r.isSet ? { secret: true, set: r.isSet() } : {}),
    ...(r.useInstead ? { useInstead: r.useInstead } : { openInPpm: settingsLinkPath(r.category) }),
  };
}

export async function settingsGet(_ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const { keys, area } = args;
  if (keys !== undefined) {
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS || !keys.every((k) => typeof k === "string")) {
      return errorResult(`\`keys\` must be a list of 1 to ${MAX_KEYS} setting keys.`);
    }
    const out = await Promise.all((keys as string[]).map(async (key) => {
      const found = lookupSetting(key);
      if (found.kind === "setting") return describe(found.entry);
      if (found.kind === "refused") return describeRefused(found.refused);
      return { key, unknown: "No such setting here. Call settings_get with no arguments for the areas, then with `area`." };
    }));
    return jsonResult({ settings: out });
  }
  if (area !== undefined) {
    if (typeof area !== "string") return errorResult("`area` must be one of the area ids settings_get lists.");
    const entries = allSettings().filter((e) => e.category === area);
    const refused = REFUSED_SETTINGS.filter((r) => r.category === area);
    const uncovered = UNCOVERED_CATEGORIES.find((u) => u.category === area);
    if (!entries.length && !refused.length && !uncovered) return errorResult(`Unknown area "${area.slice(0, 40)}".`);
    return jsonResult({
      area, openInPpm: settingsLinkPath(area),
      settings: await Promise.all(entries.map(describe)),
      ...(refused.length ? { notChangeableHere: refused.map(describeRefused) } : {}),
      ...(uncovered ? { elsewhere: uncovered.reason } : {}),
    });
  }
  const areas = new Map<string, { changeable: number; refused: number }>();
  for (const e of allSettings()) areas.set(e.category, { changeable: (areas.get(e.category)?.changeable ?? 0) + 1, refused: areas.get(e.category)?.refused ?? 0 });
  for (const r of REFUSED_SETTINGS) areas.set(r.category, { changeable: areas.get(r.category)?.changeable ?? 0, refused: (areas.get(r.category)?.refused ?? 0) + 1 });
  return jsonResult({
    areas: [...areas].map(([id, n]) => ({ id, ...n })),
    elsewhere: UNCOVERED_CATEGORIES,
    installs: INSTALL_COMPONENTS,
    howTo: "Call settings_get with `area` to see an area's settings and values, then settings_set with their keys.",
  });
}

export async function settingsHistory(_ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const limit = args.limit === undefined ? 20 : args.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) return errorResult("`limit` must be a whole number from 1 to 50.");
  if (args.key !== undefined && typeof args.key !== "string") return errorResult("`key` must be a setting key.");
  const rows = listSettingChanges({ limit: limit as number, ...(typeof args.key === "string" ? { key: args.key } : {}) });
  const changes = await Promise.all(rows.map(async (r) => {
    const block = await undoBlockFor(r);
    return {
      changeId: r.id, at: new Date(r.at).toISOString(), kind: r.kind, key: r.key, label: r.label,
      before: r.beforeText, after: r.afterText, via: r.origin, allowed: r.approval,
      ...(r.note ? { note: r.note } : {}), ...(r.undoes ? { undoes: r.undoes } : {}),
      undo: block ? undoBlockText(block) : "possible with settings_undo",
    };
  }));
  return jsonResult({ changes }, { key: "changes", list: changes });
}
