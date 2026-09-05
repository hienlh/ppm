/**
 * Detached confirmation for a named-tunnel setup.
 *
 * Once the supervisor reload has been sent, `runSetup` returns to the caller
 * immediately (a 45s status.json poll must never hold the HTTP response —
 * see the setup service's own comment) and this module polls status.json in
 * the background, broadcasting the final outcome over `/ws/global`.
 *
 * WHY a generation stamp: `setupInFlight`'s synchronous 409 lock is already
 * released by the time this runs, and `isConfirmationRunning` only extends
 * the 409 to a *same-hostname* retry (see the setup service) — a request for
 * a *different* hostname is allowed straight through and immediately
 * supersedes whatever confirmation was still polling. Without a generation
 * check, that superseded confirmer would still broadcast its own result
 * (`setup_done` or `setup_pending`) 1s-to-45s later, carrying the *old*
 * hostname and overwriting the correct, newer result in every connected
 * client. Each confirmation run is stamped with a monotonic generation, and
 * a confirmer checks it is still the current one immediately before
 * broadcasting — a superseded confirmer exits silently instead.
 */
import { readStatus } from "../supervisor-state.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";

const CONFIRM_POLL_BUDGET_MS = 45_000;
const CONFIRM_POLL_INTERVAL_MS = 1_000;

let generation = 0;
/** The hostname + deadline of the confirmation currently allowed to broadcast. */
let current: { hostname: string; deadline: number } | null = null;

/**
 * True while a background confirmation is still running for `hostname`.
 * Bounded by the same poll budget the confirmer itself uses, so a wedged
 * confirmation can never lock a hostname out of retry forever. A different
 * hostname's confirmation immediately closes this window (superseding is
 * unconditional, not per-hostname), matching "a different hostname proceeds
 * and takes over" below.
 */
export function isConfirmationRunning(hostname: string): boolean {
  return current !== null && current.hostname === hostname && Date.now() < current.deadline;
}

async function pollForConfirmation(hostname: string, budgetMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const status = readStatus();
    if (status.tunnelMode === "named" && status.shareUrl === `https://${hostname}`) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

/**
 * Fire-and-forget: polls status.json and broadcasts the final outcome.
 * Never throws into the caller. Silently drops its own broadcast if a newer
 * setup (any hostname) has started since — see the module docstring.
 * `opts` exists only so tests can shrink the poll budget/interval; production
 * always uses the real 45s/1s constants.
 */
export function confirmReloadInBackground(
  hostname: string,
  opts: { pollBudgetMs?: number; pollIntervalMs?: number } = {},
): void {
  const budgetMs = opts.pollBudgetMs ?? CONFIRM_POLL_BUDGET_MS;
  const intervalMs = opts.pollIntervalMs ?? CONFIRM_POLL_INTERVAL_MS;
  const myGeneration = ++generation;
  current = { hostname, deadline: Date.now() + budgetMs };
  const isSuperseded = () => generation !== myGeneration;

  pollForConfirmation(hostname, budgetMs, intervalMs)
    .then((confirmed) => {
      if (isSuperseded()) return;
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
      if (isSuperseded()) return;
      broadcastGlobalEvent({
        type: "tunnel:setup_pending",
        hostname,
        message: "confirmation check failed — check status again shortly",
      });
    })
    .finally(() => {
      // Release the 409 window once this generation settles — but only if
      // nothing newer has already taken `current` over.
      if (!isSuperseded() && current) current.deadline = 0;
    });
}
