/**
 * A browser that connects after an extension last pushed must still get that extension's tree
 * rows and status-bar items: without a replay, every page load showed an empty tree ("No items")
 * and no status-bar item until the extension's next update.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { ExtensionUiReplay } from "../../../src/server/ws/extension-ui-replay.ts";
import { broadcastExtMsg, extensionWebSocket } from "../../../src/server/ws/extensions.ts";
import { contributionRegistry } from "../../../src/services/contribution-registry.ts";
import { extensionService } from "../../../src/services/extension.service.ts";
import type { ExtServerMsg, StatusBarItemMsg } from "../../../src/types/extension-messages.ts";

const item = (id: string, extensionId: string, text = id): StatusBarItemMsg =>
  ({ id, text, alignment: "left", priority: 0, extensionId });
const row = (id: string) => ({ id, label: id, collapsibleState: "none" as const });
const all = () => true;
const owner = (map: Record<string, string>) => (viewId: string) => map[viewId];

describe("ExtensionUiReplay", () => {
  it("keeps the last tree roots and status-bar items, and replays status bar then trees", () => {
    const replay = new ExtensionUiReplay();
    replay.record({ type: "tree:update", viewId: "a.tree", items: [row("old")] });
    replay.record({ type: "tree:update", viewId: "a.tree", items: [row("new")] });
    replay.record({ type: "statusbar:update", item: item("a-sb-1", "ext-a", "3 loose ends") });
    replay.record({ type: "statusbar:update", item: item("a-sb-1", "ext-a", "2 loose ends") });
    expect(replay.messagesFor({ isActive: all, viewOwner: owner({ "a.tree": "ext-a" }) })).toEqual([
      { type: "statusbar:update", item: item("a-sb-1", "ext-a", "2 loose ends") },
      { type: "tree:update", viewId: "a.tree", items: [row("new")] },
    ]);
  });

  it("ignores child updates, and forgets a refreshed view and a removed item", () => {
    const replay = new ExtensionUiReplay();
    replay.record({ type: "tree:update", viewId: "a.tree", items: [row("child")], parentId: "group" });
    expect(replay.messagesFor({ isActive: all, viewOwner: owner({ "a.tree": "ext-a" }) })).toEqual([]);
    replay.record({ type: "tree:update", viewId: "a.tree", items: [row("r")] });
    replay.record({ type: "tree:refresh", viewId: "a.tree" });
    replay.record({ type: "statusbar:update", item: item("a-sb-1", "ext-a") });
    replay.record({ type: "statusbar:remove", itemId: "a-sb-1" });
    expect(replay.messagesFor({ isActive: all, viewOwner: owner({ "a.tree": "ext-a" }) })).toEqual([]);
  });

  it("replays only active extensions' state", () => {
    const replay = new ExtensionUiReplay();
    replay.record({ type: "tree:update", viewId: "gone.tree", items: [row("x")] });
    replay.record({ type: "statusbar:update", item: item("gone-sb-1", "ext-gone") });
    replay.record({ type: "statusbar:update", item: item("a-sb-1", "ext-a") });
    const out = replay.messagesFor({ isActive: (id) => id === "ext-a", viewOwner: owner({ "gone.tree": "ext-gone" }) });
    expect(out).toEqual([{ type: "statusbar:update", item: item("a-sb-1", "ext-a") }]);
  });
});

describe("/ws/extensions on ready", () => {
  const activated = (extensionService as unknown as { activatedIds: Set<string> }).activatedIds;
  afterEach(() => {
    activated.delete("ext-replay");
    contributionRegistry.unregister("ext-replay");
    broadcastExtMsg({ type: "tree:refresh", viewId: "replay.tree" });
    broadcastExtMsg({ type: "statusbar:remove", itemId: "replay-sb-1" });
  });

  it("sends a late browser the contributions, then the status bar and tree pushed before it came", async () => {
    contributionRegistry.register("ext-replay", {
      commands: [{ command: "replay.cmd", title: "Cmd" }],
      views: { sidebar: [{ id: "replay.tree", name: "Replay", type: "tree" }] },
    });
    activated.add("ext-replay");
    // Pushed while no browser was connected.
    broadcastExtMsg({ type: "tree:update", viewId: "replay.tree", items: [row("Unfinished chats (3)")] });
    broadcastExtMsg({ type: "statusbar:update", item: item("replay-sb-1", "ext-replay", "9 loose ends") });

    const sent: ExtServerMsg[] = [];
    const ws = { data: { type: "extensions" }, send: (data: string) => { sent.push(JSON.parse(data)); } };
    extensionWebSocket.open(ws);
    await extensionWebSocket.message(ws, JSON.stringify({ type: "ready" }));
    extensionWebSocket.close(ws);

    expect(sent.map((m) => m.type)).toEqual(["contributions:update", "statusbar:update", "tree:update"]);
    expect(sent[1]).toEqual({ type: "statusbar:update", item: item("replay-sb-1", "ext-replay", "9 loose ends") });
    expect(sent[2]).toEqual({ type: "tree:update", viewId: "replay.tree", items: [row("Unfinished chats (3)")] });
  });
});
