import { describe, expect, it } from "bun:test";
import { createDeviceBroker, createTabOpenBroker } from "../../../src/services/tab-tools-mcp/tab-open-broker.ts";
import { ASSISTANT_UI_NO_DEVICE_MESSAGE, createAssistantUiBroker } from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";
import type { AssistantUiRequest } from "../../../src/shared/assistant-ui-protocol.ts";
import type { TabOpenRequest } from "../../../src/shared/tab-open-protocol.ts";

const REQ = { tool: "open_file" as const, filePath: "a.ts", projectName: "demo" };
const answer = (requestId: string, opened = true) => ({ type: "tab_open_result" as const, requestId, opened });

function setup(opts: { reach?: number; now?: () => number; maxInFlightPerSession?: number; perMinute?: number } = {}) {
  const sent: Array<{ sessionId: string; request: TabOpenRequest }> = [];
  const broker = createTabOpenBroker({
    deliver: (sessionId, request) => { sent.push({ sessionId, request }); return opts.reach ?? 1; },
    now: opts.now, maxInFlightPerSession: opts.maxInFlightPerSession, perMinute: opts.perMinute,
  });
  return { broker, sent };
}

describe("tab open broker", () => {
  it("answers at once when no device has the chat open", async () => {
    const { broker } = setup({ reach: 0 });
    const outcome = await broker.request("s1", REQ, 1000);
    expect(outcome).toMatchObject({ ok: false, reason: "no-device" });
    expect(broker.pendingCount()).toBe(0);
  });

  it("settles with the first answer from the same session only", async () => {
    const { broker, sent } = setup();
    const call = broker.request("s1", REQ, 1000);
    const request = sent[0]!.request;
    expect(request).toMatchObject({ type: "tab_open", tool: "open_file", filePath: "a.ts", projectName: "demo" });
    expect(request.requestId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(broker.settle("s2", answer(request.requestId))).toBe(false);
    expect(broker.settle("s1", answer("unknown-request-id"))).toBe(false);
    expect(broker.settle("s1", answer(request.requestId))).toBe(true);
    expect(broker.settle("s1", answer(request.requestId, false))).toBe(false);
    expect(await call).toEqual({ ok: true, result: answer(request.requestId) });
  });

  it("follows a session its provider renamed after the call's token was issued", async () => {
    // Codex names a new chat after its thread once the first turn starts; the sockets move with it.
    const renamed = new Map([["ppm-id", "thread-id"]]);
    const sent: Array<{ sessionId: string; request: TabOpenRequest }> = [];
    const broker = createTabOpenBroker({
      deliver: (sessionId, request) => { sent.push({ sessionId, request }); return 1; },
      canonical: (sessionId) => renamed.get(sessionId) ?? sessionId,
    });
    const call = broker.request("ppm-id", REQ, 1000);
    expect(sent[0]!.sessionId).toBe("thread-id");
    const { requestId } = sent[0]!.request;
    expect(broker.settle("another-thread", answer(requestId))).toBe(false);
    expect(broker.settle("thread-id", answer(requestId))).toBe(true);
    expect((await call).ok).toBe(true);
  });

  it("gives up after the wait", async () => {
    const { broker } = setup();
    const outcome = await broker.request("s1", REQ, 20);
    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
    expect(broker.pendingCount()).toBe(0);
  });

  it("holds a session to a few calls at once without counting the refused ones", async () => {
    const { broker, sent } = setup({ maxInFlightPerSession: 2, perMinute: 3 });
    const first = broker.request("s1", REQ, 1000);
    broker.request("s1", REQ, 1000);
    expect(await broker.request("s1", REQ, 1000)).toMatchObject({ ok: false, reason: "busy" });
    // Another session is not held up by this one.
    broker.request("s2", REQ, 1000);
    expect(sent.length).toBe(3);
    broker.settle("s1", answer(sent[0]!.request.requestId));
    await first;
    broker.request("s1", REQ, 1000);
    expect(sent.length).toBe(4);
    for (const { sessionId, request } of sent) broker.settle(sessionId, answer(request.requestId));
  });

  it("allows a few dozen calls a minute per session", async () => {
    let time = 0;
    const { broker, sent } = setup({ now: () => time, perMinute: 2 });
    for (let i = 0; i < 2; i++) {
      const call = broker.request("s1", REQ, 1000);
      broker.settle("s1", answer(sent.at(-1)!.request.requestId));
      await call;
    }
    expect(await broker.request("s1", REQ, 1000)).toMatchObject({ ok: false, reason: "rate-limited" });
    time += 61_000;
    const later = broker.request("s1", REQ, 1000);
    broker.settle("s1", answer(sent.at(-1)!.request.requestId));
    expect((await later).ok).toBe(true);
  });

  it("treats a delivery that throws as reaching no device", async () => {
    const broker = createTabOpenBroker({ deliver: () => { throw new Error("socket closed"); } });
    expect(await broker.request("s1", REQ, 1000)).toMatchObject({ ok: false, reason: "no-device" });
  });
});

describe("device broker", () => {
  type Req = { type: "probe"; requestId: string; what: string };
  type Res = { requestId: string; value: number };
  const messages = {
    noDevice: "nobody", busy: "busy now",
    rateLimited: (n: number) => `limit ${n}`, timeout: (s: number) => `waited ${s}`,
  };

  it("builds its own wire request and answers in its own words", async () => {
    const sent: Array<{ sessionId: string; request: Req }> = [];
    const broker = createDeviceBroker<Req, Res, { what: string }>({
      deliver: (sessionId, request) => { sent.push({ sessionId, request }); return 1; },
      build: (requestId, body) => ({ type: "probe", requestId, what: body.what }),
      messages, logTag: "probe", maxPending: 8, maxInFlightPerSession: 1, perMinute: 2,
    });
    const call = broker.request("s1", { what: "layout" }, 1000);
    expect(sent[0]!.request).toMatchObject({ type: "probe", what: "layout" });
    expect(await broker.request("s1", { what: "again" }, 1000)).toEqual({ ok: false, reason: "busy", message: "busy now" });
    expect(broker.settle("s1", { requestId: sent[0]!.request.requestId, value: 7 })).toBe(true);
    expect(await call).toEqual({ ok: true, result: { requestId: sent[0]!.request.requestId, value: 7 } });
    expect(await broker.request("s1", { what: "late" }, 10)).toEqual({ ok: false, reason: "timeout", message: "waited 0" });
    expect(await broker.request("s1", { what: "over" }, 10)).toEqual({ ok: false, reason: "rate-limited", message: "limit 2" });
  });

  it("answers no-device in its own words when nothing was reached", async () => {
    const broker = createDeviceBroker<Req, Res, { what: string }>({
      deliver: () => 0, build: (requestId, body) => ({ type: "probe", requestId, what: body.what }),
      messages, logTag: "probe", maxPending: 8, maxInFlightPerSession: 1, perMinute: 2,
    });
    expect(await broker.request("s1", { what: "x" }, 1000)).toEqual({ ok: false, reason: "no-device", message: "nobody" });
    expect(broker.pendingCount()).toBe(0);
  });

  it("keeps the tab tools' wording", async () => {
    const outcome = await createTabOpenBroker({ deliver: () => 0 }).request("s1", REQ, 1000);
    expect(outcome).toEqual({ ok: false, reason: "no-device", message: "No PPM window has this chat open, so nothing was shown." });
    let time = 0;
    const limited = createTabOpenBroker({ deliver: () => 1, now: () => time, perMinute: 1 });
    void limited.request("s1", REQ, 5);
    time += 1;
    expect(await limited.request("s1", REQ, 5)).toEqual({
      ok: false, reason: "rate-limited", message: "Tabs were opened 1 times in the last minute; wait before opening more.",
    });
    expect(await createTabOpenBroker({ deliver: () => 1 }).request("s1", REQ, 20)).toEqual({
      ok: false, reason: "timeout", message: "The user's device did not confirm within 0 s; the tab may or may not have opened.",
    });
  });

  it("sends the Assistant's UI requests as assistant_ui and asks the user to chat from a device when none is", async () => {
    const sent: AssistantUiRequest[] = [];
    const broker = createAssistantUiBroker({ deliver: (_s, request) => { sent.push(request); return 1; } });
    const call = broker.request("s1", { op: "get_state", args: {} }, 1000);
    expect(sent[0]).toMatchObject({ type: "assistant_ui", op: "get_state", args: {} });
    broker.settle("s1", { type: "assistant_ui_result", requestId: sent[0]!.requestId, ok: true, data: { panels: [] } });
    expect(await call).toMatchObject({ ok: true, result: { ok: true, data: { panels: [] } } });
    const none = await createAssistantUiBroker({ deliver: () => 0 }).request("s1", { op: "get_state", args: {} }, 1000);
    expect(none).toEqual({ ok: false, reason: "no-device", message: ASSISTANT_UI_NO_DEVICE_MESSAGE });
    expect(ASSISTANT_UI_NO_DEVICE_MESSAGE).toContain("open the Assistant session on their device and send a message");
  });
});
