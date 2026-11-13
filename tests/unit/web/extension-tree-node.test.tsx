/**
 * An extension tree row: one line, with the full text reachable by hover (tooltip) and, on a
 * phone, by a long press that opens a sheet with the label and tooltip on top and the row's
 * actions below. A row's link opens as a real anchor, and only an http(s) one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { ExtensionTreeNode } = await import("../../../src/web/components/extensions/extension-tree-node");
import type { TreeItemUI } from "../../../src/web/stores/extension-store";

const realWidth = window.innerWidth;
let mounted: Mounted | null = null;
let dispatched: Array<{ command: string; args?: unknown[] }> = [];
const onCommand = (e: Event) => dispatched.push((e as CustomEvent).detail);

beforeEach(() => {
  dispatched = [];
  window.addEventListener("ext:command:execute", onCommand);
});
afterEach(async () => {
  window.removeEventListener("ext:command:execute", onCommand);
  await mounted?.unmount();
  mounted = null;
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

const ITEM: TreeItemUI = {
  id: "pr-1",
  label: "Fix the very long pull request title that never fits in one sidebar line",
  tooltip: "ppm · waiting for your review\n2 days old",
  icon: "git-pull-request",
  collapsibleState: "none",
  command: "midday.open",
  commandArgs: ["pr-1"],
  actions: [
    { icon: "check", tooltip: "Done", command: "midday.done", commandArgs: ["pr-1"] },
    { icon: "clock", tooltip: "Snooze", command: "midday.snooze", commandArgs: ["pr-1"] },
  ],
};

async function render(item: TreeItemUI): Promise<HTMLElement> {
  mounted = await mount(<ExtensionTreeNode item={item} depth={0} viewId="midday.looseEnds" />);
  return mounted.container;
}

describe("ExtensionTreeNode", () => {
  it("draws one row with the item's icon, and its actions with their own glyphs and names", async () => {
    const root = await render(ITEM);
    const row = root.querySelector(".group\\/node")!;
    expect(row.className).toContain("select-none");
    expect(row.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3); // row icon + two actions
    const done = root.querySelector<HTMLButtonElement>('button[aria-label="Done"]')!;
    expect(done).not.toBeNull();
    await act(async () => { done.click(); });
    expect(dispatched).toEqual([{ command: "midday.done", args: ["pr-1"] }]);
  });

  it("shows the tooltip, line breaks kept, when the label is focused or hovered", async () => {
    const root = await render(ITEM);
    const label = [...root.querySelectorAll("button")].find((b) => b.textContent === ITEM.label)!;
    expect(document.body.textContent).not.toContain("waiting for your review");
    await act(async () => { label.focus(); });
    await act(async () => { await Bun.sleep(50); });
    const tip = [...document.body.querySelectorAll('[data-slot="tooltip-content"]')];
    expect(tip.length).toBe(1);
    expect(tip[0]!.textContent).toContain("ppm · waiting for your review\n2 days old");
    expect(tip[0]!.className).toContain("whitespace-pre-line");
  });

  it("lets the title win the width: the description shrinks first, and the row is 44px on touch", async () => {
    const root = await render({ ...ITEM, description: "nxsys-backend · 2d" });
    const row = root.querySelector(".group\\/node")!;
    expect(row.className).toContain("pointer-coarse:min-h-11");
    const label = [...root.querySelectorAll("button")].find((b) => b.textContent === ITEM.label)!;
    const description = root.querySelector('[data-slot="tree-row-description"]')!;
    // Both truncate, but the description's shrink factor is far above the title's.
    expect(label.className).toContain("flex-[0_1_auto]");
    expect(label.className).toContain("truncate");
    expect(description.className).toContain("flex-[0_1000_auto]");
    expect(description.className).toContain("truncate");
    expect(description.className).toContain("min-w-0");
    // Title and description share one flexible box, ahead of the actions.
    expect(label.parentElement).toBe(description.parentElement);
    expect(label.parentElement!.className).toContain("flex-1");
  });

  it("runs the row's command when its label is clicked, not when an action is", async () => {
    const root = await render(ITEM);
    const label = [...root.querySelectorAll("button")].find((b) => b.textContent === ITEM.label)!;
    await act(async () => { label.click(); });
    expect(dispatched).toEqual([{ command: "midday.open", args: ["pr-1"] }]);
  });

  it("makes an http(s) row a real link that cannot reach its opener", async () => {
    const root = await render({ ...ITEM, url: "https://github.com/o/r/pull/1" });
    const a = root.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://github.com/o/r/pull/1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("drops a javascript: url and keeps the row a button", async () => {
    const root = await render({ ...ITEM, url: "javascript:alert(1)" });
    expect(root.querySelector("a")).toBeNull();
  });

  it("on a phone, a long press opens a sheet with the full label and tooltip above the actions", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    window.dispatchEvent(new Event("resize"));
    const root = await render(ITEM);
    const row = root.querySelector(".group\\/node")!;
    await act(async () => { row.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true })); });
    await act(async () => { await Bun.sleep(450); });
    const text = document.body.textContent ?? "";
    expect(text).toContain(ITEM.label);
    expect(text).toContain("waiting for your review");
    const sheetButtons = [...document.body.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(sheetButtons).toContain("Done");
    expect(sheetButtons).toContain("Snooze");
    expect(sheetButtons).toContain("Open");
  });

  it("does not repeat the title in the sheet when the tooltip opens with it", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    window.dispatchEvent(new Event("resize"));
    const root = await render({ ...ITEM, tooltip: `${ITEM.label}\nYour PR · CI failing\nnxsys-backend · 8h` });
    const row = root.querySelector(".group\\/node")!;
    await act(async () => { row.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true })); });
    await act(async () => { await Bun.sleep(450); });
    const text = document.body.textContent ?? "";
    // Once in the row, once in the sheet's header, and not a third time from the tooltip.
    expect(text.split(ITEM.label).length - 1).toBe(2);
    expect(text).toContain("Your PR · CI failing");
  });

  it("on a phone, a press cut short by a scroll (touchcancel) never opens the sheet", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    window.dispatchEvent(new Event("resize"));
    const root = await render(ITEM);
    const row = root.querySelector(".group\\/node")!;
    await act(async () => {
      row.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true }));
      row.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await Bun.sleep(450); });
    const sheetButtons = [...document.body.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(sheetButtons).not.toContain("Open");
  });
});
