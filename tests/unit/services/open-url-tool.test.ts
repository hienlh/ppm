import { describe, expect, it } from "bun:test";
import { createOpenUrlTool, MAX_FORWARDS_PER_CHAT, OPEN_URL_WAIT_MS, pageOn, parseLocalUrl, type OpenUrlDeps } from "../../../src/services/tab-tools-mcp/open-url-tool.ts";
import type { TabOpenOutcome } from "../../../src/services/tab-tools-mcp/tab-open-broker.ts";

const OPENED: TabOpenOutcome = { ok: true, result: { type: "tab_open_result", requestId: "r".repeat(16), opened: true } };
const binding = { sessionId: "chat-1", projectPath: "/proj", projectName: "demo" };

function setup(over: Partial<OpenUrlDeps> & { outcome?: TabOpenOutcome } = {}) {
  const requests: Array<{ sessionId: string; req: Record<string, unknown>; waitMs: number }> = [];
  const started: number[] = [];
  const openUrl = createOpenUrlTool({
    request: async (sessionId, req, waitMs) => {
      requests.push({ sessionId, req: req as Record<string, unknown>, waitMs });
      return over.outcome ?? OPENED;
    },
    listening: over.listening ?? (async () => true),
    ownPorts: over.ownPorts ?? (() => [8080, 41234]),
    existingForward: over.existingForward ?? (() => null),
    startPrivateForward: over.startPrivateForward ?? (async (port) => {
      started.push(port);
      return `https://host.tail1234.ts.net:${port}/`;
    }),
    ...(over.canonical ? { canonical: over.canonical } : {}),
  });
  const call = async (url: unknown, sessionId = binding.sessionId) => {
    const result = (await openUrl({ ...binding, sessionId }, { url })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0]!.text, isError: result.isError };
  };
  return { call, requests, started };
}

describe("parseLocalUrl", () => {
  it("takes this machine's own servers, written any way an agent would", () => {
    const page = (protocol: string, port: number, pathname: string, search = "", hash = "") => ({ ok: true, url: { protocol, port, pathname, search, hash } });
    expect(parseLocalUrl("http://localhost:5173/admin?tab=2#top")).toEqual(page("http:", 5173, "/admin", "?tab=2", "#top"));
    expect(parseLocalUrl("5173")).toEqual(page("http:", 5173, "/"));
    expect(parseLocalUrl("localhost:3000/docs")).toEqual(page("http:", 3000, "/docs"));
    expect(parseLocalUrl("http://127.0.0.1:8000")).toEqual(page("http:", 8000, "/"));
    expect(parseLocalUrl("http://[::1]:4321/")).toEqual(page("http:", 4321, "/"));
    expect(parseLocalUrl("http://0.0.0.0:8888/lab")).toEqual(page("http:", 8888, "/lab"));
    expect(parseLocalUrl("https://localhost")).toEqual(page("https:", 443, "/"));
  });

  it("puts the page on another origin without its path ever naming a host", () => {
    for (const asked of ["http://localhost:5173//evil.com/x", "http://localhost:5173/\\evil.com/x", "localhost:5173//evil.com"]) {
      const parsed = parseLocalUrl(asked);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(new URL(pageOn("https://host.tail1234.ts.net:8443/", parsed.url)).host).toBe("host.tail1234.ts.net:8443");
    }
    const parsed = parseLocalUrl("http://localhost:5173/a//b?x=1#h");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(pageOn("https://calm-river.trycloudflare.com", parsed.url)).toBe("https://calm-river.trycloudflare.com/a//b?x=1#h");
  });

  it("refuses any other site, any other scheme, and credentials in the address", () => {
    for (const url of [
      "https://example.com", "http://192.168.1.20:3000", "http://localhost.evil.com:3000", "http://app.localhost:3000",
      "http://127.evil.com:3000", "http://127.0.0.1.nip.io:3000",
      "file:///etc/passwd", "javascript:alert(1)", "ftp://localhost:21", "http://user:pw@localhost:3000", "", 5173, null,
    ]) {
      expect(parseLocalUrl(url).ok).toBe(false);
    }
  });
});

describe("open_url", () => {
  it("opens a dev server through a private Tailscale forward it starts, keeping the path asked for", async () => {
    const { call, requests, started } = setup();
    const answer = await call("http://localhost:5173/admin?tab=2");
    expect(started).toEqual([5173]);
    expect(requests).toEqual([{
      sessionId: "chat-1", waitMs: OPEN_URL_WAIT_MS,
      req: { tool: "open_url", url: "https://host.tail1234.ts.net:5173/admin?tab=2", port: 5173, via: "tailscale" },
    }]);
    expect(answer.isError).toBeUndefined();
    expect(answer.text).toContain("Opened http://localhost:5173/admin?tab=2 in a PPM tab on the user's device, through a private Tailscale forward PPM started");
  });

  it("keeps a path that reads as another host on the forward, whichever forward it is", async () => {
    const existing = setup({ existingForward: () => ({ url: "https://host.tail1234.ts.net:8443/", via: "tailscale" }) });
    await existing.call("http://localhost:5173//evil.com/x");
    await existing.call("http://localhost:5173/\\evil.com/x?a=1");
    expect(existing.requests.map((r) => r.req.url)).toEqual(["https://host.tail1234.ts.net:8443//evil.com/x", "https://host.tail1234.ts.net:8443//evil.com/x?a=1"]);
    const started = setup();
    await started.call("localhost:5173//evil.com");
    expect(started.requests[0]!.req.url).toBe("https://host.tail1234.ts.net:5173//evil.com");
  });

  it(`starts private forwards for ${MAX_FORWARDS_PER_CHAT} ports of one chat at most, counting each as it starts`, async () => {
    const renamed = new Map<string, string>();
    const { call, requests, started } = setup({
      startPrivateForward: async (port) => {
        started.push(port);
        if (port === 3002) throw new Error("tailscale serve failed");
        await Bun.sleep(5);
        return `https://host.tail1234.ts.net:${port}/`;
      },
      canonical: (sessionId) => renamed.get(sessionId) ?? sessionId,
    });
    // Called together, as an agent can: each place is taken before any forward is up.
    await Promise.all([3001, 3002, 3003, 3004, 3005].map((port) => call(`localhost:${port}`)));
    expect(started.toSorted()).toEqual([3001, 3002, 3003, 3004]);
    expect(requests.find((r) => r.req.port === 3005)!.req.via).toBe("local");
    // 3002's forward failed, which gave its place back.
    await call("localhost:3005");
    expect(started.at(-1)).toBe(3005);
    // Codex renames a new chat during its first turn: under either name, a port it has opens
    // again and a fifth one does not.
    renamed.set("chat-1", "codex-thread-9");
    await call("localhost:3001/again", "codex-thread-9");
    expect(requests.at(-1)!.req).toMatchObject({ port: 3001, via: "tailscale" });
    for (const sessionId of ["codex-thread-9", "chat-1"]) {
      await call("localhost:3006", sessionId);
      expect(requests.at(-1)!.req).toMatchObject({ port: 3006, via: "local" });
    }
    expect(started).not.toContain(3006);
    const refused = setup({ outcome: { ok: true, result: { type: "tab_open_result", requestId: "r".repeat(16), opened: false, error: "this device is not the machine PPM runs on" } } });
    for (const port of [4001, 4002, 4003, 4004]) await refused.call(`localhost:${port}`);
    const answer = await refused.call("localhost:4005");
    expect(refused.started).toEqual([4001, 4002, 4003, 4004]);
    expect(answer.text).toContain(`PPM could not forward the port privately (this chat already had ${MAX_FORWARDS_PER_CHAT} ports forwarded, the most PPM starts for one chat)`);
    // Another chat has places of its own.
    await refused.call("localhost:4005", "chat-2");
    expect(refused.started.at(-1)).toBe(4005);
  });

  it("reuses a forward the user already has, public ones included, without starting another", async () => {
    const quick = setup({ existingForward: () => ({ url: "https://calm-river.trycloudflare.com", via: "cloudflare" }) });
    const answer = await quick.call("localhost:3000/docs");
    expect(quick.started).toEqual([]);
    expect(quick.requests[0]!.req).toEqual({ tool: "open_url", url: "https://calm-river.trycloudflare.com/docs", port: 3000, via: "cloudflare" });
    expect(answer.text).toContain("through the public Cloudflare forward the user already has for port 3000");
  });

  it("falls back to the server's own address when no private forward can start, and says why when the device cannot reach it", async () => {
    const noTailscale = setup({
      startPrivateForward: async () => { throw new Error("Tailscale is not installed on the host"); },
      outcome: { ok: true, result: { type: "tab_open_result", requestId: "r".repeat(16), opened: false, error: "this device is not the machine PPM runs on" } },
    });
    const answer = await noTailscale.call("http://localhost:5173/");
    expect(noTailscale.requests[0]!.req).toEqual({ tool: "open_url", url: "http://localhost:5173/", port: 5173, via: "local" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("could not open http://localhost:5173/: this device is not the machine PPM runs on.");
    expect(answer.text).toContain("PPM could not forward the port privately (Tailscale is not installed on the host)");
    const onHost = setup({ startPrivateForward: async () => { throw new Error("no tailscale"); } });
    expect((await onHost.call("5173")).text).toContain("directly, which works because that device is this machine");
  });

  it("refuses PPM's own ports and a port nothing listens on, before forwarding anything", async () => {
    const { call, requests, started } = setup({ listening: async (port) => port !== 9999 });
    expect((await call("http://localhost:8080/")).text).toBe("Port 8080 is PPM itself, which the user already has open.");
    expect((await call("http://127.0.0.1:41234/api")).isError).toBe(true);
    const dead = await call("http://localhost:9999/");
    expect(dead.isError).toBe(true);
    expect(dead.text).toContain("Nothing is listening on port 9999");
    expect((await call("https://example.com/")).isError).toBe(true);
    expect(requests).toEqual([]);
    expect(started).toEqual([]);
  });

  it("names the page when no device shows the chat", async () => {
    const { call } = setup({ outcome: { ok: false, reason: "no-device", message: "No PPM window has this chat open, so nothing was shown." } });
    expect((await call("5173")).text).toBe("No PPM window has this chat open, so nothing was shown. The page is http://localhost:5173/.");
  });
});
