import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Claude Code settings files, lowest precedence first (user < project < local). */
function settingsFiles(projectPath: string): string[] {
  return [
    resolve(homedir(), ".claude", "settings.json"),
    resolve(projectPath, ".claude", "settings.json"),
    resolve(projectPath, ".claude", "settings.local.json"),
  ];
}

/** Shape we rely on from a Claude Code settings file. */
interface ClaudeSettings {
  enabledPlugins?: Record<string, unknown>;
}

function readEnabledPlugins(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as ClaudeSettings;
    return parsed.enabledPlugins ?? {};
  } catch {
    return {};
  }
}

/**
 * Collect plugin keys (`plugin-id@marketplace-id`) that settings turn off.
 *
 * Only an explicit `false` disables. A key that is absent everywhere stays
 * enabled: the install registry is the source of truth for what exists, and
 * silently hiding installed content is worse than listing one extra plugin.
 * Non-boolean values (version constraints) mean enabled.
 */
export function loadDisabledPluginKeys(projectPath: string): Set<string> {
  const merged: Record<string, unknown> = {};
  for (const file of settingsFiles(projectPath)) {
    Object.assign(merged, readEnabledPlugins(file));
  }
  return new Set(Object.keys(merged).filter((key) => merged[key] === false));
}
