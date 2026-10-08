// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/running-agents-bar.test.tsx
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { buildRunningRows, findCardLabel, finishedSiblingRows } from "../../../src/web/lib/running-agent-rows";
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

  it("gives a named card one row, with the team poll's metadata, and no second row for the same teammate", () => {
    const rows = buildRunningRows([{ cardId: "toolu_1", memberName: "dev-p1", lastWriteAt: 3, lastStep: "Bash: ls" }], members);
    expect(rows).toEqual([{
      key: "card:toolu_1", cardId: "toolu_1", memberName: "dev-p1", lastStep: "Bash: ls",
      agentType: "ak-engineer:tester", startedAt: "2026-10-01T00:00:00.000Z", lastWriteAt: 3,
    }]);
  });

  it("is empty when the hub reports nothing and no teammate is working", () => {
    expect(buildRunningRows([], [{ name: "dev-p1", workState: "paused", sizeBytes: 1 }])).toEqual([]);
  });
});

describe("finishedSiblingRows", () => {
  const launch: ChatMessage = {
    id: "m1", role: "assistant", content: "", timestamp: "now",
    events: [
      { type: "tool_use", tool: "Agent", toolUseId: "run", input: { description: "still going" } },
      { type: "tool_use", tool: "Agent", toolUseId: "ok", input: { description: "done" }, bgStatus: "completed" },
      { type: "tool_use", tool: "Agent", toolUseId: "bad", input: { name: "dev-p9" }, bgStatus: "failed" },
    ],
  };
  const other: ChatMessage = {
    id: "m2", role: "assistant", content: "", timestamp: "now",
    events: [{ type: "tool_use", tool: "Agent", toolUseId: "old", input: {}, bgStatus: "completed" }],
  };

  it("lists the agents launched beside a running card as finished, failed ones marked", () => {
    const rows = finishedSiblingRows([launch, other], [{ key: "card:run", cardId: "run" }]);
    expect(rows).toEqual([
      { key: "card:ok", cardId: "ok", done: true, failed: false },
      { key: "card:bad", cardId: "bad", memberName: "dev-p9", done: true, failed: true },
    ]);
  });

  it("lists nothing once no card of the launch is running", () => {
    expect(finishedSiblingRows([launch, other], [{ key: "member:x", memberName: "x" }])).toEqual([]);
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
    expect(findCardLabel(messages, "toolu_1")).toEqual({ handle: "dev-p1", description: "fix bug", launchedAt: "now" });
  });

  it("finds a card nested under another Agent's kept children", () => {
    expect(findCardLabel(messages, "toolu_3")).toEqual({ handle: null, description: "nested", launchedAt: "now" });
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
// The DOM and the window store are shared by every file in the run, so a phone-width
// viewport or a leftover window from an earlier file would decide what a tap opens here.
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  useWindowStore.setState({ windows: {} });
});
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

  /** `count` named cards, as the hub reports a session fanning out to that many agents. */
  function namedCards(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      cardId: `toolu_${i}`, memberName: `fix-${i}`, lastWriteAt: Date.now(), lastStep: `Step ${i}`,
    }));
  }

  async function renderWithRunning(running: unknown[], messages: ChatMessage[] = []) {
    const { client, sent } = fakeClient();
    setGlobalWsClient(client as never);
    view = await renderBar({ messages });
    await pushActivity(JSON.parse(sent[0]!).subId as string, running);
    return view;
  }

  const summary = () => [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("running"));
  const agentRows = () => view!.container.querySelectorAll('li button[title^="Open"]');

  it("summarises several agents in one folded line that opens a list capped at three rows", async () => {
    await renderWithRunning(namedCards(11));
    const toggle = summary()!;
    expect(toggle.textContent).toContain("11 agents running");
    expect(toggle.textContent).toContain("fix-0");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(agentRows()).toHaveLength(0);

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = view!.container.querySelector('[id="' + toggle.getAttribute("aria-controls") + '"]')!;
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toContain("max-h-[140px]");
    expect(agentRows()).toHaveLength(11);

    await click(agentRows()[3]!);
    const windows = Object.values(useWindowStore.getState().windows);
    expect((windows[0]!.payload as any).source).toEqual({ kind: "card", cardId: "toolu_3" });
  });

  it("counts a finished agent launched beside running ones, and lists it as finished", async () => {
    const launch: ChatMessage = {
      id: "m1", role: "assistant", content: "", timestamp: "now",
      events: [
        { type: "tool_use", tool: "Agent", toolUseId: "toolu_0", input: { name: "fix-0" } },
        { type: "tool_use", tool: "Agent", toolUseId: "toolu_1", input: { name: "fix-1" } },
        { type: "tool_use", tool: "Agent", toolUseId: "toolu_9", input: { description: "review docs" }, bgStatus: "completed" },
      ],
    };
    await renderWithRunning(namedCards(2), [launch]);
    const toggle = summary()!;
    expect(toggle.textContent).toContain("2 agents running");
    expect(toggle.textContent).toContain("1 done");

    await click(toggle);
    const finished = [...agentRows()].find((b) => b.textContent?.includes("review docs"))!;
    expect(finished.textContent).toContain("Finished");
  });

  it("shows no row for a teammate the poll no longer reports as working", async () => {
    const { client } = fakeClient();
    setGlobalWsClient(client as never);
    view = await renderBar({ teamMembers: [{ name: "dev-p1", workState: "paused", sizeBytes: 1 }] });
    expect(view.container.firstElementChild).toBeNull();
  });
});
