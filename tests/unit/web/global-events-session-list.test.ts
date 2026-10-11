/**
 * Sessions the server creates on its own (an Assistant tool, a Telegram `/new`) reach no chat
 * socket, so `/ws/global`'s `sessions:list_changed` is the only way a list already on screen
 * hears of them. It re-syncs that project — only one this browser holds a list for — and the
 * Assistant's `assistant:*` events are passed on as window events for the session list to read.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { useGlobalEvents } = await import("../../../src/web/hooks/use-global-events");
const { useSessionListStore } = await import("../../../src/web/stores/session-list-store");
const { syncKnownProject } = await import("../../../src/web/stores/session-list-sync-triggers");
const syncModule = await import("../../../src/web/lib/sync-running-sessions");

const initialStore = useSessionListStore.getState();
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  useSessionListStore.setState(initialStore, true);
});

const entry = (name: string) => ({
  project: { name, path: name }, sessions: [], tags: { byId: {}, defs: [] },
  isSyncing: false, lastSyncError: null, lastSyncedAt: Date.now(), hydrated: true,
});

/** Swaps the store's `sync` for a recorder; returns the names it was asked to sync. */
function recordSyncs(): string[] {
  const synced: string[] = [];
  useSessionListStore.setState({ sync: async (project: { name: string }) => { synced.push(project.name); } } as never);
  return synced;
}

/** Mounts `useGlobalEvents` over a socket that never connects; returns a way to deliver a message. */
async function mountGlobalEvents(): Promise<(event: object) => Promise<void>> {
  let deliver: ((e: { data: string }) => void) | null = null;
  spies.push(
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "disconnect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "send").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation(((handler: (e: { data: string }) => void) => {
      deliver = handler;
      return () => {};
    }) as never),
    spyOn(syncModule, "syncRunningSessions").mockImplementation(async () => {}),
  );
  function Probe() {
    useGlobalEvents(true, "demo");
    return null;
  }
  view = await mount(createElement(Probe));
  return (event) => act(async () => { deliver!({ data: JSON.stringify(event) }); });
}

describe("sessions:list_changed", () => {
  it("re-syncs the project it names when this browser holds its list", async () => {
    useSessionListStore.setState({ byProject: { a: entry("__assistant__"), b: entry("ppm") } } as never);
    const synced = recordSyncs();
    const emit = await mountGlobalEvents();
    await emit({ type: "sessions:list_changed", projectName: "__assistant__" });
    expect(synced).toEqual(["__assistant__"]);
  });

  it("fetches nothing for a project no screen has read", async () => {
    useSessionListStore.setState({ byProject: { b: entry("ppm") } } as never);
    const synced = recordSyncs();
    const emit = await mountGlobalEvents();
    await emit({ type: "sessions:list_changed", projectName: "__assistant__" });
    await emit({ type: "sessions:list_changed" });
    expect(synced).toEqual([]);
  });

  it("syncKnownProject matches by name, not by cache key", () => {
    useSessionListStore.setState({ byProject: { "x|/p": { ...entry("ppm"), project: { name: "ppm", path: "/p" } } } } as never);
    const synced = recordSyncs();
    syncKnownProject("ppm");
    syncKnownProject("other");
    expect(synced).toEqual(["ppm"]);
  });
});

describe("assistant:* events", () => {
  it("are passed on as window events", async () => {
    const seen: unknown[] = [];
    const onEvent = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("assistant:telegram_binding_changed", onEvent);
    try {
      const emit = await mountGlobalEvents();
      await emit({ type: "assistant:telegram_binding_changed", chatId: "42", sessionId: "s2", providerId: "codex" });
      expect(seen).toEqual([{ type: "assistant:telegram_binding_changed", chatId: "42", sessionId: "s2", providerId: "codex" }]);
    } finally {
      window.removeEventListener("assistant:telegram_binding_changed", onEvent);
    }
  });
});
