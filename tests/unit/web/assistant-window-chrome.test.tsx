/**
 * The Assistant's place in the window manager and its touch layout: the dock chip carries the
 * waiting count and the titlebar its own name, "Idle" and the settings gear; a manager chat opened
 * beside another project carries "Open in project" while an ordinary chat window carries nothing;
 * the chips, the filter and the filter sheet's rows keep 44 px (48 px) targets on a phone.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement, Fragment } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { describeWindow } = await import("../../../src/web/components/floating-window/use-window-meta");
const { ManagerChip } = await import("../../../src/web/components/assistant/manager-chip");
const { AssistantFilterSheet } = await import("../../../src/web/components/assistant/assistant-filter-sheet");
type Tab = import("../../../src/web/stores/tab-store").Tab;
type Manager = import("../../../src/shared/assistant-managers").ManagerChatSummary;

const tab = (over: Partial<Tab>): Tab => ({ id: "t", type: "chat", title: "Chat", projectId: "ppm", closable: true, ...over });
const manager = (over: Partial<Manager> = {}): Manager => ({
  projectName: "nxsys", projectPath: "/p/nxsys", sessionId: "mgr-1", providerId: "claude", title: "Manager",
  phase: "idle", permissionMode: "default", digest: true, telegramDetail: "full", waiting: 0, rulesPending: false, ...over,
});

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

async function renderExtras(t: Tab): Promise<HTMLElement> {
  const meta = describeWindow("tab-host", t, false);
  view = await mount(createElement(Fragment, null, meta.renderExtras?.("windows") ?? null));
  return view.container;
}

describe("the Assistant in the window manager", () => {
  it("puts the waiting count on the Assistant's dock chip and names its titlebar", () => {
    const meta = describeWindow("tab-host", tab({ id: "assistant", type: "assistant", title: "PPM Assistant", projectId: null }), false, 3);
    expect(meta.count).toBe(3);
    expect(meta.title).toBe("PPM Assistant");
    expect(meta.titlebarTitle).toBe("Assistant");
    expect(meta.showIdle).toBe(true);
    expect(meta.subtitle).toBeUndefined();
    expect(describeWindow("tab-host", tab({ type: "assistant", projectId: null }), false, 0).count).toBeUndefined();
    expect(describeWindow("tab-host", tab({ type: "editor" }), false, 5).renderExtras).toBeUndefined();
  });

  it("gives the Assistant a settings gear", async () => {
    const root = await renderExtras(tab({ id: "assistant", type: "assistant", projectId: null }));
    expect(root.querySelector('button[aria-label="PPM Assistant settings"]')).not.toBeNull();
  });

  it("offers Open in project only on a manager chat opened beside another project", async () => {
    let root = await renderExtras(tab({ projectId: null, metadata: { projectName: "nxsys", sessionId: "mgr-1", managerWindow: true } }));
    expect(root.querySelector('button[aria-label="Open in project"]')).not.toBeNull();
    expect(describeWindow("tab-host", tab({ projectId: null, metadata: { projectName: "nxsys" } }), false).subtitle).toBe("Chat · nxsys");
    await view!.unmount();
    root = await renderExtras(tab({ metadata: { sessionId: "s" } }));
    expect(root.querySelector("button")).toBeNull();
  });
});

describe("touch targets on a phone", () => {
  it("keeps a chip's hit area 44 px tall around its drawn pill", async () => {
    view = await mount(createElement(ManagerChip, { manager: manager({ phase: "streaming" }), waiting: 2 }));
    const button = view.container.querySelector("button")!;
    expect(button.className).toContain("h-11");
    expect(button.getAttribute("aria-label")).toBe("Open the nxsys manager chat · working · 2 waiting");
    expect(view.container.querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("running");
  });

  it("draws the filter sheet's rows 48 px tall, All first, with the explanation", async () => {
    view = await mount(createElement(AssistantFilterSheet, {
      open: true, onClose: () => {}, filter: "nxsys", managers: [manager(), manager({ projectName: "ppm", sessionId: "mgr-2" })],
      waiting: { nxsys: 1 }, onPick: () => {},
    }));
    const rows = [...document.querySelectorAll('[data-assistant-filter-sheet] [role="radio"]')];
    expect(rows.map((r) => r.textContent?.replace(/\d+$/, ""))).toEqual(["All", "nxsys", "ppm"]);
    for (const r of rows) expect(r.className).toContain("min-h-12");
    expect(rows[1]!.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector("[data-assistant-filter-sheet]")?.textContent).toContain("When filtered, the stream keeps only");
  });
});
