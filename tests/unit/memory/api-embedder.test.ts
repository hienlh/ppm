/**
 * The API embedder against a local fake OpenAI-compatible endpoint (Bun.serve on port 0).
 * No network beyond localhost.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_EMBED_TIMEOUT_MS, ApiEmbedder } from "../../../src/services/memory/embedding/api-embedder.ts";

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  contentType: string | null;
  body: any;
}

type Handler = (req: Request, body: any) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];
let handler: Handler = () => new Response("unset", { status: 500 });
let base = "";

beforeAll(() => {
  if (!process.env.PPM_HOME) process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-api-embedder-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const text = await req.text();
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {}
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body,
      });
      return handler(req, body);
    },
  });
  base = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  seen = [];
  handler = () => new Response("unset", { status: 500 });
});

/** Answers like OpenAI: one embedding per input, vector = [input length, index, 0.5]. */
const okHandler: Handler = (_req, body) =>
  Response.json({
    object: "list",
    data: (body.input as string[]).map((s, i) => ({ object: "embedding", index: i, embedding: [s.length, i, 0.5] })),
    model: body.model,
  });

describe("ApiEmbedder", () => {
  test("default timeout is 15 s", () => {
    expect(API_EMBED_TIMEOUT_MS).toBe(15_000);
  });

  test("model id carries the source: api:<url>#<model>", () => {
    const e = new ApiEmbedder({ url: base, model: "text-embedding-3-small", apiKey: "k" });
    expect(e.model).toBe(`api:${base}#text-embedding-3-small`);
  });

  test("POSTs { model, input } to <url>/embeddings with a Bearer key and parses vectors", async () => {
    handler = okHandler;
    const e = new ApiEmbedder({ url: base, model: "text-embedding-3-small", apiKey: "sk-test-123" });
    const out = await e.embed(["hello", "xin chào bạn"], "passage");

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].path).toBe("/v1/embeddings");
    expect(seen[0].auth).toBe("Bearer sk-test-123");
    expect(seen[0].contentType).toContain("application/json");
    expect(seen[0].body).toEqual({ model: "text-embedding-3-small", input: ["hello", "xin chào bạn"] });

    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[0])).toEqual([5, 0, 0.5]);
    expect(Array.from(out[1])).toEqual(["xin chào bạn".length, 1, 0.5]);
  });

  test("a trailing slash on the URL does not double the slash", async () => {
    handler = okHandler;
    const e = new ApiEmbedder({ url: base + "/", model: "m", apiKey: "k" });
    await e.embed(["a"], "query");
    expect(seen[0].path).toBe("/v1/embeddings");
  });

  test("vectors are returned in input order even when the endpoint answers out of order", async () => {
    handler = (_req, body) =>
      Response.json({
        data: (body.input as string[])
          .map((s, i) => ({ index: i, embedding: [s.length, i] }))
          .reverse(),
      });
    const e = new ApiEmbedder({ url: base, model: "m", apiKey: "k" });
    const out = await e.embed(["a", "bb", "ccc"], "passage");
    expect(out.map((v) => Array.from(v))).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
  });

  test("an e5 model gets the query: / passage: prefixes, others do not", async () => {
    handler = okHandler;
    const e5 = new ApiEmbedder({ url: base, model: "intfloat/multilingual-e5-small", apiKey: "k" });
    await e5.embed(["tìm cái này"], "query");
    await e5.embed(["một đoạn văn"], "passage");
    expect(seen[0].body.input).toEqual(["query: tìm cái này"]);
    expect(seen[1].body.input).toEqual(["passage: một đoạn văn"]);

    const plain = new ApiEmbedder({ url: base, model: "text-embedding-3-small", apiKey: "k" });
    await plain.embed(["tìm cái này"], "query");
    expect(seen[2].body.input).toEqual(["tìm cái này"]);
  });

  test("no key → no Authorization header", async () => {
    handler = okHandler;
    const e = new ApiEmbedder({ url: base, model: "m" });
    await e.embed(["a"], "passage");
    expect(seen[0].auth).toBeNull();
  });

  test("an empty list makes no request", async () => {
    handler = okHandler;
    const e = new ApiEmbedder({ url: base, model: "m", apiKey: "k" });
    expect(await e.embed([], "passage")).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("an HTTP error carries the status and the endpoint's JSON error message", async () => {
    handler = () => Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }, { status: 401 });
    const e = new ApiEmbedder({ url: base, model: "m", apiKey: "bad" });
    const err = await e.embed(["a"], "passage").then(
      () => null,
      (x: Error) => x,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("401");
    expect(err!.message).toContain("Incorrect API key provided");
  });

  test("an HTTP error with a plain-text body carries the status and that text", async () => {
    handler = () => new Response("upstream model is overloaded", { status: 503 });
    const e = new ApiEmbedder({ url: base, model: "m", apiKey: "k" });
    const err = await e.embed(["a"], "passage").then(
      () => null,
      (x: Error) => x,
    );
    expect(err!.message).toContain("503");
    expect(err!.message).toContain("upstream model is overloaded");
  });

  test("a 200 answer without data is an error, not an empty result", async () => {
    handler = () => Response.json({ nothing: true });
    const e = new ApiEmbedder({ url: base, model: "m", apiKey: "k" });
    await expect(e.embed(["a"], "passage")).rejects.toThrow();
  });

  test("a 200 answer with the wrong number of vectors is an error", async () => {
    handler = () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
    const e = new ApiEmbedder({ url: base, model: "m", apiKey: "k" });
    await expect(e.embed(["a", "b"], "passage")).rejects.toThrow();
  });

  test("an endpoint that does not answer times out with a clear error", async () => {
    handler = () => new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({ data: [] })), 3_000));
    const e = new ApiEmbedder({ url: base, model: "m", apiKey: "k", timeoutMs: 150 });
    const t0 = performance.now();
    const err = await e.embed(["a"], "passage").then(
      () => null,
      (x: Error) => x,
    );
    const ms = performance.now() - t0;
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/timed out/i);
    expect(ms).toBeLessThan(1_500);
  });

  test("an unreachable endpoint rejects with an error naming the URL", async () => {
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${dead.port}/v1`;
    dead.stop(true);
    const e = new ApiEmbedder({ url, model: "m", apiKey: "k", timeoutMs: 2_000 });
    const err = await e.embed(["a"], "passage").then(
      () => null,
      (x: Error) => x,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(url);
  });
});
