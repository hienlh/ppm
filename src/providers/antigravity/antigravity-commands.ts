import { getConfigValue, setConfigValue } from "../../services/db.service.ts";
import { createLogger } from "../../services/logger.ts";
import type { SlashItem } from "../../services/slash-discovery/types.ts";

const log = createLogger("antigravity");

/**
 * The slash commands agy last reported for each project, as one config row outside
 * `CONFIG_TABLE_KEYS` (so never loaded into the config itself).
 *
 * agy names its commands (`/goal`, `/compact`, its skills…) only to an open chat, in an
 * `available_commands_update`, and has no request that lists them without one. Kept here, they
 * are in the picker of a new tab and after a restart, before any agy process runs.
 */
const CONFIG_KEY = "antigravity_slash_commands";
/** The least recently changed projects are dropped past this, so the row stays small. */
const MAX_PROJECTS = 100;

export interface AgyCommand {
  name: string;
  description?: string;
  hint?: string;
}

/** The usable entries of an `available_commands_update` list, or of the stored copy of one. */
export function parseAgyCommands(raw: unknown): AgyCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): AgyCommand[] => {
    const c = entry as { name?: unknown; description?: unknown; hint?: unknown; input?: { hint?: unknown } | null };
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name || /\s/.test(name)) return [];
    const hint = typeof c.input?.hint === "string" ? c.input.hint : typeof c.hint === "string" ? c.hint : undefined;
    return [{ name, ...(typeof c.description === "string" ? { description: c.description } : {}), ...(hint ? { hint } : {}) }];
  });
}

function readStored(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(getConfigValue(CONFIG_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Keep the commands agy just reported for a project; written only when they changed. */
export function rememberAgyCommands(projectPath: string, raw: unknown): void {
  const commands = parseAgyCommands(raw);
  if (!projectPath || commands.length === 0) return;
  try {
    const stored = readStored();
    if (JSON.stringify(stored[projectPath]) === JSON.stringify(commands)) return;
    delete stored[projectPath];
    stored[projectPath] = commands;
    const projects = Object.keys(stored);
    for (const old of projects.slice(0, Math.max(0, projects.length - MAX_PROJECTS))) delete stored[old];
    setConfigValue(CONFIG_KEY, JSON.stringify(stored));
  } catch (err) {
    log.warn(`could not keep agy's slash commands for ${projectPath}: ${(err as Error).message}`);
  }
}

/**
 * agy's commands as picker items: the ones it reported for this project, else the latest any
 * project got (its built-in commands are the same everywhere, only a workspace's own skills
 * differ), or null while agy has never reported any.
 */
export function agySlashItems(projectPath: string): SlashItem[] | null {
  const stored = readStored();
  const commands = parseAgyCommands(stored[projectPath] ?? Object.values(stored).at(-1));
  if (commands.length === 0) return null;
  return commands.map((c) => ({
    type: "command" as const,
    name: c.name,
    description: c.description ?? "",
    ...(c.hint ? { argumentHint: c.hint } : {}),
    scope: "bundled" as const,
  }));
}
