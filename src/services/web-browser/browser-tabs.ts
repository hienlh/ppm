/**
 * The page targets of PPM's Chrome as tabs: which exist, what they show, which session to send
 * page commands on, and the tab limit.
 *
 * Every page is attached through browser-level auto-attach with `waitForDebuggerOnStart`, so a
 * popup is set up (viewport, file-chooser interception, the sound tap) before its first script
 * runs, and only then released with `Runtime.runIfWaitingForDebugger`.
 */
import { EventEmitter } from "node:events";
import type { CdpConnection, CdpEvent } from "./cdp-connection.ts";
import type { WebBrowserTabInfo } from "../../shared/web-browser-protocol.ts";

export interface TabRecord extends WebBrowserTabInfo {
  sessionId: string;
}

export interface BrowserTabsOptions {
  maxTabs: () => number;
  /** Runs on every new page session before the page is released. */
  setupPage: (sessionId: string, targetId: string) => Promise<void>;
}

/** Events: "changed" (), "limit" (url), "closed" (tabId). */
export class BrowserTabs extends EventEmitter {
  private readonly tabs = new Map<string, TabRecord>();
  private readonly aiTargets = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly cdp: CdpConnection, private readonly opts: BrowserTabsOptions) {
    super();
  }

  async start(): Promise<void> {
    this.unsubscribe = this.cdp.onEvent((e) => void this.onEvent(e));
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  stop(): void {
    this.unsubscribe?.();
    this.tabs.clear();
  }

  list(): WebBrowserTabInfo[] {
    return [...this.tabs.values()].map(({ sessionId: _s, ...info }) => info);
  }

  get(tabId: string): TabRecord | undefined {
    return this.tabs.get(tabId);
  }

  get count(): number {
    return this.tabs.size;
  }

  /** Opens a tab; null when the limit is reached. */
  async open(url: string, opts: { ai?: boolean } = {}): Promise<string | null> {
    if (this.tabs.size >= this.opts.maxTabs()) {
      this.emit("limit", url);
      return null;
    }
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    if (opts.ai) this.aiTargets.add(targetId);
    await this.waitFor(targetId);
    if (url && url !== "about:blank") await this.navigate(targetId, url);
    return targetId;
  }

  async close(tabId: string): Promise<void> {
    await this.cdp.send("Target.closeTarget", { targetId: tabId }).catch(() => {});
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("no such tab");
    await this.cdp.send("Page.navigate", { url }, tab.sessionId);
  }

  /** Refreshes back/forward availability from the page's history. */
  async refreshHistory(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    try {
      const h = await this.cdp.send<{ currentIndex: number; entries: unknown[] }>("Page.getNavigationHistory", {}, tab.sessionId);
      tab.canBack = h.currentIndex > 0;
      tab.canForward = h.currentIndex < h.entries.length - 1;
      this.emit("changed");
    } catch {}
  }

  private async waitFor(targetId: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.tabs.has(targetId) && Date.now() < deadline) await Bun.sleep(20);
    if (!this.tabs.has(targetId)) throw new Error("the new tab did not attach");
  }

  private async onEvent(e: CdpEvent): Promise<void> {
    const p = e.params as Record<string, any>;
    if (e.method === "Target.attachedToTarget" && !e.sessionId) {
      const info = p.targetInfo as { targetId: string; type: string; url: string; title: string; openerId?: string };
      const sessionId = p.sessionId as string;
      if (info.type !== "page") {
        await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
        return;
      }
      if (this.tabs.size >= this.opts.maxTabs()) {
        this.emit("limit", info.url);
        await this.cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
        return;
      }
      const ai = this.aiTargets.has(info.targetId) || (!!info.openerId && !!this.tabs.get(info.openerId)?.ai);
      this.tabs.set(info.targetId, {
        id: info.targetId, url: info.url, title: info.title, loading: true, canBack: false, canForward: false, ai, sessionId,
      });
      try {
        await this.opts.setupPage(sessionId, info.targetId);
      } finally {
        await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      }
      this.emit("changed");
    } else if (e.method === "Target.targetInfoChanged") {
      const info = p.targetInfo as { targetId: string; url: string; title: string };
      const tab = this.tabs.get(info.targetId);
      if (tab && (tab.url !== info.url || tab.title !== info.title)) {
        tab.url = info.url;
        tab.title = info.title;
        this.emit("changed");
        void this.refreshHistory(info.targetId);
      }
    } else if (e.method === "Target.targetDestroyed" || e.method === "Target.detachedFromTarget") {
      const id = (p.targetId as string | undefined) ?? [...this.tabs.values()].find((t) => t.sessionId === p.sessionId)?.id;
      if (id && this.tabs.delete(id)) {
        this.aiTargets.delete(id);
        this.emit("closed", id);
        this.emit("changed");
      }
    } else if ((e.method === "Page.frameStartedLoading" || e.method === "Page.frameStoppedLoading") && e.sessionId) {
      const tab = [...this.tabs.values()].find((t) => t.sessionId === e.sessionId);
      if (tab && p.frameId === tab.id) {
        tab.loading = e.method === "Page.frameStartedLoading";
        this.emit("changed");
      }
    }
  }
}
