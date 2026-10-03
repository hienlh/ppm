import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
installDom();
afterAll(() => uninstallDom());
const { act } = await import("react");
const { TerminalSelectionChat, readTerminalSelectionContext, placeSelectionActions } =
  await import("../../../src/web/components/terminal/terminal-selection-chat");
const { SEND_TO_CHAT_EVENT, SEND_TO_CHAT_ACK_EVENT } = await import("../../../src/web/lib/send-to-chat");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");

describe("readTerminalSelectionContext", () => {
  it("quotes the selection as one block, without the blank lines around it", () => {
    expect(readTerminalSelectionContext("\n  \n$ bun test\n  12 pass\n\n")).toEqual({
      label: "Terminal selection",
      text: "Selected text from the terminal\n```\n$ bun test\n  12 pass\n```",
    });
  });

  it("outruns any fence in the output, and offers nothing for whitespace", () => {
    expect(readTerminalSelectionContext("```ts\nx\n```")!.text).toBe("Selected text from the terminal\n````\n```ts\nx\n```\n````");
    expect(readTerminalSelectionContext(" \n\t\n")).toBeNull();
  });
});

describe("placeSelectionActions", () => {
  // 24 rows of 16px from y=4 in a 400px box; the actions are 200x24.
  const layout = (start: [number, number], end: [number, number], viewportY = 0) => ({
    start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, viewportY, rows: 24, cols: 80,
    cell: { width: 8, height: 16 }, screen: { left: 4, top: 4 }, box: { width: 648, height: 400 },
    actions: { width: 200, height: 24 },
  });

  it("sits under the last selected row, from the column the selection ends at", () => {
    // Rows 2-3 of the viewport, ending at column 10: under row 3 (4 + 4 * 16 + 4).
    expect(placeSelectionActions(layout([0, 102], [10, 103], 100))).toEqual({ left: 4 + 80, top: 72 });
  });

  it("treats a drag that stops at the start of a line as ending on the line before", () => {
    expect(placeSelectionActions(layout([0, 2], [0, 4]))).toEqual(placeSelectionActions(layout([0, 2], [80, 3])));
    // Its left edge is then held inside the box.
    expect(placeSelectionActions(layout([0, 2], [0, 4]))!.left).toBe(648 - 200);
  });

  it("goes over the selection when there is no room under it, and over the screen when neither fits", () => {
    // The last rows of the viewport: over row 20 instead (4 + 20 * 16 - 24 - 4).
    expect(placeSelectionActions(layout([5, 20], [9, 23]))!.top).toBe(296);
    // Every row selected: at the bottom of the box, over the text.
    expect(placeSelectionActions(layout([0, 0], [80, 23]))!.top).toBe(400 - 24);
  });

  it("follows the rows as the viewport scrolls, and is nowhere when none of them is in view", () => {
    expect(placeSelectionActions(layout([0, 50], [6, 50], 45))!.top).toBe(4 + 6 * 16 + 4);
    expect(placeSelectionActions(layout([0, 50], [6, 50], 51))).toBeNull();
    expect(placeSelectionActions(layout([0, 50], [6, 50], 20))).toBeNull();
  });
});

/** The parts of an xterm `Terminal` the actions use, driven by hand. */
function fakeTerminal() {
  const selectionListeners = new Set<() => void>();
  const element = document.createElement("div");
  element.appendChild(Object.assign(document.createElement("div"), { className: "xterm-screen" }));
  let selection = "";
  const terminal = {
    rows: 24,
    cols: 80,
    element,
    dimensions: { css: { cell: { width: 8, height: 16 } } },
    buffer: { active: { viewportY: 0 } },
    cleared: 0,
    getSelection: () => selection,
    getSelectionPosition: () => (selection ? { start: { x: 0, y: 1 }, end: { x: 6, y: 2 } } : undefined),
    clearSelection() {
      terminal.cleared++;
      selection = "";
      selectionListeners.forEach((listener) => listener());
    },
    onSelectionChange: (listener: () => void) => {
      selectionListeners.add(listener);
      return { dispose: () => selectionListeners.delete(listener) };
    },
    onRender: () => ({ dispose() {} }),
    /** What a released drag does: the text changes, then xterm says so. */
    select: async (text: string) => {
      await act(async () => {
        selection = text;
        selectionListeners.forEach((listener) => listener());
      });
    },
    /**
     * A drag that ends on the selection xterm last reported: it changes the text and says
     * nothing, even when the selection was cleared in between.
     */
    selectAgain: async (text: string) => {
      await act(async () => {
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        selection = text;
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    },
  };
  return terminal;
}

const button = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;

it("offers both chats once a selection is made, hands the selection over as a chip, and clears it", async () => {
  const terminal = fakeTerminal();
  const original = usePanelStore.getState();
  const opened: any[] = [];
  usePanelStore.setState({
    panels: { main: { id: "main", tabs: [{ id: "chat:a", type: "chat", title: "Chat", projectId: "demo", closable: true, metadata: { projectName: "demo" } }], activeTabId: "chat:a", tabHistory: [] } } as never,
    focusedPanelId: "main",
    setActiveTab: (() => {}) as never,
    openTab: ((tab: any) => { opened.push(tab); return "chat:new"; }) as never,
  });
  const delivered: any[] = [];
  const composer = (e: Event) => {
    delivered.push((e as CustomEvent).detail);
    window.dispatchEvent(new CustomEvent(SEND_TO_CHAT_ACK_EVENT, { detail: {} }));
  };
  window.addEventListener(SEND_TO_CHAT_EVENT, composer);
  const view = await mount(<div style={{ position: "relative" }}><TerminalSelectionChat terminal={terminal as never} projectName="demo" touch={false} /></div>);
  try {
    expect(view.container.querySelector('[role="group"]')).toBeNull();
    // Whitespace is nothing to add.
    await terminal.select("  \n ");
    expect(view.container.querySelector('[role="group"]')).toBeNull();

    await terminal.select("MARK_A\nMARK_B\n");
    expect([...view.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Add to current chat", "Add to new chat"]);
    await click(button(view.container, "Add to current chat"));
    // Into the chat that is open, as a chip the user sends with their own message.
    expect(delivered).toEqual([{ text: "Selected text from the terminal\n```\nMARK_A\nMARK_B\n```", label: "Terminal selection", projectName: "demo", targetTabId: "chat:a" }]);
    expect(terminal.cleared).toBe(1);
    expect(view.container.querySelector('[role="group"]')).toBeNull();

    await terminal.select("MARK_C");
    await click(button(view.container, "Add to new chat"));
    expect(opened).toHaveLength(1);
    expect(opened[0].metadata).toEqual({ projectName: "demo", pendingContexts: [{ text: "Selected text from the terminal\n```\nMARK_C\n```", label: "Terminal selection" }] });
    expect(delivered).toHaveLength(1);
    expect(terminal.cleared).toBe(2);
  } finally {
    await view.unmount();
    window.removeEventListener(SEND_TO_CHAT_EVENT, composer);
    usePanelStore.setState({ panels: original.panels, focusedPanelId: original.focusedPanelId, setActiveTab: original.setActiveTab, openTab: original.openTab });
  }
});

it("reads the selection when the pointer is released, since xterm does not report one it reported before", async () => {
  const terminal = fakeTerminal();
  const view = await mount(<TerminalSelectionChat terminal={terminal as never} touch={false} />);
  try {
    await terminal.select("MARK_A");
    await act(async () => terminal.clearSelection());
    expect(view.container.querySelector('[role="group"]')).toBeNull();
    await terminal.selectAgain("MARK_A");
    expect(view.container.querySelector('[role="group"]')).not.toBeNull();
  } finally {
    await view.unmount();
  }
});

it("gives a finger 44px targets", async () => {
  const terminal = fakeTerminal();
  const view = await mount(<TerminalSelectionChat terminal={terminal as never} touch />);
  try {
    await terminal.select("MARK_A");
    for (const b of view.container.querySelectorAll("button")) expect(b.className).toContain("min-h-11");
  } finally {
    await view.unmount();
  }
});
