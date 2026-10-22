/**
 * Renews Claude sign-ins while nothing is using them, and moves idle chats onto the new token.
 *
 * Every chat subprocess is started with its account's access token in
 * `CLAUDE_CODE_OAUTH_TOKEN` and cannot renew it (`SubprocessCredential` in
 * `claude-agent-sdk.ts` says why). Tokens live eight hours, and renewing one revokes the
 * previous token, so a renewal used to land in the middle of whatever turn happened to be
 * running: its next request got a 401, the provider rebuilt the subprocess, and every
 * subagent still working inside it died with it.
 *
 * So a token is renewed early — inside `QUIET_REFRESH_WINDOW_S` of expiry — at a moment
 * when no turn, approval or background work is running on that account. Idle subprocesses
 * still holding the old token are then dropped, the same way a model switch drops them, and
 * their next message resumes on the new one. A subprocess that is busy is left alone and
 * dropped once its turn is over. Only an account kept busy for the whole window still meets
 * the point-of-use renewal mid-turn, and the provider's 401 recovery covers that, as before.
 *
 * Accounts no subprocess is using are not touched: they are renewed where they are next
 * used, which is the rule `account.service.ts` follows on purpose.
 */
import { accountService } from "../../services/account.service.ts";
import { createLogger } from "../../services/logger.ts";
import type { SubprocessCredential } from "../../providers/claude-agent-sdk.ts";

const log = createLogger("token-rotation");

/** Renew this close to expiry, as soon as nothing is running on the account. */
export const QUIET_REFRESH_WINDOW_S = 2 * 3600;
/** Inside this the point-of-use renewal owns the token (`PREFLIGHT_REFRESH_BUFFER_S`). */
const POINT_OF_USE_BUFFER_S = 300;
const SWEEP_INTERVAL_MS = 60_000;

export interface LiveSubprocess {
  sessionId: string;
  credential: SubprocessCredential;
  /** A turn, an approval or background work is running in it — dropping it would lose work. */
  busy: boolean;
}

export interface RenewalCandidate {
  id: string;
  expiresAt: number | null;
  /** An OAuth account with a refresh token that the server has not rejected. */
  renewable: boolean;
}

/** Accounts to renew now: in use by some subprocess, near expiry, and busy in none. */
export function accountsToRenewNow(candidates: RenewalCandidate[], live: LiveSubprocess[], nowS: number): string[] {
  const inUse = new Set<string>();
  const busy = new Set<string>();
  for (const p of live) {
    const id = p.credential.accountId;
    if (!id || !p.credential.oauthToken) continue;
    inUse.add(id);
    if (p.busy) busy.add(id);
  }
  return candidates
    .filter((c) => {
      if (!c.renewable || c.expiresAt == null || !inUse.has(c.id) || busy.has(c.id)) return false;
      const left = c.expiresAt - nowS;
      return left <= QUIET_REFRESH_WINDOW_S && left > POINT_OF_USE_BUFFER_S;
    })
    .map((c) => c.id);
}

/** Idle subprocesses still holding a token their account no longer has. */
export function staleIdleSessions(live: LiveSubprocess[], currentToken: (accountId: string) => string | null): string[] {
  return live
    .filter((p) => {
      const id = p.credential.accountId;
      if (p.busy || !id || !p.credential.oauthToken) return false;
      const current = currentToken(id);
      return current !== null && current !== p.credential.oauthToken;
    })
    .map((p) => p.sessionId);
}

export interface TokenRotationDeps {
  /** Every live Claude subprocess and whether work is running in it right now. */
  liveSubprocesses: () => LiveSubprocess[];
  /** Restart one idle subprocess; its next message resumes on the account's current token. */
  dropIdle: (sessionId: string) => void;
}

function currentOAuthToken(accountId: string): string | null {
  const token = accountService.getWithTokens(accountId)?.accessToken;
  return token && token.startsWith("sk-ant-oat") ? token : null;
}

/** Drop every idle subprocess whose token has been replaced. Safe to call at any time. */
export function dropStaleIdle(deps: TokenRotationDeps): void {
  for (const sessionId of staleIdleSessions(deps.liveSubprocesses(), currentOAuthToken)) {
    log.info(`session=${sessionId} restarting idle subprocess: its account's token was renewed`);
    deps.dropIdle(sessionId);
  }
}

/** One pass: renew what is due and quiet, then move idle subprocesses onto new tokens. */
export async function sweepTokenRotation(deps: TokenRotationDeps, nowS = Math.floor(Date.now() / 1000)): Promise<void> {
  const candidates: RenewalCandidate[] = accountService.list().map((a) => {
    const acc = accountService.getWithTokens(a.id);
    return {
      id: a.id,
      expiresAt: acc?.expiresAt ?? null,
      renewable: !!acc && acc.accessToken.startsWith("sk-ant-oat") && acc.refreshToken !== "" && !acc.reauthRequired,
    };
  });
  for (const id of accountsToRenewNow(candidates, deps.liveSubprocesses(), nowS)) {
    const left = (candidates.find((c) => c.id === id)?.expiresAt ?? nowS) - nowS;
    log.info(`Renewing ${id} early while no turn runs on it (token expires in ${left}s)`);
    try {
      await accountService.refreshAccessToken(id, false, false, QUIET_REFRESH_WINDOW_S);
    } catch (e) {
      // The point-of-use renewal tries again before the token is needed.
      log.warn(`Early renewal failed for ${id}: ${(e as Error).message}`);
    }
  }
  dropStaleIdle(deps);
}

// Survive Bun --hot reloads: one timer and one listener, whichever module copy registered last.
const HOT_KEY = "__PPM_TOKEN_ROTATION__" as const;
const hot = ((globalThis as any)[HOT_KEY] ??= { stop: null, deps: null }) as {
  stop: (() => void) | null;
  deps: TokenRotationDeps | null;
};

/** Run a sweep now with the registered chat layer, rather than waiting for the timer. */
export async function runTokenRotationSweep(): Promise<void> {
  if (hot.deps) await sweepTokenRotation(hot.deps);
}

export function registerTokenRotation(deps: TokenRotationDeps): () => void {
  hot.stop?.();
  hot.deps = deps;
  let sweeping = false;
  const sweep = () => {
    if (sweeping) return;
    sweeping = true;
    sweepTokenRotation(deps)
      .catch((e) => log.warn(`token rotation sweep failed: ${(e as Error).message}`))
      .finally(() => { sweeping = false; });
  };
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  // Any renewal — this sweep's, a turn's pre-flight, the usage poller's — strands idle subprocesses.
  const unlisten = accountService.onTokenRotated(() => dropStaleIdle(deps));
  hot.stop = () => { clearInterval(timer); unlisten(); };
  return hot.stop;
}
