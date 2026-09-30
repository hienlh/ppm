// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/running-agents-bar.test.tsx
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { buildRunningRows, findCardLabel } from "../../../src/web/lib/running-agent-rows";
import type { TeamMemberActivity } from "../../../src/web/hooks/use-team-activity-feed";
import type { ChatMessage } from "../../../src/types/chat";

describe("buildRunningRows", () => {
  const members: TeamMemberActivity[] = [
    { name: "dev-p1", workState: "working", agentType: "ak-engineer:tester", startedAt: "2026-10-01T00:00:00.000Z", sizeBytes: 10 },
    { name: "dev-p2", workState: "paused", sizeBytes: 5 },
  ];

  it("enriches a member-sourced hub entry with the team poll's agent type and started-at", () => {
    const rows = buildRunningRows([{ memberName: "dev-p1", lastWriteAt: 1, lastStep: "Editing x.ts" }], members);
    expect(rows).toEqual([{
      key: "member:dev-p1", memberName: "dev-p1", lastStep: "Editing x.ts",
      agentType: "ak-engineer:tester", startedAt: "2026-10-01T00:00:00.000Z", lastWriteAt: 1,
    }]);
  });

  it("keeps a card-sourced hub entry as-is — no team metadata to attach", () => {
    const rows = buildRunningRows([{ cardId: "toolu_1", lastWriteAt: 2, lastStep: "Bash: ls" }], []);
    expect(rows).toEqual([{ key: "card:toolu_1", cardId: "toolu_1", lastStep: "Bash: ls", lastWriteAt: 2 }]);
  });

  it("adds a working teammate the hub push hasn't caught up to yet, without duplicating one it already reported", () => {
    const rows = buildRunningRows([{ memberName: "dev-p1", lastWriteAt: 1 }], members);
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual(["member:dev-p1"]); // dev-p1 not duplicated
    expect(keys).not.toContain("member:dev-p2"); // paused, not working — never added
  });

  it("is empty when the hub reports nothing and no teammate is working", () => {
    expect(buildRunningRows([], [{ name: "dev-p1", workState: "paused", sizeBytes: 1 }])).toEqual([]);
  });
});

describe("findCardLabel", () => {
  const messages: ChatMessage[] = [
    {
      id: "m1", role: "assistant", content: "", timestamp: "now",
      events: [
        { type: "tool_use", tool: "Agent", toolUseId: "toolu_1", input: { name: "dev-p1", description: "fix bug" } },
        {
          type: "tool_use", tool: "Agent", toolUseId: "toolu_2", input: { description: "one-shot review" },
          children: [{ type: "tool_use", tool: "Agent", toolUseId: "toolu_3", input: { description: "nested" } }],
        },
      ],
    },
  ];

  it("reads the handle and description off a known top-level card", () => {
    expect(findCardLabel(messages, "toolu_1")).toEqual({ handle: "dev-p1", description: "fix bug" });
  });

  it("finds a card nested under another Agent's kept children", () => {
    expect(findCardLabel(messages, "toolu_3")).toEqual({ handle: null, description: "nested" });
  });

  it("returns null for an id the chat has never seen", () => {
    expect(findCardLabel(messages, "toolu_unknown")).toBeNull();
  });
});

installDom();
afterAll(uninstallDom);

const { RunningAgentsBar } = await import("../../../src/web/components/chat/running-agents-bar");
const { setGlobalWsClient, notifyGlobalReady } = await import("../../../src/web/lib/global-ws-channel");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");

interface FakeClient {
  isConnected: boolean;
  send: (msg: string) => void;
}

function fakeClient(): { client: FakeClient; sent: string[] } {
  const sent: string[] = [];
  return { client: { isConnected: true, send: (msg) => { sent.push(msg); } }, sent };
}

function pushActivity(subId: string, running: unknown[]): Promise<void> {
  return import("react").then(({ act }) => act(async () => {
    window.dispatchEvent(new CustomEvent("agent-activity", {
      detail: { type: "agent-activity", subId, running },
    }));
  }));
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  setGlobalWsClient(null);
  useWindowStore.setState({ windows: {} });
});

function renderBar(props: Partial<Parameters<typeof RunningAgentsBar>[0]> = {}) {
  return mount(createElement(RunningAgentsBar, {
    projectName: "proj",
    providerId: "claude",
    sessionId: "sess-1",
    messages: [],
    teamName: "sess-1",
    teamMembers: [],
    ...props,
  } as never));
}

describe("RunningAgentsBar", () => {
  it("renders nothing without a session id — nothing for the hub to subscribe to", async () => {
    view = await renderBar({ sessionId: null });
    expect(view.container.firstElementChild).toBeNull();
  });

  it("renders nothing when the hub reports no one running and no teammate is working", async () => {
    const { client } = fakeClient();
    setGlobalWsClient(client as never);
    view = await renderBar();
    expect(view.container.firstElementChild).toBeNull();
  });

  it("shows a card row from the hub push and opens its session window on tap", async () => {
    const { client, sent } = fakeClient();
    setGlobalWsClient(client as never);
    view = await renderBar({
      messages: [{
        id: "m1", role: "assistant", content: "", timestamp: "now",
        events: [{ type: "tool_use", tool: "Agent", toolUseId: "toolu_1", input: { description: "fix bug" } }],
      }],
    });
    const subId = JSON.parse(sent[0]!).subId as string;
    await pushActivity(subId, [{ cardId: "toolu_1", lastWriteAt: Date.now(), lastStep: "Editing x.ts" }]);

    const row = view!.container.querySelector("button");
    expect(row?.textContent).toContain("fix bug");
    expect(row?.textContent).toContain("Editing x.ts");

    await click(row);
    const windows = Object.values(useWindowStore.getState().windows);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.kind).toBe("agent-session");
    expect((windows[0]!.payload as any).source).toEqual({ kind: "card", cardId: "toolu_1" });
    expect((windows[0]!.payload as any).sessionId).toBe("sess-1");
  });

  it("shows a working teammate even before the hub push reports it", async () => {
    const { client } = fakeClient();
    setGlobalWsClient(client as never);
    view = await renderBar({
      teamMembers: [{ name: "dev-p1", workState: "working", description: "reviewing", sizeBytes: 1 }],
    });
    expect(view.container.textContent).toContain("dev-p1");

    const row = view.container.querySelector("button");
    await click(row);
    const windows = Object.values(useWindowStore.getState().windows);
    expect((windows[0]!.payload as any).source).toEqual({ kind: "member", teamName: "sess-1", memberName: "dev-p1" });
  });

  it("shows no row for a teammate the poll no longer reports as working", async () => {
    const { client } = fakeClient();
    setGlobalWsClient(client as never);
    view = await renderBar({ teamMembers: [{ name: "dev-p1", workState: "paused", sizeBytes: 1 }] });
    expect(view.container.firstElementChild).toBeNull();
  });
});
