/**
 * What an AI chat can do in PPM's browser, always on the AI's own tab and always through the
 * same doors a person uses: navigation goes through the address bar's rules and the egress
 * guard, clicks and typing go through `Input.*`. There is no way here to read cookies or
 * storage, or to run script of the AI's choosing.
 */
import type { WebBrowserHost } from "../browser-host.ts";
import type { ViewerHub } from "../viewer-hub.ts";
import { resolveAddress } from "../address-bar.ts";
import { inputToCdp } from "../input-bridge.ts";
import { buildSnapshot, type AxNode } from "./ax-snapshot.ts";

const refsByTab = new Map<string, Map<string, number>>();

export class AiBrowserError extends Error {}

export function createAiBrowserActions(host: WebBrowserHost, hub: ViewerHub) {
  const cdp = () => {
    if (!host.cdp) throw new AiBrowserError("The browser is not running.");
    return host.cdp;
  };

  /** The AI's tab: the newest tab marked as the AI's, else a new one. Shown to the viewer. */
  async function aiTab(createWith?: string): Promise<{ id: string; sessionId: string }> {
    const tabs = host.tabs;
    if (!tabs) throw new AiBrowserError("The browser is not running.");
    let tab = tabs.list().filter((t) => t.ai).pop();
    if (!tab) {
      const id = await tabs.open(createWith ?? "about:blank", { ai: true });
      if (!id) throw new AiBrowserError(`The browser already has its most tabs open (${host.settings().maxTabs}); ask the user to close one.`);
      tab = tabs.list().find((t) => t.id === id);
    }
    if (!tab) throw new AiBrowserError("The AI's tab could not be opened.");
    if (host.activeTabId !== tab.id) await hub.activate(tab.id);
    return { id: tab.id, sessionId: tabs.get(tab.id)!.sessionId };
  }

  /** Until the tab's document has finished loading (a navigation may not have started yet). */
  async function waitForLoad(tabId: string, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    await Bun.sleep(100);
    while (Date.now() < end) {
      const tab = host.tabs?.get(tabId);
      if (!tab) return;
      const r = await cdp().send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, tab.sessionId).catch(() => null);
      if (!tab.loading && r?.result.value === "complete") return;
      await Bun.sleep(100);
    }
  }

  async function open(url: string): Promise<string> {
    const r = resolveAddress(url);
    if (!r.ok) throw new AiBrowserError("Only http and https addresses can be opened.");
    const tab = await aiTab(r.url);
    await host.tabs!.navigate(tab.id, r.url);
    refsByTab.delete(tab.id);
    await waitForLoad(tab.id);
    const t = host.tabs!.get(tab.id);
    return `Opened ${t?.url ?? r.url}${t?.title ? ` — ${t.title}` : ""}. Take a snapshot to read it.`;
  }

  async function snapshot(): Promise<string> {
    const tab = await aiTab();
    const { nodes } = await cdp().send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {}, tab.sessionId);
    const info = host.tabs!.get(tab.id)!;
    const snap = buildSnapshot(nodes, { url: info.url, title: info.title });
    refsByTab.set(tab.id, snap.refs);
    return snap.text;
  }

  async function screenshot(): Promise<string> {
    const tab = await aiTab();
    const shot = await cdp().send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 60 }, tab.sessionId);
    return `data:image/jpeg;base64,${shot.data}`;
  }

  async function centerOf(sessionId: string, tabId: string, ref: string): Promise<{ x: number; y: number; backendNodeId: number }> {
    const backendNodeId = refsByTab.get(tabId)?.get(ref);
    if (!backendNodeId) throw new AiBrowserError(`No element ${ref} on this page; take a new snapshot.`);
    await cdp().send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId).catch(() => {});
    const box = await cdp().send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId }, sessionId)
      .catch(() => { throw new AiBrowserError(`Element ${ref} is gone or hidden; take a new snapshot.`); });
    const q = box.model.content;
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4, backendNodeId };
  }

  async function click(ref: string): Promise<string> {
    const tab = await aiTab();
    const { x, y } = await centerOf(tab.sessionId, tab.id, ref);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp().send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, tab.sessionId);
    }
    await waitForLoad(tab.id, 5000);
    return `Clicked ${ref}.`;
  }

  async function type(text: string, ref?: string, submit?: boolean): Promise<string> {
    const tab = await aiTab();
    if (ref) {
      const { backendNodeId } = await centerOf(tab.sessionId, tab.id, ref);
      await cdp().send("DOM.focus", { backendNodeId }, tab.sessionId).catch(() => {});
    }
    await cdp().send("Input.insertText", { text }, tab.sessionId);
    if (submit) await press("Enter");
    return `Typed ${text.length} characters${ref ? ` into ${ref}` : ""}${submit ? " and pressed Enter" : ""}.`;
  }

  async function press(key: string): Promise<string> {
    const tab = await aiTab();
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const vp = { cssWidth: 1, cssHeight: 1, dpr: 1, mobile: false };
    const held = { buttons: 0, keys: new Map() };
    for (const down of [true, false]) {
      for (const call of inputToCdp({ type: "key", down, key, code, location: 0, modifiers: {}, repeat: false }, vp, held)) {
        await cdp().send(call.method, call.params, tab.sessionId);
      }
    }
    await waitForLoad(tab.id, 5000);
    return `Pressed ${key}.`;
  }

  async function scroll(dy: number): Promise<string> {
    const tab = await aiTab();
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 200, deltaX: 0, deltaY: dy }, tab.sessionId);
    return `Scrolled ${dy > 0 ? "down" : "up"} ${Math.abs(dy)} px.`;
  }

  async function back(): Promise<string> {
    const tab = await aiTab();
    const h = await cdp().send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, tab.sessionId);
    const entry = h.entries[h.currentIndex - 1];
    if (!entry) return "There is no earlier page in this tab.";
    await cdp().send("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.sessionId);
    refsByTab.delete(tab.id);
    await waitForLoad(tab.id);
    return "Went back.";
  }

  async function waitFor(textToFind: string | undefined, ms: number): Promise<string> {
    const tab = await aiTab();
    if (!textToFind) {
      await Bun.sleep(Math.min(ms, 10_000));
      return `Waited ${Math.min(ms, 10_000)} ms.`;
    }
    const world = await cdp().send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: tab.id, worldName: "ppm-ai" }, tab.sessionId);
    const end = Date.now() + Math.min(ms, 15_000);
    while (Date.now() < end) {
      const r = await cdp().send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: `document.body ? document.body.innerText.includes(${JSON.stringify(textToFind)}) : false`, contextId: world.executionContextId, returnByValue: true,
      }, tab.sessionId).catch(() => null);
      if (r?.result.value === true) return `The page shows “${textToFind}”.`;
      await Bun.sleep(250);
    }
    return `The page did not show “${textToFind}” in time.`;
  }

  return { open, snapshot, screenshot, click, type, press, scroll, back, waitFor };
}
