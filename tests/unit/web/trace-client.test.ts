/**
 * The browser half of logging. What matters is what happens when things are going wrong: an
 * error must go out fast and carry the lines before it, an offline tab must keep what it has
 * and send it later, a tab in a loop must cost a counter rather than a network, and a page
 * that is closing must get what it can out in the one request the browser still allows.
 */
import { describe, it, expect } from "bun:test";
import {
  createTraceClient,
  describe as describeValue,
  errorPayload,
  patchConsole,
  AUTH_RECHECK_MS,
  ERROR_FLUSH_MS,
  KEEPALIVE_BUDGET_CHARS,
  LOG_FLUSH_MS,
  MAX_BREADCRUMBS,
  MAX_ENTRIES_PER_MINUTE,
  MAX_PAYLOAD_CHARS,
  MAX_QUEUE,
  TRACE_QUEUE_KEY,
  type SendResult,
} from "../../../src/web/lib/trace-client.ts";

interface Sent {
  keepalive: boolean;
  token: string | null;
  body: { deviceId: string; sentAt: number; entries: Array<{ ts: number; type: string; refId: string | null; payload: Record<string, any> }> };
}

function harness(store = new Map<string, string>()) {
  let now = 1_000_000;
  const timers: Array<{ fn: () => void; due: number; cleared: boolean }> = [];
  const sent: Sent[] = [];
  let respond: (s: Sent) => Promise<SendResult> = async () => ({ status: 200 });
  let token: string | null = null;
  const client = createTraceClient({
    send: (body, keepalive, sentToken) => {
      const s = { body: JSON.parse(body), keepalive, token: sentToken };
      sent.push(s);
      return respond(s);
    },
    authToken: () => token,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
    },
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, due: now + ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    deviceId: () => "device-0000-1111",
    refId: () => "session-9",
    context: () => ({ page: "page-1", path: "/project/x" }),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cleared && t.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      now = Math.max(now, next.due);
      next.cleared = true;
      next.fn();
      await settle();
    }
    now = target;
    await settle();
  }
  const entries = () => sent.flatMap((s) => s.body.entries);
  return {
    client, sent, store, advance, entries,
    setRespond: (fn: typeof respond) => { respond = fn; },
    setToken: (t: string | null) => { token = t; },
  };
}

describe("trace client", () => {
  it("ships console.log too, batched on the slow timer, stamped with device, session and page", async () => {
    const h = harness();
    h.client.console("log", ["hello", { a: 1 }]);
    await h.advance(ERROR_FLUSH_MS);
    expect(h.sent).toEqual([]);
    await h.advance(LOG_FLUSH_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.body.deviceId).toBe("device-0000-1111");
    expect(h.sent[0]!.body.entries).toEqual([{
      ts: 1_000_000,
      type: "console_log",
      refId: "session-9",
      payload: { page: "page-1", path: "/project/x", args: ["hello", '{"a":1}'] },
    }]);
  });

  it("sends an error within a second, carrying at most 50 of the lines before it", async () => {
    const h = harness();
    for (let i = 0; i < 80; i++) h.client.console("info", [`line ${i}`]);
    h.client.console("error", [new Error("boom")]);
    await h.advance(ERROR_FLUSH_MS);
    const error = h.entries().find((e) => e.type === "console_error")!;
    expect(error).toBeDefined();
    expect(error.payload.breadcrumbs).toHaveLength(MAX_BREADCRUMBS);
    expect(error.payload.breadcrumbs.at(-1).text).toBe("line 79");
    expect(error.payload.args[0]).toContain("Error: boom");
    // Batches of at most 50, in the order they happened.
    expect(h.sent.every((s) => s.body.entries.length <= 50)).toBe(true);
    expect(h.entries().map((e) => e.payload.args?.[0]).slice(0, 3)).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("keeps entries while offline, backs off, and sends them once the network is back", async () => {
    const h = harness();
    h.setRespond(async () => ({ status: 0 }));
    h.client.record("browser_error", errorPayload(new TypeError("x is undefined")));
    await h.advance(ERROR_FLUSH_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.client.pending()).toBe(1);

    await h.advance(1_000);
    expect(h.sent).toHaveLength(1); // still backing off
    h.setRespond(async () => ({ status: 200 }));
    await h.client.flush(); // `online` — but the backoff still holds it
    expect(h.sent).toHaveLength(1);
    await h.advance(5_000);
    expect(h.sent).toHaveLength(2);
    expect(h.client.pending()).toBe(0);
  });

  it("waits out a 429's Retry-After before trying again", async () => {
    const h = harness();
    h.setRespond(async () => ({ status: 429, retryAfterMs: 30_000 }));
    h.client.record("render_error", errorPayload(new Error("render")));
    await h.advance(ERROR_FLUSH_MS);
    h.setRespond(async () => ({ status: 200 }));
    await h.advance(20_000);
    expect(h.sent).toHaveLength(1);
    await h.advance(10_000);
    expect(h.sent).toHaveLength(2);
    expect(h.client.pending()).toBe(0);
  });

  it("keeps what a 401 refused, asks nothing more until a sign-in, then sends it with the new token", async () => {
    const h = harness();
    h.setRespond(async (s) => ({ status: s.token === "tok" ? 200 : 401 }));
    h.client.console("warn", ["on the login screen"]);
    await h.advance(LOG_FLUSH_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.client.pending()).toBe(1);

    // No request while the token is the one refused — not on the timer, not on page hide.
    await h.advance(10 * 60_000);
    h.client.flushOnHide();
    await h.advance(0);
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.store.get(TRACE_QUEUE_KEY)!)).toHaveLength(1);

    h.setToken("tok");
    await h.advance(AUTH_RECHECK_MS);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.token).toBe("tok");
    expect(h.sent[1]!.body.entries.map((e) => e.payload.args)).toEqual([["on the login screen"]]);
    expect(h.client.pending()).toBe(0);
  });

  it("drops a batch the server will never accept instead of retrying it forever", async () => {
    const h = harness();
    h.setRespond(async () => ({ status: 400 }));
    h.client.console("warn", ["malformed"]);
    await h.advance(LOG_FLUSH_MS);
    expect(h.client.pending()).toBe(0);
    await h.advance(10 * 60_000);
    expect(h.sent).toHaveLength(1);
  });

  it("drops the oldest entries past the queue cap", async () => {
    const h = harness();
    h.setRespond(async () => ({ status: 0 }));
    for (let i = 0; i < MAX_QUEUE + 50; i++) {
      if (i === MAX_ENTRIES_PER_MINUTE) await h.advance(60_000); // stay under the per-minute budget
      h.client.console("log", [`n${i}`]);
    }
    expect(h.client.pending()).toBeLessThanOrEqual(MAX_QUEUE);
    h.sent.length = 0; // only what gets through from here counts
    h.setRespond(async () => ({ status: 200 }));
    await h.advance(10 * 60_000);
    const args = h.entries().map((e) => e.payload.args?.[0]);
    expect(args).not.toContain("n0");
    expect(args).toContain(`n${MAX_QUEUE + 49}`);
  });

  it("past the per-minute budget keeps only a count, reported once the minute is over", async () => {
    const h = harness();
    for (let i = 0; i < MAX_ENTRIES_PER_MINUTE + 25; i++) h.client.record("unhandled_rejection", { message: "loop" });
    expect(h.client.pending()).toBe(MAX_ENTRIES_PER_MINUTE);
    await h.advance(60_000);
    h.client.console("log", ["after"]);
    await h.advance(LOG_FLUSH_MS);
    const dropped = h.entries().find((e) => e.type === "console_dropped");
    expect(dropped?.payload.count).toBe(25);
  });

  it("on page hide sends one keepalive request that fits the browser's budget, and persists the rest", async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) h.client.console("log", [`${i}:`.padEnd(4_000, "x")]);
    h.client.flushOnHide();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.keepalive).toBe(true);
    expect(JSON.stringify(h.sent[0]!.body).length).toBeLessThanOrEqual(KEEPALIVE_BUDGET_CHARS);
    const persisted = JSON.parse(h.store.get(TRACE_QUEUE_KEY)!) as unknown[];
    expect(persisted.length + h.sent[0]!.body.entries.length).toBe(30);
  });

  it("sends what a previous page load left in storage", async () => {
    const store = new Map<string, string>();
    store.set(TRACE_QUEUE_KEY, JSON.stringify([{ ts: 1, type: "chunk_error", refId: null, payload: { message: "gone" } }]));
    const h = harness(store);
    await h.advance(2_000);
    expect(h.entries().map((e) => e.type)).toEqual(["chunk_error"]);
    await h.advance(2_000);
    expect(store.has(TRACE_QUEUE_KEY)).toBe(false);
  });

  it("keeps every entry under the server's size cap", async () => {
    const h = harness();
    h.client.console("error", ["a".repeat(50_000), "b".repeat(50_000)]);
    await h.advance(ERROR_FLUSH_MS);
    expect(JSON.stringify(h.entries()[0]!.payload).length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
  });
});

describe("describe", () => {
  it("costs a bounded amount however large or cyclic the object", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i++) big[`k${i}`] = { nested: { value: i } };
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(describeValue(big).length).toBeLessThan(2_100);
    expect(describeValue(cyclic)).toContain("[circular]");
    expect(describeValue(undefined)).toBe("undefined");
    expect(describeValue(12n)).toBe("12");
  });

  it("turns a non-Error rejection into a message", () => {
    expect(errorPayload("nope")).toEqual({ message: "nope" });
    expect(errorPayload({ code: 5 })).toEqual({ message: '{"code":5}' });
  });

  it("names an event and what fired it, where JSON would say only isTrusted", () => {
    // A rejection with a socket's or a script's error event, as seen on the login screen.
    // `dispatchEvent` refuses an event from another realm, and the test preload installs
    // happy-dom's `Event` while leaving Bun's `EventTarget`, so the target comes from the
    // window's realm when there is one.
    const Target: typeof EventTarget =
      (globalThis as { window?: { EventTarget?: typeof EventTarget } }).window?.EventTarget ?? EventTarget;
    class FakeSocket extends Target { url = "ws://ppm.test/ws/global"; }
    const socket = new FakeSocket();
    let fired: Event | null = null;
    socket.addEventListener("error", (e) => { fired = e; });
    socket.dispatchEvent(new Event("error"));
    expect(errorPayload(fired)).toEqual({ message: "[Event error on FakeSocket ws://ppm.test/ws/global]" });
    expect(describeValue(new Event("abort"))).toBe("[Event abort]");
  });
});

describe("patchConsole", () => {
  it("runs the original first with the same arguments, and never records a line twice", () => {
    const calls: string[] = [];
    const recorded: unknown[][] = [];
    const fake = {
      log: (...a: unknown[]) => calls.push(`log:${a.join(",")}`),
      info: () => {}, debug: () => {}, warn: () => {},
      error: (...a: unknown[]) => calls.push(`error:${a.join(",")}`),
    } as unknown as Console;
    patchConsole(fake, {
      console: (level, args) => {
        recorded.push([level, ...args]);
        fake.error("from inside the recorder"); // must reach the console, not the recorder
      },
    });
    fake.log("a", 1);
    expect(calls).toEqual(["log:a,1", "error:from inside the recorder"]);
    expect(recorded).toEqual([["log", "a", 1]]);
  });
});
