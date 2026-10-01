// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/agent-session-window-content.test.tsx
//
// Header (title/steps/status), the collapsible prompt for a card source, and the fallback
// indicator — mounted with the real DOM harness so `useAgentSessionStream`'s effects run and
// push through the same window-event bus `use-global-events.ts` re-dispatches onto.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);

const { default: AgentSessionWindowContent } = await import(
  "../../../src/web/components/chat/agent-session-window-content"
);
const { setGlobalWsClient } = await import("../../../src/web/lib/global-ws-channel");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const { setFallbackEvents, fallbackKey } = await import(
  "../../../src/web/components/chat/agent-session-fallback-store"
);

interface FakeClient {
  isConnected: boolean;
  send: (msg: string) => void;
}

function fakeClient(): { client: FakeClient; sent: string[] } {
  const sent: string[] = [];
  return { client: { isConnected: true, send: (msg) => { sent.push(msg); } }, sent };
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  setGlobalWsClient(null);
});

async function pushEvents(sent: string[], patch: Record<string, unknown>) {
  const subId = JSON.parse(sent[0]!).subId as string;
  await act(async () => {
    window.dispatchEvent(new CustomEvent("agent-transcript:events", {
      detail: { type: "agent-transcript:events", subId, cursor: {}, available: true, running: true, events: [], ...patch },
    }));
  });
}

describe("AgentSessionWindowContent", () => {
  it("shows a loading state before the first response", async () => {
    const { client } = fakeClient();
    setGlobalWsClient(client as never);
    view = await mount(
      <AgentSessionWindowContent id="w1" payload={{ projectName: "p", providerId: "claude", sessionId: "s1", source: { kind: "card", cardId: "c1" }, title: "Research" }} />,
    );
    expect(view.container.textContent).toContain("Loading session");
    expect(view.container.textContent).toContain("Research");
  });

  it("shows the step count and a running badge once steps arrive", async () => {
    const { client, sent } = fakeClient();
    setGlobalWsClient(client as never);
    view = await mount(
      <AgentSessionWindowContent id="w2" payload={{ projectName: "p", providerId: "claude", sessionId: "s2", source: { kind: "card", cardId: "c2" }, title: "Research" }} />,
    );
    await pushEvents(sent, {
      running: true,
      events: [
        { ev: { type: "tool_use", tool: "Bash", input: { command: "ls" }, toolUseId: "t1" }, ts: 1, k: "f:0:0" },
        { ev: { type: "tool_result", toolUseId: "t1", output: "ok" }, ts: 2, k: "f:0:1" },
      ],
    });
    expect(view.container.textContent).toContain("1 step");
    expect(view.container.textContent).not.toContain("1 steps");
    expect(view.container.textContent).toContain("running");
  });

  it("renders nested Agent children inline (variant=\"window\")", async () => {
    const { client, sent } = fakeClient();
    setGlobalWsClient(client as never);
    view = await mount(
      <AgentSessionWindowContent id="w3" payload={{ projectName: "p", providerId: "claude", sessionId: "s3", source: { kind: "card", cardId: "c3" }, title: "Research" }} />,
    );
    await pushEvents(sent, {
      running: false,
      events: [
        {
          ev: {
            type: "tool_use", tool: "Agent", toolUseId: "nested-1", input: { description: "sub task" },
            children: [{ type: "tool_use", tool: "Bash", toolUseId: "nested-bash-1", input: { command: "echo nested-marker-xyz" } }],
          },
          ts: 1, k: "f:0:0",
        },
      ],
    });
    // The Agent card itself starts collapsed, same as in chat — clicking it reveals the
    // nested step's own summary inline rather than opening a second window/sheet.
    expect(view.container.textContent).not.toContain("nested-marker-xyz");
    const toggle = view.container.querySelector("button");
    await act(async () => { toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(view.container.textContent).toContain("nested-marker-xyz");
  });

  it("shows the collapsible prompt for a card source, closed by default", async () => {
    const { client } = fakeClient();
    setGlobalWsClient(client as never);
    view = await mount(
      <AgentSessionWindowContent
        id="w4"
        payload={{ projectName: "p", providerId: "claude", sessionId: "s4", source: { kind: "card", cardId: "c4" }, title: "Research", prompt: "Investigate the flaky test" }}
      />,
    );
    expect(view.container.textContent).not.toContain("Investigate the flaky test");
    const toggle = view.container.querySelector("button");
    await act(async () => { toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(view.container.textContent).toContain("Investigate the flaky test");
  });

  it("falls back to steps already held in memory when the server reports unavailable", async () => {
    const { client, sent } = fakeClient();
    setGlobalWsClient(client as never);
    const payload = { projectName: "p", providerId: "claude" as const, sessionId: "s5", source: { kind: "member" as const, teamName: "s5", memberName: "fixer" }, title: "Session — fixer" };
    // Remembered steps are kept only while a window shows them, and any window-store change
    // prunes the rest — so open the window first, the way the opener does.
    useWindowStore.setState({ windows: {} });
    const id = useWindowStore.getState().open("agent-session", payload as unknown as Record<string, unknown>);
    // A tool step rather than text: text goes through the lazily loaded markdown renderer,
    // whose chunk may not have resolved yet, while a tool card renders synchronously.
    setFallbackEvents(fallbackKey("s5", payload.source), [
      { type: "tool_use", tool: "Read", input: { file_path: "/src/remembered-step.ts" }, toolUseId: "r1" } as never,
    ]);
    view = await mount(<AgentSessionWindowContent id={id} payload={payload as never} />);
    await pushEvents(sent, { available: false, running: false });
    expect(view.container.textContent).toContain("remembered-step.ts");
    expect(view.container.textContent).toContain("1 step");
    expect(view.container.textContent).toContain("offline");
  });
});
