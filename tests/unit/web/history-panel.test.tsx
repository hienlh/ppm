/**
 * The Query tab's History panel against a stubbed `/history`: what an entry shows, a click handing
 * its whole SQL to the editor, the search sent once typing stops, Load more, a read again when a run
 * ends, an answer that came too late left unshown, a failed read offered again, and Escape putting a
 * floating panel away — one opened floating taking the keyboard to its search and giving it back.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
const { act, useState } = await import("react");
const { HistoryPanel } = await import("../../../src/web/components/database/query/history-panel");
type QueryHistoryItem = import("../../../src/shared/db-query-script").QueryHistoryItem;
type DbTarget = import("../../../src/web/lib/db-tabs").DbTarget;

const target: DbTarget = { kind: "connection", connectionId: 5 };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const entry = (id: number, over: Partial<QueryHistoryItem> = {}): QueryHistoryItem => ({
  id, sql: `SELECT ${id}`, status: "ok", error: null, rowCount: 2, durationMs: 7, ranAt: minutesAgo(0), byAgent: false, ...over,
});

let requests: string[] = [];
/** What `/history` answers, by the request's URL; a page of nothing when no rule matches. */
let answer: (url: string) => QueryHistoryItem[] | Error = () => [];
/** Answers held until released, by a part of their URL. */
let gates = new Map<string, Promise<void>>();

beforeEach(() => {
  requests = [];
  answer = () => [];
  gates = new Map();
  installGlobal("fetch", (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/history")) return new Response("{}", { headers: { "Content-Type": "application/json" } });
    requests.push(url);
    const held = [...gates].find(([part]) => url.includes(part));
    if (held) await held[1];
    const items = answer(url);
    const body = items instanceof Error
      ? { ok: false, error: items.message }
      : { ok: true, data: { items, retentionDays: 30, maxSizeMb: 500 } };
    return new Response(JSON.stringify(body), { status: items instanceof Error ? 500 : 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);
});

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const picked: string[] = [];
let closed = 0;
/** Ends a run of the tab, as far as the panel can tell: its `refreshKey` moves on. */
let endRun: () => void = () => {};
/** The tab narrows or widens round the open panel. */
let setFloating: (floating: boolean) => void = () => {};
function Host({ floating: opensFloating }: { floating: boolean }) {
  const [runsEnded, setRunsEnded] = useState(0);
  const [floating, setFloatingNow] = useState(opensFloating);
  endRun = () => setRunsEnded((n) => n + 1);
  setFloating = setFloatingNow;
  return (
    <HistoryPanel
      target={target} refreshKey={runsEnded} floating={floating}
      onPick={(sql) => picked.push(sql)} onClose={() => { closed += 1; }}
    />
  );
}
async function show(floating = false) {
  picked.length = 0;
  closed = 0;
  view = await mount(<Host floating={floating} />);
  await settle();
}
/** Lets the stubbed fetch answer and React draw what it said. */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const panelEl = () => view!.container.querySelector<HTMLElement>('aside[aria-label="Query history"]')!;
const entries = () => [...panelEl().querySelectorAll<HTMLButtonElement>("button[title]")].filter((b) => b.title !== "Close history" && b.title !== "Clear search");
const text = () => panelEl().textContent ?? "";

describe("what the panel shows", () => {
  it("lists entries newest first with their status, when, rows and time, and the audit log's reach", async () => {
    answer = () => [
      entry(3, { sql: "SELECT o.id, u.email\nFROM orders o JOIN users u ON u.id = o.user_id", rowCount: 24, durationMs: 41, database: "shop" }),
      entry(2, { status: "error", sql: "SELECT * FROM order_itemz", error: 'relation "order_itemz" does not exist', rowCount: null, ranAt: minutesAgo(14) }),
      entry(1, { status: "blocked", sql: "DELETE FROM sessions", error: "Connection is readonly", rowCount: null, durationMs: null, byAgent: true }),
    ];
    await show();
    expect(requests).toEqual(["/api/db/connections/5/history"]);
    const [first, second, third] = entries();
    expect(entries()).toHaveLength(3);
    expect(first!.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Ran");
    expect(first!.textContent).toContain("just now · shop · 24 rows · 41 ms");
    expect(second!.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Failed");
    expect(second!.textContent).toContain("14 minutes ago");
    expect(second!.textContent).toContain('relation "order_itemz" does not exist');
    expect(third!.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Blocked");
    expect(third!.textContent).toContain("Blocked: Connection is readonly");
    expect(third!.textContent).toContain("agent");
    expect(first!.textContent).not.toContain("agent");
    expect(text()).toContain("Kept as long as audit settings say (30 days / 500 MB).");
  });

  it("says when nothing has run, and when nothing matches the search", async () => {
    await show();
    expect(text()).toContain("Nothing has been run here yet.");
    const input = panelEl().querySelector<HTMLInputElement>('input[aria-label="Search history"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
    await settle();
    expect(text()).toContain("No query run here matches.");
  });
});

describe("using it", () => {
  it("hands the whole SQL of the entry clicked to the editor", async () => {
    const sql = "SELECT o.id, u.email\nFROM orders o\nJOIN users u ON u.id = o.user_id\nWHERE o.total > 100";
    answer = () => [entry(1, { sql })];
    await show();
    await click(entries()[0]!);
    expect(picked).toEqual([sql]);
  });

  it("searches once typing stops, not on every key", async () => {
    await show();
    const input = panelEl().querySelector<HTMLInputElement>('input[aria-label="Search history"]')!;
    const type = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("us");
    await type("users");
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(requests).toHaveLength(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    await settle();
    expect(requests).toEqual(["/api/db/connections/5/history", "/api/db/connections/5/history?search=users"]);
  });

  it("reads the next page from where the list ends, without repeating an entry pushed into it", async () => {
    answer = (url) => (url.includes("offset=50")
      ? [entry(51), entry(50), entry(49)]
      : Array.from({ length: 50 }, (_, i) => entry(100 - i)));
    await show();
    expect(entries()).toHaveLength(50);
    const more = [...panelEl().querySelectorAll("button")].find((b) => b.textContent === "Load more")!;
    await click(more);
    await settle();
    expect(requests.at(-1)).toBe("/api/db/connections/5/history?offset=50");
    // 51 was the page's last entry already: the list grows by the two it did not have.
    expect(entries().map((b) => b.title).slice(-3)).toEqual(["SELECT 51", "SELECT 50", "SELECT 49"]);
    expect(entries()).toHaveLength(52);
    expect([...panelEl().querySelectorAll("button")].some((b) => b.textContent === "Load more")).toBe(false);
  });

  it("reads each next page from where the list ends, and a page that failed again from there", async () => {
    let failing = false;
    answer = (url) => {
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
      if (offset === 100 && failing) return new Error("audit log locked");
      return Array.from({ length: offset < 100 ? 50 : 1 }, (_, i) => entry(1000 - offset - i));
    };
    await show();
    const loadMore = () => click([...panelEl().querySelectorAll("button")].find((b) => b.textContent === "Load more")!);
    await loadMore();
    await settle();
    expect(entries()).toHaveLength(100);
    failing = true;
    await loadMore();
    await settle();
    expect(requests.at(-1)).toBe("/api/db/connections/5/history?offset=100");
    expect(panelEl().querySelector('[role="alert"]')!.textContent).toBe("Could not read the history: audit log locked");
    failing = false;
    await click([...panelEl().querySelectorAll("button")].find((b) => b.textContent === "Try again")!);
    await settle();
    expect(requests.at(-1)).toBe("/api/db/connections/5/history?offset=100");
    expect(entries()).toHaveLength(101);
  });

  it("reads the list again when a run of the tab ends, the run at its top", async () => {
    let runs = 1;
    answer = () => Array.from({ length: runs }, (_, i) => entry(runs - i));
    await show();
    expect(entries().map((b) => b.title)).toEqual(["SELECT 1"]);
    runs = 2;
    await act(async () => { endRun(); });
    await settle();
    expect(requests).toEqual(["/api/db/connections/5/history", "/api/db/connections/5/history"]);
    expect(entries().map((b) => b.title)).toEqual(["SELECT 2", "SELECT 1"]);
  });

  it("shows only the latest answer when an older one comes back after it", async () => {
    let release!: () => void;
    gates.set("search=old", new Promise<void>((r) => { release = r; }));
    answer = (url) => (url.includes("search=old") ? [entry(1, { sql: "SELECT old" })] : url.includes("search=new") ? [entry(2, { sql: "SELECT new" })] : []);
    await show();
    const input = panelEl().querySelector<HTMLInputElement>('input[aria-label="Search history"]')!;
    const type = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
    });
    await type("old");
    await type("new");
    await settle();
    expect(entries().map((b) => b.title)).toEqual(["SELECT new"]);
    release();
    await settle();
    expect(entries().map((b) => b.title)).toEqual(["SELECT new"]);
  });

  it("offers a failed read again, from the same place", async () => {
    let fail = true;
    answer = () => (fail ? new Error("audit log locked") : [entry(1)]);
    await show();
    expect(panelEl().querySelector('[role="alert"]')!.textContent).toBe("Could not read the history: audit log locked");
    fail = false;
    await click([...panelEl().querySelectorAll("button")].find((b) => b.textContent === "Try again")!);
    await settle();
    expect(requests).toEqual(["/api/db/connections/5/history", "/api/db/connections/5/history"]);
    expect(entries()).toHaveLength(1);
    expect(panelEl().querySelector('[role="alert"]')).toBeNull();
  });

  it("is put away by its close button, and by Escape only while it floats", async () => {
    const escape = () => act(async () => { panelEl().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await show();
    await click(panelEl().querySelector('button[aria-label="Close history"]'));
    expect(closed).toBe(1);
    // Beside the editor, Escape is the editor's or the grid's, not the panel's.
    await escape();
    expect(closed).toBe(1);
    await view!.unmount();
    await show(true);
    await escape();
    expect(closed).toBe(1);
  });

  /** A button outside the panel with the keyboard, as the toolbar's History has it once clicked. */
  async function withOpener(body: (opener: HTMLButtonElement) => Promise<void>) {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    try { await body(opener); } finally { opener.remove(); }
  }
  const searchInput = () => panelEl().querySelector('input[aria-label="Search history"]');

  it("opened floating, has the keyboard in its search, and gives it back when put away", async () => {
    await withOpener(async (opener) => {
      await show(true);
      expect(document.activeElement).toBe(searchInput());
      await act(async () => { searchInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(closed).toBe(1);
      expect(document.activeElement).toBe(opener);

      await view!.unmount();
      opener.focus();
      await show(true);
      expect(document.activeElement).toBe(searchInput());
      await click(panelEl().querySelector('button[aria-label="Close history"]'));
      expect(closed).toBe(1);
      expect(document.activeElement).toBe(opener);
    });
  });

  it("leaves the keyboard where it is beside the editor, and when it comes to float as the tab narrows", async () => {
    await withOpener(async (opener) => {
      await show(false);
      expect(document.activeElement).toBe(opener);
      await act(async () => { setFloating(true); });
      expect(document.activeElement).toBe(opener);
      await act(async () => { panelEl().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(closed).toBe(1);
    });
  });
});
