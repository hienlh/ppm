/**
 * `POST /api/trace` treats its body as hostile: a batch that is too big is refused whole, an
 * entry that does not fit is dropped, secrets are redacted string by string, and the rate
 * limit is keyed by device — so one tab in a render loop cannot lock out the others, all of
 * which reach PPM from one tunnel IP.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTraceRoutes } from "../../../src/server/routes/trace.ts";
import { DeviceRateLimiter, browserRows } from "../../../src/services/session-trace/browser-trace-ingest.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch, readEvents, readSessionTimeline } from "../../../src/services/session-trace/session-trace-store.ts";
import { TRACE_INGEST_MAX_PAYLOAD_BYTES } from "../../../src/shared/session-trace.ts";

const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;
let app: Hono;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-trace-route-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeTraceDb();
  _resetPpmDir();
  app = new Hono();
  app.route("/api/trace", createTraceRoutes(new DeviceRateLimiter({ windowMs: 60_000, maxRequests: 3, maxEntries: 100 })));
});

afterAll(() => {
  closeTraceDb();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

const DEVICE_A = "0b7c2a4e-1111-4c5d-9e8f-000000000001";
const DEVICE_B = "0b7c2a4e-2222-4c5d-9e8f-000000000002";

function entry(extra: Record<string, unknown> = {}) {
  return { ts: Date.now(), type: "console_error", refId: "session-1", payload: { message: "boom" }, ...extra };
}

const post = (body: unknown) =>
  app.request("http://localhost/api/trace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/trace", () => {
  it("stores a valid batch as browser rows keyed by device and filed against the session", async () => {
    const res = await post({ deviceId: DEVICE_A, sentAt: Date.now(), entries: [entry(), entry({ type: "console_log", payload: { args: ["hi"] } })] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ accepted: 2, dropped: 0 });

    const rows = readEvents(`browser:${DEVICE_A}`);
    expect(rows.map((r) => [r.seq, r.type, r.source, r.origin, r.refId])).toEqual([
      [1, "console_error", "browser", "browser", "session-1"],
      [2, "console_log", "browser", "browser", "session-1"],
    ]);
    expect(rows[0]!.payload).toEqual({ type: "console_error", message: "boom" });
  });

  it("refuses a batch over 50 entries, and a body that is not a batch", async () => {
    const tooMany = Array.from({ length: 51 }, () => entry());
    expect((await post({ deviceId: DEVICE_A, sentAt: Date.now(), entries: tooMany })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post({ deviceId: "../../etc", sentAt: Date.now(), entries: [] })).status).toBe(400);
    expect((await post({ deviceId: DEVICE_A, entries: [] })).status).toBe(400);
    expect(readEvents(`browser:${DEVICE_A}`)).toEqual([]);
  });

  it("drops the entries that do not fit and keeps the rest", async () => {
    const res = await post({
      deviceId: DEVICE_A,
      sentAt: Date.now(),
      entries: [
        entry({ payload: { message: "x".repeat(TRACE_INGEST_MAX_PAYLOAD_BYTES + 1) } }),
        entry({ type: "drop_table" }),
        entry({ refId: "<script>" }),
        entry({ payload: "not an object" }),
        entry(),
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ accepted: 1, dropped: 4 });
    expect(readEvents(`browser:${DEVICE_A}`)).toHaveLength(1);
  });

  it("rate-limits the flooding device while another device still gets through", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post({ deviceId: DEVICE_A, sentAt: Date.now(), entries: [entry()] })).status).toBe(200);
    }
    const limited = await post({ deviceId: DEVICE_A, sentAt: Date.now(), entries: [entry()] });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post({ deviceId: DEVICE_B, sentAt: Date.now(), entries: [entry()] })).status).toBe(200);
  });

  it("redacts secrets inside strings without corrupting the row", async () => {
    await post({
      deviceId: DEVICE_A,
      sentAt: Date.now(),
      entries: [entry({ payload: { args: ['fetch failed {"password":"hunter2"}', "Authorization: Bearer abc.def"] } })],
    });
    const [row] = readEvents(`browser:${DEVICE_A}`);
    const text = JSON.stringify(row!.payload);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc.def");
    expect(Array.isArray((row!.payload as { args: unknown[] }).args)).toBe(true);
  });
});

describe("browser timestamps", () => {
  it("are moved onto the server clock by the batch's own offset", () => {
    const now = 1_000_000_000_000;
    // The browser's clock is 5 minutes fast; the error happened 2 s before it was sent.
    const skew = 5 * 60_000;
    const rows = browserRows({
      deviceId: DEVICE_A,
      sentAt: now + skew,
      entries: [{ ts: now + skew - 2_000, type: "browser_error", refId: null, payload: {} }],
    }, now);
    expect(rows[0]!.ts).toBe(now - 2_000);
  });
});

describe("GET /api/trace/sessions/:id", () => {
  it("returns the session's trace interleaved with the browser rows filed against it", async () => {
    appendBatch([
      { traceId: "session-1", turnId: "t", ts: Date.now() - 1_000, source: "server", origin: "ws", providerId: "claude", refId: null, type: "user_message", payloadJson: '{"type":"user_message","text":"hi"}' },
    ]);
    await post({ deviceId: DEVICE_A, sentAt: Date.now(), entries: [entry({ type: "render_error" })] });
    const res = await app.request("http://localhost/api/trace/sessions/session-1");
    expect(res.status).toBe(200);
    const { events } = (await res.json()).data;
    expect(events.map((e: { type: string }) => e.type)).toEqual(["user_message", "render_error"]);
    expect(readSessionTimeline("session-1")).toHaveLength(2);
  });
});
