/**
 * Warm-session pool. The guarantees that matter: a pooled session is warmed
 * before it is handed out, it is handed out exactly once (so no request inherits
 * another's conversation), a dead one is never reused, and a provider that
 * cannot warm still works.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  takePooledSession, releasePooledSession, drainPool, pooledCount,
} from "../../../src/services/proxy-agent-pool.ts";
import type { AIProvider, ChatEvent, Session, SendMessageOpts } from "../../../src/types/chat.ts";

/** Lets the background refill finish before assertions look at the pool. */
const settled = () => new Promise((r) => setTimeout(r, 10));

class PoolProvider implements AIProvider {
  name = "Pool";
  created: string[] = [];
  warmed: Array<{ id: string; opts?: SendMessageOpts }> = [];
  deleted: string[] = [];
  dead = new Set<string>();
  warmThrows = false;
  private n = 0;

  constructor(readonly id: string, private readonly canWarm = true) {
    if (!canWarm) delete (this as Partial<AIProvider>).warmSession;
  }

  async createSession(): Promise<Session> {
    const id = `${this.id}-${++this.n}`;
    this.created.push(id);
    return { id, providerId: this.id, title: "t", createdAt: new Date().toISOString() } as Session;
  }
  async resumeSession(): Promise<Session> { throw new Error("unused"); }
  async listSessions() { return []; }
  async deleteSession(id: string) { this.deleted.push(id); }
  async *sendMessage(): AsyncIterable<ChatEvent> { /* unused here */ }
  hasStreamingSession(id: string) { return !this.dead.has(id); }

  warmSession = async (id: string, opts?: SendMessageOpts) => {
    if (this.warmThrows) throw new Error("cannot warm");
    this.warmed.push({ id, opts });
  };
}

const request = (provider: AIProvider, model?: string) => ({
  provider,
  projectPath: "/tmp/proxy-ws",
  title: "[API] test",
  opts: { permissionMode: "plan", ...(model ? { model } : {}) } as SendMessageOpts,
});

beforeEach(async () => { await drainPool(); });

describe("proxy agent pool", () => {
  it("serves the first request cold, then keeps a warm session ready", async () => {
    const p = new PoolProvider("pool-a");

    // Nothing pooled yet, so this one is created on the spot — it is not the
    // session the pool warms in the background behind it.
    const first = await takePooledSession("pool-a", request(p));
    await settled();
    expect(p.warmed.map((w) => w.id)).not.toContain(first);

    // The refill triggered by that take is what makes the next request fast.
    expect(pooledCount("pool-a")).toBe(1);
    expect(p.warmed.length).toBe(1);

    await releasePooledSession(p, first);
    const second = await takePooledSession("pool-a", request(p));
    expect(p.warmed.map((w) => w.id)).toContain(second);
    expect(second).not.toBe(first);
  });

  it("warms with the same options the turn will use", async () => {
    const p = new PoolProvider("pool-b");
    await takePooledSession("pool-b", request(p, "gpt-5.6"));
    await settled();
    expect(p.warmed[0]!.opts).toEqual({ permissionMode: "plan", model: "gpt-5.6" });
  });

  it("keeps a separate warm session per model", async () => {
    const p = new PoolProvider("pool-c");
    await takePooledSession("pool-c", request(p, "m1"));
    await takePooledSession("pool-c", request(p, "m2"));
    await settled();
    expect(pooledCount("pool-c", "m1")).toBe(1);
    expect(pooledCount("pool-c", "m2")).toBe(1);
  });

  it("hands a warm session out only once", async () => {
    const p = new PoolProvider("pool-d");
    await takePooledSession("pool-d", request(p));
    await settled();
    const pooled = pooledCount("pool-d");
    expect(pooled).toBe(1);

    const a = await takePooledSession("pool-d", request(p));
    const b = await takePooledSession("pool-d", request(p));
    // Two requests must never share a session — that would leak one caller's
    // conversation into the other's context.
    expect(a).not.toBe(b);
  });

  it("discards a pooled session whose runtime died instead of reusing it", async () => {
    const p = new PoolProvider("pool-e");
    await takePooledSession("pool-e", request(p));
    await settled();

    const warmId = p.warmed[0]!.id;
    p.dead.add(warmId);

    const taken = await takePooledSession("pool-e", request(p));
    expect(taken).not.toBe(warmId);
    expect(p.deleted).toContain(warmId);
  });

  it("still serves requests when warming fails", async () => {
    const p = new PoolProvider("pool-f");
    p.warmThrows = true;
    const id = await takePooledSession("pool-f", request(p));
    await settled();
    expect(id).toBeTruthy();
    expect(pooledCount("pool-f")).toBe(0);
  });

  it("does not pool for a provider that cannot warm", async () => {
    const p = new PoolProvider("pool-g", false);
    expect(p.warmSession).toBeUndefined();
    const id = await takePooledSession("pool-g", request(p));
    await settled();
    expect(id).toBeTruthy();
    expect(pooledCount("pool-g")).toBe(0);
  });

  it("release retires the session", async () => {
    const p = new PoolProvider("pool-h");
    const id = await takePooledSession("pool-h", request(p));
    await releasePooledSession(p, id);
    expect(p.deleted).toContain(id);
  });
});
