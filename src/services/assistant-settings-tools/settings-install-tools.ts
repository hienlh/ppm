import type { Json } from "../mcp-http-endpoint.ts";
import { errorResult, jsonResult, notApprovedResult } from "../assistant-mcp/assistant-tool-output.ts";
import type { ToolContext } from "../assistant-mcp/assistant-tool-family.ts";
import { SETTINGS_INSTALL_TOOL } from "../../shared/assistant-settings-tool-names.ts";
import type { SettingsToolResult } from "../../shared/assistant-settings-changes.ts";
import { installSummary } from "./settings-approval-summary.ts";
import { recordSettingChange } from "./settings-change-log.ts";
import { routeError } from "./settings-apply.ts";
import { INSTALL_COMPONENTS, installComponent, type InstallComponent, type InstallOption } from "./settings-installs.ts";
import { originOf } from "./settings-write-tools.ts";
import { watchInstall } from "./settings-install-watch.ts";

/**
 * `settings_install` (install or remove, always with a card) and `settings_install_status`. A
 * background install answers `installing` at once; the chat card follows its progress, Telegram
 * gets one message edited in place, and `settings_install_status` reads it.
 */

const result = (r: SettingsToolResult): Json => jsonResult(r as unknown as Record<string, unknown>);

async function pickOption(component: InstallComponent, option: unknown, action: "install" | "uninstall"): Promise<{ option: InstallOption | null } | { error: string }> {
  if (!component.needsOption) return { option: null };
  const options = await component.options();
  if (action === "uninstall" && option === undefined) {
    const installed = options.filter((o) => o.installed);
    if (installed.length === 1) return { option: installed[0]! };
  }
  const found = options.find((o) => o.id === option);
  if (!found) return { error: `\`option\` must be one of: ${options.map((o) => `${o.id} (${o.label})`).join(", ") || "none on this host"}.` };
  return { option: found };
}

export async function settingsInstall(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const component = installComponent(args.component);
  if (!component) return errorResult(`\`component\` must be one of: ${INSTALL_COMPONENTS.join(", ")}.`);
  const action = args.action === undefined ? "install" : args.action;
  if (action !== "install" && action !== "uninstall") return errorResult("`action` must be install or uninstall.");
  const unavailable = await component.unavailable();
  if (unavailable && action === "install") return errorResult(unavailable);
  const picked = await pickOption(component, args.option, action);
  if ("error" in picked) return errorResult(picked.error);
  const optionId = picked.option?.id ?? null;
  const status = await component.status(optionId);
  if (status.running) return errorResult(`An install of ${component.label} is already running. Check it with settings_install_status.`);
  if (action === "install" && status.installed) return result({ outcome: "unchanged", changes: [], note: `${component.label} is already installed.` });
  if (action === "uninstall" && !status.installed) return result({ outcome: "unchanged", changes: [], note: `${component.label} is not installed.` });
  if (action === "uninstall" && picked.option && !picked.option.removable) {
    return errorResult(`${picked.option.label} was not installed by PPM (it is on PATH or in the project), so PPM does not remove it.`);
  }

  const verdict = await ctx.ask({
    tool: SETTINGS_INSTALL_TOOL,
    input: { component: component.id, action, option: optionId },
    summary: installSummary(component.label, action, picked.option?.label ?? null, await component.facts(optionId, action)),
    alwaysAsk: action === "install" ? "It downloads and runs a program on this machine" : "It deletes a program PPM installed",
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`${action} ${component.label}`, verdict);

  const call = action === "install" ? component.install(optionId) : component.uninstall(optionId);
  const bodyless = call.method === "DELETE";
  const r = await ctx.callRoute(call.method, call.path, bodyless ? undefined : call.body);
  if (!r.ok) return errorResult(`${component.label} was not ${action === "install" ? "installed" : "removed"}: ${routeError(r)}`);
  const label = `${component.label}${picked.option ? ` — ${picked.option.label}` : ""}`;
  const row = recordSettingChange({
    sessionId: ctx.sessionId, origin: originOf(ctx), approval: verdict.auto ? "full" : "card",
    kind: action, key: `install:${component.id}${optionId ? `:${optionId}` : ""}`, label,
    before: null, after: null, beforeText: null, afterText: action === "install" ? "Installed" : "Removed",
  });
  const change = { changeId: row.id, key: row.key, label, before: null, after: row.afterText };
  if (action === "install" && component.background) {
    watchInstall({ component, option: optionId, label, sessionId: ctx.sessionId, origin: originOf(ctx) });
    return result({ outcome: "installing", approval: row.approval, changes: [change], install: { component: component.id, option: optionId },
      note: "It downloads in the background; the user sees its progress. Check it with settings_install_status." });
  }
  return result({ outcome: action === "install" ? "installed" : "uninstalled", approval: row.approval, changes: [change] });
}

export async function settingsInstallStatus(_ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const component = installComponent(args.component);
  if (!component) return errorResult(`\`component\` must be one of: ${INSTALL_COMPONENTS.join(", ")}.`);
  const option = typeof args.option === "string" ? args.option : null;
  const [status, options, unavailable] = await Promise.all([component.status(option), component.options(), component.unavailable()]);
  return jsonResult({
    component: component.id, ...status,
    ...(status.running ? { percent: status.running.totalBytes ? Math.floor((status.running.receivedBytes / status.running.totalBytes) * 100) : null } : {}),
    ...(options.length ? { options } : {}), ...(unavailable ? { unavailable } : {}),
  });
}
