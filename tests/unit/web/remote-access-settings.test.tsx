/**
 * Settings → Remote Access against a stub server: an open Settings moving to the pane a link
 * asks for, the sub-tabs, and the public link's switch and address — what each control sends,
 * and what it refuses to do without a confirmation. Port forwarding is the sidebar's panel, in
 * `port-forwarding-panel.test.tsx`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { SETTINGS_NAVIGATE_EVENT } = await import("../../../src/web/components/settings/settings-categories");
const { SECTIONS } = await import("../../../src/web/components/settings/settings-section-content");
const { SettingsBody } = await import("../../../src/web/components/settings/settings-body");
const { openSettings } = await import("../../../src/web/components/settings/open-settings");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const { RemoteAccessSettingsSection } = await import("../../../src/web/components/settings/remote-access/remote-access-settings-section");
const { useRemoteAccessTab } = await import("../../../src/web/components/settings/remote-access/remote-access-tab-store");
const { PublicLinkPane } = await import("../../../src/web/components/settings/remote-access/public-link-pane");

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };
type Route = (req: Req) => Answer | undefined;

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let routes: Route[] = [];

function on(method: string, url: string, answer: Answer | ((req: Req) => Answer)): Route {
  return (req) => (req.method === method && req.url === url ? (typeof answer === "function" ? answer(req) : answer) : undefined);
}
const ok = (data: unknown): Answer => ({ body: { ok: true, data } });
/** Stubs answering before the ones already installed. */
const serve = (...extra: Route[]) => { routes = [...extra, ...routes]; };
const sent = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url);

const TUNNEL_OFF = { active: false, url: null, localUrl: null, enabled: false };
const QUICK = {
  mode: "quick", hostname: null, tunnelName: null, tokenMasked: null, certState: "none", dismissed: true,
  login: { state: "idle", url: null, message: null }, liveMode: null, tunnelWarning: null, authEnabled: true,
};
const NAMED = { ...QUICK, mode: "named", hostname: "ppm.example.com", tunnelName: "ppm", certState: "ok", liveMode: "named" };

beforeEach(() => {
  requests = [];
  routes = [
    on("GET", "/api/tunnel", ok(TUNNEL_OFF)),
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
  useRemoteAccessTab.setState({ tab: "tailscale" });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  const windows = useWindowStore.getState();
  for (const id of Object.keys(windows.windows)) windows.close(id);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function $(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

function buttons(text: string, root: ParentNode = document.body): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text);
}

function button(text: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = buttons(text, root)[0];
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

const dialog = () => $('[role="dialog"]');
const text = () => document.body.textContent ?? "";

describe("Settings navigation", () => {
  const stub = (label: string) => Object.assign(() => <p>{label} pane</p>, { preload: async () => {} }) as never;
  const real = { general: SECTIONS.general, remote: SECTIONS["remote-access"] };
  beforeEach(() => { SECTIONS.general = stub("general"); SECTIONS["remote-access"] = stub("remote access"); });
  afterEach(() => { SECTIONS.general = real.general; SECTIONS["remote-access"] = real.remote; });

  it("moves an open Settings to the pane a link asks for, and tells the host", async () => {
    const changes: string[] = [];
    view = await mount(<SettingsBody initialCategory="general" onCategoryChange={(c) => changes.push(c)} />);
    expect($('[data-testid="settings-window"]').dataset.category).toBe("general");

    await act(async () => { window.dispatchEvent(new CustomEvent(SETTINGS_NAVIGATE_EVENT, { detail: "remote-access" })); });
    expect($('[data-testid="settings-window"]').dataset.category).toBe("remote-access");
    expect($('[data-testid="settings-pane-title"]').textContent).toBe("Remote Access");
    expect(changes).toEqual(["remote-access"]);

    // The pane this replaced is not a category any more; a stale link names nothing.
    await act(async () => { window.dispatchEvent(new CustomEvent(SETTINGS_NAVIGATE_EVENT, { detail: "tailscale" })); });
    expect($('[data-testid="settings-window"]').dataset.category).toBe("remote-access");
  });

  it("openSettings on an open window points it at the pane and asks the mounted body to follow", async () => {
    const id = useWindowStore.getState().open("settings", { category: "general" });
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(SETTINGS_NAVIGATE_EVENT, listen);
    try {
      openSettings("remote-access");
    } finally {
      window.removeEventListener(SETTINGS_NAVIGATE_EVENT, listen);
    }
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([id]);
    expect(useWindowStore.getState().windows[id]!.payload).toEqual({ category: "remote-access" });
    expect(heard).toEqual(["remote-access"]);
  });
});

describe("Remote Access sub-tabs", () => {
  it("starts on Tailscale and switches to the public link; port forwarding is not one of them", async () => {
    view = await mount(<RemoteAccessSettingsSection />);
    expect($('[data-testid="remote-access"]').dataset.tab).toBe("tailscale");
    expect($('[data-testid="remote-access-tab-tailscale"]').getAttribute("aria-selected")).toBe("true");
    expect([...document.body.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Tailscale", "Public link"]);

    await click($('[data-testid="remote-access-tab-public-link"]'));
    await settle();
    expect(document.body.querySelector('[data-testid="public-link-pane"]')).not.toBeNull();
  });

  it("opens on the sub-tab a link picked", async () => {
    useRemoteAccessTab.getState().setTab("public-link");
    view = await mount(<RemoteAccessSettingsSection />);
    await settle();
    expect(document.body.querySelector('[data-testid="public-link-pane"]')).not.toBeNull();
  });
});

describe("Public link", () => {
  it("turns the link on, then shows the address once Cloudflare hands it out", async () => {
    let tunnel: object = TUNNEL_OFF;
    serve(
      (req) => (req.method === "GET" && req.url === "/api/tunnel" ? ok(tunnel) : undefined),
      on("POST", "/api/tunnel/enabled", (req) => {
        tunnel = { ...TUNNEL_OFF, enabled: (req.body as { enabled: boolean }).enabled };
        return ok({ enabled: true, reload: "retunnel" });
      }),
    );
    view = await mount(<PublicLinkPane />);
    await settle();
    expect($('[data-testid="public-link-status"]').textContent).toBe("Off.");

    await click($("#public-link-switch"));
    await settle();
    expect(sent("POST", "/api/tunnel/enabled").map((r) => r.body)).toEqual([{ enabled: true }]);
    expect($('[data-testid="public-link-status"]').textContent).toContain("Waiting for Cloudflare");
    expect(text()).not.toContain("trycloudflare.com/");

    tunnel = { active: true, url: "https://quiet-river.trycloudflare.com", localUrl: null, enabled: true };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect($('[data-testid="public-link-status"]').textContent).toContain("Anyone with the link");
    expect($('[data-testid="tailscale-address-url"]').textContent).toContain("https://quiet-river.trycloudflare.com");
  });

  it("will not turn the link on, or set up a domain, while PPM's password is off", async () => {
    serve(on("GET", "/api/tunnel/named/status", ok({ ...QUICK, authEnabled: false })));
    view = await mount(<PublicLinkPane />);
    await settle();
    expect(($("#public-link-switch") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("PPM's password is off. Turn it on first");
    expect(buttons("Set up")).toHaveLength(0);
    expect(text()).toContain("Turn on PPM's password to use your own domain.");
  });

  it("offers a domain to a temporary address, through the setup flow", async () => {
    serve(on("POST", "/api/tunnel/named/login", ok({ state: "waiting", url: "https://dash.cloudflare.com/argotunnel?x=1", message: null })));
    view = await mount(<PublicLinkPane />);
    await settle();
    const temporary = $('[data-testid="public-link-address"]').querySelector("[data-in-use]");
    expect(temporary?.textContent).toContain("Temporary address");

    await click(button("Set up"));
    await settle();
    expect(sent("POST", "/api/tunnel/named/login")).toHaveLength(1);
    expect(text()).toContain("Sign in to Cloudflare");
    expect(text()).toContain("https://dash.cloudflare.com/argotunnel?x=1");
  });

  it("gives a domain up for a temporary address only after a confirmation", async () => {
    serve(
      on("GET", "/api/tunnel", ok({ active: true, url: "https://ppm.example.com", localUrl: null, enabled: true })),
      on("GET", "/api/tunnel/named/status", ok(NAMED)),
      on("POST", "/api/tunnel/named/disable", ok({ mode: "quick" })),
    );
    view = await mount(<PublicLinkPane />);
    await settle();
    expect($('[data-testid="public-link-address"]').querySelector("[data-in-use]")?.textContent).toContain("https://ppm.example.com");

    await click(button("Switch"));
    await settle();
    expect(dialog().textContent).toContain("stops answering at https://ppm.example.com");
    expect(sent("POST", "/api/tunnel/named/disable")).toHaveLength(0);

    await click(button("Switch", dialog()));
    await settle();
    expect(sent("POST", "/api/tunnel/named/disable")).toHaveLength(1);
  });

  it("says when PPM could not use the domain and fell back", async () => {
    serve(on("GET", "/api/tunnel/named/status", ok({
      ...NAMED, liveMode: "quick", tunnelWarning: "named tunnel failed to start — running on the quick tunnel instead",
    })));
    view = await mount(<PublicLinkPane />);
    await settle();
    expect(text()).toContain("PPM could not use your domain and is on a temporary address for now.");
    expect(text()).toContain("named tunnel failed to start");
  });

  it("asks for a fresh Cloudflare sign-in when the saved one belongs to another account", async () => {
    serve(
      on("GET", "/api/tunnel/named/status", ok({ ...NAMED, certState: "mismatch" })),
      on("POST", "/api/tunnel/named/login?relogin=1", ok({ state: "waiting", url: "https://dash.cloudflare.com/argotunnel?x=2", message: null })),
    );
    view = await mount(<PublicLinkPane />);
    await settle();
    expect(text()).toContain("Cloudflare sign-in needed");

    await click(button("Sign in again"));
    await settle();
    // `?relogin=1` moves the old credential aside instead of reusing it.
    expect(sent("POST", "/api/tunnel/named/login?relogin=1")).toHaveLength(1);
    expect(text()).toContain("https://dash.cloudflare.com/argotunnel?x=2");
  });
});
