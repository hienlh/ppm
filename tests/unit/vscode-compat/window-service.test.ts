import { describe, it, expect, beforeEach } from "bun:test";
import { WindowService } from "../../../packages/vscode-compat/src/window.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

function createMockRpc(): RpcClient & { requests: { method: string; params: unknown[] }[] } {
  const mock = {
    requests: [] as { method: string; params: unknown[] }[],
    async request<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
      mock.requests.push({ method, params });
      return undefined as T;
    },
    notify(_event: string, _data: unknown): void {},
  };
  return mock;
}

describe("WindowService", () => {
  let rpc: ReturnType<typeof createMockRpc>;
  let window: WindowService;

  beforeEach(() => {
    rpc = createMockRpc();
    window = new WindowService(rpc, "test-ext");
  });

  describe("_serializeTreeItems (via _getTreeChildren)", () => {
    it("serializes tree items using getTreeItem", async () => {
      const provider = {
        getChildren: (el?: string) => el ? [] : [{ id: "item1" }, { id: "item2" }],
        getTreeItem: (el: { id: string }) => ({
          id: el.id,
          label: `Label ${el.id}`,
          description: "desc",
          collapsibleState: "collapsed",
          contextValue: "item",
        }),
      };

      window.createTreeView("test-view", { treeDataProvider: provider });
      // Wait for async init
      await new Promise((r) => setTimeout(r, 50));

      const items = await (window as any)._getTreeChildren("test-view");
      expect(items.length).toBe(2);
      expect(items[0].label).toBe("Label item1");
      expect(items[0].description).toBe("desc");
      expect(items[0].collapsibleState).toBe("collapsed");
    });

    it("handles numeric collapsibleState enum values", async () => {
      const provider = {
        getChildren: () => [{ id: "a" }, { id: "b" }, { id: "c" }],
        getTreeItem: (el: { id: string }) => ({
          id: el.id,
          label: el.id,
          collapsibleState: el.id === "a" ? 0 : el.id === "b" ? 1 : 2,
        }),
      };

      window.createTreeView("enum-view", { treeDataProvider: provider });
      await new Promise((r) => setTimeout(r, 50));

      const items = await (window as any)._getTreeChildren("enum-view");
      expect(items[0].collapsibleState).toBe("none");
      expect(items[1].collapsibleState).toBe("collapsed");
      expect(items[2].collapsibleState).toBe("expanded");
    });

    it("returns empty for unknown viewId", async () => {
      const items = await (window as any)._getTreeChildren("nonexistent");
      expect(items).toEqual([]);
    });
  });

  describe("_deliverWebviewMessage", () => {
    it("fires onDidReceiveMessage for correct panel", () => {
      const panel = window.createWebviewPanel("test", "Title", -1) as any;
      const received: unknown[] = [];
      panel.webview.onDidReceiveMessage((msg: unknown) => received.push(msg));

      // Find the panelId from RPC calls
      const createCall = rpc.requests.find((r) => r.method === "window:webview:create");
      const panelId = createCall!.params[0] as string;

      const delivered = (window as any)._deliverWebviewMessage(panelId, { type: "test", data: 42 });

      expect(delivered).toBe(true);
      expect(received).toEqual([{ type: "test", data: 42 }]);
    });

    it("returns false for unknown panelId", () => {
      const result = (window as any)._deliverWebviewMessage("nonexistent", {});
      expect(result).toBe(false);
    });

    it("cleans up emitter after panel dispose", () => {
      const panel = window.createWebviewPanel("test", "Title", -1) as any;
      const createCall = rpc.requests.find((r) => r.method === "window:webview:create");
      const panelId = createCall!.params[0] as string;

      panel.dispose();

      const result = (window as any)._deliverWebviewMessage(panelId, {});
      expect(result).toBe(false);
    });
  });

  describe("createStatusBarItem", () => {
    it("generates unique IDs with monotonic counter", () => {
      const item1 = window.createStatusBarItem();
      const item2 = window.createStatusBarItem();

      item1.text = "Item 1";
      item1.show();
      item2.text = "Item 2";
      item2.show();

      const ids = rpc.requests
        .filter((r) => r.method === "window:statusbar:update")
        .map((r) => (r.params[0] as any).id);

      expect(ids.length).toBe(2);
      expect(ids[0]).not.toBe(ids[1]);
      // Both should use monotonic counter, not Date.now()
      expect(ids[0]).toMatch(/^test-ext-sb-\d+$/);
      expect(ids[1]).toMatch(/^test-ext-sb-\d+$/);
    });
  });

  describe("createWebviewPanel", () => {
    it("sends create RPC with correct args", () => {
      window.createWebviewPanel("viewType", "Panel Title", -1);

      const call = rpc.requests.find((r) => r.method === "window:webview:create");
      expect(call).toBeTruthy();
      expect(call!.params[1]).toBe("test-ext"); // extensionId
      expect(call!.params[2]).toBe("viewType");
      expect(call!.params[3]).toBe("Panel Title");
    });

    it("html setter sends RPC", () => {
      const panel = window.createWebviewPanel("vt", "Title", -1) as any;
      panel.webview.html = "<h1>Hello</h1>";

      const call = rpc.requests.find((r) => r.method === "window:webview:html");
      expect(call).toBeTruthy();
      expect(call!.params[1]).toBe("<h1>Hello</h1>");
    });
  });
});
