/**
 * A session token store makes room by evicting its least recently used token, except a token a
 * running process still carries: a Codex app-server gets its tokens in its environment at spawn
 * and cannot be handed new ones. Revoking a session still takes its token, held or not.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createSessionTokenStore, holdTokens } from "../../../src/services/mcp-session-tokens.ts";

const store = (max: number) => createSessionTokenStore<{ sessionId: string }>({ max, sameBinding: () => true });

const releases: Array<() => void> = [];
afterEach(() => { for (const release of releases.splice(0)) release(); });

describe("session token eviction", () => {
  it("evicts the least recently used token when nothing holds it", () => {
    const tokens = store(2);
    const a = tokens.mint({ sessionId: "a" });
    tokens.mint({ sessionId: "b" });
    tokens.mint({ sessionId: "c" });
    expect(tokens.resolve(a)).toBeNull();
    expect(tokens.size()).toBe(2);
  });

  it("skips a held token and evicts the next one instead", () => {
    const tokens = store(2);
    const a = tokens.mint({ sessionId: "a" });
    const b = tokens.mint({ sessionId: "b" });
    releases.push(holdTokens((token) => token === a));
    tokens.mint({ sessionId: "c" });
    expect(tokens.resolve(a)).toEqual({ sessionId: "a" });
    expect(tokens.resolve(b)).toBeNull();
  });

  it("grows past its limit rather than evict a token every running process holds", () => {
    const tokens = store(2);
    const a = tokens.mint({ sessionId: "a" });
    const b = tokens.mint({ sessionId: "b" });
    releases.push(holdTokens((token) => token === a || token === b));
    const c = tokens.mint({ sessionId: "c" });
    expect([a, b, c].map((t) => tokens.resolve(t)?.sessionId)).toEqual(["a", "b", "c"]);
    expect(tokens.size()).toBe(3);
  });

  it("evicts a token again once its holder is gone", () => {
    const tokens = store(1);
    const a = tokens.mint({ sessionId: "a" });
    const release = holdTokens((token) => token === a);
    tokens.mint({ sessionId: "b" });
    expect(tokens.resolve(a)).not.toBeNull();
    release();
    tokens.mint({ sessionId: "c" });
    expect(tokens.resolve(a)).toBeNull();
  });

  it("still revokes a held token when its session is revoked", () => {
    const tokens = store(4);
    const a = tokens.mint({ sessionId: "a" });
    releases.push(holdTokens((token) => token === a));
    tokens.revoke("a");
    expect(tokens.resolve(a)).toBeNull();
  });
});
