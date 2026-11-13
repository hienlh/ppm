import type { ExtServerMsg, StatusBarItemMsg, TreeItemMsg } from "../../types/extension-messages.ts";

/**
 * The extension UI a browser can only learn from a broadcast: each tree view's root items and
 * each status-bar item. A browser that connects (or reloads) after an extension last pushed would
 * otherwise show an empty tree ("No items") and no status-bar item until that extension's next
 * update, which can be hours away for an item that only changes when its text does.
 *
 * Fed with every broadcast, read on `ready`. Only what the extension last said is kept, so it
 * costs one entry per view and per status-bar item.
 */
export class ExtensionUiReplay {
  private trees = new Map<string, TreeItemMsg[]>();
  private statusItems = new Map<string, StatusBarItemMsg>();

  /** Note what a broadcast changed. Child updates (expand) go to one browser, never here. */
  record(msg: ExtServerMsg): void {
    switch (msg.type) {
      case "tree:update":
        if (!msg.parentId) this.trees.set(msg.viewId, msg.items);
        break;
      case "tree:refresh":
        // The view was disposed: a browser connecting now must not get its old rows.
        this.trees.delete(msg.viewId);
        break;
      case "statusbar:update":
        this.statusItems.set(msg.item.id, msg.item);
        break;
      case "statusbar:remove":
        this.statusItems.delete(msg.itemId);
        break;
    }
  }

  /**
   * The messages that bring a new browser up to date: status-bar items first, then tree roots.
   * Only an active extension's state is replayed, so an extension whose host stopped (or that was
   * disabled without a chance to clear its items) leaves nothing behind on a fresh page.
   */
  messagesFor(opts: {
    isActive: (extensionId: string) => boolean;
    /** The active extension that contributes a view, or undefined when none does. */
    viewOwner: (viewId: string) => string | undefined;
  }): ExtServerMsg[] {
    const out: ExtServerMsg[] = [];
    for (const item of this.statusItems.values()) {
      if (item.extensionId && opts.isActive(item.extensionId)) out.push({ type: "statusbar:update", item });
    }
    for (const [viewId, items] of this.trees) {
      const owner = opts.viewOwner(viewId);
      if (owner && opts.isActive(owner)) out.push({ type: "tree:update", viewId, items });
    }
    return out;
  }

  clear(): void {
    this.trees.clear();
    this.statusItems.clear();
  }
}
