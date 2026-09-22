import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { act } from "react";

installDom();
afterAll(uninstallDom);
const { SearchPanel } = await import("../../../src/web/components/explorer/search-panel");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { api } = await import("../../../src/web/lib/api-client");
let view: Mounted | null;
let get: ReturnType<typeof spyOn>;
let visibility: ReturnType<typeof spyOn>;
let events: unknown[];
let pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[];
const observe = (e: Event) => events.push((e as CustomEvent).detail);

beforeEach(() => {
  events = []; pending = []; view = null;
  useProjectStore.setState({ activeProject: { name: "tour-test", path: "/tmp/tour-test" } as any });
  get = spyOn(api, "get").mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  // happy-dom has no layout; visibility is exercised in browser smoke tests.
  visibility = spyOn(Element.prototype, "checkVisibility").mockReturnValue(true);
  window.addEventListener("ppm:onboarding-evidence", observe);
});
afterEach(async () => {
  await view?.unmount(); get.mockRestore(); visibility.mockRestore();
  window.removeEventListener("ppm:onboarding-evidence", observe);
});
async function type(text: string) {
  const input = view!.container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function debounce() { await act(async () => { await new Promise((r) => setTimeout(r, 330)); }); }

it("ignores a stale search during the debounce gap and accepts successful zero results", async () => {
  view = await mount(<SearchPanel />);
  await type("old"); await debounce();
  expect(pending).toHaveLength(1);
  await type("new");
  await act(async () => { pending[0]!.resolve({ results: [], total: 0 }); });
  expect(events).toHaveLength(0);
  await debounce();
  await act(async () => { pending[1]!.resolve({ results: [], total: 0 }); });
  expect(events).toEqual([expect.objectContaining({ type: "search-succeeded", projectName: "tour-test" })]);
  expect(view.container.textContent).toContain("No results");
});

it("distinguishes request errors from empty success and retries explicitly", async () => {
  view = await mount(<SearchPanel />);
  await type("readme"); await debounce();
  await act(async () => { pending[0]!.reject(new Error("offline")); });
  expect(events).toHaveLength(0);
  expect(view.container.textContent).toContain("Search failed");
  expect(view.container.textContent).not.toContain("No results");
  await click(view.container.querySelector('[role="alert"] button'));
  await act(async () => { pending[1]!.resolve({ results: [], total: 0 }); });
  expect(events).toHaveLength(1);
});

it("does not request short queries or complete hidden search panels", async () => {
  view = await mount(<SearchPanel />);
  await type("a"); await debounce();
  expect(pending).toHaveLength(0);
  visibility.mockReturnValue(false);
  await type("ab"); await debounce();
  await act(async () => { pending[0]!.resolve({ results: [], total: 0 }); });
  expect(events).toHaveLength(0);
});

it("invalidates the old project's response and permits a valid one-character regex", async () => {
  view = await mount(<SearchPanel />);
  await type("readme"); await debounce();
  await act(async () => {
    useProjectStore.setState({ activeProject: { name: "other", path: "/tmp/other" } as any });
    pending[0]!.resolve({ results: [], total: 0 });
  });
  // Let the old-project response and the render both settle before checking.
  await debounce();
  expect(events).toHaveLength(0);
  await click(view.container.querySelector('button[title="Use Regular Expression (Alt+R)"]'));
  await type("["); await debounce();
  expect(view.container.textContent).toContain("Invalid regex");
  const previousRequests = pending.length;
  await type("."); await debounce();
  expect(pending.length).toBe(previousRequests + 1);
  await act(async () => { pending.at(-1)!.resolve({ results: [], total: 0 }); });
  expect(events).toEqual([expect.objectContaining({ projectName: "other", type: "search-succeeded" })]);
});
