import { randomUUIDv7 } from "bun";

interface DownloadToken {
  token: string;
  createdAt: number;
  /** Absolute path this token may fetch; null = legacy project-scoped token. */
  path: string | null;
}

const TTL_MS = 30_000;
const tokens = new Map<string, DownloadToken>();

/**
 * Generate a short-lived download token. Passing `path` binds the token to one
 * file and makes it single-use — required now that the browse whitelist covers
 * the whole disk, so a leaked token cannot be replayed against another file.
 */
export function createDownloadToken(path?: string): string {
  const token = randomUUIDv7();
  tokens.set(token, { token, createdAt: Date.now(), path: path ?? null });
  cleanup();
  return token;
}

/**
 * Validate a download token.
 *
 * Without `path` the token is only checked, not spent: the auth middleware
 * runs before any handler knows which file is being requested, so it may only
 * gate the request. The handler then calls this again *with* the resolved
 * path, which enforces the binding and consumes the token.
 */
export function consumeDownloadToken(token: string, path?: string): boolean {
  const entry = tokens.get(token);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > TTL_MS) {
    tokens.delete(token);
    return false;
  }
  if (path === undefined) return true;
  if (entry.path === null || entry.path !== path) return false;
  tokens.delete(token);
  return true;
}

/** Remove expired tokens */
function cleanup(): void {
  const now = Date.now();
  for (const [key, entry] of tokens) {
    if (now - entry.createdAt > TTL_MS) tokens.delete(key);
  }
}
