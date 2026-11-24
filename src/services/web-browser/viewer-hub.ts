/**
 * Viewers of PPM's browser (one per open window or phone tab) and the one of them in control.
 *
 * The last viewer to connect, or to press "Use here", controls: it alone gets pictures and its
 * input and viewport reach the page. Others keep tabs and status, and see who has it. Two
 * viewports fighting over one page would otherwise relayout it on every message.
 */
import type { WebBrowserClientMessage, WebBrowserServerMessage } from "../../shared/web-browser-protocol.ts";
import { InputBridge, type Viewport } from "./input-bridge.ts";
import { ScreencastPacer } from "./screencast-pacer.ts";
import { applyViewport, DEFAULT_VIEWPORT } from "./page-viewport.ts";
import { resolveAddress } from "./address-bar.ts";
import { webBrowserHost, type WebBrowserHost } from "./browser-host.ts";
import { createLogger } from "../logger.ts";
import { installPageFeatures } from "./page-features.ts";
import { installAudioRelay } from "./audio/audio-relay.ts";

const log = createLogger("web-browser");

export interface Viewer {
  id: string;
  send(msg: WebBrowserServerMessage): void;
  sendBinary(bytes: Uint8Array): void;
}

/** Handlers other modules add for message types this file does not own (files, clipboard, dialogs, AI). */
export type ExtraHandler = (msg: WebBrowserClientMessage, viewer: Viewer, hub: ViewerHub) => Promise<void> | void;

const INPUT_TYPES = new Set(["pointer", "wheel", "key", "text", "compose", "touch", "releaseAll"]);

export class ViewerHub {
  private readonly viewers = new Map<string, Viewer>();
  private controllerId: string | null = null;
  viewport: Viewport = { ...DEFAULT_VIEWPORT };
  private pacer: ScreencastPacer | null = null;
  private input: InputBridge | null = null;
  private readonly extra = new Map<string, ExtraHandler>();
  private streamedTabId: string | null = null;

  constructor(readonly host: WebBrowserHost) {
    host.on("state", (state, message) => {
      if (state !== "running") this.dropStream();
      this.broadcast(this.status(message));
      if (state === "running") void this.restream();
    });
    host.on("tabs", () => {
      this.broadcast(this.tabsMessage());
      // The tab on screen was closed: show the one the host fell back to.
      if (this.controller && host.activeTabId !== this.streamedTabId) void this.restream();
    });
    host.on("blocked", (b: { url: string; reason: never }) => this.broadcast({ type: "blocked", url: b.url, reason: b.reason }));
    host.addPageSetup(async (sessionId) => {
      const cdp = host.cdp;
      if (!cdp) return;
      await cdp.send("Page.enable", {}, sessionId).catch(() => {});
      await applyViewport(cdp, sessionId, this.viewport);
    });
  }

  handle(type: string, handler: ExtraHandler): void {
    this.extra.set(type, handler);
  }

  get controller(): Viewer | null {
    return this.controllerId ? this.viewers.get(this.controllerId) ?? null : null;
  }

  status(message?: string): WebBrowserServerMessage {
    const h = this.host;
    return { type: "status", state: h.state, ramMB: null, tabCount: h.tabs?.count ?? 0, idleStopAt: h.idleStopAt(), ...(message ? { message } : {}) };
  }

  tabsMessage(): WebBrowserServerMessage {
    return { type: "tabs", list: this.host.tabs?.list() ?? [], activeTabId: this.host.activeTabId };
  }

  broadcast(msg: WebBrowserServerMessage): void {
    for (const v of this.viewers.values()) {
      try { v.send(msg); } catch {}
    }
  }

  /** A viewer authenticated; it takes control. */
  add(viewer: Viewer): void {
    this.viewers.set(viewer.id, viewer);
    const s = this.host.settings();
    viewer.send({ type: "hello", tabs: this.host.tabs?.list() ?? [], activeTabId: this.host.activeTabId, limits: { maxTabs: s.maxTabs, idleStopMinutes: s.idleStopMinutes, fpsCap: s.fpsCap, audio: s.audio } });
    viewer.send(this.status());
    this.takeControl(viewer.id);
  }

  remove(viewerId: string): void {
    this.viewers.delete(viewerId);
    this.host.setViewerVisible(viewerId, false);
    if (this.controllerId === viewerId) {
      this.controllerId = null;
      this.dropStream();
    }
  }

  takeControl(viewerId: string): void {
    this.controllerId = viewerId;
    for (const v of this.viewers.values()) v.send({ type: "controller", isYou: v.id === viewerId });
    void this.restream();
  }

  /** The tab every controlling viewer sees; switching it restarts the picture stream. */
  async activate(tabId: string): Promise<void> {
    if (!this.host.tabs?.get(tabId)) return;
    this.host.activeTabId = tabId;
    await this.host.cdp?.send("Target.activateTarget", { targetId: tabId }).catch(() => {});
    this.broadcast(this.tabsMessage());
    await this.restream();
  }

  private dropStream(): void {
    this.streamedTabId = null;
    this.pacer?.dispose();
    this.pacer = null;
    this.input = null;
  }

  private async restream(): Promise<void> {
    const cdp = this.host.cdp;
    const controller = this.controller;
    const tab = this.host.activeTabId ? this.host.tabs?.get(this.host.activeTabId) : undefined;
    if (!cdp || !controller || !tab) return this.dropStream();
    if (!this.pacer) {
      this.pacer = new ScreencastPacer(cdp, { sendBinary: (b) => this.controller?.sendBinary(b) }, () => this.host.settings());
      this.input = new InputBridge(cdp);
    }
    this.streamedTabId = tab.id;
    await applyViewport(cdp, tab.sessionId, this.viewport);
    await this.pacer.start(tab.sessionId, this.viewport);
  }

  async onMessage(viewer: Viewer, msg: WebBrowserClientMessage): Promise<void> {
    const isController = viewer.id === this.controllerId;
    if (msg.type === "visibility") return this.host.setViewerVisible(viewer.id, msg.visible);
    if (msg.type === "takeover") return this.takeControl(viewer.id);
    if (!isController) return; // a viewer that lost control may still send a stray event
    const tabs = this.host.tabs;
    const active = this.host.activeTabId ? tabs?.get(this.host.activeTabId) : undefined;
    if (INPUT_TYPES.has(msg.type)) {
      this.host.touchInput();
      if (active && this.input) await this.input.send(msg, this.viewport, active.sessionId);
      return;
    }
    switch (msg.type) {
      case "frame.ack":
        return this.pacer?.ack(msg.seq);
      case "viewport":
        this.viewport = { cssWidth: msg.cssWidth, cssHeight: msg.cssHeight, dpr: msg.dpr, mobile: msg.mobile };
        return this.restream();
      case "navigate": {
        this.host.touchInput();
        const r = resolveAddress(msg.url);
        if (!r.ok) return viewer.send({ type: "blocked", url: msg.url, reason: "scheme" });
        if (active) await tabs?.navigate(active.id, r.url).catch((e) => log.warn(`navigate failed: ${e?.message ?? e}`));
        return;
      }
      case "back": case "forward": {
        if (!active || !this.host.cdp) return;
        const h = await this.host.cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, active.sessionId).catch(() => null);
        const entry = h?.entries[h.currentIndex + (msg.type === "back" ? -1 : 1)];
        if (entry) await this.host.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, active.sessionId).catch(() => {});
        return;
      }
      case "reload":
        if (active) await this.host.cdp?.send("Page.reload", {}, active.sessionId).catch(() => {});
        return;
      case "stop":
        if (active) await this.host.cdp?.send("Page.stopLoading", {}, active.sessionId).catch(() => {});
        return;
      case "tab.open": {
        const r = msg.url ? resolveAddress(msg.url) : { ok: true as const, url: "about:blank" };
        if (!r.ok) return viewer.send({ type: "blocked", url: msg.url ?? "", reason: "scheme" });
        const id = await tabs?.open(r.url).catch(() => null);
        if (id) await this.activate(id);
        return;
      }
      case "tab.close":
        await tabs?.close(msg.tabId);
        if (this.host.activeTabId === msg.tabId || !this.host.activeTabId) {
          const next = tabs?.list().find((t) => t.id !== msg.tabId);
          if (next) await this.activate(next.id);
        }
        return;
      case "tab.activate":
        return this.activate(msg.tabId);
      default: {
        const handler = this.extra.get(msg.type);
        if (handler) await handler(msg, viewer, this);
      }
    }
  }
}

export const viewerHub = new ViewerHub(webBrowserHost);
installPageFeatures(viewerHub);
installAudioRelay(viewerHub);
