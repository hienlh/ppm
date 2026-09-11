/**
 * Codex quota reader: runs a short-lived app-server bound to a given CODEX_HOME
 * and reads `account/rateLimits/read`.
 *
 * Deliberately uncached and unguarded — one call, one answer, throws on failure.
 * Caching, the background sweep, the timeout, and persistence belong to the
 * shared provider-usage layer, which reaches this through `codex-usage-source`.
 * It lives here rather than in the provider or the account service to avoid a
 * provider↔account-service import cycle.
 */
import type { UsageInfo } from "../provider.interface.ts";
import { CodexJsonRpcClient, CONTROL_REQUEST_TIMEOUT_MS } from "./codex-jsonrpc-client.ts";
import { parseCodexUsage } from "./codex-usage-parser.ts";
import type { GetAccountRateLimitsResponse } from "./codex-protocol.ts";

const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };

/**
 * Read one codex login's quota, live.
 *
 * Throws on any failure — the caller distinguishes a failure from a login with
 * nothing to report, and a swallowed error would be stored as the latter.
 */
export async function fetchCodexUsageLive(codexHome?: string): Promise<UsageInfo> {
  const client = new CodexJsonRpcClient();
  try {
    client.start({ cwd: process.cwd(), codexHome });
    await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS);
    client.notify("initialized");
    const res = await client.request<GetAccountRateLimitsResponse>("account/rateLimits/read", {}, CONTROL_REQUEST_TIMEOUT_MS);
    return parseCodexUsage(res);
  } finally {
    // Runs even when a request rejects on its own timeout, so a subprocess that
    // accepted the spawn and then went silent is still killed rather than left
    // behind. Before the client had a timeout, that was one orphan per attempt.
    client.close();
  }
}
