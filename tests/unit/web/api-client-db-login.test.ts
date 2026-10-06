/**
 * The API client's side of Database Log In: a `428 DB_LOGIN_REQUIRED` asks the registered
 * handler, and the request goes again once it says a login is held. Waiting for a person to type
 * a password is not a stalled connection, so only the sends themselves are timed.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

// api-client reads the token from localStorage at call time; see api-client-get-dedup.test.ts.
const store = new Map<string, string>();
installGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
afterAll(uninstallDom);

const { ApiClient, ApiError, setDbLoginHandler } = await import("../../../src/web/lib/api-client");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setDbLoginHandler(null);
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const LOGIN_REQUIRED = { ok: false, error: "prod asks for its password", code: "DB_LOGIN_REQUIRED", login: { connectionId: 9 } };

describe("a database login asked for mid-request", () => {
  it("does not time the wait for the login, and does time the request sent after it", async () => {
    const client = new ApiClient("", 30);
    let sends = 0;
    // Counted per URL: this test spans a real sleep, and a request another suite left behind can
    // land in that window.
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (!String(url).endsWith("/api/db/connections/9/tables")) return Promise.resolve(json(599, { ok: false, error: "not this test's" }));
      sends++;
      if (sends === 1) return Promise.resolve(json(428, LOGIN_REQUIRED));
      // The second send never answers; only its own clock can end it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as typeof fetch;
    // Longer than the client's timeout: a person typing a password.
    setDbLoginHandler(async () => { await Bun.sleep(80); return true; });

    const started = Date.now();
    const error = await client.get("/api/db/connections/9/tables").catch((e) => e);
    expect(sends).toBe(2);
    expect((error as DOMException).name).toBe("TimeoutError");
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it("asks only for a 428 that says a login is needed", async () => {
    const client = new ApiClient("", 1000);
    let asked = 0;
    globalThis.fetch = (() => Promise.resolve(json(428, { ok: false, error: "Precondition Required" }))) as unknown as typeof fetch;
    setDbLoginHandler(async () => { asked++; return true; });

    const error = await client.post("/api/anything").catch((e) => e);
    expect(asked).toBe(0);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(428);
  });

  it("sends a write again with the same body once the login is held", async () => {
    const client = new ApiClient("", 1000);
    const bodies: unknown[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(bodies.length === 1 ? json(428, LOGIN_REQUIRED) : json(200, { ok: true, data: { applied: 1 } }));
    }) as typeof fetch;
    let prompt: unknown = null;
    setDbLoginHandler(async (body) => { prompt = body; return true; });

    expect(await client.post("/api/db/connections/9/changeset/apply", { changes: [1] })).toEqual({ applied: 1 });
    expect(bodies).toEqual([{ changes: [1] }, { changes: [1] }]);
    expect((prompt as { login: unknown }).login).toEqual({ connectionId: 9 });
  });
});

describe("a streamed answer", () => {
  const ndjson = (text: string) => new Response(text, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });

  it("hands back the response with its body unread, once the request was taken", async () => {
    const client = new ApiClient("", 1000);
    globalThis.fetch = (() => Promise.resolve(ndjson('{"type":"start"}\n'))) as unknown as typeof fetch;
    const res = await client.postStream("/api/db/connections/9/query/script", { sql: "SELECT 1" });
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe('{"type":"start"}\n');
  });

  it("throws a refusal as post does, and sends again once a login asked for is held", async () => {
    const client = new ApiClient("", 1000);
    const answers = [json(428, LOGIN_REQUIRED), ndjson("{}\n")];
    let sends = 0;
    globalThis.fetch = (() => { sends++; return Promise.resolve(answers.shift()!); }) as unknown as typeof fetch;
    setDbLoginHandler(async () => true);
    expect((await client.postStream("/api/db/connections/9/query/script", { sql: "SELECT 1" })).status).toBe(200);
    expect(sends).toBe(2);

    globalThis.fetch = (() => Promise.resolve(json(403, { ok: false, error: "Connection is readonly" }))) as unknown as typeof fetch;
    const refused = await client.postStream("/api/db/connections/9/query/script", { sql: "DELETE FROM t" }).catch((e) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 403, message: "Connection is readonly" });
  });

  it("says what went wrong when a failure is not JSON", async () => {
    const client = new ApiClient("", 1000);
    globalThis.fetch = (() => Promise.resolve(new Response("Bad Gateway", { status: 502 }))) as unknown as typeof fetch;
    expect((await client.postStream("/x", {}).catch((e) => e)).message).toBe("Server error (HTTP 502)");
  });
});
