import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { projectCacheId } = await import("../../../src/web/lib/browser-cache/cache-keys");
const { useSessionListStore, emptyProjectSessionState } = await import("../../../src/web/stores/session-list-store");
const { SessionListSyncIndicator } = await import("../../../src/web/components/chat/session-list-sync-indicator");

const project = { name: "indicator-proj", path: "/indicator-proj" };
const id = projectCacheId(project);

function setSyncState(patch: Partial<ReturnType<typeof emptyProjectSessionState>>) {
  useSessionListStore.setState((state) => ({
    byProject: { ...state.byProject, [id]: { ...emptyProjectSessionState(), ...state.byProject[id], ...patch } },
  }));
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  useSessionListStore.setState({ byProject: {} });
});

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

it("renders nothing while idle", async () => {
  setSyncState({});
  view = await mount(<SessionListSyncIndicator project={project} />);
  expect(view.container.textContent).toBe("");
  expect(view.container.querySelector('[role="status"]')).toBeNull();
});

it("shows a status role and Syncing… text while the store is syncing", async () => {
  setSyncState({ isSyncing: true });
  view = await mount(<SessionListSyncIndicator project={project} />);
  const status = view.container.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(status?.getAttribute("aria-live")).toBe("polite");
  expect(view.container.textContent).toContain("Syncing");
});

it("stays visible for a minimum duration even after syncing ends quickly", async () => {
  setSyncState({ isSyncing: true });
  view = await mount(<SessionListSyncIndicator project={project} />);
  await act(async () => {
    setSyncState({ isSyncing: false });
  });
  // Immediately after the sync ends the indicator must still be up — this is
  // the whole point of the minimum-visible-time guard.
  expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  await wait(400);
  expect(view.container.querySelector('[role="status"]')).toBeNull();
});

it("shows a subtle offline note after a failed sync, and it clears itself", async () => {
  setSyncState({ isSyncing: false, lastSyncError: "offline" });
  view = await mount(<SessionListSyncIndicator project={project} />);
  expect(view.container.textContent).toContain("Offline");
  const status = view.container.querySelector('[role="status"]');
  expect(status).not.toBeNull();
});
