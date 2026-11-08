/**
 * Settings → Storage against a stub server: the four blocks render from one overview request,
 * the session trace limits go out as a PUT, and a refusal from the route is shown by the form.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { StorageSettingsSection } = await import("../../../src/web/components/settings/storage-settings-section");

type Req = { method: string; url: string; body: unknown };
interface Answer { status?: number; body: unknown }

const MB = 1024 * 1024;
const TRACE = {
  path: "/home/u/.ppm/session-trace.db",
  sizeBytes: 412 * MB,
  oldestTs: Date.UTC(2026, 9, 1),
  retention_days: 30,
  max_size_mb: 500,
};
const OVERVIEW = {
  appDb: { path: "/home/u/.ppm/ppm.db", sizeBytes: 3 * MB },
  backups: { dir: "/home/u/.ppm-backups", dbStem: "ppm", count: 12, totalBytes: 40 * MB, newest: { name: "ppm-20261108-1800.db", mtimeMs: Date.now() - 5 * 60_000 }, others: [{ dbStem: "ppm.dev", count: 3, totalBytes: 6 * MB }] },
  sessionTrace: TRACE,
};
const AUDIT = { retention_days: 30, max_size_mb: 100, size_bytes: 2048, entry_count: 7 };

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let putAnswer: Answer;

beforeEach(() => {
  requests = [];
  putAnswer = { body: { ok: true, data: { ...TRACE, retention_days: 14, max_size_mb: 200 } } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const reply = (a: Answer) => new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "Content-Type": "application/json" } });
    if (req.method === "GET" && req.url.endsWith("/api/settings/storage")) return reply({ body: { ok: true, data: OVERVIEW } });
    if (req.method === "GET" && req.url.endsWith("/api/settings/query-audit")) return reply({ body: { ok: true, data: AUDIT } });
    if (req.method === "PUT" && req.url.endsWith("/api/settings/session-trace")) return reply(putAnswer);
    return reply({ status: 599, body: { ok: false, error: `no stub for ${req.method} ${req.url}` } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = () => document.body.textContent ?? "";

function inputs(): HTMLInputElement[] {
  return [...document.body.querySelectorAll<HTMLInputElement>('input[type="number"]')];
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The session trace's Save is the first one; the Query Audit block below has its own. */
function traceSave(): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Save")[0];
  if (!found) throw new Error("no Save button");
  return found;
}

describe("Storage pane", () => {
  it("shows the app database, backups, session trace and Query Audit blocks", async () => {
    view = await mount(<StorageSettingsSection />);
    await settle();
    const headings = [...document.body.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual(["App database", "Backups", "Session trace", "Query Audit"]);
    expect(text()).toContain("/home/u/.ppm/ppm.db");
    expect(text()).toContain("3.0 MB");
    expect(text()).toContain("ppm-20261108-1800.db");
    expect(text()).toContain("5m ago");
    expect(text()).toContain("/home/u/.ppm-backups");
    expect(text()).toContain("ppm.dev.db: 3");
    expect(text()).toContain("412 MB of 500 MB");
    // Query Audit still loads its own settings.
    expect(text()).toContain("7 entries");
  });

  it("saves the session trace limits with a PUT and shows the server's answer", async () => {
    view = await mount(<StorageSettingsSection />);
    await settle();
    const [days, size] = inputs();
    await type(days!, "14");
    await type(size!, "200");
    await click(traceSave());
    await settle();
    const puts = requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.body)).toEqual([{ retention_days: 14, max_size_mb: 200 }]);
    expect(inputs()[0]!.value).toBe("14");
    expect(text()).toContain("412 MB of 200 MB");
  });

  it("refuses a size below the floor without asking the server", async () => {
    view = await mount(<StorageSettingsSection />);
    await settle();
    await type(inputs()[1]!, "10");
    await click(traceSave());
    await settle();
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
    expect(text()).toContain("Max size must be a whole number of at least 50 MB.");
  });

  it("shows the route's message when it answers 400", async () => {
    putAnswer = { status: 400, body: { ok: false, error: "max_size_mb is too large" } };
    view = await mount(<StorageSettingsSection />);
    await settle();
    await type(inputs()[0]!, "60");
    await click(traceSave());
    await settle();
    expect(text()).toContain("max_size_mb is too large");
  });
});
