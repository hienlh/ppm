/**
 * The commands the blame hover's buttons reach.
 *
 * They are registered on Monaco's standalone `CommandsRegistry`, which is
 * global to the page — so any markdown anywhere could name these ids, not just
 * the hover that was built with them in mind. Hence the argument checks, and
 * hence these tests: an extension view command reads a falsy project path as
 * "resolve the project yourself", so a link with a missing path would open some
 * *other* project's history while looking like it worked.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type * as MonacoType from "monaco-editor";

// The module dispatches a DOM event, and bun's test environment has no window.
// Stubbed before the import, which is how the other web tests here do it.
const eventBus = new EventTarget();
(globalThis as unknown as { window: EventTarget }).window = eventBus;

const { _resetBlameHoverCommands, registerBlameHoverCommands } = await import(
  "../../../src/web/lib/blame-hover-commands.ts"
);
const { BLAME_HOVER_COMMANDS } = await import("../../../src/web/lib/blame-hover.ts");

type Handler = (accessor: unknown, ...args: unknown[]) => void;

function fakeMonaco() {
  const handlers = new Map<string, Handler>();
  const monaco = {
    editor: {
      registerCommand: (id: string, handler: Handler) => {
        handlers.set(id, handler);
        return { dispose: () => handlers.delete(id) };
      },
    },
  } as unknown as typeof MonacoType;
  return { monaco, handlers };
}

/** Every `ext:command:execute` the handlers dispatched. */
let dispatched: Array<{ command: string; args: unknown[] }>;
let listener: (e: Event) => void;

beforeEach(() => {
  _resetBlameHoverCommands();
  dispatched = [];
  listener = (e: Event) => dispatched.push((e as CustomEvent).detail);
  eventBus.addEventListener("ext:command:execute", listener);
});

afterEach(() => {
  eventBus.removeEventListener("ext:command:execute", listener);
});

describe("registerBlameHoverCommands", () => {
  it("registers exactly the commands the hover's links name", () => {
    // A link with no command behind it is a button that does nothing.
    const { monaco, handlers } = fakeMonaco();

    registerBlameHoverCommands(monaco);

    expect([...handlers.keys()].sort()).toEqual([...BLAME_HOVER_COMMANDS].sort());
  });

  it("does nothing on a second call", () => {
    // The registry is global to the page, and every editor mount calls this.
    const first = fakeMonaco();
    const second = fakeMonaco();

    registerBlameHoverCommands(first.monaco);
    registerBlameHoverCommands(second.monaco);

    expect(second.handlers.size).toBe(0);
  });
});

describe("the extension hand-offs", () => {
  // Registration is idempotent per page, so it happens once per test and the
  // handlers are reused — registering again inside `run` would silently be a
  // no-op and leave nothing to call.
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    const fake = fakeMonaco();
    handlers = fake.handlers;
    registerBlameHoverCommands(fake.monaco);
  });

  function run(id: string, ...args: unknown[]) {
    handlers.get(id)!(null, ...args);
  }

  it("opens the file's history through the Git Graph extension", () => {
    run("ppm.blame.fileHistory", "/repo", "src/a.ts");

    expect(dispatched).toEqual([{ command: "git-graph.fileHistory", args: ["/repo", "src/a.ts"] }]);
  });

  it("opens the blame view with the file as the second argument", () => {
    // Which is the argument `git-graph.blame` already accepts.
    run("ppm.blame.blameFile", "/repo", "src/a.ts");

    expect(dispatched).toEqual([{ command: "git-graph.blame", args: ["/repo", "src/a.ts"] }]);
  });

  it("opens the graph with just the project", () => {
    run("ppm.blame.showInGraph", "/repo");

    expect(dispatched).toEqual([{ command: "git-graph.view", args: ["/repo"] }]);
  });

  it("dispatches nothing without a project path", () => {
    run("ppm.blame.fileHistory", "", "src/a.ts");
    run("ppm.blame.blameFile", undefined, "src/a.ts");
    run("ppm.blame.showInGraph", "");

    expect(dispatched).toEqual([]);
  });

  it("dispatches nothing without a file path", () => {
    run("ppm.blame.fileHistory", "/repo", "");
    run("ppm.blame.blameFile", "/repo", 42);

    expect(dispatched).toEqual([]);
  });
});

describe("copying the sha", () => {
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    const fake = fakeMonaco();
    handlers = fake.handlers;
    registerBlameHoverCommands(fake.monaco);
  });

  function run(...args: unknown[]) {
    handlers.get("ppm.blame.copySha")!(null, ...args);
  }

  it("refuses anything that is not a hash", () => {
    // The registry is global; this handler's argument is not necessarily ours.
    const copied: string[] = [];
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
      configurable: true,
    });

    run("not-a-hash");
    run("");
    run(42);
    run("../../etc/passwd");

    Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
    expect(copied).toEqual([]);
  });
});
