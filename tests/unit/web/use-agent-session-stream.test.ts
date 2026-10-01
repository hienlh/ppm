// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/use-agent-session-stream.test.ts
//
// Two layers: the pure merge reducer (ordering/de-dupe/replace/reset/cap — no WebSocket, no
// React) and the hook itself (subscribe/resubscribe/fallback wiring, mounted with the DOM
// harness so real effects run). Plain `.ts`, not `.tsx`, so the component under test is built
// with `React.createElement` rather than JSX.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import {
  applyEnvelopeBatch,
  MAX_STREAM_ENTRIES,
} from "../../../src/web/lib/agent-session-stream-merge";
import type { AgentTranscriptEventsMsg } from "../../../src/shared/agent-transcript-protocol";

function textEvent(content: string) {
  return { type: "text" as const, content };
}

function page(
  events: AgentTranscriptEventsMsg["events"],
  extra: Partial<AgentTranscriptEventsMsg> = {},
): AgentTranscriptEventsMsg {
  return {
    type: "agent-transcript:events",
    subId: "sub-1",
    events,
    cursor: {},
    available: true,
    running: true,
    ...extra,
  };
}

describe("applyEnvelopeBatch", () => {
  it("inserts by ts, even when a batch arrives out of order", () => {
    const result = applyEnvelopeBatch([], page([
      { ev: textEvent("b"), ts: 20, k: "f:0:0" },
      { ev: textEvent("a"), ts: 10, k: "f:0:1" },
    ]));
    expect(result.map((e) => e.k)).toEqual(["f:0:1", "f:0:0"]);
  });

  it("de-dupes by k — a duplicate delivery without `replace` is skipped", () => {
    const first = applyEnvelopeBatch([], page([{ ev: textEvent("a"), ts: 10, k: "f:0:0" }]));
    const second = applyEnvelopeBatch(first, page([{ ev: textEvent("a-dup"), ts: 10, k: "f:0:0" }]));
    expect(second).toHaveLength(1);
    expect((second[0]!.ev as { content: string }).content).toBe("a");
  });

  it("upserts in place when the envelope carries replace", () => {
    const first = applyEnvelopeBatch([], page([{ ev: textEvent("pending"), ts: 10, k: "f:0:0" }]));
    const second = applyEnvelopeBatch(
      first,
      page([{ ev: textEvent("done"), ts: 10, k: "f:0:0", replace: true }]),
    );
    expect(second).toHaveLength(1);
    expect((second[0]!.ev as { content: string }).content).toBe("done");
  });

  it("replaces everything on reset instead of appending to it", () => {
    const first = applyEnvelopeBatch([], page([{ ev: textEvent("old"), ts: 10, k: "f:0:0" }]));
    const second = applyEnvelopeBatch(
      first,
      page([{ ev: textEvent("new"), ts: 5, k: "f:1:0" }], { reset: true }),
    );
    expect(second.map((e) => e.k)).toEqual(["f:1:0"]);
  });

  it("caps at MAX_STREAM_ENTRIES, dropping the oldest", () => {
    const events = Array.from({ length: MAX_STREAM_ENTRIES + 10 }, (_, i) => (
      { ev: textEvent(String(i)), ts: i, k: `f:0:${i}` }
    ));
    const result = applyEnvelopeBatch([], page(events));
    expect(result).toHaveLength(MAX_STREAM_ENTRIES);
    expect(result[0]!.k).toBe("f:0:10");
    expect(result[result.length - 1]!.k).toBe(`f:0:${MAX_STREAM_ENTRIES + 9}`);
  });
});

installDom();
afterAll(uninstallDom);

const { useAgentSessionStream } = await import("../../../src/web/hooks/use-agent-session-stream");
const { setGlobalWsClient, notifyGlobalReady } = await import("../../../src/web/lib/global-ws-channel");

interface FakeClient {
  isConnected: boolean;
  send: (msg: string) => void;
}

function fakeClient(): { client: FakeClient; sent: string[] } {
  const sent: string[] = [];
  return { client: { isConnected: false, send: (msg) => { sent.push(msg); } }, sent };
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  setGlobalWsClient(null);
});

function Probe({ sessionId }: { sessionId: string }) {
  const s = useAgentSessionStream({
    projectName: "proj",
    providerId: "claude",
    sessionId,
    source: { kind: "card", cardId: "card-1" },
    fallbackEvents: [{ type: "text", content: "fallback" } as never],
  });
  return createElement(
    "pre",
    { "data-available": String(s.available), "data-running": String(s.running), "data-loading": String(s.loading) },
    JSON.stringify(s.events),
  );
}

function mountProbe(sessionId: string): Promise<Mounted> {
  return mount(createElement(Probe, { sessionId }));
}

function readProbe() {
  const el = view!.container.firstElementChild as HTMLElement;
  return {
    available: el.getAttribute("data-available") === "true",
    running: el.getAttribute("data-running") === "true",
    loading: el.getAttribute("data-loading") === "true",
    events: JSON.parse(el.textContent!),
  };
}

describe("useAgentSessionStream", () => {
  it("never queues a subscribe while the socket is closed — resubscribes on global_ready", async () => {
    const { client, sent } = fakeClient();
    setGlobalWsClient(client as never);
    view = await mountProbe("s1");
    expect(sent).toHaveLength(0);

    client.isConnected = true;
    const { act } = await import("react");
    await act(async () => { notifyGlobalReady(); });
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]!);
    expect(msg.type).toBe("agent-transcript:subscribe");
    expect(msg.cursor).toBeUndefined();
  });

  it("applies a pushed page, then falls back once the server reports unavailable", async () => {
    const { client, sent } = fakeClient();
    client.isConnected = true;
    setGlobalWsClient(client as never);
    view = await mountProbe("s2");
    const subId = JSON.parse(sent[0]!).subId as string;

    const { act } = await import("react");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("agent-transcript:events", {
        detail: {
          type: "agent-transcript:events",
          subId,
          events: [{ ev: { type: "text", content: "hi" }, ts: 1, k: "f:0:0" }],
          cursor: { f: 10 },
          available: true,
          running: true,
        },
      }));
    });
    expect(readProbe()).toMatchObject({ available: true, running: true, loading: false });
    expect(readProbe().events).toEqual([{ type: "text", content: "hi" }]);

    await act(async () => {
      window.dispatchEvent(new CustomEvent("agent-transcript:events", {
        detail: { type: "agent-transcript:events", subId, events: [], cursor: {}, available: false, running: false },
      }));
    });
    const state = readProbe();
    expect(state.available).toBe(false);
    expect(state.events).toEqual([{ type: "text", content: "fallback" }]);
  });

  it("ignores an events page addressed to a different subId", async () => {
    const { client } = fakeClient();
    client.isConnected = true;
    setGlobalWsClient(client as never);
    view = await mountProbe("s3");

    const { act } = await import("react");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("agent-transcript:events", {
        detail: {
          type: "agent-transcript:events", subId: "someone-elses-sub",
          events: [{ ev: { type: "text", content: "not mine" }, ts: 1, k: "f:0:0" }],
          cursor: {}, available: true, running: true,
        },
      }));
    });
    expect(readProbe().loading).toBe(true);
    expect(readProbe().events).toEqual([{ type: "text", content: "fallback" }]);
  });

  it("resubscribes with the last applied cursor on reconnect", async () => {
    const { client, sent } = fakeClient();
    client.isConnected = true;
    setGlobalWsClient(client as never);
    view = await mountProbe("s4");
    const subId = JSON.parse(sent[0]!).subId as string;

    const { act } = await import("react");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("agent-transcript:events", {
        detail: {
          type: "agent-transcript:events", subId,
          events: [{ ev: { type: "text", content: "hi" }, ts: 1, k: "f:0:0" }],
          cursor: { f: 42 }, available: true, running: true,
        },
      }));
    });

    await act(async () => { notifyGlobalReady(); });
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]!).cursor).toEqual({ f: 42 });
  });

  it("unsubscribes on unmount", async () => {
    const { client, sent } = fakeClient();
    client.isConnected = true;
    setGlobalWsClient(client as never);
    view = await mountProbe("s5");
    const subId = JSON.parse(sent[0]!).subId as string;
    await view.unmount();
    view = null;
    const last = JSON.parse(sent[sent.length - 1]!);
    expect(last).toEqual({ type: "agent-transcript:unsubscribe", subId });
  });
});
