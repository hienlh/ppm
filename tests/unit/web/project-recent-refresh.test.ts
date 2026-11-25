/**
 * The Recent order of the project switcher across devices: the server holds every device's open
 * times, and a switcher reads them again when it opens, so a project opened on another device
 * since this page loaded comes first — without losing one this browser opened even later.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

const store = new Map<string, string>();
installGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
afterAll(uninstallDom);

const { useProjectStore, sortByRecent, loadRecentTimes } = await import("../../../src/web/stores/project-store");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  store.clear();
});

const project = (name: string) => ({ name, path: `/p/${name}` }) as never;

describe("refreshRecent", () => {
  it("puts a project another device opened since first, keeps a newer local one, and re-sorts the switchers", async () => {
    store.set("ppm-recent-times", JSON.stringify({ "nxsys-workspace": 300, velox: 100 }));
    store.set("ppm-recent-projects", JSON.stringify(["nxsys-workspace", "velox"]));
    globalThis.fetch = (() => Promise.resolve(new Response(
      JSON.stringify({ ok: true, data: { recentOpen: { nesku: 500, ppm: 400, "nxsys-workspace": 200 } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))) as unknown as typeof fetch;

    const before = useProjectStore.getState().recentVersion;
    await useProjectStore.getState().refreshRecent();

    expect(useProjectStore.getState().recentVersion).toBe(before + 1);
    expect(loadRecentTimes()).toEqual({ nesku: 500, ppm: 400, "nxsys-workspace": 300, velox: 100 });
    const names = sortByRecent(["velox", "ppm", "nxsys-workspace", "nesku"].map(project)).map((p: { name: string }) => p.name);
    expect(names).toEqual(["nesku", "ppm", "nxsys-workspace", "velox"]);
  });

  it("keeps the local order when the server cannot be reached", async () => {
    store.set("ppm-recent-projects", JSON.stringify(["velox", "ppm"]));
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const before = useProjectStore.getState().recentVersion;
    await useProjectStore.getState().refreshRecent();
    expect(useProjectStore.getState().recentVersion).toBe(before);
    expect(JSON.parse(store.get("ppm-recent-projects")!)).toEqual(["velox", "ppm"]);
  });
});
