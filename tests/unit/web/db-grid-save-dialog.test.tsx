/**
 * DBGate's Save changes for a grid's rows, against a stub server: the script read from
 * `changeset/preview` and shown before anything runs, OK sending the changes to
 * `changeset/apply` with the tables ticked under "Delete references CASCADE", a refusal keeping
 * the dialog open with the database's words, Don't ask again, and Open script. What the grid is
 * told is the promise `requestGridSave` answers: the result once saved, `GridSaveCancelled`
 * otherwise — which is what keeps its changes.
 *
 * Monaco does not run here, so the script box is replaced by one that shows its text — only
 * while this file runs: `mock.module` outlives it, and other suites render the real one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { resolve } from "node:path";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { toast } = await import("sonner");

const SQL_OBJECT_TAB = resolve(import.meta.dir, "../../../src/web/components/database/sql-object/sql-object-tab.tsx");
const realSqlObjectTab = { ...(await import(SQL_OBJECT_TAB)) };
let stubbing = true;
afterAll(() => { stubbing = false; });
const RealReadOnlySql = realSqlObjectTab.ReadOnlySql as (p: { sql: string }) => React.ReactNode;
mock.module(SQL_OBJECT_TAB, () => ({
  ...realSqlObjectTab,
  ReadOnlySql: (p: { sql: string }) => (stubbing ? <pre data-script="">{p.sql}</pre> : <RealReadOnlySql {...p} />),
}));

const { GridSaveHost } = await import("../../../src/web/components/database/grid/grid-save-host.tsx");
const { GridSaveCancelled, endGridSave, requestGridSave, useGridSave } = await import("../../../src/web/components/database/grid/grid-save-store.ts");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
type GridSaveRequest = import("../../../src/web/components/database/grid/grid-save-store.ts").GridSaveRequest;
type ChangesetPreview = import("../../../src/shared/db-changeset").ChangesetPreview;

type Req = { url: string; body: Record<string, unknown> };
let requests: Req[] = [];
/** What the stub server answers to a preview, and to each apply in turn. */
let preview: () => Response;
let applies: (() => Response | Promise<Response>)[] = [];
const realFetch = globalThis.fetch;
const realWidth = window.innerWidth;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const previewOf = (p: ChangesetPreview) => () => json(200, { ok: true, data: p });
const APPLIED = { inserted: 1, updated: 1, deleted: 0, cascaded: 0, executionTimeMs: 12 };

const CHANGES = { inserts: [{ name: "Dee" }], updates: [{ key: { id: 1 }, set: { name: "Ann" }, original: { name: "Anna" } }], deletes: [] };
const REQUEST: GridSaveRequest = { target: { kind: "connection", connectionId: 5 }, place: null, table: "users", schema: "public", changes: CHANGES };
const PLAIN: ChangesetPreview = { script: `INSERT INTO "users" ("name") VALUES ('Dee');\nUPDATE "users" SET "name" = 'Ann' WHERE "id" = 1;`, statementCount: 2, references: [] };
const DELETING: ChangesetPreview = {
  script: `DELETE FROM "users" WHERE "id" = 1;`,
  statementCount: 1,
  references: [
    { schema: "public", table: "order_items", paths: [["order_items", "orders", "users"]], cascadesInDb: false, script: `DELETE FROM "order_items" WHERE …;` },
    { schema: "public", table: "orders", paths: [["orders", "users"]], cascadesInDb: true, script: `DELETE FROM "orders" WHERE …;` },
  ],
};

let success: ReturnType<typeof spyOn>;
beforeEach(() => {
  requests = [];
  applies = [];
  preview = previewOf(PLAIN);
  localStorage.clear();
  useGridSave.setState({ pending: null, seq: 0 });
  success = spyOn(toast, "success").mockImplementation(() => 0);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    requests.push(req);
    if (req.url.includes("/changeset/preview")) return preview();
    if (req.url.includes("/changeset/apply")) return (applies.shift() ?? (() => json(200, { ok: true, data: APPLIED })))();
    return json(404, { ok: false, error: `no stub for ${req.url}` });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  success.mockRestore();
  globalThis.fetch = realFetch;
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

const settle = () => act(async () => { await Bun.sleep(5); });
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const script = () => document.body.querySelector("[data-script]")?.textContent ?? null;
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;
const checkbox = (title: string) => [...document.body.querySelectorAll("label")].find((l) => l.querySelector("b")?.textContent === title)?.querySelector("input") ?? null;
/** An element as its markup, or null: a failed assertion then prints the markup, not the whole DOM behind it. */
const html = (el: Element | null | undefined) => el?.outerHTML ?? null;
const applied = () => requests.filter((r) => r.url.includes("/changeset/apply")).map((r) => r.body);
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
/** An answer held back until the test lets it go: what is on screen while the server works. */
function held(answer: () => Response) {
  let release!: () => void;
  const response = new Promise<Response>((done) => { release = () => done(answer()); });
  return { respond: () => response, release: () => act(async () => { release(); await Bun.sleep(5); }) };
}
const DELETE_ONE = { ...REQUEST, changes: { inserts: [], updates: [], deletes: [{ key: { id: 1 } }] } };
// What the server says when the database refuses a statement: its own words, the statement, and that nothing was written.
const REFUSED = `Statement 1 of 1 failed: update or delete on table "users" violates foreign key constraint "orders_user_id_fkey" on table "orders". Nothing was saved.\nDELETE FROM "users" WHERE "id" = 1`;

/** A save asked for, with the host mounted as the app mounts it; what the grid would be told. */
async function save(request: GridSaveRequest = REQUEST) {
  view ??= await mount(<GridSaveHost />);
  const outcome: { result?: unknown; error?: unknown } = {};
  await act(async () => {
    void requestGridSave(request).then((result) => { outcome.result = result; }, (error) => { outcome.error = error; });
    await Bun.sleep(5);
  });
  await settle();
  return outcome;
}

describe("Save changes", () => {
  it("shows the script the server wrote, and runs it on OK as one changeset", async () => {
    const outcome = await save();
    expect(dialog()!.textContent).toContain("Save changes");
    expect(requests.map((r) => r.url)).toEqual(["/api/db/connections/5/changeset/preview"]);
    expect(requests[0]!.body).toEqual({ table: "users", schema: "public", ...CHANGES });
    expect(script()).toBe(PLAIN.script);
    // Nothing to cascade: no CASCADE box, and Don't ask again instead.
    expect(html(checkbox("Delete references CASCADE"))).toBeNull();
    expect(html(checkbox("Don't ask again"))).not.toBeNull();
    await click(button("OK"));
    await settle();
    expect(applied()).toEqual([{ table: "users", schema: "public", ...CHANGES }]);
    expect(outcome.result).toEqual(APPLIED);
    expect(success.mock.calls.at(-1)?.[0]).toBe("2 changes saved in one transaction · 12 ms");
    expect(html(dialog())).toBeNull();
  });

  it("saves nothing on Close or Esc, and tells the grid so: it keeps its changes", async () => {
    for (const shut of [() => click(button("Close")), () => press(dialog()!, "Escape")]) {
      const outcome = await save();
      await shut();
      await settle();
      expect(outcome.error).toBeInstanceOf(GridSaveCancelled);
      expect(html(dialog())).toBeNull();
    }
    expect(applied()).toEqual([]);
  });

  it("runs on Enter, except from a button, which answers Enter itself, or with a modifier held", async () => {
    await save();
    await press(button("Close")!, "Enter");
    await press(dialog()!, "Enter", { shiftKey: true });
    await press(dialog()!, "Enter", { ctrlKey: true });
    expect(applied()).toEqual([]);
    await press(checkbox("Don't ask again")!, "Enter");
    await settle();
    expect(applied()).toHaveLength(1);
  });

  it("opens with the focus on itself, so the Enter that follows runs OK and not the button it would have landed on", async () => {
    await save();
    expect(document.activeElement).toBe(dialog());
    await press(document.activeElement!, "Enter");
    await settle();
    expect(applied()).toHaveLength(1);
  });

  it("hands the focus back to what had it, however it closes: a save asked for by a key has no trigger to go back to", async () => {
    // The grid, or the form, Ctrl+S was pressed in: without the focus its keys are gone.
    const opener = document.createElement("div");
    opener.tabIndex = 0;
    document.body.appendChild(opener);
    try {
      for (const shut of [() => click(button("OK")), () => click(button("Close")), () => press(dialog()!, "Escape")]) {
        opener.focus();
        await save();
        expect(document.activeElement).toBe(dialog());
        await shut();
        await settle();
        expect(html(dialog())).toBeNull();
        expect(document.activeElement).toBe(opener);
      }
    } finally {
      opener.remove();
    }
  });

  it("takes one save at a time: another asked for meanwhile is turned away", async () => {
    const first = await save();
    let second: unknown = null;
    await act(async () => { await requestGridSave({ ...REQUEST, table: "orders" }).catch((e: unknown) => { second = e; }); });
    expect(second).toBeInstanceOf(GridSaveCancelled);
    await click(button("OK"));
    await settle();
    expect(first.result).toEqual(APPLIED);
    expect(applied().map((b) => b.table)).toEqual(["users"]);
  });

  it("never lets a dialog's late answer end the save after it", async () => {
    await save();
    const { seq } = useGridSave.getState().pending!;
    await click(button("Close"));
    const next = await save();
    await act(async () => { endGridSave(seq, APPLIED); await Bun.sleep(5); });
    expect(next).toEqual({});
    expect(html(dialog())).not.toBeNull();
  });
});

describe("Delete references CASCADE", () => {
  beforeEach(() => { preview = previewOf(DELETING); });

  it("lists each table still pointing at the rows deleted, and puts the ticked ones' DELETEs first", async () => {
    await save(DELETE_ONE);
    expect(html(checkbox("Don't ask again"))).toBeNull();
    expect(script()).toBe(DELETING.script);
    expect(html(document.body.querySelector('[aria-label="Tables to delete from first"]'))).toBeNull();
    await click(checkbox("Delete references CASCADE"));
    // Every table ticked at first, deepest first: the order their deletes run in.
    const rows = [...document.body.querySelectorAll('[aria-label="Tables to delete from first"] li')].map((li) => li.textContent);
    expect(rows).toEqual([
      "order_itemsorder_items → orders → users",
      "ordersorders → users · ON DELETE CASCADE in the database already",
    ]);
    expect(script()).toBe([DELETING.references[0]!.script, DELETING.references[1]!.script, DELETING.script].join("\n"));
    await click(checkbox("order_items"));
    expect(script()).toBe([DELETING.references[1]!.script, DELETING.script].join("\n"));
    await click(button("Uncheck all"));
    expect(script()).toBe(DELETING.script);
    await click(button("Check all"));
    await click(checkbox("orders"));
    await click(button("OK"));
    await settle();
    expect(applied()[0]!.cascade).toEqual([{ schema: "public", table: "order_items" }]);
  });

  it("keeps the dialog open on a refusal, in the server's words, so a table can be ticked and OK pressed again", async () => {
    applies = [() => json(400, { ok: false, error: REFUSED, data: { statementIndex: 0, statementCount: 1, sql: `DELETE FROM "users" WHERE "id" = 1` } })];
    const outcome = await save(DELETE_ONE);
    await click(button("OK"));
    await settle();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe(REFUSED);
    expect(script()).toBe(DELETING.script);
    expect(outcome).toEqual({});
    await click(checkbox("Delete references CASCADE"));
    await click(button("OK"));
    await settle();
    expect(applied().map((b) => b.cascade)).toEqual([undefined, [{ schema: "public", table: "order_items" }, { schema: "public", table: "orders" }]]);
    expect(outcome.result).toEqual(APPLIED);
  });
});

describe("Don't ask again", () => {
  it("runs the next save straight away, showing nothing, unless it deletes rows others point at", async () => {
    await save();
    await click(checkbox("Don't ask again"));
    await click(button("OK"));
    await settle();
    const answer = held(() => json(200, { ok: true, data: APPLIED }));
    applies = [answer.respond];
    const quiet = await save();
    expect(applied()).toHaveLength(2);
    expect(html(dialog())).toBeNull();
    await answer.release();
    expect(quiet.result).toEqual(APPLIED);
    expect(success.mock.calls.at(-1)?.[0]).toBe("2 changes saved in one transaction · 12 ms");
    preview = previewOf(DELETING);
    await save();
    expect(html(dialog())).not.toBeNull();
    expect(applied()).toHaveLength(2);
  });

  it("is kept only by an OK that saved with it ticked", async () => {
    // OK with it unticked, Close with it ticked, an OK that failed with it ticked: each asks again.
    await save();
    await click(button("OK"));
    await settle();
    await save();
    await click(checkbox("Don't ask again"));
    await click(button("Close"));
    await settle();
    applies = [() => json(500, { ok: false, error: "connection reset" })];
    await save();
    await click(checkbox("Don't ask again"));
    await click(button("OK"));
    await settle();
    expect(dialog()!.textContent).toContain("connection reset");
    await click(button("Close"));
    await settle();
    await save();
    expect(html(dialog())).not.toBeNull();
    expect(applied()).toHaveLength(2);
  });

  it("shows the dialog after all when a save it skipped is refused, or its script cannot be read", async () => {
    localStorage.setItem("ppm-db-save-dont-ask", "1");
    const stale = "Statement 2 of 2 failed: The row was changed or deleted by someone else since it was loaded. Nothing was saved. Reload to see its current values.\nUPDATE …";
    applies = [() => json(409, { ok: false, error: stale, data: { statementIndex: 1, statementCount: 2, sql: "UPDATE …", affected: 0 } })];
    const refused = await save();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe(stale);
    expect(refused).toEqual({});
    await click(button("Close"));
    await settle();
    preview = () => json(500, { ok: false, error: "connection reset" });
    await save();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe("connection reset");
  });
});

describe("what else the dialog does", () => {
  it("opens the script it shows in a new Query tab, and saves nothing", async () => {
    usePanelStore.setState({
      currentProject: "p", focusedPanelId: "left", grid: [["left"]], lastFocusedChatProviders: {},
      panels: { left: { id: "left", activeTabId: null, tabHistory: [], tabs: [] } },
    } as never);
    preview = previewOf(DELETING);
    const place = { target: REQUEST.target, connectionName: "shop", dbType: "postgres" as const };
    const outcome = await save({ ...DELETE_ONE, place });
    await click(checkbox("Delete references CASCADE"));
    await click(checkbox("order_items"));
    await click(button("Open script"));
    await settle();
    const tabs = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs);
    expect(tabs.map((t) => [t.type, t.metadata?.currentSql, t.metadata?.runOnOpen])).toEqual([
      ["db-query", [DELETING.references[1]!.script, DELETING.script].join("\n"), undefined],
    ]);
    expect(applied()).toEqual([]);
    expect(outcome.error).toBeInstanceOf(GridSaveCancelled);
  });

  it("has no Open script where there is nowhere to open it", async () => {
    await save();
    expect(html(button("Open script"))).toBeNull();
  });

  it("says why when the script cannot be read, with nothing for OK to run", async () => {
    preview = () => json(404, { ok: false, error: `Table "public.users" not found` });
    const outcome = await save();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe(`Table "public.users" not found`);
    expect(button("OK")!.disabled).toBe(true);
    await press(dialog()!, "Enter");
    await click(button("Close"));
    await settle();
    expect(outcome.error).toBeInstanceOf(GridSaveCancelled);
    expect(applied()).toEqual([]);
  });

  it("changes nothing and cannot be closed while the script runs", async () => {
    preview = previewOf(DELETING);
    const answer = held(() => json(200, { ok: true, data: APPLIED }));
    applies = [answer.respond];
    const outcome = await save({ ...DELETE_ONE, place: { target: REQUEST.target } });
    await click(checkbox("Delete references CASCADE"));
    await click(button("OK"));
    expect(button("Saving…")!.disabled).toBe(true);
    expect(button("Close")!.disabled).toBe(true);
    expect(button("Open script")!.disabled).toBe(true);
    expect([...dialog()!.querySelectorAll("input"), button("Check all")!, button("Uncheck all")!].every((c) => c.disabled)).toBe(true);
    expect(script()).toBe([DELETING.references[0]!.script, DELETING.references[1]!.script, DELETING.script].join("\n"));
    await press(dialog()!, "Escape");
    await press(dialog()!, "Enter");
    await answer.release();
    expect(applied()).toHaveLength(1);
    expect(outcome.result).toEqual(APPLIED);
  });

  it("leaves Don't ask again as it was while the script runs", async () => {
    const answer = held(() => json(200, { ok: true, data: APPLIED }));
    applies = [answer.respond];
    await save();
    await click(button("OK"));
    expect(checkbox("Don't ask again")!.disabled).toBe(true);
    await answer.release();
  });

  it("starts every save afresh: what was ticked for one is not ticked for the next", async () => {
    preview = previewOf(DELETING);
    const first = await save(DELETE_ONE);
    await click(checkbox("Delete references CASCADE"));
    await click(checkbox("order_items"));
    // The grid asks again the moment the first is closed, before anything is drawn in between.
    await act(async () => {
      button("Close")!.click();
      requestGridSave(DELETE_ONE).catch(() => {});
      await Bun.sleep(5);
    });
    await settle();
    expect(first.error).toBeInstanceOf(GridSaveCancelled);
    expect(checkbox("Delete references CASCADE")!.checked).toBe(false);
    await click(checkbox("Delete references CASCADE"));
    expect(checkbox("order_items")!.checked).toBe(true);
  });

  it("is a bottom sheet on a phone, with OK the widest button at its foot", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    await save();
    const sheet = dialog()!;
    const foot = sheet.lastElementChild!;
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["OK", "Close"]);
    expect(button("OK")!.className).toContain("flex-[2]");
    expect(button("OK")!.className).toContain("h-11");
  });
});
