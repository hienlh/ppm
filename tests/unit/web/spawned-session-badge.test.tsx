/**
 * The mark on an AI-created session: absent on a person's session, naming the creator as text, a
 * click opening the creator on a desktop, and a tap opening a sheet on a touch screen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, installGlobal, type Mounted } from "../../helpers/react-dom";
import type { SessionInfo } from "../../../src/types/chat";

installDom();
const realMatchMedia = window.matchMedia;
afterAll(() => {
  (window as unknown as { matchMedia: unknown }).matchMedia = realMatchMedia;
  uninstallDom();
});
const { SpawnedSessionBadge, createdByText } = await import("../../../src/web/components/chat/spawned-session-badge");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");

const PARENT = "aaaaaaaa-0000-4000-8000-000000000000";
const child: SessionInfo = {
  id: "cccccccc-2222-4000-8000-000000000002", providerId: "codex", title: "Tests", createdAt: "2026-11-06T00:00:00Z",
  spawnedBy: PARENT, parentTitle: "<b>Planner</b>",
};
let view: Mounted | null = null;

/** `(pointer: coarse)` answers `coarse`; everything else false. */
function pointer(coarse: boolean): void {
  const matchMedia = (query: string) => ({
    matches: query.includes("coarse") ? coarse : false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  // The hook asks `window`, which is the installed DOM's own object rather than `globalThis`.
  installGlobal("matchMedia", matchMedia);
  (window as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [{ name: "ppm", path: "/p" }] as never, activeProject: { name: "ppm", path: "/p" } as never });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe("SpawnedSessionBadge", () => {
  it("names the creator, falling back when it has no title", () => {
    expect(createdByText("Planner")).toBe("Created by Planner");
    expect(createdByText(null)).toBe("Created by another session");
  });

  it("draws nothing for a session a person started", async () => {
    pointer(false);
    view = await mount(<SpawnedSessionBadge session={{ ...child, spawnedBy: null }} projectName="ppm" />);
    expect(view.container.querySelector("[data-spawned-badge]")).toBeNull();
  });

  it("opens the creator with a click where there is a mouse", async () => {
    pointer(false);
    const openTab = spyOn(useTabStore.getState(), "openTab").mockImplementation(() => "tab");
    try {
      view = await mount(<SpawnedSessionBadge session={child} projectName="ppm" />);
      const badge = view.container.querySelector(`[data-spawned-badge="${PARENT}"]`)!;
      expect(badge.getAttribute("aria-label")).toBe("Created by <b>Planner</b>");
      await click(badge);
      expect(openTab.mock.calls[0]![0]).toMatchObject({ type: "chat", metadata: { sessionId: PARENT, projectName: "ppm" } });
    } finally {
      openTab.mockRestore();
    }
  });

  it("opens a sheet with the creator on a touch screen", async () => {
    pointer(true);
    const openTab = spyOn(useTabStore.getState(), "openTab").mockImplementation(() => "tab");
    try {
      view = await mount(<SpawnedSessionBadge session={child} projectName="ppm" />);
      await click(view.container.querySelector("[data-spawned-badge]"));
      expect(openTab).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Created by <b>Planner</b>");
      const open = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Open the session that created it"))!;
      await click(open);
      expect(openTab).toHaveBeenCalledTimes(1);
    } finally {
      openTab.mockRestore();
    }
  });
});
