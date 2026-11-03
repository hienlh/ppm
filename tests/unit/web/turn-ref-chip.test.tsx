/**
 * A turn chip: drawn from the message's own block with no request, its text never HTML, the
 * project named only when it is another one, a warning when the AI cannot read turns, and a
 * long press that opens the preview — unless the browser took the gesture for a scroll.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { encodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import type { TurnReference } from "../../../src/shared/chat-turn-ref";

installDom();
afterAll(uninstallDom);
const { TurnRefChip, TurnRefChipView } = await import("../../../src/web/components/chat/turn-ref-chip");
const { ComposerTurnRefRow } = await import("../../../src/web/components/chat/composer-turn-ref-row");
const { UserBubble } = await import("../../../src/web/components/chat/message-user-bubble");
const { api } = await import("../../../src/web/lib/api-client");
const { useChatJumpStore } = await import("../../../src/web/stores/chat-jump-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { resetReadSessionTurnsCache } = await import("../../../src/web/hooks/use-read-session-turns-on");

const ref: TurnReference = {
  version: 1, projectName: "other", providerId: "codex", sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
  turnId: "bbbbbbbb-1111-4000-8000-000000000001", n: 7, title: "<b>Release</b> & notes", prompt: "ship <script>x</script>", at: "2026-11-01T08:00:00.000Z",
};
let view: Mounted | null = null;
let get: ReturnType<typeof spyOn>;
let settings: Record<string, unknown>;

beforeEach(() => {
  resetReadSessionTurnsCache();
  settings = { default_provider: "claude", providers: {} };
  get = spyOn(api, "get").mockImplementation(((path: string) => Promise.resolve(path.includes("/settings/ai") ? settings : null)) as never);
  useChatJumpStore.setState({ request: null, aliases: {} });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  get.mockRestore();
});

describe("turn chips", () => {
  it("renders a sent message's chips from its block alone, with the title and prompt as text", async () => {
    view = await mount(<UserBubble content={encodeMessageBlocks("compare", { turnRefs: [ref] })} timestamp="2026-11-02T00:00:00Z" projectName="ppm" />);
    const chip = view.container.querySelector('[data-turn-chip="ready"]')!;
    expect(chip.textContent).toContain("<b>Release</b> & notes");
    expect(chip.textContent).toContain("Turn 7");
    expect(chip.textContent).toContain("other");
    expect(chip.querySelector("b")).toBeNull();
    // The body is what the bubble shows and copies; the block is not text in it.
    expect(view.container.textContent).not.toContain("ppm-turnrefs-v1");
    expect(get).not.toHaveBeenCalled();
  });

  it("leaves the project out when it is the one being looked at", async () => {
    view = await mount(<TurnRefChipView refData={{ ...ref, projectName: "ppm" }} currentProject="ppm" />);
    expect(view.container.textContent).not.toContain("· ppm");
  });

  it("shows a loading chip and a gone chip at the chip's size, both removable", async () => {
    const removed: string[] = [];
    view = await mount(
      <div>
        <TurnRefChip chip={{ key: "a", status: "loading", target: ref, nonce: 1 }} onRemove={() => removed.push("a")} />
        <TurnRefChip chip={{ key: "b", status: "error", target: ref, reason: "No longer available" }} onRemove={() => removed.push("b")} />
      </div>,
    );
    expect(view.container.querySelector('[data-turn-chip="loading"]')?.className).toContain("h-[44px]");
    // One width for every composer state, so a chip resolving does not shift the row.
    for (const status of ["loading", "error"]) expect(view.container.querySelector(`[data-turn-chip="${status}"]`)?.className).toContain("w-[18rem]");
    expect(view.container.querySelector('[data-turn-chip="error"]')?.textContent).toContain("No longer available");
    for (const button of view.container.querySelectorAll('[aria-label="Remove turn reference"]')) await click(button);
    expect(removed).toEqual(["a", "b"]);
  });

  it("warns in the composer when read_session_turns is off", async () => {
    settings = { ...settings, ppm_tools: { read_session_turns: false } };
    view = await mount(<ComposerTurnRefRow chips={[{ key: "k", status: "ready", target: ref, ref }]} currentProject="ppm" onRemove={() => {}} />);
    await act(async () => { await Bun.sleep(10); });
    expect(view.container.querySelector('[aria-label^="The AI can\'t read this turn"]')).not.toBeNull();
  });

  it("does not warn while the tool is on", async () => {
    view = await mount(<ComposerTurnRefRow chips={[{ key: "k", status: "ready", target: ref, ref }]} currentProject="ppm" onRemove={() => {}} />);
    await act(async () => { await Bun.sleep(10); });
    expect(view.container.querySelector('[aria-label^="The AI can\'t read this turn"]')).toBeNull();
    // The resolved composer chip keeps the width its skeleton had.
    expect(view.container.querySelector('[data-turn-chip="ready"]')?.className).toContain("w-[18rem]");
  });

  it("opens the session on a tap and asks it to show the turn", async () => {
    useProjectStore.setState({ activeProject: { name: "other", path: "/x" } as never });
    const openTab = spyOn(useTabStore.getState(), "openTab").mockImplementation(() => "tab");
    try {
      view = await mount(<TurnRefChipView refData={ref} currentProject="other" />);
      await click(view.container.querySelector('[data-turn-chip="ready"] button'));
      expect(useChatJumpStore.getState().request).toMatchObject({ sessionId: ref.sessionId, turnId: ref.turnId });
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(openTab.mock.calls[0]![0]).toMatchObject({ type: "chat", metadata: { sessionId: ref.sessionId, providerId: "codex", projectName: "other" } });
    } finally {
      openTab.mockRestore();
    }
  });
});

describe("opening a turn of another project", () => {
  it("asks for no jump when this PPM has no such project", async () => {
    const { openTurnRef } = await import("../../../src/web/lib/open-turn-ref");
    const { toast } = await import("sonner");
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    useProjectStore.setState({ projects: [{ name: "ppm", path: "/p" }] as never, activeProject: { name: "ppm", path: "/p" } as never });
    try {
      await openTurnRef(ref);
      expect(useChatJumpStore.getState().request).toBeNull();
      expect(shown).toHaveBeenCalledTimes(1);
    } finally { shown.mockRestore(); }
  });
});

describe("the long press on a chip", () => {
  const press = (el: Element, type: string) => act(async () => { el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true })); });
  const sheetOpen = () => [...document.body.querySelectorAll("button")].some((b) => b.textContent?.includes("Open session"));

  it("opens the preview sheet after 400 ms", async () => {
    view = await mount(<TurnRefChipView refData={ref} />);
    const button = view.container.querySelector('[data-turn-chip="ready"] button')!;
    await press(button, "touchstart");
    await act(async () => { await Bun.sleep(450); });
    expect(sheetOpen()).toBe(true);
    expect(document.body.textContent).toContain("ship <script>x</script>");
  });

  it("keeps the sheet's backdrop tap from reaching the composer around the chip", async () => {
    // React bubbles a portalled click to the chip's ancestors; the composer's would focus its
    // textarea and pop the phone keyboard as the sheet closes.
    const outer: string[] = [];
    view = await mount(<div onClick={() => outer.push("composer")}><TurnRefChipView refData={ref} /></div>);
    const button = view.container.querySelector('[data-turn-chip="ready"] button')!;
    await press(button, "touchstart");
    await act(async () => { await Bun.sleep(450); });
    expect(sheetOpen()).toBe(true);
    const backdrop = [...document.body.querySelectorAll<HTMLElement>("div.fixed.inset-0")].at(-1)!;
    await click(backdrop);
    expect(sheetOpen()).toBe(false);
    expect(outer).toEqual([]);
  });

  it("is disarmed when the browser cancels the touch for a scroll", async () => {
    view = await mount(<TurnRefChipView refData={ref} />);
    const button = view.container.querySelector('[data-turn-chip="ready"] button')!;
    await press(button, "touchstart");
    await press(button, "touchcancel");
    await act(async () => { await Bun.sleep(450); });
    expect(sheetOpen()).toBe(false);
  });
});
