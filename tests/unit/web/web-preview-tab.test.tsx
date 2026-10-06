/**
 * The web-preview tab tells the server which origin PPM is open at before the frame loads, so a
 * forwarded page sending `X-Frame-Options` is let into it, and tells it again on Reload, since a
 * server restart forgets. A server that cannot answer must not keep the page from showing.
 */
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { click, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

afterAll(uninstallDom);

const { act } = await import("react");
const { WebPreviewTab } = await import("../../../src/web/components/web-preview/web-preview-tab");

const FORWARD = "https://devbox.tail1234.ts.net:5173/";
const ASK = "/api/tunnels/frame-ancestors";

const realFetch = globalThis.fetch;
let asked: unknown[] = [];
/** What the next ask answers; a pending promise holds the answer back. */
let answer: () => Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  asked = [];
  answer = async () => json({ ok: true, data: { origin: window.location.origin } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== ASK || init?.method !== "POST") return json({ ok: false, error: `no stub for ${String(input)}` }, 599);
    asked.push(JSON.parse(String(init.body)));
    return answer();
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

const frame = () => view!.container.querySelector("iframe");
const show = async () => {
  view = await mount(<WebPreviewTab metadata={{ url: FORWARD, port: 5173, via: "tailscale" }} />);
};

it("loads the page only once the server knows this PPM may frame it", async () => {
  let release!: () => void;
  answer = () => new Promise((resolve) => { release = () => resolve(json({ ok: true, data: {} })); });
  await show();
  await settle();
  expect(asked).toEqual([{ origin: window.location.origin }]);
  expect(frame()).toBeNull();

  release();
  await settle();
  expect(frame()?.getAttribute("src")).toBe(FORWARD);
});

it("still loads the page when the server cannot answer", async () => {
  answer = async () => json({ ok: false, error: "Not found" }, 404);
  await show();
  await settle();
  expect(frame()?.getAttribute("src")).toBe(FORWARD);
});

it("asks again before Reload loads the page again", async () => {
  await show();
  await settle();
  const first = frame();
  expect(first).not.toBeNull();

  await click(view!.container.querySelector('button[aria-label="Reload"]'));
  await settle();
  expect(asked).toHaveLength(2);
  expect(frame()).not.toBe(first);
  expect(frame()?.getAttribute("src")).toBe(FORWARD);
});

// The frame keeps allow-scripts and allow-same-origin, which is safe only while what it loads is
// cross-origin to PPM: PPM's own origin, or a javascript: URL, could read the session token.
it.each([
  ["PPM's own origin", () => `${window.location.origin}/`],
  ["a javascript: URL", () => "javascript:parent.localStorage.getItem('token')"],
])("refuses to frame %s, which could read PPM's token", async (_name, address) => {
  view = await mount(<WebPreviewTab metadata={{ url: address() }} />);
  await settle();
  expect(frame()).toBeNull();
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("no address PPM can show");
});

it("keeps the framed page from navigating PPM away", async () => {
  await show();
  await settle();
  const sandbox = frame()?.getAttribute("sandbox")?.split(/\s+/) ?? [];
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox.filter((token) => token.startsWith("allow-top-navigation"))).toEqual([]);
});
