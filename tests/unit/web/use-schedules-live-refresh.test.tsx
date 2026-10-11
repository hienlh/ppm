/**
 * Settings → Schedules catches up the moment the schedules change elsewhere — the Assistant's
 * tools, another device — instead of on its next 10 s poll: `schedules:changed`, re-dispatched
 * by `use-global-events` as a window event, makes the open list and the open run history read
 * again, and nothing listens once they are gone.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { useSchedules, useScheduleRuns, SCHEDULES_CHANGED_EVENT } = await import("../../../src/web/hooks/use-schedules.ts");
const { act } = await import("react");

const realFetch = globalThis.fetch;
let requests: string[] = [];
let schedules: Array<{ id: number; name: string }> = [];
let runs: Array<{ id: number; status: string }> = [];

beforeEach(() => {
  requests = [];
  schedules = [{ id: 1, name: "first" }];
  runs = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const data = url.includes("/runs") ? runs : schedules;
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

const settle = async () => { await act(async () => { await Bun.sleep(10); }); };
const changed = async () => {
  await act(async () => { window.dispatchEvent(new CustomEvent(SCHEDULES_CHANGED_EVENT, { detail: { type: SCHEDULES_CHANGED_EVENT } })); });
  await settle();
};

describe("schedules live refresh", () => {
  it("re-reads the open list and run history on schedules:changed", async () => {
    let list: Array<{ id: number; name: string }> = [];
    let history: Array<{ id: number; status: string }> = [];
    function Probe() {
      list = useSchedules().schedules as never;
      history = useScheduleRuns(1).runs as never;
      return null;
    }
    view = await mount(<Probe />);
    await settle();
    expect(list.map((s) => s.name)).toEqual(["first"]);
    expect(history).toEqual([]);
    const before = requests.length;

    schedules = [{ id: 1, name: "first" }, { id: 2, name: "made by the Assistant" }];
    runs = [{ id: 9, status: "running" }];
    await changed();
    expect(requests.slice(before).sort()).toEqual(["/api/schedules", "/api/schedules/1/runs?limit=20"]);
    expect(list.map((s) => s.name)).toEqual(["first", "made by the Assistant"]);
    expect(history).toEqual([{ id: 9, status: "running" }]);
  });

  it("stops listening once unmounted", async () => {
    function Probe() {
      useSchedules();
      return null;
    }
    view = await mount(<Probe />);
    await settle();
    await view.unmount();
    view = null;
    const before = requests.length;
    await changed();
    expect(requests.length).toBe(before);
  });
});
