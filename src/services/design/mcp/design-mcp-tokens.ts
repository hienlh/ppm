import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Capability tokens for the design MCP endpoint, one per design session.
 *
 * The endpoint is called by the session's own Claude or Codex subprocess, which holds no
 * PPM credentials, so the token is the whole authorization: it names one session, one
 * project and one design, and nothing else can be reached with it. Tokens live in memory
 * only — a restart revokes every one, and the next turn mints a fresh one — and are stored
 * by their SHA-256, so neither a log line nor a heap dump of the map holds a usable secret.
 */

export interface DesignMcpBinding {
  sessionId: string;
  projectPath: string;
  slug: string;
}

interface Entry extends DesignMcpBinding {
  digest: Buffer;
}

/** Enough for every design session a server could plausibly keep alive at once. */
export const MAX_DESIGN_MCP_TOKENS = 256;

const digestOf = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export function createDesignMcpTokenStore(max = MAX_DESIGN_MCP_TOKENS) {
  const byDigest = new Map<string, Entry>();
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
   * later turn; a changed project or design replaces it.
   */
  function mint(binding: DesignMcpBinding): string {
    const existing = tokenBySession.get(binding.sessionId);
    if (existing) {
      const entry = byDigest.get(digestOf(existing).toString("hex"));
      if (entry && entry.projectPath === binding.projectPath && entry.slug === binding.slug) {
        // Re-inserted so the map's order stays least-recently-used first.
        tokenBySession.delete(binding.sessionId);
        tokenBySession.set(binding.sessionId, existing);
        return existing;
      }
      revoke(binding.sessionId);
    }
    while (tokenBySession.size >= max) {
      const oldest = tokenBySession.keys().next().value;
      if (oldest === undefined) break;
      revoke(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const digest = digestOf(token);
    byDigest.set(digest.toString("hex"), { ...binding, digest });
    tokenBySession.set(binding.sessionId, token);
    return token;
  }

  /** The binding a presented token grants, or null. */
  function resolve(token: string | null | undefined): DesignMcpBinding | null {
    if (!token || token.length > 200) return null;
    const digest = digestOf(token);
    const entry = byDigest.get(digest.toString("hex"));
    // The map lookup is by digest, which says nothing about the token; the compare is the
    // constant-time confirmation that the digests really are equal.
    if (!entry || !timingSafeEqual(entry.digest, digest)) return null;
    return { sessionId: entry.sessionId, projectPath: entry.projectPath, slug: entry.slug };
  }

  return { mint, resolve, revoke, size: () => tokenBySession.size };
}

export const designMcpTokens = createDesignMcpTokenStore();
