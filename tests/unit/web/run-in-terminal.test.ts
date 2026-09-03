/**
 * "Send to terminal" delivery for chat code blocks.
 *
 * Two properties matter:
 *  - The command text is normalized like a human would paste it: no `$` prompt
 *    markers, no trailing newline (the trailing newline would run the last line
 *    instead of leaving it for the user's Enter).
 *  - A terminal already on screen claims the command; only when nobody claims it
 *    does a new terminal get opened to carry it via `pendingCommand`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// runInTerminal only needs an event bus on `window`; the panel store reads
// localStorage at import time. Stub both before importing either module.
const eventBus = new EventTarget();
(globalThis as any).window = eventBus;
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const {
  normalizeTerminalCommand,
  runInTerminal,
  RUN_IN_TERMINAL_EVENT,
  RUN_IN_TERMINAL_ACK_EVENT,
} = await import("../../../src/web/lib/run-in-terminal");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");

describe("normalizeTerminalCommand", () => {
  it("drops `$ ` prompt markers on every line", () => {
    expect(normalizeTerminalCommand("$ bun test")).toBe("bun test");
    expect(normalizeTerminalCommand("$ cd app\n$ bun test")).toBe("cd app\nbun test");
  });

  it("drops the trailing newline so the last line waits for Enter", () => {
    expect(normalizeTerminalCommand("bun test\n")).toBe("bun test");
    expect(normalizeTerminalCommand("bun test\n\n")).toBe("bun test");
  });

  it("keeps a `$` that is part of the command (shell variable)", () => {
    expect(normalizeTerminalCommand("echo $HOME")).toBe("echo $HOME");
    expect(normalizeTerminalCommand("$HOME/bin/tool --flag")).toBe("$HOME/bin/tool --flag");
  });
});

describe("runInTerminal", () => {
  let opened: any[] = [];
  let originalOpenInDock: any;

  beforeEach(() => {
    opened = [];
    originalOpenInDock = usePanelStore.getState().openInDock;
    usePanelStore.setState({
      openInDock: ((def: any) => {
        opened.push(def);
        return "terminal:1";
      }) as any,
    });
  });

  afterEach(() => {
    usePanelStore.setState({ openInDock: originalOpenInDock });
  });

  it("hands the command to a live terminal that acks, without opening a tab", () => {
    const received: string[] = [];
    const listener = (e: any) => {
      received.push(e.detail.command);
      window.dispatchEvent(new Event(RUN_IN_TERMINAL_ACK_EVENT));
    };
    window.addEventListener(RUN_IN_TERMINAL_EVENT, listener);

    runInTerminal("$ bun test\n", "ppm");

    window.removeEventListener(RUN_IN_TERMINAL_EVENT, listener);
    expect(received).toEqual(["bun test"]);
    expect(opened).toHaveLength(0);
  });

  it("opens a terminal carrying pendingCommand when no terminal claims it", () => {
    runInTerminal("bun test", "ppm");

    expect(opened).toHaveLength(1);
    expect(opened[0].type).toBe("terminal");
    expect(opened[0].metadata).toMatchObject({ projectName: "ppm", pendingCommand: "bun test" });
  });

  it("ignores an empty command", () => {
    runInTerminal("   \n", "ppm");
    expect(opened).toHaveLength(0);
  });
});
