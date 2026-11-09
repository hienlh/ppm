/**
 * Setting the share host up: its switch, the temporary address, and a hostname on the user's
 * Cloudflare domain — on a tunnel of its own (`named`) or on PPM's named tunnel (`shared`).
 *
 * The domain flow is PPM's own (`named-tunnel-setup.service.ts`): the Cloudflare login's cert,
 * the hostname rules, every collision check before anything is created, and a DNS record
 * overwritten only when it already points at a tunnel of this installation's. The supervisor is
 * told with `reshare`; what then runs is reported through status.json (`share-host-status.ts`).
 */
import { readOriginCertState } from "../named-tunnel/cloudflared-cert.ts";
import { fetchZoneName } from "../named-tunnel/cloudflare-zone-api.ts";
import { fetchDnsRecords, fetchTunnelByName } from "../named-tunnel/cloudflare-dns-api.ts";
import { validateHostname } from "../named-tunnel/hostname-rules.ts";
import { createTunnelArgs, routeDnsArgs, tunnelNameForHost, tunnelTokenArgs } from "../named-tunnel/named-tunnel-args.ts";
import { runCloudflared } from "../named-tunnel/cloudflared-exec.ts";
import { pinsMatch } from "../named-tunnel/cloudflared-login-helpers.ts";
import { resolveTunnelConfig } from "../named-tunnel/named-tunnel-config.ts";
import { readZoneInfo, SetupError, TOKEN_SHAPE } from "../named-tunnel/named-tunnel-setup.service.ts";
import { configService } from "../config.service.ts";
import { requestShareHostReload } from "../supervisor-state.ts";
import { createLogger } from "../logger.ts";
import { shareTunnelNameForHost } from "./share-host-config.ts";
import { NOT_SUPERVISED_MESSAGE, OUTDATED_SUPERVISOR_MESSAGE } from "./share-host-status.ts";

const log = createLogger("share-host");

const RELOAD_RETRY_DELAY_MS = 2_000;

/** Test seam: the one-shot cloudflared runner (tunnel create, route dns, token). */
export const shareHostSetupDeps = { runCloudflared, reloadRetryDelayMs: RELOAD_RETRY_DELAY_MS };

/** Whether the running supervisor took the change, and what to tell the user when it did not. */
export type ShareHostApplied = { applied: true } | { applied: false; message: string };

export interface ShareHostSetupResult {
  hostname: string;
  tunnelName: string;
  applied: ShareHostApplied;
}

/** Module-level in-flight guard — two concurrent setups would race `route dns`. */
let setupInFlight = false;

async function applyToSupervisor(what: string): Promise<ShareHostApplied> {
  let reload = requestShareHostReload();
  if (reload === "busy") {
    await Bun.sleep(shareHostSetupDeps.reloadRetryDelayMs);
    reload = requestShareHostReload();
  }
  log[reload === "sent" ? "info" : "warn"](`${what}; supervisor reload ${reload}`);
  switch (reload) {
    case "sent":
      return { applied: true };
    case "busy":
      return { applied: false, message: "PPM is busy and picks this up shortly, or run `ppm restart`." };
    case "outdated":
      return { applied: false, message: OUTDATED_SUPERVISOR_MESSAGE };
    case "no-supervisor":
      return { applied: false, message: NOT_SUPERVISED_MESSAGE };
  }
}

export function setShareHostEnabled(enabled: boolean): Promise<ShareHostApplied> {
  configService.set("share_host", { ...configService.get("share_host"), enabled });
  return applyToSupervisor(`Review address switched ${enabled ? "on" : "off"}`);
}

/** Back to a temporary address. The domain fields stay: they record which tunnel is ours. */
export function useTemporaryShareAddress(): Promise<ShareHostApplied> {
  configService.set("share_host", { ...configService.get("share_host"), mode: "quick" });
  return applyToSupervisor("Review address on a temporary address");
}

export async function readShareZone(): Promise<{ zone: string; proposedHostname: string }> {
  const { zone } = await readZoneInfo();
  return { zone, proposedHostname: `share.${zone}` };
}

export async function runShareHostSetup(mode: "named" | "shared", hostname: string): Promise<ShareHostSetupResult> {
  if (setupInFlight) throw new SetupError(409, "a setup is already running");
  setupInFlight = true;
  try {
    return await runSetupInner(mode, hostname.trim().toLowerCase());
  } finally {
    setupInFlight = false;
  }
}

async function runSetupInner(mode: "named" | "shared", hostname: string): Promise<ShareHostSetupResult> {
  const certState = readOriginCertState();
  if (certState.kind !== "parsed") throw new SetupError(400, "Not logged in to Cloudflare");
  if (!pinsMatch(certState.cert)) throw new SetupError(400, "cert belongs to a different Cloudflare account — log in again");
  const { zoneID, accountID, apiToken } = certState.cert;

  const zone = await fetchZoneName(zoneID, apiToken);
  const check = validateHostname(hostname, zone);
  if (!check.ok) throw new SetupError(400, check.reason);

  const ppm = resolveTunnelConfig(configService.get("tunnel"));
  if (ppm.mode === "named" && ppm.hostname === hostname) {
    throw new SetupError(400, "that is PPM's own address — pick another name");
  }
  const ppmTunnelName = ppm.mode === "named" ? ppm.tunnelName ?? tunnelNameForHost() : null;
  if (mode === "shared" && !ppmTunnelName) {
    throw new SetupError(400, "PPM's public link is not on your domain — set it up under Public link first");
  }
  const current = configService.get("share_host");
  const tunnelName = mode === "shared" ? ppmTunnelName! : shareTunnelNameForHost();

  const target = await fetchTunnelByName(accountID, apiToken, tunnelName);
  if (mode === "shared" && !target) {
    throw new SetupError(400, `PPM's tunnel "${tunnelName}" no longer exists on Cloudflare — set PPM's public link up again`);
  }
  // As for PPM's own tunnel: a second connector on a tunnel another PPM serves would have
  // Cloudflare spread that PPM's requests over both.
  if (mode === "named" && target && target.activeConnections > 0 && current?.tunnelName !== tunnelName) {
    throw new SetupError(
      409,
      `a tunnel named "${tunnelName}" is already running elsewhere — stop that PPM instance first, or run this one with its own PPM_HOME`,
    );
  }

  const records = await fetchDnsRecords(zoneID, apiToken, hostname);
  let overwrite = false;
  if (records.length > 0) {
    const ours = new Set<string>();
    if (target) ours.add(`${target.id}.cfargotunnel.com`);
    // This installation's own review hostname, moving between its own tunnel and PPM's.
    if (current?.hostname === hostname) {
      const otherName = mode === "shared" ? current.tunnelName : ppmTunnelName;
      const other = otherName ? await fetchTunnelByName(accountID, apiToken, otherName) : null;
      if (other) ours.add(`${other.id}.cfargotunnel.com`);
    }
    if (!records.some((r) => ours.has(r.content))) {
      throw new SetupError(400, "that name already points somewhere else — pick another prefix");
    }
    overwrite = true;
  }

  if (mode === "named") {
    const create = await shareHostSetupDeps.runCloudflared(createTunnelArgs(tunnelName));
    if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
      throw new SetupError(500, `cloudflared tunnel create failed: ${(create.stderr || create.stdout).trim()}`);
    }
  }

  const route = await shareHostSetupDeps.runCloudflared(routeDnsArgs(tunnelName, hostname, overwrite));
  if (route.code !== 0) {
    throw new SetupError(500, `cloudflared tunnel route dns failed: ${(route.stderr || route.stdout).trim()}`);
  }

  let own: { tunnelName: string; token: string } | null = null;
  if (mode === "named") {
    const tokenResult = await shareHostSetupDeps.runCloudflared(tunnelTokenArgs(tunnelName));
    const token = tokenResult.stdout.trim();
    if (tokenResult.code !== 0 || !TOKEN_SHAPE.test(token)) {
      throw new SetupError(500, "unexpected cloudflared output while fetching the run token");
    }
    own = { tunnelName, token };
  }

  configService.set("share_host", {
    // Carries the switch (setting a domain up is not turning the address on) and, in `shared`
    // mode, the share host's own tunnel if it has one.
    ...configService.get("share_host"),
    mode,
    hostname,
    zoneID,
    accountID,
    ...own,
  });
  // Never the run token: it is the credential the connector runs with.
  const applied = await applyToSupervisor(
    `Review address set up: ${hostname} mode=${mode} tunnel=${tunnelName} reused=${!!target} overwriteDns=${overwrite}`,
  );
  return { hostname, tunnelName, applied };
}

/**
 * Aggregate for the HTTP routes, which patch these properties in tests rather than reaching for
 * `mock.module` (see `namedTunnelSetupService`).
 */
export const shareHostSetupService = {
  setEnabled: setShareHostEnabled,
  useTemporary: useTemporaryShareAddress,
  readZone: readShareZone,
  runSetup: runShareHostSetup,
};
