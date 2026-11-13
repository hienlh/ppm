/**
 * Two ways the window API used to lose: a UI update whose RPC failed left an unhandled
 * rejection, which ends the shared extension host (and every extension in it); and a prompt gave
 * up at the RPC default of 10 s while the browser still waited 30 s for the person's click.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { PROMPT_REPLY_WAIT_MS, WindowService } from "../../../packages/vscode-compat/src/window.ts";
import { BROWSER_PROMPT_TIMEOUT_MS } from "../../../src/server/ws/extensions.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
process.on("unhandledRejection", onUnhandled);
afterEach(() => { unhandled.length = 0; });

/** Every request fails, the way a call does when the main thread is too busy to answer in time. */
function failingRpc() {
  const timed: Array<{ method: string; timeoutMs: number }> = [];
  const rpc: RpcClient = {
    request: async (method: string) => { throw new Error(`RPC timeout: ${method} (10000ms)`); },
    requestWithTimeout: async <T>(method: string, timeoutMs: number) => { timed.push({ method, timeoutMs }); return undefined as T; },
    notify: () => {},
  };
  return { rpc, timed };
}

describe("UI updates nobody awaits", () => {
  it("leave no unhandled rejection when their RPC fails", async () => {
    const window = new WindowService(failingRpc().rpc, "probe");
    const item = window.createStatusBarItem();
    item.text = "3 loose ends";
    item.show();
    item.hide();
    item.dispose();
    const panel = window.createWebviewPanel("probe.panel", "Probe", 1 as never) as { webview: { html: string }; dispose(): void };
    panel.webview.html = "<p>hi</p>";
    panel.dispose();
    const tree = window.createTreeView("probe.tree", { treeDataProvider: { getChildren: () => ["a"], getTreeItem: (a: string) => ({ label: a }) } });
    await Bun.sleep(30);
    tree.dispose();
    await Bun.sleep(30);
    expect(unhandled).toEqual([]);
  });
});

describe("prompts", () => {
  // A message prompt waits the browser's 30 s plus a margin; a quick pick or input box waits the
  // 600 s the browser gives those dialogs (`EXTENSION_DIALOG_TIMEOUT_MS`), so a slow answer still lands.
  it("wait longer than the browser waits for the person", async () => {
    expect(PROMPT_REPLY_WAIT_MS).toBeGreaterThan(BROWSER_PROMPT_TIMEOUT_MS);
    const { rpc, timed } = failingRpc();
    const window = new WindowService(rpc, "probe");
    await window.showInformationMessage("Undo?", "Undo");
    await window.showWarningMessage("Switch zone?", "Switch", "Keep");
    await window.showErrorMessage("Failed", "Retry");
    await window.showQuickPick(["afternoon", "tomorrow"]);
    await window.showInputBox({ prompt: "Note" });
    expect(timed).toEqual([
      { method: "window:showMessage", timeoutMs: PROMPT_REPLY_WAIT_MS },
      { method: "window:showMessage", timeoutMs: PROMPT_REPLY_WAIT_MS },
      { method: "window:showMessage", timeoutMs: PROMPT_REPLY_WAIT_MS },
      { method: "window:showQuickPick", timeoutMs: 600_000 },
      { method: "window:showInputBox", timeoutMs: 600_000 },
    ]);
  });
});
