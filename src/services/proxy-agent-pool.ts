/**
 * Warm-session pool for the provider-scoped proxy.
 *
 * Measured on codex: a cold turn spent minutes before its first token, almost
 * all of it spawning `codex app-server` and opening the thread. That cost cannot
 * be hidden from an HTTP caller if it is paid inside the request, so this keeps
 * sessions that are already connected but have never received a turn.
 *
 * Each pooled session is handed out **once** and destroyed afterwards. Reusing a
 * thread across requests would be cheaper still, but an OpenAI/Anthropic client
 * replays its whole conversation every call — a reused thread would stack that
 * history on top of itself, corrupting context and inflating cost. Keeping the
 * warm-up rather than the conversation is what makes this safe for a stateless
 * API.
 *
 * Providers without `warmSession` (Claude) fall through to plain create-on-
 * demand, so nothing changes for them.
 */
import type { AIProvider, SendMessageOpts } from "../types/chat.ts";

/** Warm sessions held per key. One is enough to cover back-to-back requests. */
const POOL_SIZE = 1;

/** A warm session left unused this long is disposed — an idle subprocess is pure cost. */
const IDLE_TTL_MS = 10 * 60 * 1000;

interface WarmSession {
  sessionId: string;
  /** Fires if nothing claims this session; cleared the moment it is taken. */
  expiry: ReturnType<typeof setTimeout>;
}

/** Warm sessions keyed by provider+model — a thread bakes in the model it opened with. */
const pool = new Map<string, WarmSession[]>();
/** Keys with a refill already in flight, so a burst cannot spawn a queue of them. */
const refilling = new Set<string>();

function keyOf(providerId: string, model?: string): string {
  return `${providerId}::${model ?? ""}`;
}

export interface PoolSessionRequest {
  provider: AIProvider;
  projectPath: string;
  title: string;
  opts: SendMessageOpts;
}

/** Create a session and bring its runtime up. Returns null if warming failed. */
async function createWarm(req: PoolSessionRequest): Promise<string | null> {
  try {
    const session = await req.provider.createSession({ projectPath: req.projectPath, title: req.title });
    await req.provider.warmSession!(session.id, req.opts);
    return session.id;
  } catch {
    // A provider that cannot warm right now (signed out, binary missing) must not
    // break the request path — the caller falls back to a cold session.
    return null;
  }
}

async function dispose(provider: AIProvider, sessionId: string): Promise<void> {
  try { provider.abortQuery?.(sessionId, "proxy-pool"); } catch { /* best effort */ }
  try { await provider.deleteSession(sessionId); } catch { /* best effort */ }
}

/** Top the pool back up to POOL_SIZE in the background. Never throws. */
function refill(key: string, req: PoolSessionRequest): void {
  if (!req.provider.warmSession || refilling.has(key)) return;
  const held = pool.get(key) ?? [];
  if (held.length >= POOL_SIZE) return;

  refilling.add(key);
  void (async () => {
    try {
      const sessionId = await createWarm(req);
      if (!sessionId) return;
      const entry: WarmSession = {
        sessionId,
        expiry: setTimeout(() => {
          const list = pool.get(key);
          if (list) pool.set(key, list.filter((w) => w !== entry));
          void dispose(req.provider, sessionId);
        }, IDLE_TTL_MS),
      };
      (entry.expiry as { unref?: () => void }).unref?.();
      pool.set(key, [...(pool.get(key) ?? []), entry]);
    } finally {
      refilling.delete(key);
    }
  })();
}

/**
 * Hand out a session for one turn. Uses a warm one when available, otherwise
 * creates a cold session so a miss still works. Triggers a background refill so
 * the next request finds the pool stocked.
 */
export async function takePooledSession(providerId: string, req: PoolSessionRequest): Promise<string> {
  const key = keyOf(providerId, req.opts.model);
  const held = pool.get(key) ?? [];

  while (held.length > 0) {
    const entry = held.shift()!;
    clearTimeout(entry.expiry);
    pool.set(key, held);
    // A pooled session whose subprocess died in the meantime is worse than none.
    if (!req.provider.hasStreamingSession || req.provider.hasStreamingSession(entry.sessionId)) {
      refill(key, req);
      return entry.sessionId;
    }
    void dispose(req.provider, entry.sessionId);
  }

  const session = await req.provider.createSession({ projectPath: req.projectPath, title: req.title });
  refill(key, req);
  return session.id;
}

/** Retire a session after its single turn. */
export async function releasePooledSession(provider: AIProvider, sessionId: string): Promise<void> {
  await dispose(provider, sessionId);
}

/** Drop every warm session — used by tests and shutdown. */
export async function drainPool(): Promise<void> {
  const entries = [...pool.values()].flat();
  pool.clear();
  refilling.clear();
  for (const e of entries) clearTimeout(e.expiry);
}

/** Warm sessions currently held, for tests and diagnostics. */
export function pooledCount(providerId?: string, model?: string): number {
  if (providerId === undefined) return [...pool.values()].flat().length;
  return (pool.get(keyOf(providerId, model)) ?? []).length;
}
