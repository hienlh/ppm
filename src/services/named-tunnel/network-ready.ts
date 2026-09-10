/**
 * "Is the network back yet?" gate for the named-tunnel spawn path.
 *
 * A connector started before the machine's Wi-Fi has reassociated cannot
 * register, and the readiness wait then expires on a failure that would have
 * cleared itself seconds later. Observed live after a laptop resumed from
 * sleep: the supervisor regenerated the tunnel immediately, named timed out,
 * and the permanent hostname served 530 until someone intervened.
 *
 * Only the named path waits: a quick tunnel that fails is retried with a fresh
 * URL anyway, while a named failure costs the user their fixed address.
 */

/** Cheap, unauthenticated, and the exact host the connector needs anyway. */
const PROBE_URL = "https://api.cloudflare.com/client/v4/";

export interface NetworkReadyOptions {
  /** Give up after this long and let the caller try regardless. */
  timeoutMs?: number;
  /** Wait between probes. */
  intervalMs?: number;
  /** Per-probe timeout. */
  probeTimeoutMs?: number;
  /** Injectable for tests; defaults to a HEAD against Cloudflare's API. */
  probe?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function defaultProbe(probeTimeoutMs: number): Promise<boolean> {
  try {
    // Any HTTP answer proves DNS + TCP + TLS to Cloudflare work; the status
    // code is irrelevant (401/404 are just as good a signal as 200).
    await fetch(PROBE_URL, { method: "HEAD", signal: AbortSignal.timeout(probeTimeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `true` as soon as Cloudflare is reachable, `false` if the budget
 * runs out. Never throws: a failed wait is a hint, not a veto — the caller
 * still attempts the spawn, because a probe can fail for reasons (proxy, DNS
 * filtering) that would not stop the connector itself.
 */
export async function waitForCloudflareReachable(opts: NetworkReadyOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 3_000;
  const probe = opts.probe ?? (() => defaultProbe(probeTimeoutMs));
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
