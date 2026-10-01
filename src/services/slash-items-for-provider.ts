import { providerRegistry } from "../providers/registry.ts";
import { listSlashItems } from "./slash-items.service.ts";
import type { SlashItem } from "./slash-discovery/types.ts";
import { ensureSdkCommands } from "./slash-discovery/sdk-commands.ts";

/**
 * Slash items a session can actually run.
 *
 * A provider that owns its own skill runtime answers for itself, and the disk-discovered
 * Claude-side list is not merged in: a codex turn cannot execute a Claude skill, and a Claude
 * turn cannot execute a codex one, so a combined list would offer entries that quietly do
 * nothing when picked.
 *
 * PPM's host-level built-ins ARE kept, because they are intercepted before any provider runs
 * and therefore work in every tab. Dropping them would have cost a codex tab `/clear`,
 * `/skills`, and `/version` — commands that do work — which is a different thing from hiding
 * ones that don't.
 *
 * When such a provider reports no skills — app-server failed to spawn, account not logged
 * in — only the built-ins remain, rather than falling back to the Claude list; showing
 * runnable-looking Claude entries in a codex tab is the very confusion this split exists to
 * remove.
 *
 * Shared between `GET /chat/slash-items` and `POST /chat/prepare` so a brand-new tab (which
 * has no session yet) and a reload of the same list agree on exactly what a provider offers.
 */
export async function listSlashItemsForProvider(
  projectPath: string,
  providerId: string | undefined,
  sessionId: string | undefined,
): Promise<SlashItem[]> {
  const provider = providerId ? providerRegistry.get(providerId) : null;
  if (provider?.listSkills) {
    const { codexSkillsToSlashItems } = await import("./slash-discovery/codex-skill-items.ts");
    const { getHostBuiltinSlashItems } = await import("./slash-discovery/builtin-commands.ts");
    return [...codexSkillsToSlashItems(await provider.listSkills(sessionId)), ...getHostBuiltinSlashItems()];
  }
  // Claude's own built-ins need a live SDK session to enumerate; cached 30 min,
  // so only the first request per project pays for the CLI spawn.
  await ensureSdkCommands(projectPath);
  return listSlashItems(projectPath);
}
