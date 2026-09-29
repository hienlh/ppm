/**
 * The history list's mutations are optimistic: the shared store (and so every list that
 * reads it) changes before the request is sent, and a refused request puts the server's
 * version back by re-syncing the project.
 */
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useSessionHistory } = await import("../../../src/web/hooks/use-session-history");
const { useSessionListStore, __clearInFlightForTest } = await import("../../../src/web/stores/session-list-store");
const { api } = await import("../../../src/web/lib/api-client");
const { projectCacheId } = await import("../../../src/web/lib/browser-cache/cache-keys");

const PROJECT = "optimistic-history";
const ref = { name: PROJECT, path: PROJECT };
const serverRow = { id: "row-1", providerId: "claude", title: "Server title", createdAt: "2026-01-01T00:00:00.000Z", pinned: false };

let history: ReturnType<typeof useSessionHistory>;
function Harness() {
  history = useSessionHistory({ projectName: PROJECT });
  return null;
}

let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
const row = () => useSessionListStore.getState().byProject[projectCacheId(ref)]?.sessions.find((s) => s.id === "row-1");
const click = { stopPropagation() {} } as unknown as React.MouseEvent;

/** Replaces one `api` method for a test; `api` is a singleton, so the spy comes back off. */
function stubApi(method: "put" | "patch" | "del", impl: () => Promise<unknown>) {
  spies.push(spyOn(api, method).mockImplementation(impl as never));
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  __clearInFlightForTest();
  useSessionListStore.setState({ byProject: {} });
  spies.push(spyOn(api, "get").mockImplementation((async (url: string) =>
    url.includes("/tags") ? { tags: [], counts: {}, defaultTagId: null } : { sessions: [serverRow], hasMore: false }
  ) as typeof api.get));
  view = await mount(<Harness />);
  await act(async () => { await useSessionListStore.getState().sync(ref); });
});

afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  __clearInFlightForTest();
});

it("shows a pin before the server answers, and keeps it once accepted", async () => {
  const put = deferred();
  stubApi("put", () => put.promise);
  let pending!: Promise<void>;
  await act(async () => { pending = history.togglePin(click, { ...serverRow }); });
  expect(row()?.pinned).toBe(true);
  await act(async () => { put.resolve({}); await pending; });
  expect(row()?.pinned).toBe(true);
});

it("rolls a refused rename back to the server's title", async () => {
  const patch = deferred();
  stubApi("patch", () => patch.promise);
  await act(async () => { history.startEditing({ ...serverRow }, click); });
  await act(async () => { history.setEditingTitle("Local title"); });
  let pending!: Promise<void>;
  await act(async () => { pending = history.saveTitle(); });
  expect(row()?.title).toBe("Local title");
  await act(async () => { patch.reject(new Error("HTTP 500")); await pending; });
  await act(async () => { await useSessionListStore.getState().sync(ref); });
  expect(row()?.title).toBe("Server title");
});

it("removes a deleted row at once and brings it back when the delete is refused", async () => {
  const realConfirm = window.confirm;
  window.confirm = () => true;
  spies.push({ mockRestore: () => { window.confirm = realConfirm; } });
  const del = deferred();
  stubApi("del", () => del.promise);
  let pending!: Promise<void>;
  await act(async () => { pending = history.deleteSession(click, { ...serverRow }); });
  expect(row()).toBeUndefined();
  await act(async () => { del.reject(new Error("HTTP 500")); await pending; });
  await act(async () => { await useSessionListStore.getState().sync(ref); });
  expect(row()?.title).toBe("Server title");
});
