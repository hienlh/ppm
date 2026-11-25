import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { act } from "react";

installDom();
afterAll(uninstallDom);
const { SearchPanel } = await import("../../../src/web/components/explorer/search-panel");
const { createSearchClient } = await import("../../../src/web/lib/search/search-client");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useSearchStore } = await import("../../../src/web/stores/search-store");

// The panel searches with plain `fetch` through its client (`search-client.ts`), so the fake is a
// `fetch`: every real search waits in `pending` until the test answers it; the warm-up (`q=`) is
// answered at once. An aborted search rejects, as a browser's does.
interface Pending { resolve: (data: unknown, status?: number) => void; reject: (e: unknown) => void }
let view: Mounted | null;
let visibility: ReturnType<typeof spyOn>;
let events: unknown[];
let pending: Pending[];
let client: ReturnType<typeof createSearchClient>;
const observe = (e: Event) => events.push((e as CustomEvent).detail);
const empty = { results: [], total: 0, files: 0, limitHit: false, engine: "rg" };
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  if (new URL(url, "http://x").searchParams.get("q") === "") return Promise.resolve(json({ ok: true, data: empty }, 200));
  return new Promise((resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    pending.push({
      resolve: (data, status = 200) =>
        resolve(status === 200 ? json({ ok: true, data }, 200) : json({ ok: false, error: data }, status)),
      reject,
    });
  });
}

beforeEach(() => {
  events = []; pending = []; view = null;
  useSearchStore.setState({ projects: {} } as any);
  useProjectStore.setState({ activeProject: { name: "tour-test", path: "/tmp/tour-test" } as any });
  client = createSearchClient({ fetch: fakeFetch as typeof fetch });
  // happy-dom has no layout; visibility is exercised in browser smoke tests.
  visibility = spyOn(Element.prototype, "checkVisibility").mockReturnValue(true);
  window.addEventListener("ppm:onboarding-evidence", observe);
});
afterEach(async () => {
  await view?.unmount(); visibility.mockRestore();
  window.removeEventListener("ppm:onboarding-evidence", observe);
});
async function type(text: string) {
  const input = view!.container.querySelector<HTMLInputElement>('input[aria-label="Search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function debounce() { await act(async () => { await new Promise((r) => setTimeout(r, 330)); }); }

it("ignores a stale search during the debounce gap and accepts successful zero results", async () => {
  view = await mount(<SearchPanel client={client} />);
  await type("old"); await debounce();
  expect(pending).toHaveLength(1);
  await type("new");
  await act(async () => { pending[0]!.resolve(empty); });
  expect(events).toHaveLength(0);
  await debounce();
  await act(async () => { pending[1]!.resolve(empty); });
  expect(events).toEqual([expect.objectContaining({ type: "search-succeeded", projectName: "tour-test" })]);
  expect(view.container.textContent).toContain("No results");
});

it("distinguishes request errors from empty success and retries explicitly", async () => {
  view = await mount(<SearchPanel client={client} />);
  await type("readme"); await debounce();
  await act(async () => { pending[0]!.reject(new Error("offline")); });
  expect(events).toHaveLength(0);
  expect(view.container.textContent).toContain("Search failed");
  expect(view.container.textContent).not.toContain("No results");
  await click(view.container.querySelector('[role="alert"] button'));
  await act(async () => { pending[1]!.resolve(empty); });
  expect(events).toHaveLength(1);
});

it("does not complete the step from a hidden search panel", async () => {
  view = await mount(<SearchPanel client={client} />);
  visibility.mockReturnValue(false);
  await type("ab"); await debounce();
  await act(async () => { pending[0]!.resolve(empty); });
  expect(events).toHaveLength(0);
});

it("invalidates the old project's response and permits a valid one-character regex", async () => {
  view = await mount(<SearchPanel client={client} />);
  await type("readme"); await debounce();
  await act(async () => {
    useProjectStore.setState({ activeProject: { name: "other", path: "/tmp/other" } as any });
    pending[0]!.resolve(empty);
  });
  // Let the old-project response and the render both settle before checking.
  await debounce();
  expect(events).toHaveLength(0);
  await click(view.container.querySelector('button[title="Use Regular Expression (Alt+R)"]'));
  await type("["); await debounce();
  await act(async () => { pending.at(-1)!.resolve("Invalid regex: unclosed character class", 400); });
  expect(view.container.textContent).toContain("Invalid regex");
  const previousRequests = pending.length;
  await type("."); await debounce();
  expect(pending.length).toBe(previousRequests + 1);
  await act(async () => { pending.at(-1)!.resolve(empty); });
  expect(events).toEqual([expect.objectContaining({ projectName: "other", type: "search-succeeded" })]);
});
