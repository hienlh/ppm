import { randomUUIDv7 } from "bun";

interface DownloadToken {
  token: string;
  createdAt: number;
}

const TTL_MS = 30_000;
const tokens = new Map<string, DownloadToken>();

/** Generate a one-time download token (30s TTL) */
export function createDownloadToken(): string {
  const token = randomUUIDv7();
  tokens.set(token, { token, createdAt: Date.now() });
  cleanup();
  return token;
}

/** Validate and consume a download token (one-time use) */
export function consumeDownloadToken(token: string): boolean {
  const entry = tokens.get(token);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > TTL_MS) {
    tokens.delete(token);
    return false;
  }
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
