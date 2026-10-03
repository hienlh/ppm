/**
 * New File from a right-click menu, in both explorers.
 *
 * Choosing New File (or New Folder) from the project tree's menu showed the name box for about
 * 10 ms and then removed it, so a file could not be created from the menu at all. Radix hands
 * focus back to whatever held it before the menu opened — the row that was right-clicked — a
 * tick after the menu closes, and does it unconditionally. By then the box had taken focus; it
 * reads a blur as "done", and done with nothing typed means cancel. Rename escaped only because
 * its box replaces the very row focus would have gone back to.
 *
 * The explorer window lost the same race differently: its field focuses while it mounts, which
 * is still inside the menu's click, so the menu's focus trap took focus straight back and the
 * field sat there unfocused — whatever was typed next went to the list behind it.
 *
 * These mount the real menu and the real name fields and dispatch the real events. Which of the
 * two runs first, the field's next frame or the menu's hand-back timer, is up to the browser
 * (in Chrome the frame won, which is the losing order), so every case runs in both.
 */
import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { useState } from "react";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
// The menu's focus trap watches its own content for removals, and the harness has no observer.
installGlobal("MutationObserver", (window as unknown as { MutationObserver: unknown }).MutationObserver);

const { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } =
  await import("../../../src/web/components/ui/adaptive-context-menu.tsx");
const { InlineTreeInput } = await import("../../../src/web/components/explorer/inline-tree-input.tsx");
const { InlineNameInput } = await import("../../../src/web/components/os-explorer/views/inline-name-input.tsx");
const { act } = await import("react");

/*
 * A frame, run either before any pending timer (a microtask) or well after one. happy-dom's own
 * frame always comes after a zero-delay timer, which is the order that happened to work.
 */
type FrameOrder = "frame first" | "timer first";
let frameOrder: FrameOrder = "frame first";
let nextFrame = 1;
const cancelledFrames = new Set<number>();
installGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  const id = nextFrame++;
  const run = () => { if (!cancelledFrames.delete(id)) cb(performance.now()); };
  if (frameOrder === "frame first") queueMicrotask(run);
  else setTimeout(run, 20);
  return id;
});
installGlobal("cancelAnimationFrame", (id: number) => { cancelledFrames.add(id); });

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

/** A row with a menu whose one item opens a name field, the way both explorers are wired. */
function Row({ field }: { field: "tree" | "explorer window" }) {
  const [naming, setNaming] = useState(false);
  const [cancelled, setCancelled] = useState(0);
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button">src</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setNaming(true)}>New File</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {naming && field === "tree" && (
        <InlineTreeInput
          defaultValue=""
          placeholder="filename.ts"
          depth={1}
          icon="file"
          onConfirm={async () => {}}
          onCancel={() => { setNaming(false); setCancelled((n) => n + 1); }}
        />
      )}
      {naming && field === "explorer window" && (
        <InlineNameInput initial="" onCommit={() => {}} onCancel={() => setNaming(false)} />
      )}
      <output data-cancelled={cancelled} />
    </div>
  );
}

/** What holds focus, readable in a failure message. */
function focusHolder(): string {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return "body";
  if (el.tagName === "INPUT") return `input ${el.getAttribute("placeholder") ?? el.getAttribute("aria-label") ?? ""}`.trim();
  return `${el.tagName.toLowerCase()} "${el.textContent ?? ""}"`;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)); });

/** Right-click the row (a press focuses it first, as in a browser) and choose New File. */
async function chooseNewFile(container: HTMLElement): Promise<void> {
  const row = [...container.querySelectorAll("button")].find((b) => b.textContent === "src")!;
  await act(async () => { row.focus(); });
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  await settle();
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === "New File");
  expect(item, "the menu opened").toBeTruthy();
  await click(item!);
  await settle();
}

for (const order of ["frame first", "timer first"] as const) {
  describe(`New File from a row's menu (${order})`, () => {
    it("leaves the tree's name box open, focused and not cancelled", async () => {
      frameOrder = order;
      view = await mount(<Row field="tree" />);
      await chooseNewFile(view.container);

      expect(view.container.querySelector("output")!.getAttribute("data-cancelled")).toBe("0");
      expect(view.container.querySelector('input[placeholder="filename.ts"]')).not.toBeNull();
      expect(focusHolder()).toBe("input filename.ts");
    });

    it("puts focus in the explorer window's name field", async () => {
      frameOrder = order;
      view = await mount(<Row field="explorer window" />);
      await chooseNewFile(view.container);

      expect(view.container.querySelector('input[aria-label="Name"]')).not.toBeNull();
      expect(focusHolder()).toBe("input Name");
    });
  });
}

describe("a menu item that moves focus nowhere", () => {
  it("still hands focus back to the row, so the keyboard keeps its place", async () => {
    frameOrder = "frame first";
    function PlainRow() {
      return (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button type="button">src</button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => {}}>Copy Path</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      );
    }
    view = await mount(<PlainRow />);
    const row = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "src")!;
    await act(async () => { row.focus(); });
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === "Copy Path");
    expect(item, "the menu opened").toBeTruthy();
    await click(item!);
    await settle();

    expect(focusHolder()).toBe('button "src"');
  });
});
