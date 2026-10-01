// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/tool-card-window-store-rerender.test.tsx
//
// Every ToolCard calls useOpenAgentSession() unconditionally (Bash/Read cards too, not
// just Agent/Task), and that hook used to subscribe to the floating-window store's `windows`/
// `bounds` — so dragging any window re-rendered every mounted tool card, in every chat tab.
// `Profiler.onRender` only fires for a subtree that actually committed, so it is the direct
// way to prove a store mutation causes zero re-renders rather than reasoning about selectors.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Profiler, createElement } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { ChatEvent } from "../../../src/types/chat";

installDom();
afterAll(uninstallDom);

const { ToolCard } = await import("../../../src/web/components/chat/tool-cards");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");

const READ_TOOL: ChatEvent = { type: "tool_use", tool: "Read", input: { file_path: "/a.ts" }, toolUseId: "t1" };

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
  useWindowStore.setState({ windows: {} });
});

describe("ToolCard — window store isolation", () => {
  it("does not re-render on a window-store mutation (a plain Bash/Read card)", async () => {
    let commits = 0;
    view = await mount(
      createElement(
        Profiler,
        { id: "probe", onRender: () => { commits++; } },
        createElement(ToolCard, { tool: READ_TOOL }),
      ),
    );
    expect(commits).toBe(1);

    const { act } = await import("react");
    await act(async () => {
      // The kind of mutation `window-store.ts`'s `move()` performs on every pointermove frame
      // while dragging a window — a brand new `windows` object, unrelated to this card.
      useWindowStore.setState({ windows: { ...useWindowStore.getState().windows, ghost: {} as never } });
    });

    expect(commits).toBe(1); // still just the initial commit — no subscription fired
  });

  it("still opens a session window on tap — the fix removed the subscription, not the callback", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    const agentTool: ChatEvent = {
      type: "tool_use", tool: "Agent", input: { description: "review" }, toolUseId: "a1",
    };
    view = await mount(createElement(ToolCard, { tool: agentTool, projectName: "proj" }));
    const before = Object.keys(useWindowStore.getState().windows).length;

    const { act } = await import("react");
    const button = view.container.querySelector("button")!;
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(Object.keys(useWindowStore.getState().windows).length).toBe(before + 1);
  });
});
