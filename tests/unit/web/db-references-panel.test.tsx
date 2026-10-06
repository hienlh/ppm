/**
 * DBGate's References list, beside a table's grid and in a phone's Columns and filters sheet: the
 * tables this table's keys point at and those whose keys point at it, each named by its key's
 * columns, searchable, with the one shown under the grid lit. The reference data has its own tests
 * (`db-references.test.ts`); this is the list a user clicks.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { ReferencesSection } = await import("../../../src/web/components/database/grid/references-panel");
const { tableReferences } = await import("../../../src/web/components/database/grid/references");
type GridReference = import("../../../src/web/components/database/grid/references").GridReference;
type DbForeignKey = import("../../../src/shared/db-structure").DbForeignKey;

const fk = (over: Partial<DbForeignKey>): DbForeignKey => ({
  name: "fk", schema: "shop", table: "orders", columns: ["user_id"], refSchema: "shop", refTable: "users", refColumns: ["id"],
  onDelete: "NO ACTION", onUpdate: "NO ACTION", ...over,
});

// users holds team_id → teams and plan_id → plans; orders and invoices point at it.
const REFS = tableReferences({
  foreignKeys: [
    fk({ name: "users_team", table: "users", columns: ["team_id"], refTable: "teams" }),
    fk({ name: "users_plan", table: "users", columns: ["plan_id"], refTable: "plans" }),
  ],
  references: [
    fk({ name: "orders_user", table: "orders", columns: ["user_id"] }),
    fk({ name: "invoices_user", table: "invoices", columns: ["billed_to"] }),
  ],
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

interface Shown {
  open?: GridReference | null;
  sheet?: boolean;
  collapsed?: boolean;
}
const opened: GridReference[] = [];
const collapses: boolean[] = [];
async function show({ open = null, sheet = false, collapsed = false }: Shown = {}) {
  opened.length = 0;
  collapses.length = 0;
  view = await mount(
    <ReferencesSection table="users" references={REFS} open={open} sheet={sheet} collapsed={collapsed}
      onOpen={(r) => opened.push(r)} onCollapsedChange={(c) => collapses.push(c)} />,
  );
}

const list = () => view!.container.querySelector('[role="list"]');
/** The list as read: group headings, and each table with its key columns. */
const lines = () => [...(list()?.children ?? [])].map((el) => el.textContent?.replace(/\s+/g, " ").trim());
const item = (table: string) => [...view!.container.querySelectorAll<HTMLButtonElement>('[role="listitem"] button')]
  .find((b) => b.textContent?.startsWith(`${table} `)) ?? null;
const search = () => view!.container.querySelector<HTMLInputElement>('input[aria-label="Search references"]')!;
async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the References list", () => {
  it("lists the tables the keys point at, then the tables pointing here, each with its count and key columns", async () => {
    await show();
    expect(list()?.getAttribute("aria-label")).toBe("References of users");
    expect(lines()).toEqual([
      "References tables (2)", "teams (team_id)", "plans (plan_id)",
      "Dependent tables (2)", "orders (user_id)", "invoices (billed_to)",
    ]);
  });

  it("leaves out a group with nothing in it", async () => {
    view = await mount(
      <ReferencesSection table="orders" references={{ out: REFS.in.slice(0, 1), in: [] }} open={null}
        collapsed={false} onOpen={() => {}} onCollapsedChange={() => {}} />,
    );
    expect(lines()).toEqual(["References tables (1)", "orders (user_id)"]);
  });

  it("shows the one it is handed under the grid when clicked", async () => {
    await show();
    await click(item("orders"));
    expect(opened).toEqual([REFS.in[0]!]);
    await click(item("teams"));
    expect(opened.map((r) => r.table)).toEqual(["orders", "teams"]);
  });

  it("lights the reference shown under the grid, and only that one", async () => {
    await show({ open: REFS.in[1]! });
    const pressed = [...view!.container.querySelectorAll('[role="listitem"] button')].map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["false", "false", "false", "true"]);
    expect(item("invoices")?.className).toContain("bg-accent-wash");
    expect(item("orders")?.className).not.toContain("bg-accent-wash");
  });

  it("says what a click does", async () => {
    await show();
    expect(item("orders")?.title).toBe("Show orders below the grid, following the selected row");
  });

  it("narrows to the tables or key columns holding the search, recounting each group", async () => {
    await show();
    await typeInto(search(), "user");
    expect(lines()).toEqual(["Dependent tables (1)", "orders (user_id)"]);
    // Found by its key column; only a table name is marked.
    expect(list()?.querySelector("mark")).toBeNull();
    await typeInto(search(), " ORD");
    expect(lines()).toEqual(["Dependent tables (1)", "orders (user_id)"]);
    expect(list()?.querySelector("mark")?.textContent).toBe("ord");
    await typeInto(search(), "BILLED");
    expect(lines()).toEqual(["Dependent tables (1)", "invoices (billed_to)"]);
    await typeInto(search(), "  pl ");
    expect(lines()).toEqual(["References tables (1)", "plans (plan_id)"]);
  });

  it("says when nothing matches, naming the search as typed", async () => {
    await show();
    await typeInto(search(), "  zzz ");
    expect(lines()).toEqual(["No reference matches “zzz”."]);
    await click(view!.container.querySelector('button[aria-label="Clear search"]'));
    expect(lines()).toHaveLength(6);
  });

  it("folds away under its header, which says whether it is open", async () => {
    await show();
    const header = view!.container.querySelector<HTMLButtonElement>('section[aria-label="References"] > button')!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await click(header);
    expect(collapses).toEqual([true]);
    await view!.unmount();
    await show({ collapsed: true });
    expect(list()).toBeNull();
    expect(view!.container.querySelector('section[aria-label="References"] > button')?.getAttribute("aria-expanded")).toBe("false");
    await click(view!.container.querySelector('section[aria-label="References"] > button'));
    expect(collapses).toEqual([false]);
  });

  it("scrolls in the height it is given beside the grid; the phone's sheet scrolls as a whole", async () => {
    await show();
    expect(list()?.className).toContain("overflow-auto");
    await view!.unmount();
    view = await mount(
      <ReferencesSection table="users" references={REFS} open={null} sheet grow={false}
        collapsed={false} onOpen={() => {}} onCollapsedChange={() => {}} />,
    );
    expect(list()?.className).not.toContain("overflow-auto");
  });

  it("gives every row a 44px target in a phone's sheet", async () => {
    await show({ sheet: true });
    for (const button of view!.container.querySelectorAll('[role="listitem"] button')) expect(button.className).toContain("h-11");
    await view!.unmount();
    await show();
    expect(item("orders")?.className).not.toContain("h-11");
  });
});
