/**
 * Runtime seam between "what's persisted" (named-tunnel-config.ts) and "what
 * to actually spawn" (cloudflared.service.ts / named-tunnel-args.ts). Kept out
 * of supervisor.ts (already large) and out of phase 1b's config/argv modules
 * so neither grows to own the other's concern.
 */
import { getConfigValue } from "../db.service.ts";
import { resolveTunnelConfig, type ResolvedTunnelConfig, type TunnelMode } from "./named-tunnel-config.ts";
import { getQuickTunnelArgs } from "../cloudflared.service.ts";
import { namedRunArgs } from "./named-tunnel-args.ts";

/**
 * Fresh (non-cached) read of the persisted tunnel config.
 *
 * The supervisor runs in its own process with its own `configService`
 * singleton, which never observes writes the server process makes to
 * SQLite — so every caller here must go through `getConfigValue` (a raw DB
 * read), never `configService.get`, or the supervisor would spawn/adopt
 * against a stale mode forever.
 */
export async function readTunnelConfigFresh(): Promise<ResolvedTunnelConfig> {
  return resolveTunnelConfig(getConfigValue("tunnel"));
}

export interface TunnelSpawnPlan {
  mode: TunnelMode;
  args: string[];
}

/**
 * Pick the argv for the next tunnel spawn attempt from a resolved config.
 * When `config.mode` is not `"named"` (or the token is somehow absent —
 * `resolveTunnelConfig` already guarantees this can't happen for a config row
 * with `mode: "named"`, this is belt-and-suspenders), the output is exactly
 * `getQuickTunnelArgs(port)` — byte-identical to today's quick-only argv.
 */
export function chooseTunnelSpawn(config: ResolvedTunnelConfig, port: number): TunnelSpawnPlan {
  if (config.mode === "named" && config.token) {
    return { mode: "named", args: namedRunArgs(config.token, port) };
  }
  return { mode: "quick", args: getQuickTunnelArgs(port) };
}
