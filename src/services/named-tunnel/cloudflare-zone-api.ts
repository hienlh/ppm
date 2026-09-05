/**
 * Resolve the zone name behind a `zoneID`, using the `apiToken` embedded in the
 * user's origin cert — this avoids asking the user to type a hostname; PPM
 * proposes `ppm.<zone>` from data it already has.
 */

/** 10s bound so a hung Cloudflare API call never wedges setup indefinitely. */
const TIMEOUT_MS = 10_000;

export async function fetchZoneName(zoneID: string, apiToken: string): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneID)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  let json: { success?: boolean; result?: { name?: string } } | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok || !json || json.success !== true || typeof json.result?.name !== "string" || !json.result.name) {
    throw new Error(`Cloudflare rejected the certificate token (HTTP ${res.status}) — log in again`);
  }
  return json.result.name;
}
