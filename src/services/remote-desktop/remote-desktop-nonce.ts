/**
 * Single-use, short-TTL connection nonce — mirrors `download-token.service.ts`'s
 * consume-once pattern.
 *
 * The PPM static bearer token already travels as `?token=` on every WS upgrade
 * (`isWsUpgradeAuthorized`, `src/server/index.ts`) and proves nothing beyond "holds the one
 * reusable app token" — it is not a real per-session grant. `POST /api/remote-desktop/session`
 * mints one of these after re-checking `auth.enabled`; the client then presents it via the WS
 * subprotocol header (never the query string) and it is consumed exactly once, at upgrade
 * time, in `src/server/index.ts`.
 */
import { randomUUIDv7 } from "bun";

const TTL_MS = 30_000;
const nonces = new Map<string, number>();

/** Mint a nonce; caller must have already verified auth is enabled + a valid request. */
export function mintRemoteDesktopNonce(): string {
  const token = randomUUIDv7();
  nonces.set(token, Date.now());
  cleanup();
  return token;
}

/** Validate + consume. Returns false for missing/expired/already-used nonces. */
export function consumeRemoteDesktopNonce(token: string): boolean {
  const mintedAt = nonces.get(token);
  if (mintedAt === undefined) return false;
  nonces.delete(token);
  return Date.now() - mintedAt <= TTL_MS;
}

function cleanup(): void {
  const now = Date.now();
  for (const [token, mintedAt] of nonces) {
    if (now - mintedAt > TTL_MS) nonces.delete(token);
  }
}
