/**
 * An idle chat reloads its history only when it missed an event. Every reload swaps the rows the
 * list draws for the transcript's copy, which moves a reader who has scrolled up, and the chat
 * socket of a flaky link reconnects every few minutes. A fresh tab used to read its own event
 * number (0) as a gap on every ping, asking for a resync and reloading history every few seconds.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { api } = await import("../../../src/web/lib/api-client");
const { idleGreetingNeedsHistory } = await import("../../../src/web/lib/idle-greeting-refetch");

const SID = "cccccccc-0000-4000-8000-000000000004";
let view: Mounted | null = null;
let receive: (event: MessageEvent) => void;
let sent: string[] = [];
let historyReads = 0;
const spies: Array<{ mockRestore(): void }> = [];

function Probe() {
  useChat(SID, "claude", "proj");
  return null;
}
const emit = (frame: unknown) => act(async () => receive(new MessageEvent("message", { data: JSON.stringify(frame) })));
const settle = (ms = 30) => act(async () => { await Bun.sleep(ms); });
const greeting = (streamSeq?: number) => ({ type: "session_state", sessionId: SID, phase: "idle", pendingApproval: null, sessionTitle: null, ...(streamSeq === undefined ? {} : { streamSeq }) });
const resyncs = () => sent.filter((s) => s.includes('"resync"')).length;

beforeEach(() => {
  sent = [];
  historyReads = 0;
  spies.push(
    spyOn(WsClient.prototype, "send").mockImplementation((msg: string) => { sent.push(msg); }),
    spyOn(api, "get").mockImplementation((async (url: string) => {
      if (url.includes("/messages")) historyReads++;
      return { messages: [], start: 0, total: 0 };
    }) as never),
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; }),
  );
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Mounts the chat, lets its first history load land, and moves the clock past "just loaded". */
async function openedLongAgo(firstGreetingSeq?: number) {
  view = await mount(<Probe />);
  await emit(greeting(firstGreetingSeq));
  await settle();
  const later = Date.now() + 60_000;
  spies.push(spyOn(Date, "now").mockReturnValue(later));
  historyReads = 0;
}

describe("an idle chat", () => {
  it("does not ask for a resync on every ping once its greeting named the event number", async () => {
    await openedLongAgo(57);
    for (let i = 0; i < 4; i++) await emit({ type: "ping", streamSeq: 57 });
    expect(resyncs()).toBe(0);
    expect(historyReads).toBe(0);
  });

  it("does not reload history when a reconnect missed nothing", async () => {
    await openedLongAgo(57);
    await emit(greeting(57));
    await settle();
    expect(historyReads).toBe(0);
  });

  it("reloads history when a reconnect missed events", async () => {
    await openedLongAgo(57);
    await emit(greeting(64));
    await settle();
    expect(historyReads).toBe(1);
  });

  it("reloads once and then holds still when the server restarted and numbers from 0 again", async () => {
    await openedLongAgo(57);
    await emit(greeting(3));
    await settle();
    expect(historyReads).toBe(1);
    await emit({ type: "ping", streamSeq: 3 });
    await emit(greeting(3));
    await settle();
    expect(resyncs()).toBe(0);
    expect(historyReads).toBe(1);
  });

  it("keeps reloading on a greeting from a server that sends no event number", async () => {
    await openedLongAgo();
    await emit(greeting());
    await settle();
    expect(historyReads).toBe(1);
  });
});

describe("idleGreetingNeedsHistory", () => {
  const base = { replayWasTruncated: false, wasIdle: true, historyFresh: false, serverSeq: 10, clientSeq: 10 };

  it("reloads after a turn ended while the tab thought it was running", () => {
    expect(idleGreetingNeedsHistory({ ...base, wasIdle: false, historyFresh: true })).toBe(true);
  });

  it("reloads after a truncated replay", () => {
    expect(idleGreetingNeedsHistory({ ...base, replayWasTruncated: true, historyFresh: true })).toBe(true);
  });

  it("leaves a history that has just loaded alone", () => {
    expect(idleGreetingNeedsHistory({ ...base, clientSeq: 0 })).toBe(true);
    expect(idleGreetingNeedsHistory({ ...base, clientSeq: 0, historyFresh: true })).toBe(false);
  });

  it("compares event numbers when the server sends one", () => {
    expect(idleGreetingNeedsHistory(base)).toBe(false);
    expect(idleGreetingNeedsHistory({ ...base, serverSeq: 11 })).toBe(true);
    expect(idleGreetingNeedsHistory({ ...base, serverSeq: 2 })).toBe(true);
  });

  it("falls back to reloading when the server sends none", () => {
    expect(idleGreetingNeedsHistory({ ...base, serverSeq: undefined })).toBe(true);
  });
});
