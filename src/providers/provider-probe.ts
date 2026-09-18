/**
 * Why a CLI provider is not registered, and whether asking again could change it.
 *
 * The probe that decides whether Codex exists is `bun x @openai/codex --version`,
 * and bun re-fetches the npm manifest whenever its cached copy has gone stale —
 * so a server restarting during a network blip probes a perfectly good install
 * and is told `ConnectionRefused downloading package manifest @openai/codex`.
 * Registration only ever happened at startup, so that one bad second hid Codex
 * from the chat composer for the whole life of the process, with nothing but a
 * log line to say why (the composer's provider chip is hidden while only one
 * provider is registered, so the option does not even render greyed out).
 *
 * Everything except a missing bun is therefore `retryable`: with `bun x` there
 * is no real "not installed" state — the package is fetched on demand — so a
 * failure is almost always the network, not the host.
 */
export type ProviderProbeResult =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean };

/** What the last probe of a provider concluded — rendered in Settings → AI. */
export interface ProviderProbeStatus {
  id: string;
  registered: boolean;
  /** Absent while registered. */
  reason?: string;
  /** Probes made so far in this process, successful or not. */
  attempts: number;
  lastProbeAt: string;
  /** Absent when nothing is scheduled: registered, or a failure retrying cannot fix. */
  nextProbeAt?: string;
}

/**
 * Backoff between probes: 30s, 1m, 2m, 5m, then every 15 minutes.
 *
 * It never gives up. The case this exists for is a host that starts PPM before
 * its network is up and is not looked at again for hours — a bounded set of
 * attempts puts that user back in front of the same silent gap. A warm probe is
 * one ~20ms spawn against bun's cache, so the 15-minute ceiling costs nothing
 * measurable, and it stops the moment the provider registers.
 */
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000];

/** Delay before the next probe, given how many have already failed (1 = the first). */
export function nextProbeDelayMs(failedAttempts: number): number {
  const index = Math.min(Math.max(failedAttempts, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index]!;
}

/**
 * The one line of a failed probe's stderr worth showing a user.
 *
 * bun narrates its work before it fails: a cold `bun x` writes "Resolving
 * dependencies" and "Resolved, downloaded and extracted [6]" ahead of
 * `error: ConnectionRefused downloading package manifest @openai/codex`.
 * Handing all three to a settings strip buries the only sentence that says
 * what went wrong.
 */
export function stderrReason(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => line.toLowerCase().startsWith("error:")) ?? lines.at(-1) ?? "";
}
