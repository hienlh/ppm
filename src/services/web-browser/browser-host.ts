/**
 * PPM's one browser: the egress guard, the Chrome behind it, its tabs, who is watching, and when
 * it stops. Viewers (WS), AI tools and routes all go through `webBrowserHost`.
 *
 * Start order matters for safety: the SOCKS5 guard runs first, Chrome is pointed at it, and a
 * canary request must arrive at the guard before Chrome counts as running — a machine policy
 * that overrides `--proxy-server` would otherwise send every page straight to the network.
 */
import { EventEmitter } from "node:events";
import { configService } from "../config.service.ts";
import { parseWebBrowserSettings, type WebBrowserSettings } from "../../shared/web-browser-settings.ts";
import type { WebBrowserState } from "../../shared/web-browser-protocol.ts";
import { isWebBrowserAllowedByEnv } from "./web-browser-flag.ts";
import { installHint, pickBrowser } from "./chrome-locate.ts";
import { preferredTransport } from "./chrome-launch-args.ts";
import { freeLoopbackPort, killOrphanChrome, type RunningChrome, startChrome, stopChrome } from "./chrome-process.ts";
import { BrowserTabs } from "./browser-tabs.ts";
import { idleDeadline, shouldStopForIdle } from "./browser-idle.ts";
import { EGRESS_CANARY_HOST, type EgressGuard, startEgressGuard } from "./egress/egress-process.ts";
import { ppmOwnPorts } from "./ppm-own-ports.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("web-browser");
const CANARY_TIMEOUT_MS = 6000;
const IDLE_CHECK_MS = 30_000;

export type PageSetupHook = (sessionId: string, targetId: string, host: WebBrowserHost) => Promise<void>;

export class WebBrowserUnavailableError extends Error {
  constructor(readonly code: "disabled" | "not-decided" | "no-browser" | "proxy-bypassed" | "start-failed", message: string) {
    super(message);
  }
}

/** Events: "state" (state, message?), "tabs" (), "blocked" ({url, reason}), "stopped" (). */
/**
 * What the egress guard is told: the user's two switches (localhost, LAN — both on by default,
 * cards dccf1ef2 and 2b73ffa8) and the ports that stay closed whatever they say: PPM's own and
 * the DevTools port, which would hand a page the whole browser.
 */
export function egressOptionsFor(settings: Pick<WebBrowserSettings, "allowLocalhost" | "allowLan">, ownPorts: number[], devtoolsPort?: number) {
  const blockedLocalPorts = [...ownPorts];
  if (devtoolsPort) blockedLocalPorts.push(devtoolsPort);
  return { allowLocalhost: settings.allowLocalhost, allowLan: settings.allowLan, blockedLocalPorts };
}

export class WebBrowserHost extends EventEmitter {
  state: WebBrowserState = "stopped";
  chrome: RunningChrome | null = null;
  tabs: BrowserTabs | null = null;
  activeTabId: string | null = null;
  private egress: EgressGuard | null = null;
  private starting: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly setupHooks: PageSetupHook[] = [];
  private readonly visibleViewers = new Set<string>();
  private lastVisibleAt = 0;
  private lastInputAt = 0;
  private lastAiAt = 0;

  settings(): WebBrowserSettings {
    return parseWebBrowserSettings(configService.get("web_browser"));
  }

  /** Called for every page before its first script runs. */
  addPageSetup(hook: PageSetupHook): void {
    this.setupHooks.push(hook);
  }

  get cdp() {
    return this.chrome?.cdp ?? null;
  }

  ensureStarted(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private setState(state: WebBrowserState, message?: string): void {
    this.state = state;
    this.emit("state", state, message);
  }

  private async start(): Promise<void> {
    const settings = this.settings();
    if (!isWebBrowserAllowedByEnv()) throw new WebBrowserUnavailableError("disabled", "WEB_BROWSER_ENABLED=0 turns the browser off on this host.");
    if (settings.enabled !== true) {
      throw new WebBrowserUnavailableError(settings.enabled === false ? "disabled" : "not-decided", "The web browser is turned off in Settings.");
    }
    const browser = await pickBrowser(settings.browserPath);
    if (!browser) throw new WebBrowserUnavailableError("no-browser", `No Chrome or Edge found. ${installHint()}`);
    this.setState("starting");
    try {
      await killOrphanChrome();
      const transport = preferredTransport();
      const devtoolsPort = transport === "port" ? await freeLoopbackPort() : undefined;
      this.egress = await startEgressGuard(this.egressOptions(settings, devtoolsPort));
      this.egress.onBlocked((b) => this.emit("blocked", { url: `${b.host}:${b.port}`, reason: b.reason }));
      const canary = new Promise<boolean>((resolve) => {
        const off = this.egress!.onCanary(() => { off(); resolve(true); });
        setTimeout(() => { off(); resolve(false); }, CANARY_TIMEOUT_MS);
      });
      this.chrome = await startChrome({ executable: browser.path, egressPort: this.egress.port, transport, devtoolsPort, audio: settings.audio });
      log.info(`Browser started: ${browser.name} ${browser.version} (PID ${this.chrome.pid}, CDP over ${transport})`);
      void this.chrome.exited.then(() => this.onChromeExit());
      this.tabs = new BrowserTabs(this.chrome.cdp, {
        maxTabs: () => this.settings().maxTabs,
        setupPage: (sessionId, targetId) => this.runSetupHooks(sessionId, targetId),
      });
      this.tabs.on("changed", () => this.emit("tabs"));
      this.tabs.on("limit", (url: string) => this.emit("blocked", { url, reason: "tab-limit" }));
      this.tabs.on("closed", (id: string) => { if (this.activeTabId === id) this.activeTabId = this.tabs?.list()[0]?.id ?? null; });
      await this.tabs.start();
      // Chrome opens with the `about:blank` page of its command line; reuse it for the canary.
      for (let i = 0; i < 50 && this.tabs.count === 0; i++) await Bun.sleep(20);
      let probe = this.tabs.list()[0]?.id ?? null;
      if (probe) await this.tabs.navigate(probe, `http://${EGRESS_CANARY_HOST}/`);
      else probe = await this.tabs.open(`http://${EGRESS_CANARY_HOST}/`);
      if (!(await canary)) {
        throw new WebBrowserUnavailableError("proxy-bypassed", "Chrome did not use PPM's network guard (a machine policy may override its proxy), so it was stopped.");
      }
      if (probe) await this.tabs.navigate(probe, "about:blank");
      this.activeTabId = probe;
      this.touchInput();
      this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
      this.setState("running");
    } catch (error) {
      log.error(`Browser failed to start: ${(error as Error)?.message ?? error}`);
      await this.teardown();
      this.setState("crashed", (error as Error)?.message);
      throw error instanceof WebBrowserUnavailableError ? error : new WebBrowserUnavailableError("start-failed", String((error as Error)?.message ?? error));
    }
  }

  private egressOptions(settings: WebBrowserSettings, devtoolsPort?: number) {
    return egressOptionsFor(settings, ppmOwnPorts(), devtoolsPort);
  }

  /** Settings changed: tell the guard now; tab limits are read on each new tab. */
  applySettings(): void {
    if (!this.egress) return;
    this.egress.update(this.egressOptions(this.settings(), this.chrome?.devtoolsPort ?? undefined));
  }

  private async runSetupHooks(sessionId: string, targetId: string): Promise<void> {
    for (const hook of this.setupHooks) {
      try { await hook(sessionId, targetId, this); } catch (error) {
        log.warn(`page setup failed: ${(error as Error)?.message ?? error}`);
      }
    }
  }

  /** A viewer became visible or hidden; hidden or disconnected viewers keep nothing alive. */
  setViewerVisible(viewerId: string, visible: boolean): void {
    if (visible) this.visibleViewers.add(viewerId);
    else this.visibleViewers.delete(viewerId);
    this.lastVisibleAt = Date.now();
  }

  touchInput(): void {
    this.lastInputAt = Date.now();
  }

  touchAi(): void {
    this.lastAiAt = Date.now();
  }

  idleStopAt(): number | null {
    if (this.state !== "running") return null;
    return idleDeadline(this.idleInput());
  }

  private idleInput() {
    return {
      now: Date.now(),
      idleStopMs: this.settings().idleStopMinutes * 60_000,
      visibleViewers: this.visibleViewers.size,
      lastVisibleAt: this.visibleViewers.size > 0 ? Date.now() : this.lastVisibleAt,
      lastInputAt: this.lastInputAt,
      lastAiAt: this.lastAiAt,
    };
  }

  private checkIdle(): void {
    if (this.state === "running" && shouldStopForIdle(this.idleInput())) {
      log.info("Stopping the browser: nobody used it for a while");
      void this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.setState("stopping");
    await this.teardown();
    this.setState("stopped");
    this.emit("stopped");
  }

  private onChromeExit(): void {
    if (this.state === "running") {
      log.warn("The browser exited on its own");
      void this.teardown().then(() => this.setState("crashed", "The browser closed unexpectedly."));
    }
  }

  private async teardown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.tabs?.stop();
    this.tabs = null;
    this.activeTabId = null;
    const chrome = this.chrome;
    this.chrome = null;
    if (chrome) await stopChrome(chrome).catch(() => {});
    const egress = this.egress;
    this.egress = null;
    if (egress) await egress.stop().catch(() => {});
  }

  /** On process exit: no awaiting is possible, so kill the root and let its children go with it. */
  killNow(): void {
    try { if (this.chrome) process.kill(this.chrome.pid); } catch {}
  }
}

export const webBrowserHost = new WebBrowserHost();

let exitHookInstalled = false;
export function installWebBrowserExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => webBrowserHost.killNow());
}
