/**
 * Reads the PPM Assistant's settings tool calls (`mcp__ppm-assistant__settings_set`,
 * `ppm_assistant:settings_set`, …) for their chat card: what was asked, and what the tool answered
 * (`SettingsToolResult`, `src/shared/assistant-settings-changes.ts`). Pure, so it is tested without
 * the stores. Everything comes from an AI or a tool's output, so every field is checked.
 */
import { ppmToolArgs, ppmToolName } from "./ppm-tool-call";
import { tabToolResultText } from "./tab-tool-call";
import { SETTINGS_TOOLS, type SettingsToolName } from "../../shared/assistant-settings-tool-names";
import type { SettingChangeApproval, SettingsToolChange, SettingsToolResult } from "../../shared/assistant-settings-changes";

export interface SettingsToolCall {
  tool: SettingsToolName;
  /** settings_set: the keys asked for. */
  keys: string[];
  /** settings_install: component, action and option. */
  install: { component: string; action: "install" | "uninstall"; option: string | null } | null;
  /** settings_get: the area or keys read. */
  target: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function settingsToolCall(toolName: string, input: unknown): SettingsToolCall | null {
  const name = ppmToolName(toolName);
  if (!name || name.server !== "assistant" || !(SETTINGS_TOOLS as readonly string[]).includes(name.tool)) return null;
  const args = ppmToolArgs(input);
  const changes = Array.isArray(args.changes) ? args.changes : [];
  const keys = changes.map((c) => (isObj(c) ? str(c.key) : null)).filter((k): k is string => !!k);
  const install = name.tool === "settings_install" || name.tool === "settings_install_status"
    ? { component: str(args.component) ?? "?", action: args.action === "uninstall" ? "uninstall" as const : "install" as const, option: str(args.option) }
    : null;
  const target = str(args.area) ?? (Array.isArray(args.keys) ? args.keys.filter((k) => typeof k === "string").join(", ") || null : null);
  return { tool: name.tool as SettingsToolName, keys, install, target };
}

const APPROVALS: readonly SettingChangeApproval[] = ["full", "card", "user"];
const OUTCOMES: readonly SettingsToolResult["outcome"][] = ["changed", "unchanged", "stale", "installing", "installed", "uninstalled", "undone"];

function parseChange(v: unknown): SettingsToolChange | null {
  if (!isObj(v) || !Number.isInteger(v.changeId) || typeof v.label !== "string" || typeof v.key !== "string") return null;
  return {
    changeId: v.changeId as number, key: v.key, label: v.label,
    before: typeof v.before === "string" ? v.before : null, after: typeof v.after === "string" ? v.after : null,
    ...(typeof v.note === "string" ? { note: v.note } : {}),
  };
}

/** The tool's JSON answer, or null for an error, a refusal or anything unexpected. */
export function settingsToolResult(output: string | undefined): SettingsToolResult | null {
  if (output === undefined) return null;
  let data: unknown;
  try { data = JSON.parse(tabToolResultText(output)); } catch { return null; }
  if (!isObj(data) || !OUTCOMES.includes(data.outcome as SettingsToolResult["outcome"])) return null;
  const changes = Array.isArray(data.changes) ? data.changes.map(parseChange).filter((c): c is SettingsToolChange => !!c) : [];
  const install = isObj(data.install) && typeof data.install.component === "string"
    ? { component: data.install.component, option: typeof data.install.option === "string" ? data.install.option : null }
    : undefined;
  return {
    outcome: data.outcome as SettingsToolResult["outcome"],
    ...(APPROVALS.includes(data.approval as SettingChangeApproval) ? { approval: data.approval as SettingChangeApproval } : {}),
    changes,
    ...(install ? { install } : {}),
    ...(typeof data.note === "string" ? { note: data.note } : {}),
  };
}

/** The card's one-line title. */
export function settingsToolTitle(call: SettingsToolCall, result: SettingsToolResult | null): string {
  switch (call.tool) {
    case "settings_get": return call.target ? `Read settings: ${call.target}` : "Read settings";
    case "settings_history": return "Read settings history";
    case "settings_install_status": return `Check install: ${call.install?.component ?? ""}`;
    case "settings_undo": return result?.outcome === "undone" ? "Setting put back" : "Undo a settings change";
    case "settings_install": {
      const what = `${call.install?.component.replace(/_/g, " ") ?? ""}${call.install?.option ? ` (${call.install.option})` : ""}`;
      if (result?.outcome === "installing") return `Installing ${what}`;
      if (result?.outcome === "installed") return `Installed ${what}`;
      if (result?.outcome === "uninstalled") return `Removed ${what}`;
      return call.install?.action === "uninstall" ? `Remove ${what}` : `Install ${what}`;
    }
    case "settings_set":
      if (result?.outcome === "changed") return result.changes.length === 1 ? "Setting changed" : `${result.changes.length} settings changed`;
      if (result?.outcome === "unchanged") return "Settings already set";
      if (result?.outcome === "stale") return "Settings not changed (they moved)";
      return call.keys.length === 1 ? `Change ${call.keys[0]}` : `Change ${call.keys.length} settings`;
  }
}

const NOT_DONE: Readonly<Record<string, string>> = {
  declined: "Not changed: declined on the card.",
  "no-answer": "Not changed: the card was not answered.",
  withdrawn: "Not changed: the card was withdrawn.",
  unavailable: "Not changed: nobody could be asked.",
};

/**
 * What the card says under a call that changed nothing: a person's sentence for a declined or
 * withdrawn card (the tool answers the agent in JSON), else the tool's own words.
 */
export function settingsToolMessage(output: string, isError: boolean, result: SettingsToolResult | null): string | null {
  if (result) return result.outcome === "changed" || result.outcome === "undone" || result.outcome === "installed" || result.outcome === "uninstalled" ? null : (result.note ?? null);
  const text = tabToolResultText(output);
  try {
    const data: unknown = JSON.parse(text);
    if (isObj(data) && typeof data.outcome === "string" && NOT_DONE[data.outcome]) return NOT_DONE[data.outcome]!;
  } catch { /* plain words */ }
  return isError || text ? text : null;
}

export const approvalLabel = (a: SettingChangeApproval | undefined): string | null =>
  a === "full" ? "Full mode, no card" : a === "card" ? "Allowed on card" : a === "user" ? "Your undo" : null;
