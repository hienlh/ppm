/**
 * A chat's database tool reached a connection nobody has logged in to: the user is told once per
 * connection and chat within the window, following a renamed session, on the bus and through the
 * notification channels.
 */
import { describe, expect, it } from "bun:test";
import { createDbAttentionEvents, type DbAttentionEvents } from "../../../src/services/db-ai-tools/db-attention-events.ts";
import { DB_LOGIN_NOTICE_WINDOW_MS, createDbLoginAttention, loginNotificationOptions } from "../../../src/services/db-ai-tools/db-login-attention.ts";

function setup(canonical?: (id: string) => string) {
  let now = 0;
  const events = createDbAttentionEvents();
  const told: Array<DbAttentionEvents["login_needed"]> = [];
  const notified: Array<{ sessionId: string; id: number }> = [];
  events.on("login_needed", (p) => told.push(p));
  const attention = createDbLoginAttention({
    events, now: () => now, canonical,
    notify: (sessionId, conn) => { notified.push({ sessionId, id: conn.id }); },
  });
  return { attention, told, notified, advance: (ms: number) => { now += ms; } };
}

const PG = { id: 4, name: "Prod PG" };
const MY = { id: 5, name: "Prod MySQL" };

describe("telling the user a connection needs a login", () => {
  it("tells once per connection and chat within the window, then again after it", () => {
    const t = setup();
    expect(DB_LOGIN_NOTICE_WINDOW_MS).toBe(30 * 60_000);
    expect(t.attention.loginNeeded("s1", PG)).toBe(true);
    expect(t.attention.loginNeeded("s1", PG)).toBe(false);
    t.advance(DB_LOGIN_NOTICE_WINDOW_MS - 1);
    expect(t.attention.loginNeeded("s1", PG)).toBe(false);
    // Another connection, or another chat, is news of its own.
    expect(t.attention.loginNeeded("s1", MY)).toBe(true);
    expect(t.attention.loginNeeded("s2", PG)).toBe(true);
    t.advance(1);
    expect(t.attention.loginNeeded("s1", PG)).toBe(true);
    expect(t.told).toEqual([
      { sessionId: "s1", connectionId: 4, connectionName: "Prod PG" },
      { sessionId: "s1", connectionId: 5, connectionName: "Prod MySQL" },
      { sessionId: "s2", connectionId: 4, connectionName: "Prod PG" },
      { sessionId: "s1", connectionId: 4, connectionName: "Prod PG" },
    ]);
    expect(t.notified).toEqual(t.told.map((p) => ({ sessionId: p.sessionId, id: p.connectionId })));
  });

  it("follows a renamed session, and forgets pairs once their window is over", () => {
    const renamed = new Map([["draft", "thread"]]);
    const t = setup((id) => renamed.get(id) ?? id);
    expect(t.attention.loginNeeded("draft", PG)).toBe(true);
    expect(t.attention.loginNeeded("thread", PG)).toBe(false);
    expect(t.told.map((p) => p.sessionId)).toEqual(["thread"]);
    t.advance(DB_LOGIN_NOTICE_WINDOW_MS);
    t.attention.loginNeeded("s9", MY);
    expect(t.attention.size()).toBe(1);
  });

  it("still tells the bus when a notification channel throws", () => {
    const events = createDbAttentionEvents();
    const told: unknown[] = [];
    events.on("login_needed", (p) => told.push(p));
    const attention = createDbLoginAttention({ events, notify: () => { throw new Error("push down"); } });
    expect(attention.loginNeeded("s1", PG)).toBe(true);
    expect(told).toHaveLength(1);
  });

  it("keeps the notification apart from the session's own, and drops it once someone logged in", () => {
    const held = new Set<number>();
    const opts = loginNotificationOptions(4, "s1", (id) => held.has(id));
    expect(opts.ownKey).toBe("db-login:4:s1");
    expect(opts.stillUnseen()).toBe(true);
    held.add(4);
    expect(opts.stillUnseen()).toBe(false);
  });
});
