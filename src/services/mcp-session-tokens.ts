import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Capability tokens for an MCP endpoint PPM serves to one chat session's own agent.
 *
 * The endpoint is called by the session's Claude or Codex subprocess, which holds no PPM
 * credentials, so the token is the whole authorization: it names one session and whatever
 * else the binding carries, and nothing else can be reached with it. Tokens live in memory
 * only — a restart revokes every one, and the next turn mints a fresh one. A presented token
 * is looked up by its SHA-256 and confirmed with a constant-time compare; the store also keeps
 * each session's own token, because the session's later turns are handed that same one.
 */

interface Entry<B> {
  binding: B;
  digest: Buffer;
}

const digestOf = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export function createSessionTokenStore<B extends { sessionId: string }>(opts: {
  max: number;
  /** Whether a session's existing token still fits a new binding; when not, it is replaced. */
  sameBinding: (held: B, wanted: B) => boolean;
}) {
  const byDigest = new Map<string, Entry<B>>();
  const tokenBySession = new Map<string, string>();

  function revoke(sessionId: string): void {
    const token = tokenBySession.get(sessionId);
    if (!token) return;
    tokenBySession.delete(sessionId);
    byDigest.delete(digestOf(token).toString("hex"));
  }

  /**
   * The session's token, minted on first use. The same token comes back for as long as the
   * binding holds, because a Claude query keeps the MCP config it started with for every
   * later turn; a binding that no longer fits replaces it.
   */
  function mint(binding: B): string {
    const existing = tokenBySession.get(binding.sessionId);
    if (existing) {
      const entry = byDigest.get(digestOf(existing).toString("hex"));
      if (entry && opts.sameBinding(entry.binding, binding)) {
        // Re-inserted so the map's order stays least-recently-used first.
        tokenBySession.delete(binding.sessionId);
        tokenBySession.set(binding.sessionId, existing);
        return existing;
      }
      revoke(binding.sessionId);
    }
    while (tokenBySession.size >= opts.max) {
      const oldest = tokenBySession.keys().next().value;
      if (oldest === undefined) break;
      revoke(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const digest = digestOf(token);
    byDigest.set(digest.toString("hex"), { binding: { ...binding }, digest });
    tokenBySession.set(binding.sessionId, token);
    return token;
  }

  /** The binding a presented token grants, or null. */
  function resolve(token: string | null | undefined): B | null {
    if (!token || token.length > 200) return null;
    const digest = digestOf(token);
    const entry = byDigest.get(digest.toString("hex"));
    // The map lookup is by digest, which says nothing about the token; the compare is the
    // constant-time confirmation that the digests really are equal.
    if (!entry || !timingSafeEqual(entry.digest, digest)) return null;
    return { ...entry.binding };
  }

  return { mint, resolve, revoke, size: () => tokenBySession.size };
}
