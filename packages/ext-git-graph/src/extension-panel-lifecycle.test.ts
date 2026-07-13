import { describe, it, expect, afterEach } from "bun:test";
import { activate } from "./extension.ts";
import type { ExtensionContext } from "@ppm/vscode-compat";

/**
 * Panel lifecycle tests: one live panel per project.
 * Opening git graph for project B must not dispose project A's panel;
 * reopening the same project disposes and recreates only that panel.
 */

interface FakePanel {
  viewType: string;
  title: string;
  projectPath?: string;
  disposed: boolean;
  webview: {
    html: string;
    onDidReceiveMessage: (listener: (msg: unknown) => void) => { dispose(): void };
    postMessage(message: unknown): Promise<boolean>;
  };
  onDidDispose: (listener: () => void) => { dispose(): void };
  dispose(): void;
}

function createFakeVscode() {
  const panels: FakePanel[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();

  const vscode = {
    commands: {
      registerCommand(command: string, callback: (...args: unknown[]) => unknown) {
        commands.set(command, callback);
        return { dispose() {} };
      },
    },
    window: {
      async showErrorMessage() { return undefined; },
      async showInformationMessage() { return undefined; },
      async openTab() {},
      async switchProject() {},
      createWebviewPanel(viewType: string, title: string, _showOptions: unknown, options?: { projectPath?: string }) {
        const disposeListeners: (() => void)[] = [];
        const panel: FakePanel = {
          viewType,
          title,
          projectPath: options?.projectPath,
          disposed: false,
          webview: {
            html: "",
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
          },
          onDidDispose(listener: () => void) {
            disposeListeners.push(listener);
            return { dispose() {} };
          },
          dispose() {
            if (panel.disposed) return;
            panel.disposed = true;
            for (const l of disposeListeners) l();
          },
        };
        panels.push(panel);
        return panel;
      },
    },
    process: {
      async spawn() { return { stdout: "", stderr: "", exitCode: 0 }; },
    },
    ViewColumn: { Active: 1 },
  };

  return { vscode, panels, commands };
}

function createFakeContext(): ExtensionContext {
  const state = new Map<string, unknown>();
  return {
    subscriptions: [],
    globalState: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { state.set(key, value); },
    },
  } as unknown as ExtensionContext;
}

describe("git-graph extension: per-project panel lifecycle", () => {
  const openedPanels: FakePanel[] = [];

  afterEach(() => {
    // Dispose all panels so uncommitted-poll intervals are cleared
    for (const p of openedPanels) p.dispose();
    openedPanels.length = 0;
  });

  async function setup() {
    const { vscode, panels, commands } = createFakeVscode();
    activate(createFakeContext(), vscode as never);
    const viewCommand = commands.get("git-graph.view")!;
    expect(viewCommand).toBeDefined();
    return {
      panels,
      open: async (path: string) => {
        await viewCommand(path);
        openedPanels.length = 0;
        openedPanels.push(...panels);
      },
    };
  }

  it("keeps project A's panel alive when project B opens git graph", async () => {
    const { panels, open } = await setup();
    await open("/repos/project-a");
    await open("/repos/project-b");

    expect(panels.length).toBe(2);
    expect(panels[0]!.disposed).toBe(false);
    expect(panels[1]!.disposed).toBe(false);
    expect(panels[0]!.projectPath).toBe("/repos/project-a");
    expect(panels[1]!.projectPath).toBe("/repos/project-b");
  });

  it("disposes and recreates the panel when the SAME project reopens", async () => {
    const { panels, open } = await setup();
    await open("/repos/project-a");
    await open("/repos/project-a");

    expect(panels.length).toBe(2);
    expect(panels[0]!.disposed).toBe(true);
    expect(panels[1]!.disposed).toBe(false);
  });

  it("reopening project A leaves project B's panel untouched", async () => {
    const { panels, open } = await setup();
    await open("/repos/project-a");
    await open("/repos/project-b");
    await open("/repos/project-a");

    expect(panels.length).toBe(3);
    expect(panels[0]!.disposed).toBe(true); // old A — recreated
    expect(panels[1]!.disposed).toBe(false); // B untouched
    expect(panels[2]!.disposed).toBe(false); // new A
  });

  it("browser-initiated dispose clears only that project's slot — reopen creates fresh panel", async () => {
    const { panels, open } = await setup();
    await open("/repos/project-a");
    await open("/repos/project-b");

    panels[0]!.dispose(); // browser closed project A's tab
    await open("/repos/project-a");

    expect(panels.length).toBe(3);
    expect(panels[1]!.disposed).toBe(false); // B still alive
    expect(panels[2]!.disposed).toBe(false); // fresh A panel
    expect(panels[2]!.projectPath).toBe("/repos/project-a");
  });

  it("passes projectPath through createWebviewPanel options", async () => {
    const { panels, open } = await setup();
    await open("/repos/my-app");

    expect(panels[0]!.projectPath).toBe("/repos/my-app");
    expect(panels[0]!.title).toContain("my-app");
  });
});
