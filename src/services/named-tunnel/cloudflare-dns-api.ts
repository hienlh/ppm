/**
 * Cloudflare REST calls the setup flow needs beyond what cloudflared's own
 * CLI exposes: looking up an existing tunnel's UUID by name (so the DNS
 * collision check can tell "already ours" from "someone else's" before
 * `tunnel create` has even run) and reading a zone's DNS records for a
 * candidate hostname.
 */

const TIMEOUT_MS = 10_000;

export interface DnsRecord {
  content: string;
}

async function cfGet<T extends { success?: boolean }>(url: string, apiToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || !json || json.success !== true) {
    throw new Error(`Cloudflare API call failed (HTTP ${res.status})`);
  }
  return json;
}

/** DNS records at `zoneID` matching `name` exactly (empty when none exist). */
export async function fetchDnsRecords(zoneID: string, apiToken: string, name: string): Promise<DnsRecord[]> {
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneID)}/dns_records?name=${encodeURIComponent(name)}`;
  const json = await cfGet<{ success: true; result?: DnsRecord[] }>(url, apiToken);
  return Array.isArray(json.result) ? json.result : [];
}

/** UUID of an existing, non-deleted tunnel named `name` — null if none exists yet. */
export async function fetchTunnelIdByName(accountID: string, apiToken: string, name: string): Promise<string | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountID)}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`;
  const json = await cfGet<{ success: true; result?: Array<{ id?: string }> }>(url, apiToken);
  const found = (json.result ?? []).find((t) => typeof t.id === "string" && t.id);
  return found?.id ?? null;
}
