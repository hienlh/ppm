/**
 * The Share dialog's review-only address card against a stub server: what its switch sends,
 * that turning on goes through the dialog's own start (so the address block shows it coming
 * up), and setting a domain up in place — asking which tunnel only when PPM has a domain.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { ReviewAddressCard } = await import("../../../src/web/components/design/share/review-address-card");
const { useShareHostStatus } = await import("../../../src/web/components/settings/remote-access/use-share-host-status");

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };
type Route = (req: Req) => Answer | undefined;

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let routes: Route[] = [];

const ok = (data: unknown): Answer => ({ body: { ok: true, data } });
function on(method: string, url: string, answer: Answer | ((req: Req) => Answer)): Route {
  return (req) => (req.method === method && req.url === url ? (typeof answer === "function" ? answer(req) : answer) : undefined);
}
const serve = (...extra: Route[]) => { routes = [...extra, ...routes]; };
const sent = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url);

const OFF = {
  enabled: false, mode: "quick", hostname: null, tunnelName: null, canApply: true, supervised: true, running: false,
  connected: false, url: null, warning: null, ppmTunnel: { named: false, hostname: null, enabled: false },
  certState: "ok", authEnabled: true,
};
const PPM_ON_DOMAIN = { named: true, hostname: "ppm.example.com", enabled: true };

let status: Record<string, unknown> = OFF;
let turnedOn = 0;
let changed = 0;

beforeEach(() => {
  requests = [];
  status = OFF;
  turnedOn = 0;
  changed = 0;
  routes = [
    (req) => (req.method === "GET" && req.url === "/api/share-host/status" ? ok(status) : undefined),
    on("GET", "/api/share-host/zone", ok({ zone: "example.com", proposedHostname: "share.example.com" })),
    on("POST", "/api/share-host/enabled", (req) => {
      status = { ...status, enabled: (req.body as { enabled: boolean }).enabled };
      return ok({ applied: true });
    }),
    on("POST", "/api/share-host/setup", (req) => {
      const { mode, hostname } = req.body as { mode: string; hostname: string };
      status = { ...status, mode, hostname };
      return ok({ hostname, tunnelName: "ppm", applied: { applied: true } });
    }),
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
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

/** The dialog's wiring: its start switches the address on, the way the address block's own would. */
function Card() {
  const shareHost = useShareHostStatus(true);
  return (
    <ReviewAddressCard
      shareHost={shareHost}
      onTurnOn={async () => {
        turnedOn++;
        await fetch("/api/share-host/enabled", { method: "POST", body: JSON.stringify({ enabled: true }) });
      }}
      onChanged={() => { changed++; }}
    />
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function $(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}
const has = (selector: string) => document.body.querySelector(selector) !== null;
const text = () => document.body.textContent ?? "";

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("review-only address card", () => {
  it("is offered while links open at PPM's own address, and turns on through the dialog's start", async () => {
    status = { ...OFF, ppmTunnel: PPM_ON_DOMAIN };
    view = await mount(<Card />);
    await settle();
    expect($('[data-testid="share-review-state"]').textContent).toContain("opens the review pages and nothing else of PPM");
    expect(has('[data-testid="share-review-domain"]')).toBe(false);

    await click($("#share-review-switch"));
    await settle();
    expect(turnedOn).toBe(1);
    expect(changed).toBe(1);
    expect($('[data-testid="share-review-state"]').textContent).toBe("On a temporary address.");
    expect($('[data-testid="share-review-domain"]').textContent).toBe("Use my domain");
  });

  it("turns it off, and has the dialog read where links open again", async () => {
    status = { ...OFF, enabled: true, running: true, connected: true, url: "https://calm-lake-3.trycloudflare.com" };
    view = await mount(<Card />);
    await settle();
    await click($("#share-review-switch"));
    await settle();
    expect(sent("POST", "/api/share-host/enabled").map((r) => r.body)).toEqual([{ enabled: false }]);
    expect(turnedOn).toBe(0);
    expect(changed).toBe(1);
    expect(($("#share-review-switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
  });

  it("asks which tunnel when PPM has a domain, then sets the name up in place", async () => {
    status = { ...OFF, enabled: true, ppmTunnel: PPM_ON_DOMAIN };
    view = await mount(<Card />);
    await settle();
    await click($('[data-testid="share-review-domain"]'));
    await settle();
    expect(text()).toContain("Added to the tunnel https://ppm.example.com uses.");
    expect(sent("GET", "/api/share-host/zone")).toHaveLength(0);

    await click($('[data-testid="share-review-choose-shared"]'));
    await settle();
    expect(($("#named-tunnel-prefix") as HTMLInputElement).value).toBe("share");
    await typeInto($("#named-tunnel-prefix") as HTMLInputElement, "review");
    await click($('[data-testid="review-links-submit"]'));
    await settle();
    expect(sent("POST", "/api/share-host/setup").map((r) => r.body)).toEqual([{ mode: "shared", hostname: "review.example.com" }]);
    expect(has('[data-testid="share-review-setup"]')).toBe(false);
    expect(changed).toBe(1);
    expect($('[data-testid="share-review-state"]').textContent).toBe("On your domain, on PPM's tunnel.");
    expect($('[data-testid="share-review-domain"]').textContent).toBe("Change domain");
  });

  it("goes straight to a tunnel of its own when PPM has no domain", async () => {
    status = { ...OFF, enabled: true };
    view = await mount(<Card />);
    await settle();
    await click($('[data-testid="share-review-domain"]'));
    await settle();
    expect(has('[data-testid="share-review-choose"]')).toBe(false);
    expect(text()).toContain("Review address on its own tunnel");
    await click($('[data-testid="review-links-submit"]'));
    await settle();
    expect(sent("POST", "/api/share-host/setup").map((r) => r.body)).toEqual([{ mode: "named", hostname: "share.example.com" }]);
  });

  it("says which domain turning it on uses", async () => {
    status = { ...OFF, mode: "named", hostname: "share.example.com", tunnelName: "ppm-share-box" };
    view = await mount(<Card />);
    await settle();
    expect(text()).toContain("Turning it on uses https://share.example.com.");
  });

  it("is not there while PPM sign-in is off", async () => {
    status = { ...OFF, authEnabled: false };
    view = await mount(<Card />);
    await settle();
    expect(has('[data-testid="share-review-card"]')).toBe(false);
  });
});
