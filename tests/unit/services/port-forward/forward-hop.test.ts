import { afterEach, describe, expect, test } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  rewriteLocation,
  sendableCloseCode,
  startForwardHop,
  upstreamRequestHeaders,
  type ForwardHop,
} from "../../../../src/services/port-forward/forward-hop.ts";
import { allowFramingFrom, forgetFramingOriginsForTest } from "../../../../src/services/port-forward/frame-ancestors.ts";

/**
 * A dev server shaped like Vite 8's defaults: it listens on one loopback family only and
 * refuses any Host that is not localhost, with Vite's own wording.
 */
function startDevServer(hostname: "::1" | "127.0.0.1") {
  return Bun.serve<{ host: string | null }>({
    hostname,
    port: 0,
    fetch(req, srv) {
      const host = req.headers.get("host") ?? "";
      if (!/^localhost(:\d+)?$/.test(host)) {
        return new Response(`Blocked request. This host ("${host.replace(/:\d+$/, "")}") is not allowed.`, { status: 403 });
      }
      if (req.headers.get("upgrade") === "websocket") {
        const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const ok = srv.upgrade(req, {
          data: { host },
          headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
        });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/gz") {
        return new Response(gzipSync("compressed body"), { headers: { "content-encoding": "gzip", "content-type": "text/plain" } });
      }
      if (url.pathname === "/framed") {
        // What a Rails app sends with its defaults.
        return new Response("<h1>framed</h1>", { headers: { "content-type": "text/html", "x-frame-options": "SAMEORIGIN" } });
      }
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: `http://localhost:${srv.port}/landed?x=1` } });
      }
      if (url.pathname === "/echo" && req.method === "POST") {
        return req.text().then((body) => new Response(`posted:${body}`));
      }
      return new Response(JSON.stringify({ host, origin: req.headers.get("origin"), referer: req.headers.get("referer") }), {
        headers: { "content-type": "application/json" },
      });
    },
    websocket: {
      open(ws) { ws.send(`hello host=${ws.data.host}`); },
      message(ws, message) { ws.send(`echo:${message}`); },
    },
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const PUBLIC_HOST = "devbox.tail1234.ts.net:5173";

/** A hop whose forward is at `https://${PUBLIC_HOST}/`, as the transport reports it. */
function hopFor(port: number): ForwardHop {
  const hop = startForwardHop(port);
  cleanups.push(() => hop.stop());
  hop.setPublicUrl(`https://${PUBLIC_HOST}/`);
  return hop;
}

function devServer(hostname: "::1" | "127.0.0.1") {
  const server = startDevServer(hostname);
  cleanups.push(() => server.stop(true));
  return server;
}

describe("upstreamRequestHeaders", () => {
  test("sends Host as localhost and drops what described the incoming connection", () => {
    const out = upstreamRequestHeaders(new Headers({
      host: PUBLIC_HOST, connection: "keep-alive", "x-forwarded-host": PUBLIC_HOST,
      "sec-websocket-key": "abc", "sec-websocket-extensions": "permessage-deflate", cookie: "a=1",
    }), 5173, PUBLIC_HOST);
    expect(out.get("host")).toBe("localhost:5173");
    expect(out.get("connection")).toBeNull();
    expect(out.get("x-forwarded-host")).toBeNull();
    expect(out.get("sec-websocket-key")).toBeNull();
    expect(out.get("sec-websocket-extensions")).toBeNull();
    expect(out.get("cookie")).toBe("a=1");
  });

  test("rewrites Origin and Referer only when they name the forward's own origin", () => {
    const own = upstreamRequestHeaders(new Headers({
      origin: `https://${PUBLIC_HOST}`, referer: `https://${PUBLIC_HOST}/src/main.tsx?t=1`,
    }), 5173, PUBLIC_HOST);
    expect(own.get("origin")).toBe("http://localhost:5173");
    expect(own.get("referer")).toBe("http://localhost:5173/src/main.tsx?t=1");

    const foreign = upstreamRequestHeaders(new Headers({
      origin: "https://evil.example", referer: `https://${PUBLIC_HOST}.evil.example/`,
    }), 5173, PUBLIC_HOST);
    expect(foreign.get("origin")).toBe("https://evil.example");
    expect(foreign.get("referer")).toBe(`https://${PUBLIC_HOST}.evil.example/`);
  });
});

describe("rewriteLocation", () => {
  test("makes a redirect to the dev server's local origin relative", () => {
    expect(rewriteLocation("http://localhost:5173/a/b?c=1", 5173)).toBe("/a/b?c=1");
    expect(rewriteLocation("http://127.0.0.1:5173", 5173)).toBe("/");
    expect(rewriteLocation("https://[::1]:5173?x=1", 5173)).toBe("/?x=1");
  });

  test("leaves every other redirect alone", () => {
    expect(rewriteLocation("http://localhost:3000/a", 5173)).toBe("http://localhost:3000/a");
    expect(rewriteLocation("http://localhost:51730/a", 5173)).toBe("http://localhost:51730/a");
    expect(rewriteLocation("https://accounts.example.com/login", 5173)).toBe("https://accounts.example.com/login");
    expect(rewriteLocation("/relative", 5173)).toBe("/relative");
  });
});

test("sendableCloseCode turns the reserved codes into a normal close", () => {
  expect(sendableCloseCode(1000)).toBe(1000);
  expect(sendableCloseCode(1001)).toBe(1001);
  expect(sendableCloseCode(4001)).toBe(4001);
  expect(sendableCloseCode(1005)).toBe(1000);
  expect(sendableCloseCode(1006)).toBe(1000);
  expect(sendableCloseCode(1015)).toBe(1000);
  expect(sendableCloseCode(undefined)).toBe(1000);
});

describe("startForwardHop", () => {
  test("reaches a dev server listening on [::1] only, past its Host check", async () => {
    const dev = devServer("::1");
    // The premise: what a transport arriving with its own host name gets without the hop.
    const direct = await fetch(`http://[::1]:${dev.port}/`, { headers: { host: PUBLIC_HOST } });
    expect(direct.status).toBe(403);

    const hop = hopFor(dev.port!);
    const res = await fetch(`http://127.0.0.1:${hop.port}/`, {
      headers: { host: PUBLIC_HOST, origin: `https://${PUBLIC_HOST}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: `localhost:${dev.port}`, origin: `http://localhost:${dev.port}`, referer: null });
  });

  test("reaches a dev server listening on 127.0.0.1 only", async () => {
    const dev = devServer("127.0.0.1");
    const hop = hopFor(dev.port!);
    const res = await fetch(`http://127.0.0.1:${hop.port}/`, { headers: { host: PUBLIC_HOST } });
    expect(res.status).toBe(200);
  });

  test("answers 421 to any host but its forward's, so a rebound name gets no further than without it", async () => {
    const dev = devServer("::1");
    const hop = hopFor(dev.port!);
    // A page whose own name resolves to 127.0.0.1 (DNS rebinding), open in a browser on the host.
    const rebound = `rebind.example:${hop.port}`;
    const res = await fetch(`http://127.0.0.1:${hop.port}/`, { headers: { host: rebound, origin: `http://${rebound}` } });
    expect(res.status).toBe(421);
    const ws = new WebSocket(`ws://127.0.0.1:${hop.port}/`, { headers: { host: rebound, origin: `http://${rebound}` } });
    expect(await new Promise<string>((resolve) => { ws.onopen = () => resolve("open"); ws.onclose = () => resolve("closed"); })).toBe("closed");
    // Host names are case-insensitive.
    const own = await fetch(`http://127.0.0.1:${hop.port}/`, { headers: { host: PUBLIC_HOST.toUpperCase() } });
    expect(own.status).toBe(200);
  });

  test("answers nothing until its transport has said where the forward is", async () => {
    const dev = devServer("::1");
    const hop = startForwardHop(dev.port!);
    cleanups.push(() => hop.stop());
    const res = await fetch(`http://127.0.0.1:${hop.port}/`, { headers: { host: PUBLIC_HOST } });
    expect(res.status).toBe(421);
  });

  test("passes a compressed body through untouched", async () => {
    const dev = devServer("::1");
    const hop = hopFor(dev.port!);
    const res = await fetch(`http://127.0.0.1:${hop.port}/gz`, { headers: { host: PUBLIC_HOST }, decompress: false });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString()).toBe("compressed body");
  });

  test("keeps a redirect to the dev server on the forward", async () => {
    const dev = devServer("::1");
    const hop = hopFor(dev.port!);
    const res = await fetch(`http://127.0.0.1:${hop.port}/redirect`, { headers: { host: PUBLIC_HOST }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/landed?x=1");
  });

  test("lets the PPM it was told about frame a page that refuses framing", async () => {
    const dev = devServer("::1");
    const hop = hopFor(dev.port!);
    const before = await fetch(`http://127.0.0.1:${hop.port}/framed`, { headers: { host: PUBLIC_HOST } });
    expect(before.headers.get("x-frame-options")).toBe("SAMEORIGIN");

    cleanups.push(forgetFramingOriginsForTest);
    allowFramingFrom("http://192.168.1.20:3210");
    const after = await fetch(`http://127.0.0.1:${hop.port}/framed`, { headers: { host: PUBLIC_HOST } });
    expect(after.headers.get("x-frame-options")).toBeNull();
    expect(after.headers.get("content-security-policy")).toBe("frame-ancestors 'self' http://192.168.1.20:3210");
    expect(await after.text()).toBe("<h1>framed</h1>");
  });

  test("forwards a request body", async () => {
    const dev = devServer("::1");
    const hop = hopFor(dev.port!);
    const res = await fetch(`http://127.0.0.1:${hop.port}/echo`, { method: "POST", headers: { host: PUBLIC_HOST }, body: "form=1" });
    expect(await res.text()).toBe("posted:form=1");
  });

  test("answers 502 with a page when nothing listens on the port", async () => {
    const dev = devServer("::1");
    const port = dev.port!;
    dev.stop(true);
    const hop = hopFor(port);
    const res = await fetch(`http://127.0.0.1:${hop.port}/`, { headers: { host: PUBLIC_HOST } });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain(`Nothing answers on localhost:${port}`);
  });

  test("relays a WebSocket with its subprotocol, as Vite's HMR client opens it", async () => {
    const dev = devServer("::1");
    const hop = hopFor(dev.port!);
    const ws = new WebSocket(`ws://127.0.0.1:${hop.port}/?token=t`, {
      headers: { host: PUBLIC_HOST, origin: `https://${PUBLIC_HOST}` },
      protocols: ["vite-hmr"],
    });
    cleanups.push(() => ws.close());
    const messages: string[] = [];
    const twoMessages = new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => { messages.push(String(e.data)); if (messages.length === 2) resolve(); };
      ws.onerror = () => reject(new Error("socket error"));
    });
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    expect(ws.protocol).toBe("vite-hmr");
    ws.send("ping");
    await twoMessages;
    expect(messages).toEqual([`hello host=localhost:${dev.port}`, "echo:ping"]);
  });

  test("fails the WebSocket handshake when the dev server is not there", async () => {
    const dev = devServer("::1");
    const port = dev.port!;
    dev.stop(true);
    const hop = hopFor(port);
    const ws = new WebSocket(`ws://127.0.0.1:${hop.port}/`, { headers: { host: PUBLIC_HOST } });
    const outcome = await new Promise<string>((resolve) => {
      ws.onopen = () => resolve("open");
      ws.onclose = () => resolve("closed");
    });
    expect(outcome).toBe("closed");
  });
});
