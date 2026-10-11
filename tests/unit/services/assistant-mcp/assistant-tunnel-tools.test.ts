import { describe, expect, test } from "bun:test";
import { createTunnelToolHandlers, TUNNEL_ROUTES } from "../../../../src/services/assistant-mcp/assistant-tunnel-tools.ts";
import type { OwnForward, TunnelHost } from "../../../../src/services/assistant-mcp/assistant-tunnel-host.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import type { CallPpmRoute, RouteCallResult, RouteMethod } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import { checkRouteCall } from "../../../../src/services/assistant-mcp/assistant-route-call.ts";
import { TUNNEL_TOOLS } from "../../../../src/shared/assistant-tunnel-tool-names.ts";
import { TUNNEL_TOOL_DEFINITIONS } from "../../../../src/services/assistant-mcp/assistant-tunnel-tool-definitions.ts";

/** What every route answers, as the real ones shape it, including the fields that must not leak. */
function routeAnswers(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    "GET /api/tunnel": { active: true, url: "https://ppm-now.trycloudflare.com", localUrl: "http://192.168.1.20:3210", enabled: true },
    "GET /api/tunnel/named/status": {
      mode: "quick", liveMode: "quick", hostname: null, tunnelName: null, tokenMasked: "eyJh…SECRET", certState: "present",
      dismissed: false, login: { state: "waiting", url: "https://dash.cloudflare.com/argotunnel?callback=x" }, tunnelWarning: null, authEnabled: true,
    },
    "GET /api/tailscale/state": {
      installed: true, backendState: "Running", canManage: true, osUser: "victor", platform: "win32", tailnet: "example.org",
      dnsSuffix: "tail1234.ts.net", magicDns: true, httpsCertificates: true,
      device: { name: "devbox", dnsName: "devbox.tail1234.ts.net", ips: ["100.64.0.7", "fd7a::7"], tags: ["tag:ppm"] },
      service: { name: "ppm", url: "https://ppm.tail1234.ts.net/", defined: true, approved: true, advertised: true, target: "http://127.0.0.1:3210", pointsAtPpm: true },
      enabled: true, ppmPort: 3210, login: { state: "waiting", url: "https://login.tailscale.com/a/abc", message: null }, authEnabled: true,
    },
    "GET /api/tunnels/transports": { tailscale: { available: true, dnsName: "devbox.tail1234.ts.net" } },
    "GET /api/tunnels?force=1": [
      { pid: 100, port: 5173, url: "https://mine.trycloudflare.com", source: "ppm", protected: false, status: "running" },
      { pid: 200, port: 8000, url: "https://theirs.trycloudflare.com", source: "external", protected: false, status: "running", runRef: "named-x" },
      { pid: 300, port: 3210, url: "https://ppm-now.trycloudflare.com", source: "app", protected: true, status: "running" },
    ],
    "POST /api/tunnels": { port: 5173, url: "https://fresh.trycloudflare.com", via: "cloudflare" },
    "POST /api/tunnel/enabled": { enabled: false, reload: "no-supervisor" },
    ...over,
  };
}

interface Harness {
  ctx: ToolContext;
  calls: string[];
  asks: ApprovalAsk[];
  host: TunnelHost & { own: OwnForward[]; auth: boolean; profile: string | null };
}

function harness(opts: { verdict?: ApprovalVerdict; answers?: Record<string, unknown>; onAsk?: (h: Harness) => void } = {}): Harness {
  const answers = opts.answers ?? routeAnswers();
  const calls: string[] = [];
  const asks: ApprovalAsk[] = [];
  const callRoute = (async <T,>(method: RouteMethod, path: string, body?: Record<string, unknown>): Promise<RouteCallResult<T>> => {
    // Every call the tools make must also pass the family's real allowlist.
    const checked = checkRouteCall(TUNNEL_ROUTES, method, path, body, () => null);
    if (!checked.ok) throw new Error(`not allowed: ${method} ${path}`);
    calls.push(`${method} ${path}`);
    const key = `${method} ${path}`;
    if (method === "DELETE") return { status: 200, ok: true, data: { pid: Number(path.split("/").pop()) } as T };
    if (!(key in answers)) return { status: 404, ok: false, error: "no route" };
    return { status: 200, ok: true, data: answers[key] as T };
  }) as CallPpmRoute;
  const host = {
    own: [{ pid: 100, port: 5173, url: "https://mine.trycloudflare.com", via: "cloudflare" }] as OwnForward[],
    auth: true,
    profile: null as string | null,
    ownForwards: async () => host.own,
    ppmPorts: async () => [3210, 3214],
    dbProfile: async () => host.profile,
    authEnabled: async () => host.auth,
  };
  const h: Harness = {
    calls, asks, host,
    ctx: {
      sessionId: "s1",
      callRoute,
      ask: async (ask) => {
        asks.push(ask);
        opts.onAsk?.(h);
        return opts.verdict ?? { verdict: "approved" };
      },
    },
  };
  return h;
}

const run = (h: Harness, tool: string, args: Record<string, unknown> = {}) => createTunnelToolHandlers(h.host)[tool]!(h.ctx, args);
const textOf = (r: Record<string, unknown>) => ((r.content as Array<{ text: string }>)[0]!.text);
const jsonOf = (r: Record<string, unknown>) => JSON.parse(textOf(r));

test("names, definitions and handlers line up", () => {
  expect(TUNNEL_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...TUNNEL_TOOLS]);
  expect(Object.keys(createTunnelToolHandlers()).sort()).toEqual([...TUNNEL_TOOLS].sort());
  expect(TUNNEL_TOOL_DEFINITIONS[0]!.annotations.readOnlyHint).toBe(true);
  expect(TUNNEL_TOOL_DEFINITIONS.slice(1).every((d) => d.annotations.readOnlyHint === false)).toBe(true);
});

describe("tunnels_status", () => {
  test("asks nothing and keeps only whitelisted fields: no token, sign-in link, IP, LAN address or OS user", async () => {
    const h = harness();
    const result = await run(h, "tunnels_status");
    expect(h.asks).toHaveLength(0);
    const text = textOf(result);
    for (const leak of ["SECRET", "tokenMasked", "certState", "login.tailscale", "dash.cloudflare", "100.64.0.7", "fd7a", "192.168.1.20", "victor", "127.0.0.1", "named-x", "\"ips\"", "osUser"]) {
      expect(text).not.toContain(leak);
    }
    const out = JSON.parse(text);
    expect(out.publicLink).toEqual({ enabled: true, active: true, url: "https://ppm-now.trycloudflare.com", mode: "quick", liveMode: "quick", hostname: null, warning: null });
    expect(out.auth).toEqual({ enabled: true });
    expect(out.tailscale).toEqual({
      installed: true, backendState: "Running", tailnet: "example.org", deviceName: "devbox",
      service: { name: "ppm", url: "https://ppm.tail1234.ts.net/", enabled: true, approved: true, pointsAtPpm: true },
    });
    expect(out.forwardOverTailscale).toEqual({ available: true, reason: null });
    expect(out.forwards.map((f: { pid: number; ownedByThisPpm: boolean }) => [f.pid, f.ownedByThisPpm])).toEqual([[100, true], [200, false], [300, false]]);
    expect(h.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  test("a tailnet named by an email address goes out as its MagicDNS suffix, or not at all", async () => {
    const base = routeAnswers()["GET /api/tailscale/state"] as Record<string, unknown>;
    const withSuffix = harness({ answers: routeAnswers({ "GET /api/tailscale/state": { ...base, tailnet: "someone@gmail.com" } }) });
    const text = textOf(await run(withSuffix, "tunnels_status"));
    expect(text).not.toContain("@");
    expect(JSON.parse(text).tailscale.tailnet).toBe("tail1234.ts.net");

    const noSuffix = harness({ answers: routeAnswers({ "GET /api/tailscale/state": { ...base, tailnet: "someone@gmail.com", dnsSuffix: null } }) });
    const out = jsonOf(await run(noSuffix, "tunnels_status"));
    expect("tailnet" in out.tailscale).toBe(false);
    expect(JSON.stringify(out)).not.toContain("@");
  });

  test("one route failing leaves the other sections answered", async () => {
    const answers = routeAnswers();
    delete answers["GET /api/tailscale/state"];
    const out = jsonOf(await run(harness({ answers }), "tunnels_status"));
    expect(out.tailscale.error).toBeString();
    expect(out.publicLink.enabled).toBe(true);
  });
});

describe("port_forward_start", () => {
  test("a Cloudflare forward asks with a card saying anyone with the address reaches it, then posts", async () => {
    const h = harness();
    const out = jsonOf(await run(h, "port_forward_start", { port: 4000 }));
    expect(h.asks[0]!.summary.headline).toBe("Put localhost:4000 on the public internet");
    expect(h.asks[0]!.summary.facts.find((f) => f.label === "Who can reach it")?.value).toBe("Anyone who has the address");
    expect(h.calls).toContain("POST /api/tunnels");
    expect(out.outcome).toBe("forwarded");
  });

  test("a Tailscale forward names the tailnet on its card", async () => {
    const h = harness();
    await run(h, "port_forward_start", { port: 4000, via: "tailscale" });
    expect(h.asks[0]!.summary.headline).toBe("Share localhost:4000 with the devices on your tailnet example.org");
  });

  test("a Tailscale card names the MagicDNS suffix instead of an email-address tailnet", async () => {
    const base = routeAnswers()["GET /api/tailscale/state"] as Record<string, unknown>;
    for (const state of [{ ...base, tailnet: "someone@gmail.com" }, { ...base, tailnet: "someone@gmail.com", dnsSuffix: null }]) {
      const h = harness({ answers: routeAnswers({ "GET /api/tailscale/state": state }) });
      await run(h, "port_forward_start", { port: 4000, via: "tailscale" });
      const summary = h.asks[0]!.summary;
      expect(JSON.stringify(summary)).not.toContain("@");
      // With no suffix in the state, the suffix of this machine's tailnet name stands in.
      expect(summary.headline).toBe("Share localhost:4000 with the devices on your tailnet tail1234.ts.net");
    }
  });

  test("refuses PPM's own ports before asking", async () => {
    for (const port of [3210, 3214]) {
      const h = harness();
      const r = await run(h, "port_forward_start", { port });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("public_link_set");
      expect(h.asks).toHaveLength(0);
      expect(h.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
    }
  });

  test("a port this PPM already forwards answers at once, with no card", async () => {
    const h = harness();
    const out = jsonOf(await run(h, "port_forward_start", { port: 5173 }));
    expect(out).toMatchObject({ outcome: "already-forwarded", url: "https://mine.trycloudflare.com" });
    expect(h.asks).toHaveLength(0);
  });

  test("Tailscale unavailable is an error with the reason, and no card", async () => {
    const h = harness({ answers: routeAnswers({ "GET /api/tunnels/transports": { tailscale: { available: false, reason: "Tailscale is signed out on the host" } } }) });
    const r = await run(h, "port_forward_start", { port: 4000, via: "tailscale" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("signed out");
    expect(h.asks).toHaveLength(0);
  });

  test("a declined card starts nothing", async () => {
    const h = harness({ verdict: { verdict: "denied", reason: "no" } });
    const r = await run(h, "port_forward_start", { port: 4000 });
    expect(r.isError).toBe(true);
    expect(h.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });

  test("a watch turn's refusal (unavailable) starts nothing", async () => {
    const h = harness({ verdict: { verdict: "unavailable", reason: "watch turn" } });
    await run(h, "port_forward_start", { port: 4000 });
    expect(h.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });

  test("rejects a malformed port or transport", async () => {
    for (const args of [{ port: 0 }, { port: 70000 }, { port: 1.5 }, { port: "80" }, { port: 4000, via: "ngrok" }]) {
      const h = harness();
      expect((await run(h, "port_forward_start", args)).isError).toBe(true);
      expect(h.asks).toHaveLength(0);
    }
  });
});

describe("port_forward_stop", () => {
  test("stops this PPM's forward by port after asking, naming its address", async () => {
    const h = harness();
    const out = jsonOf(await run(h, "port_forward_stop", { port: 5173 }));
    expect(h.asks[0]!.summary.facts.find((f) => f.label === "Address")?.value).toBe("https://mine.trycloudflare.com");
    expect(h.calls).toEqual(["DELETE /api/tunnels/100"]);
    expect(out.outcome).toBe("stopped");
  });

  test("refuses another program's, another PPM's or the protected app tunnel without any DELETE", async () => {
    for (const args of [{ pid: 200 }, { pid: 300 }, { port: 8000 }, { pid: 424242 }]) {
      const h = harness();
      const r = await run(h, "port_forward_stop", args);
      expect(r.isError).toBe(true);
      expect(h.asks).toHaveLength(0);
      expect(h.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(0);
    }
  });

  test("a forward that ended while the card waited is stale and not stopped", async () => {
    const h = harness({ onAsk: (x) => { x.host.own = []; } });
    const out = jsonOf(await run(h, "port_forward_stop", { pid: 100 }));
    expect(out.outcome).toBe("stale");
    expect(h.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(0);
  });

  test("a pid reused for a different forward while the card waited is stale too", async () => {
    const h = harness({ onAsk: (x) => { x.host.own = [{ pid: 100, port: 9999, url: null, via: "cloudflare" }]; } });
    expect(jsonOf(await run(h, "port_forward_stop", { pid: 100 })).outcome).toBe("stale");
    expect(h.calls).toHaveLength(0);
  });

  test("needs exactly one of port or pid; a port forwarded twice asks for the pid", async () => {
    const h = harness();
    expect((await run(h, "port_forward_stop", {})).isError).toBe(true);
    expect((await run(h, "port_forward_stop", { port: 5173, pid: 100 })).isError).toBe(true);
    h.host.own = [...h.host.own, { pid: 101, port: 5173, url: "https://x.ts.net:5173/", via: "tailscale" }];
    const r = await run(h, "port_forward_stop", { port: 5173 });
    expect(textOf(r)).toContain("give the `pid`");
    expect(h.asks).toHaveLength(0);
  });
});

describe("public_link_set", () => {
  test("switching off asks with the address that goes away and reports no-supervisor plainly", async () => {
    const h = harness();
    const out = jsonOf(await run(h, "public_link_set", { enabled: false }));
    expect(h.asks[0]!.summary.headline).toBe("Switch off PPM's public address https://ppm-now.trycloudflare.com");
    expect(h.calls).toContain("POST /api/tunnel/enabled");
    expect(out).toMatchObject({ outcome: "switched", reload: "no-supervisor" });
    expect(out.note).toContain("next `ppm start`");
  });

  test("the state already asked for answers at once, with no card", async () => {
    const h = harness();
    expect(jsonOf(await run(h, "public_link_set", { enabled: true })).outcome).toBe("unchanged");
    expect(h.asks).toHaveLength(0);
  });

  test("refused on a non-default database profile, either way, before reading or asking", async () => {
    for (const enabled of [true, false]) {
      const h = harness();
      h.host.profile = "dev";
      const r = await run(h, "public_link_set", { enabled });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("\"dev\" database profile");
      expect(h.asks).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
    }
  });

  test("switching on is refused while PPM's login is off", async () => {
    const h = harness({ answers: routeAnswers({ "GET /api/tunnel": { active: false, url: null, enabled: false } }) });
    h.host.auth = false;
    const r = await run(h, "public_link_set", { enabled: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("login is off");
    expect(h.asks).toHaveLength(0);
  });

  test("switching on re-checks the login after approval", async () => {
    const h = harness({
      answers: routeAnswers({ "GET /api/tunnel": { active: false, url: null, enabled: false } }),
      onAsk: (x) => { x.host.auth = false; },
    });
    const out = jsonOf(await run(h, "public_link_set", { enabled: true }));
    expect(out.outcome).toBe("stale");
    expect(h.calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
  });

  test("switching on shows a public URL will exist", async () => {
    const h = harness({ answers: routeAnswers({ "GET /api/tunnel": { active: false, url: null, enabled: false } }) });
    await run(h, "public_link_set", { enabled: true });
    expect(h.asks[0]!.summary.facts.find((f) => f.label === "Address")?.value).toBe("a new random https://….trycloudflare.com address");
  });

  test("`enabled` must be a boolean", async () => {
    const h = harness();
    expect((await run(h, "public_link_set", { enabled: "yes" })).isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});
