/**
 * A Structure or SQL tab shows a read of the database. A change saved from the tree — a column
 * dropped, the table renamed — has to reach the tab that shows that table, or it keeps drawing a
 * column that no longer exists: right away when the tab is in view, when it is next shown
 * otherwise, and never for a change on another connection. And `reload()`, which the table
 * editor waits on before it lets go of a saved edit, must not resolve before the new read is on
 * screen, or the table flashes back to how it was before the save.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act, useState } = await import("react");
const { useDbRead } = await import("../../../src/web/components/database/use-db-read");
const { useDbExplorer, _resetDbExplorer } = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
type DbTarget = import("../../../src/web/lib/db-tabs").DbTarget;

const realFetch = globalThis.fetch;
let reads: string[] = [];
let version = 0;
/** Answers held until released, by a part of their URL: to see what is on screen while a read is out. */
let gates = new Map<string, Promise<void>>();

beforeEach(() => {
  reads = [];
  version = 0;
  gates = new Map();
  _resetDbExplorer();
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    // Only this file's reads count: a UI pref an earlier file saved goes out 400 ms later and
    // can land here (settings-store's debounced `/api/settings/ui-prefs`).
    if (!url.includes("/structure")) return new Response("{}", { headers: { "Content-Type": "application/json" } });
    reads.push(url);
    const answer = ++version;
    const held = [...gates].find(([part]) => url.includes(part));
    if (held) await held[1];
    return new Response(JSON.stringify({ ok: true, data: { version: answer } }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);
});

type Read = ReturnType<typeof useDbRead<{ version: number }>>;
const seen: { current: Read | null } = { current: null };

function Probe({ target, tabId }: { target: DbTarget; tabId: string }) {
  const r = useDbRead<{ version: number }>(target, "/structure?table=users", tabId);
  seen.current = r;
  return <span>{r.data ? `v${r.data.version}` : "…"}</span>;
}

const onConn = (connectionId: number): DbTarget => ({ kind: "connection", connectionId });
/** One Structure tab per table: a database tab's id is its place, so two with the same metadata are one tab. */
const openTab = (table: string) => useTabStore.getState().openTab({
  type: "db-structure", title: table, projectId: null, closable: true, metadata: { connectionId: 1, schemaName: "", tableName: table },
});
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
/** What `refreshAfterStructureChange` records for connection `id`. */
const structureSaved = (id: number) => act(async () => {
  useDbExplorer.setState((s) => ({ structureChanges: { ...s.structureChanges, [id]: (s.structureChanges[id] ?? 0) + 1 } }));
});

describe("a database tab after a structure change", () => {
  it("in view reads again at once", async () => {
    const tab = openTab("users");
    view = await mount(<Probe target={onConn(1)} tabId={tab} />);
    await settle();
    expect(view.container.textContent).toBe("v1");
    await structureSaved(1);
    await settle();
    expect(reads).toHaveLength(2);
    expect(view.container.textContent).toBe("v2");
  });

  it("does not read for a change on another connection", async () => {
    const tab = openTab("users");
    view = await mount(<Probe target={onConn(1)} tabId={tab} />);
    await settle();
    await structureSaved(2);
    await settle();
    expect(reads).toHaveLength(1);
  });

  it("out of view waits until it is shown, and reads once then", async () => {
    const tab = openTab("users");
    view = await mount(<Probe target={onConn(1)} tabId={tab} />);
    await settle();
    await act(async () => { openTab("other"); });
    await structureSaved(1);
    await settle();
    expect(reads).toHaveLength(1);
    await act(async () => { useTabStore.getState().setActiveTab(tab); });
    await settle();
    expect(reads).toHaveLength(2);
    expect(view.container.textContent).toBe("v2");
  });

  it("a file tab has no connection to hear about", async () => {
    const tab = openTab("notes");
    view = await mount(<Probe target={{ kind: "file", path: "/data/notes.db" }} tabId={tab} />);
    await settle();
    await structureSaved(0);
    await structureSaved(-1);
    await settle();
    expect(reads).toHaveLength(1);
  });
});

describe("reload()", () => {
  it("resolves only once the read it asked for is on screen", async () => {
    const tab = openTab("users");
    view = await mount(<Probe target={onConn(1)} tabId={tab} />);
    await settle();
    let release!: () => void;
    gates.set("table=users", new Promise<void>((r) => { release = r; }));
    let done = false;
    await act(async () => { void seen.current!.reload().then(() => { done = true; }); });
    await settle();
    expect(done).toBe(false);
    expect(view.container.textContent).toBe("v1");
    await act(async () => { release(); });
    await settle();
    expect(done).toBe(true);
    expect(view.container.textContent).toBe("v2");
  });
});

describe("two reads out at once", () => {
  it("only the latest lands, whichever answers last", async () => {
    let showTable!: (table: string) => void;
    function Switching({ tabId }: { tabId: string }) {
      const [table, setTable] = useState("old");
      showTable = setTable;
      const r = useDbRead<{ version: number }>(onConn(1), `/structure?table=${table}`, tabId);
      return <span>{r.data ? `v${r.data.version}` : "…"}</span>;
    }
    let releaseOld!: () => void;
    gates.set("table=old", new Promise<void>((r) => { releaseOld = r; }));
    const tab = openTab("users");
    view = await mount(<Switching tabId={tab} />);
    await act(async () => { showTable("new"); });
    await settle();
    expect(view.container.textContent).toBe("v2");
    await act(async () => { releaseOld(); });
    await settle();
    expect(view.container.textContent).toBe("v2");
  });
});
