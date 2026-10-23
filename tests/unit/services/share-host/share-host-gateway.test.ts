import { describe, expect, it } from "bun:test";
import {
  createShareHostHandler, isShareHostPath, MAX_FORWARDED_BODY_BYTES,
} from "../../../../src/services/share-host/share-host-gateway.ts";

interface Seen { url: string; init: RequestInit & { decompress?: boolean } }

/** A handler whose upstream is `answer`, recording every request it would have sent to PPM. */
function gateway(answer: (seen: Seen) => Response | Promise<Response> = () => new Response("ok"), port: number | null = 4321) {
  const seen: Seen[] = [];
  let resets = 0;
  const handle = createShareHostHandler({
    targetPort: () => port,
    resetTargetPort: () => { resets++; },
    fetch: (async (url: string, init: RequestInit) => {
      const entry = { url, init };
      seen.push(entry);
      return answer(entry);
    }) as typeof fetch,
    connectWindowMs: 300,
    timeoutMs: 1000,
  });
  return { handle, seen, resets: () => resets };
}

const req = (path: string, init: RequestInit = {}) => new Request(`https://share.example.com${path}`, init);

describe("isShareHostPath", () => {
  it("takes the review pages and their build", () => {
    for (const path of ["/s", "/s/", "/s/abc123", "/s/abc123/info", "/s/abc123/f/index.html", "/s/abc123/comments",
      "/assets/share-AbC_12-x.js", "/assets/share-AbC.css", "/assets/share-Q1.woff2"]) {
      expect(isShareHostPath(path)).toBe(true);
    }
  });

  it("refuses everything else of PPM", () => {
    for (const path of ["/", "/index.html", "/api/projects", "/api/auth/login", "/ws/global", "/settings", "/sx",
      "/sw.js", "/manifest.webmanifest", "/assets/index-abc.js", "/assets/monaco/vs/loader.js", "/assets/share-a/b.js",
      "/assets/share-.js", "/assets/sharex-a.js", "/project/x/editor/s/a"]) {
      expect(isShareHostPath(path)).toBe(false);
    }
  });
});

describe("share host handler", () => {
  it("answers a path outside the review pages itself, without asking PPM", async () => {
    const g = gateway();
    for (const path of ["/", "/api/projects", "/api/settings/tunnel", "/ws/global", "/assets/index-abc.js"]) {
      const res = await g.handle(req(path));
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    expect(g.seen).toHaveLength(0);
  });

  it("decides on the resolved path, so dot segments cannot climb out of /s", async () => {
    const g = gateway();
    for (const raw of ["/s/x/../../api/projects", "/s/%2e%2e/api/projects", "/s/%2E%2E/%2e%2e/api/projects", "/s\\..\\api"]) {
      const res = await g.handle(new Request(`https://share.example.com${raw}`));
      expect(res.status).toBe(404);
    }
    expect(g.seen).toHaveLength(0);
  });

  it("forwards the parsed path and query to PPM on loopback, keeping Host and the visitor's address", async () => {
    const g = gateway();
    const res = await g.handle(req("/s/abc123/f/index.html?n=xyz", {
      headers: {
        Host: "share.example.com", "CF-Connecting-IP": "203.0.113.7", Accept: "text/html",
        Authorization: "Bearer stolen", Cookie: "ppm=1", Connection: "keep-alive", "Proxy-Authorization": "x",
      },
    }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(g.seen).toHaveLength(1);
    const { url, init } = g.seen[0]!;
    expect(url).toBe("http://127.0.0.1:4321/s/abc123/f/index.html?n=xyz");
    const headers = new Headers(init.headers);
    expect(headers.get("host")).toBe("share.example.com");
    expect(headers.get("cf-connecting-ip")).toBe("203.0.113.7");
    expect(headers.get("accept")).toBe("text/html");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("connection")).toBe(false);
    expect(headers.has("proxy-authorization")).toBe(false);
    expect(init.redirect).toBe("manual");
    expect(init.decompress).toBe(false);
  });

  it("passes a reviewer's comment write through, and only the methods the share routes take", async () => {
    const g = gateway((s) => new Response(JSON.stringify({ method: s.init.method }), { status: 201 }));
    const body = JSON.stringify({ body: "Looks good" });
    const res = await g.handle(req("/s/abc123/comments", {
      method: "POST", body, headers: { "Content-Type": "application/json", "X-PPM-Request": "1" },
    }));
    expect(res.status).toBe(201);
    expect(new TextDecoder().decode(g.seen[0]!.init.body as ArrayBuffer)).toBe(body);
    expect(new Headers(g.seen[0]!.init.headers).get("x-ppm-request")).toBe("1");

    for (const method of ["PUT", "OPTIONS", "TRACE", "CONNECT"]) {
      expect((await g.handle(req("/s/abc123/comments", { method }))).status).toBe(404);
    }
    // The page's own build is only ever read.
    expect((await g.handle(req("/assets/share-abc.js", { method: "POST", body: "x" }))).status).toBe(404);
    expect(g.seen).toHaveLength(1);
  });

  it("refuses a body larger than any reviewer write, declared or not", async () => {
    const g = gateway();
    const big = "x".repeat(MAX_FORWARDED_BODY_BYTES + 1);
    expect((await g.handle(req("/s/abc123/comments", { method: "POST", body: big }))).status).toBe(413);
    const declared = req("/s/abc123/comments", { method: "POST", body: "{}", headers: { "Content-Length": String(10 * 1024 * 1024) } });
    expect((await g.handle(declared)).status).toBe(413);
    expect(g.seen).toHaveLength(0);
  });

  it("returns PPM's answer as it is, minus the hop's own headers", async () => {
    const g = gateway(() => new Response("compressed-bytes", {
      status: 200,
      headers: {
        "Content-Encoding": "br", "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable",
        Connection: "close", "Keep-Alive": "timeout=5",
      },
    }));
    const res = await g.handle(req("/assets/share-abc.js", { headers: { "Accept-Encoding": "br" } }));
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.has("connection")).toBe(false);
    expect(res.headers.has("keep-alive")).toBe(false);
    expect(await res.text()).toBe("compressed-bytes");
  });

  it("keeps redirects and empty answers as they are", async () => {
    const redirect = gateway(() => new Response(null, { status: 302, headers: { Location: "/s/abc123" } }));
    const res = await redirect.handle(req("/s/abc123/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/s/abc123");

    const notModified = gateway(() => new Response(null, { status: 304, headers: { ETag: '"v1"' } }));
    const cached = await notModified.handle(req("/s/abc123/comments", { headers: { "If-None-Match": '"v1"' } }));
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe('"v1"');

    const head = gateway(() => new Response("body", { headers: { "Content-Type": "text/html" } }));
    const headRes = await head.handle(req("/s/abc123", { method: "HEAD" }));
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe("");
  });

  it("waits for PPM to come back from a restart, reading its port again", async () => {
    let calls = 0;
    const g = gateway(() => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("refused"), { code: "ConnectionRefused" });
      return new Response("back");
    });
    const res = await g.handle(req("/s/abc123"));
    expect(await res.text()).toBe("back");
    expect(g.resets()).toBe(2);
  });

  it("says unavailable when PPM stays down, and when there is no port to reach", async () => {
    const down = gateway(() => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); });
    const res = await down.handle(req("/s/abc123"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");

    const noPort = gateway(undefined, null);
    expect((await noPort.handle(req("/s/abc123"))).status).toBe(503);
    expect(noPort.seen).toHaveLength(0);
  });

  it("cuts a hung answer off as a timeout, not a retry", async () => {
    const g = gateway(() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
    expect((await g.handle(req("/s/abc123"))).status).toBe(504);
    expect(g.seen).toHaveLength(1);
  });
});
