/**
 * The sidebar's Port Forwarding panel against a stub server: the two rows saying where Tailscale
 * and Cloudflare stand and opening Settings → Remote Access on the matching sub-tab, and the
 * forwards themselves — what each control sends, and what it refuses to do without a
 * confirmation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useRemoteAccessTab } = await import("../../../src/web/components/settings/remote-access/remote-access-tab-store");
const { PortForwardingPanel } = await import("../../../src/web/components/tunnels/port-forwarding-panel");

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };
type Route = (req: Req) => Answer | undefined;

const realFetch = globalThis.fetch;
const realWidth = window.innerWidth;
let requests: Req[] = [];
let routes: Route[] = [];

function on(method: string, url: string, answer: Answer | ((req: Req) => Answer)): Route {
  return (req) => (req.method === method && req.url === url ? (typeof answer === "function" ? answer(req) : answer) : undefined);
}
const ok = (data: unknown): Answer => ({ body: { ok: true, data } });
/** Stubs answering before the ones already installed. */
const serve = (...extra: Route[]) => { routes = [...extra, ...routes]; };
const sent = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url);

const TAILSCALE_READY = { tailscale: { available: true, dnsName: "devbox.tail1234.ts.net" } };
const QUICK = {
  mode: "quick", hostname: null, tunnelName: null, tokenMasked: null, certState: "none", dismissed: true,
  login: { state: "idle", url: null, message: null }, liveMode: null, tunnelWarning: null, authEnabled: true,
};
const NAMED = { ...QUICK, mode: "named", hostname: "ppm.example.com", tunnelName: "ppm", certState: "ok", liveMode: "named" };

beforeEach(() => {
  requests = [];
  routes = [
    on("GET", "/api/tunnels", ok([])),
    on("GET", "/api/tunnels/transports", ok(TAILSCALE_READY)),
    on("GET", "/api/tunnel/named/status", ok(QUICK)),
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    for (const route of routes) {
      const answer = route(req);
      if (answer) return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, error: `no stub for ${req.method} ${req.url}` }), { status: 599 });
  }) as typeof fetch;
  // A desktop: Settings opens as a window, which is what the store can be asked about.
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  useRemoteAccessTab.setState({ tab: "tailscale" });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  const windows = useWindowStore.getState();
  for (const id of Object.keys(windows.windows)) windows.close(id);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function $(selector: string, root: ParentNode = document.body): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

function button(text: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

const dialog = () => $('[role="dialog"]');
const text = () => document.body.textContent ?? "";
const row = (service: "tailscale" | "cloudflare") => $(`[data-testid="setup-${service}"]`);
const status = (service: "tailscale" | "cloudflare") => $(`[data-testid="setup-${service}-status"]`).textContent;
const settingsWindows = () => Object.values(useWindowStore.getState().windows).filter((w) => w.kind === "settings");

async function typePort(value: string): Promise<void> {
  const el = $("#forward-port") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Set up rows", () => {
  it("say what is missing, and Set up opens Remote Access on that service's tab", async () => {
    serve(on("GET", "/api/tunnels/transports", ok({ tailscale: { available: false, reason: "Tailscale is signed out on the host" } })));
    let navigated = 0;
    view = await mount(<PortForwardingPanel onNavigate={() => { navigated++; }} />);
    await settle();
    expect(status("tailscale")).toBe("Tailscale is signed out on the host");
    expect(status("cloudflare")).toBe("No domain set up");
    expect(row("tailscale").dataset.done).toBe("false");

    useRemoteAccessTab.setState({ tab: "public-link" });
    await click(button("Set up", row("tailscale")));
    expect(useRemoteAccessTab.getState().tab).toBe("tailscale");
    expect(settingsWindows().map((w) => w.payload)).toEqual([{ category: "remote-access" }]);
    // The phone's drawer closes so the Settings tab underneath is what shows.
    expect(navigated).toBe(1);

    await click(button("Set up", row("cloudflare")));
    expect(useRemoteAccessTab.getState().tab).toBe("public-link");
    expect(settingsWindows()).toHaveLength(1);
    expect(navigated).toBe(2);
  });

  it("turn into Manage once each service is set up", async () => {
    serve(on("GET", "/api/tunnel/named/status", ok(NAMED)));
    view = await mount(<PortForwardingPanel />);
    await settle();
    expect(status("tailscale")).toBe("devbox.tail1234.ts.net");
    expect(status("cloudflare")).toBe("ppm.example.com");
    expect(row("tailscale").dataset.done).toBe("true");
    expect(row("cloudflare").dataset.done).toBe("true");

    await click(button("Manage", row("cloudflare")));
    expect(useRemoteAccessTab.getState().tab).toBe("public-link");
    expect(settingsWindows().map((w) => w.payload)).toEqual([{ category: "remote-access" }]);
  });

  it("asks for Cloudflare again when the saved sign-in no longer works", async () => {
    serve(on("GET", "/api/tunnel/named/status", ok({ ...NAMED, certState: "mismatch" })));
    view = await mount(<PortForwardingPanel />);
    await settle();
    expect(status("cloudflare")).toBe("Cloudflare sign-in needed");
    expect(button("Set up", row("cloudflare"))).toBeDefined();
  });

  it("says when the domain is set up but PPM fell back to a temporary link", async () => {
    serve(on("GET", "/api/tunnel/named/status", ok({ ...NAMED, liveMode: "quick", tunnelWarning: "named tunnel failed to start" })));
    view = await mount(<PortForwardingPanel />);
    await settle();
    expect(status("cloudflare")).toBe("ppm.example.com is not in use right now");
    expect(row("cloudflare").dataset.done).toBe("true");
  });

  it("reads both services again when the Settings window closes", async () => {
    const settings = useWindowStore.getState().open("settings", { category: "remote-access" });
    serve(on("GET", "/api/tunnels/transports", ok({ tailscale: { available: false, reason: "Tailscale is not installed on the host" } })));
    view = await mount(<PortForwardingPanel />);
    await settle();
    // An open Settings does not hold the first read back.
    expect(status("tailscale")).toBe("Tailscale is not installed on the host");

    // Signed in over in Settings, then closed it.
    serve(on("GET", "/api/tunnels/transports", ok(TAILSCALE_READY)));
    await act(async () => { useWindowStore.getState().close(settings); });
    await settle();
    expect(status("tailscale")).toBe("devbox.tail1234.ts.net");
    expect(button("Manage", row("tailscale"))).toBeDefined();
  });

  it("keeps the last known state when a read fails", async () => {
    view = await mount(<PortForwardingPanel />);
    await settle();
    expect(status("tailscale")).toBe("devbox.tail1234.ts.net");

    serve(
      on("GET", "/api/tunnels?force=1", ok([])),
      on("GET", "/api/tunnels/transports", { status: 500, body: { ok: false, error: "boom" } }),
      on("GET", "/api/tunnel/named/status", { status: 500, body: { ok: false, error: "boom" } }),
    );
    await click($('button[aria-label="Refresh"]'));
    await settle();
    expect(status("tailscale")).toBe("devbox.tail1234.ts.net");
    expect(status("cloudflare")).toBe("No domain set up");
  });
});

describe("Forwarding", () => {
  it("forwards over Tailscale and opens the forward in a tab", async () => {
    serve(on("POST", "/api/tunnels", ok({ port: 3000, url: "https://devbox.tail1234.ts.net:3000", via: "tailscale" })));
    let navigated = 0;
    view = await mount(<PortForwardingPanel onNavigate={() => { navigated++; }} />);
    await settle();
    expect(document.body.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("Tailscale");

    await typePort("3000");
    await click(button("Forward"));
    await settle();
    expect(sent("POST", "/api/tunnels").map((r) => r.body)).toEqual([{ port: 3000, via: "tailscale" }]);
    const tab = useTabStore.getState().tabs.find((t) => t.type === "web-preview");
    expect(tab?.metadata).toMatchObject({ url: "https://devbox.tail1234.ts.net:3000", port: 3000, via: "tailscale" });
    expect(navigated).toBe(1);
  });

  it("falls back to Cloudflare when this host has no Tailscale", async () => {
    serve(
      on("GET", "/api/tunnels/transports", ok({ tailscale: { available: false, reason: "Tailscale is not installed on the host" } })),
      on("POST", "/api/tunnels", ok({ port: 5173, url: "https://calm-lake.trycloudflare.com", via: "cloudflare" })),
    );
    view = await mount(<PortForwardingPanel />);
    await settle();
    const [tailscale, cloudflare] = [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(tailscale!.disabled).toBe(true);
    expect(cloudflare!.getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("Public: anyone with the link can open it.");

    await typePort("5173");
    await click(button("Forward"));
    await settle();
    expect(sent("POST", "/api/tunnels").map((r) => r.body)).toEqual([{ port: 5173, via: "cloudflare" }]);
  });

  it("never sends a port outside 1-65535: the field's own range check stops the submit", async () => {
    view = await mount(<PortForwardingPanel />);
    await settle();
    await typePort("70000");
    expect(($("#forward-port") as HTMLInputElement).validity.rangeOverflow).toBe(true);
    await click(button("Forward"));
    await settle();
    expect(sent("POST", "/api/tunnels")).toHaveLength(0);
  });

  it("stops a tunnel PPM did not start only after a confirmation", async () => {
    serve(
      on("GET", "/api/tunnels", ok([{ pid: 4242, port: 8080, url: "https://other.trycloudflare.com", source: "external", protected: false, status: "running" }])),
      on("DELETE", "/api/tunnels/4242", ok({ stopped: true })),
    );
    view = await mount(<PortForwardingPanel />);
    await settle();
    expect(text()).toContain("Started outside PPM");

    await click($('[data-testid="forward-row"] button[aria-label="Stop"]'));
    await settle();
    expect(dialog().textContent).toContain("https://other.trycloudflare.com");
    expect(sent("DELETE", "/api/tunnels/4242")).toHaveLength(0);

    await click(button("Stop", dialog()));
    await settle();
    expect(sent("DELETE", "/api/tunnels/4242")).toHaveLength(1);
  });

  it("lists PPM's own public link without a way to stop it, and opens its Settings tab", async () => {
    serve(on("GET", "/api/tunnels", ok([{ pid: 77, port: 3210, url: "https://quiet-river.trycloudflare.com", source: "app", protected: true, status: "running" }])));
    view = await mount(<PortForwardingPanel />);
    await settle();
    expect(document.body.querySelector('[data-testid="forward-row"] button[aria-label="Stop"]')).toBeNull();

    await click(button("Public link"));
    expect(useRemoteAccessTab.getState().tab).toBe("public-link");
    expect(settingsWindows().map((w) => w.payload)).toEqual([{ category: "remote-access" }]);
  });
});
