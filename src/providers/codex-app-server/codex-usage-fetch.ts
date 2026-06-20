/**
 * Shared codex quota fetcher: runs a short-lived app-server bound to a given
 * CODEX_HOME and reads account/rateLimits/read → UsageInfo. Cached per home
 * (60s) so the provider badge and the multi-account list don't spawn per call.
 * Lives here (not the provider/service) to avoid a provider↔account-service cycle.
 */
import type { UsageInfo } from "../provider.interface.ts";
import { CodexJsonRpcClient } from "./codex-jsonrpc-client.ts";
import { parseCodexUsage } from "./codex-usage-parser.ts";
import type { GetAccountRateLimitsResponse } from "./codex-protocol.ts";

const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };
const TTL = 60 * 1000;

const cache = new Map<string, { usage: UsageInfo; expiry: number }>();

export async function fetchCodexUsage(codexHome?: string): Promise<UsageInfo> {
  const key = codexHome ?? "__default__";
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.usage;

  const client = new CodexJsonRpcClient();
  try {
    client.start({ cwd: process.cwd(), codexHome });
    await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES });
    client.notify("initialized");
    const res = await client.request<GetAccountRateLimitsResponse>("account/rateLimits/read", {});
    const usage = parseCodexUsage(res);
    cache.set(key, { usage, expiry: Date.now() + TTL });
    return usage;
  } catch {
    return {};
  } finally {
    client.close();
  }
}
