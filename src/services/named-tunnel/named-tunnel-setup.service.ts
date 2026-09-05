/**
 * Zone → precheck → create → route → token → persist → confirm.
 *
 * The DNS collision precheck runs *before* `tunnel create`, so "is this
 * record already ours" is answered via the Cloudflare API's own tunnel
 * lookup-by-name (an idempotent retry has an existing tunnel; a first-time
 * setup does not) rather than by depending on `create` having already run.
 */
import { readOriginCertState } from "./cloudflared-cert.ts";
import { fetchZoneName } from "./cloudflare-zone-api.ts";
import { fetchDnsRecords, fetchTunnelIdByName } from "./cloudflare-dns-api.ts";
import { proposeHostname, validateHostname } from "./hostname-rules.ts";
import { createTunnelArgs, routeDnsArgs, tunnelTokenArgs, tunnelNameForHost } from "./named-tunnel-args.ts";
import { runCloudflared } from "./cloudflared-exec.ts";
import { configService } from "../config.service.ts";
import { requestTunnelReload, readStatus } from "../supervisor-state.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { pinsMatch } from "./cloudflared-login-helpers.ts";

export type CertState = "none" | "invalid" | "ok" | "mismatch";

/** Thrown by the flow below; routes map `.status` straight to the HTTP response. */
export class SetupError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TOKEN_SHAPE = /^[A-Za-z0-9._-]{100,}$/;
const RELOAD_RETRY_DELAY_MS = 2_000;
const CONFIRM_POLL_BUDGET_MS = 45_000;
const CONFIRM_POLL_INTERVAL_MS = 1_000;

/** Module-level in-flight guard — two concurrent setups would race `route dns`. */
let setupInFlight = false;

/**
 * Read-mostly cert classification for `/status` — never leaks the token.
 * `"mismatch"` is a pure pin comparison (no network call): the parsed cert's
 * zoneID/accountID differ from whatever `tunnel` config already pinned, i.e.
 * cloudflared logged into a *different* Cloudflare account than the one this
 * machine's named tunnel was set up under.
 */
export function currentCertState(): CertState {
  const state = readOriginCertState();
  if (state.kind === "absent") return "none";
  if (state.kind === "unparseable") return "invalid";
  return pinsMatch(state.cert) ? "ok" : "mismatch";
}

export async function readZoneInfo(): Promise<{ zone: string; zoneID: string; accountID: string; proposedHostname: string }> {
  const certState = readOriginCertState();
  if (certState.kind !== "parsed") throw new SetupError(400, "Not logged in to Cloudflare");
  if (!pinsMatch(certState.cert)) {
    throw new SetupError(400, "cert belongs to a different Cloudflare account — log in again");
  }
  const zone = await fetchZoneName(certState.cert.zoneID, certState.cert.apiToken);
  return { zone, zoneID: certState.cert.zoneID, accountID: certState.cert.accountID, proposedHostname: proposeHostname(zone) };
}

export async function disableNamedTunnel(): Promise<void> {
  const current = configService.get("tunnel");
  configService.set("tunnel", { ...current, mode: "quick" });
  requestTunnelReload();
}

async function pollForConfirmation(hostname: string): Promise<boolean> {
  const deadline = Date.now() + CONFIRM_POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    const status = readStatus();
    if (status.tunnelMode === "named" && status.shareUrl === `https://${hostname}`) return true;
    await Bun.sleep(CONFIRM_POLL_INTERVAL_MS);
  }
  return false;
}

export type SetupOutcome =
  | { ok: true; hostname: string; tunnelName: string }
  | { ok: "pending"; hostname: string; tunnelName: string; message: string };

export async function runSetup(hostname: string): Promise<SetupOutcome> {
  if (setupInFlight) throw new SetupError(409, "a setup is already running");
  setupInFlight = true;
  try {
    return await runSetupInner(hostname);
  } finally {
    setupInFlight = false;
  }
}

async function runSetupInner(hostname: string): Promise<SetupOutcome> {
  broadcastGlobalEvent({ type: "tunnel:setup_step", step: "zone", message: "reading Cloudflare zone" });
  const certState = readOriginCertState();
  if (certState.kind !== "parsed") throw new SetupError(400, "Not logged in to Cloudflare");
  const { zoneID, accountID, apiToken } = certState.cert;

  const zone = await fetchZoneName(zoneID, apiToken);
  const check = validateHostname(hostname, zone);
  if (!check.ok) throw new SetupError(400, check.reason);

  const tunnelName = tunnelNameForHost();

  broadcastGlobalEvent({ type: "tunnel:setup_step", step: "precheck", message: "checking for a DNS collision" });
  const existingId = await fetchTunnelIdByName(accountID, apiToken, tunnelName);
  const records = await fetchDnsRecords(zoneID, apiToken, hostname);
  let overwrite = false;
  if (records.length > 0) {
    const ownTarget = existingId ? `${existingId}.cfargotunnel.com` : null;
    const isOwn = ownTarget != null && records.some((r) => r.content === ownTarget);
    if (!isOwn) throw new SetupError(400, "that name already points somewhere else — pick another prefix");
    overwrite = true;
  }

  broadcastGlobalEvent({ type: "tunnel:setup_step", step: "create", message: "creating tunnel" });
  const create = await runCloudflared(createTunnelArgs(tunnelName));
  if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
    throw new SetupError(500, `cloudflared tunnel create failed: ${(create.stderr || create.stdout).trim()}`);
  }

  broadcastGlobalEvent({ type: "tunnel:setup_step", step: "route", message: "routing DNS" });
  const route = await runCloudflared(routeDnsArgs(tunnelName, hostname, overwrite));
  if (route.code !== 0) {
    throw new SetupError(500, `cloudflared tunnel route dns failed: ${(route.stderr || route.stdout).trim()}`);
  }

  broadcastGlobalEvent({ type: "tunnel:setup_step", step: "token", message: "fetching run token" });
  const tokenResult = await runCloudflared(tunnelTokenArgs(tunnelName));
  const token = tokenResult.stdout.trim();
  if (tokenResult.code !== 0 || !TOKEN_SHAPE.test(token)) {
    throw new SetupError(500, "unexpected cloudflared output while fetching the run token");
  }

  broadcastGlobalEvent({ type: "tunnel:setup_step", step: "apply", message: "applying configuration" });
  configService.set("tunnel", {
    mode: "named",
    namedTunnelName: tunnelName,
    namedTunnelHostname: hostname,
    namedTunnelToken: token,
    zoneID,
    accountID,
  });

  const pending = (message: string): SetupOutcome => {
    broadcastGlobalEvent({ type: "tunnel:setup_pending", hostname, message });
    return { ok: "pending", hostname, tunnelName, message };
  };

  const status = readStatus();
  const capabilities = Array.isArray(status.capabilities) ? (status.capabilities as unknown[]) : [];
  if (!capabilities.includes("retunnel")) {
    return pending("run `ppm restart` to apply — this PPM version needs a restart to pick up named tunnels");
  }

  let reload = requestTunnelReload();
  if (reload === "busy") {
    await Bun.sleep(RELOAD_RETRY_DELAY_MS);
    reload = requestTunnelReload();
  }
  if (reload === "busy") {
    return pending("supervisor busy — it will pick up the new setting shortly, or run `ppm restart`");
  }
  if (reload === "no-supervisor") {
    return pending("no supervisor detected — run `ppm restart`");
  }

  // reload === "sent" — don't block the HTTP response on up to 45s of
  // polling: a proxy/tunnel in front of PPM with a shorter idle timeout would
  // time the browser out while setup was actually succeeding. Confirm
  // detached and let /ws/global carry the final result (setup_done, or a
  // follow-up setup_pending if confirmation itself times out) — the UI
  // already listens for both events.
  confirmReloadInBackground(hostname);
  return pending("reload sent — waiting for the supervisor to confirm");
}

/** Fire-and-forget: polls status.json and broadcasts the final outcome. Never throws into the caller. */
function confirmReloadInBackground(hostname: string): void {
  pollForConfirmation(hostname)
    .then((confirmed) => {
      if (confirmed) {
        broadcastGlobalEvent({ type: "tunnel:setup_done", hostname });
        return;
      }
      const latest = readStatus();
      const warning = typeof latest.tunnelWarning === "string" ? latest.tunnelWarning : null;
      broadcastGlobalEvent({
        type: "tunnel:setup_pending",
        hostname,
        message: warning ?? "setup saved but the supervisor has not confirmed it yet — check again shortly",
      });
    })
    .catch(() => {
      broadcastGlobalEvent({
        type: "tunnel:setup_pending",
        hostname,
        message: "confirmation check failed — check status again shortly",
      });
    });
}

/**
 * Aggregate for callers that need a single patchable seam (the HTTP routes) —
 * route tests monkey-patch these properties directly rather than reaching for
 * `mock.module`, which replaces the module for every importer process-wide and
 * would poison this file's own direct-function unit tests.
 */
export const namedTunnelSetupService = { readZoneInfo, runSetup, disableNamedTunnel, currentCertState };
