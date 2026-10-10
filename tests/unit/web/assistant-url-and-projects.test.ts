/**
 * The Assistant's virtual project is a chat scope, not a workspace: it must never become the
 * open project, appear in the project list, name an address, or be synced as a layout. The
 * Assistant tab itself has a plain address under whichever project is open.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { buildUrl, parseUrlState, buildMetadataFromUrl } = await import("../../../src/web/hooks/use-url-sync");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
// Both stores outlive this file in the test process.
const initialProjects = useProjectStore.getState();
const initialPanels = usePanelStore.getState();
afterAll(() => {
  useProjectStore.setState(initialProjects, true);
  usePanelStore.setState(initialPanels, true);
  window.history.replaceState(null, "", "/");
  uninstallDom();
});
const { fetchWorkspaceFromServer, hydrateWorkspaceFromServer, isVirtualWorkspaceName } = await import("../../../src/web/stores/panel-utils");
const { api } = await import("../../../src/web/lib/api-client");

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

describe("addresses", () => {
  it("never names the virtual project", () => {
    expect(buildUrl("__assistant__", "assistant")).toBe("/");
    expect(buildUrl("__assistant__", null)).toBe("/");
  });

  it("gives the Assistant tab a plain address under the open project", () => {
    expect(buildUrl("ppm", "assistant")).toBe("/project/ppm/assistant");
    window.history.replaceState(null, "", "/project/ppm/assistant");
    expect(parseUrlState()).toMatchObject({ projectName: "ppm", tabType: "assistant", tabIdentifier: null });
  });

  it("ignores an address that names the virtual project", () => {
    window.history.replaceState(null, "", "/project/__assistant__/chat/claude/abc");
    expect(parseUrlState()).toMatchObject({ projectName: null, tabType: null });
    window.history.replaceState(null, "", "/");
  });

  it("builds no tab metadata from a URL for the Assistant (it opens through openAssistant)", () => {
    expect(buildMetadataFromUrl("assistant", null, "ppm")).toBeNull();
  });
});

describe("the project list and layouts", () => {
  it("drops the virtual project from the project list", async () => {
    const get = spyOn(api, "get").mockResolvedValue([
      { name: "ppm", path: "/p" }, { name: "__assistant__", path: "/x" },
    ] as never);
    spies.push(get);
    await useProjectStore.getState().fetchProjects();
    expect(useProjectStore.getState().projects.map((p) => p.name)).toEqual(["ppm"]);
  });

  it("never switches the grid to the virtual project", () => {
    usePanelStore.setState({ currentProject: "ppm" } as never);
    usePanelStore.getState().switchProject("__assistant__");
    expect(usePanelStore.getState().currentProject).toBe("ppm");
  });

  it("never fetches or hydrates a workspace for it", async () => {
    const get = spyOn(globalThis, "fetch");
    spies.push(get);
    expect(isVirtualWorkspaceName("__assistant__")).toBe(true);
    expect(isVirtualWorkspaceName("__global__")).toBe(true);
    expect(isVirtualWorkspaceName("ppm")).toBe(false);
    expect(await fetchWorkspaceFromServer("__assistant__")).toBeNull();
    expect(await hydrateWorkspaceFromServer("__assistant__")).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});
