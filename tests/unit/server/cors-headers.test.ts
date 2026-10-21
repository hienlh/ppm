import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corsHeaders } from "../../../src/server/middleware/cors-headers.ts";
import { rangeFileResponse } from "../../../src/server/helpers/range-file-response.ts";

let dir: string;
let file: string;
let small: string;
const SIZE = 3 * 1024 * 1024;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cors-headers-"));
  file = join(dir, "big.bin");
  writeFileSync(file, new Uint8Array(SIZE).fill(7));
  small = join(dir, "digits.txt");
  writeFileSync(small, "0123456789");
  const app = new Hono();
  app.use("*", corsHeaders);
  app.get("/file", () => new Response(Bun.file(file), { headers: { "Content-Type": "application/octet-stream" } }));
  app.get("/range", (c) => rangeFileResponse(small, c.req.raw, {}, "text/plain"));
  app.get("/json", (c) => c.json({ ok: true }));
  app.get("/own-origin", () => new Response("x", { headers: { "Access-Control-Allow-Origin": "null" } }));
  app.get("/redirect", () => Response.redirect("http://localhost/elsewhere", 302));
  app.get("/boom", () => { throw new Error("boom"); });
  server = Bun.serve({ port: 0, fetch: app.fetch });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

describe("corsHeaders", () => {
  it("leaves a Bun.file response unrebuilt: it keeps its Content-Length instead of going chunked", async () => {
    // A rebuilt response (what Hono's `cors()` caused) loses Content-Length and is sent through
    // Bun's file stream, which keeps about the file's size in native memory per response.
    const res = await fetch(url("/file"));
    expect(res.headers.get("content-length")).toBe(String(SIZE));
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE);
  });

  it("sends a range of a file as the range: a rebuilt BunFile.slice() body used to run to EOF", async () => {
    const res = await fetch(url("/range"), { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  it("adds * to an ordinary response and to an error response", async () => {
    expect((await fetch(url("/json"))).headers.get("access-control-allow-origin")).toBe("*");
    const boom = await fetch(url("/boom"));
    expect(boom.status).toBe(500);
    expect(boom.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps an origin a route set itself", async () => {
    expect((await fetch(url("/own-origin"))).headers.get("access-control-allow-origin")).toBe("null");
  });

  it("rebuilds a response whose headers are immutable instead of throwing", async () => {
    const res = await fetch(url("/redirect"), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/elsewhere");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers a preflight as cors() did, echoing the requested headers", async () => {
    const res = await fetch(url("/json"), {
      method: "OPTIONS",
      headers: { Origin: "http://other.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,HEAD,PUT,POST,DELETE,PATCH");
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization,content-type");
    expect(res.headers.get("vary")).toBe("Access-Control-Request-Headers");
  });
});
