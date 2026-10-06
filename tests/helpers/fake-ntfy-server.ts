/**
 * An ntfy server in miniature, answering the way ntfy 2.x does — the shapes were taken from
 * a real 2.28 server with `auth-default-access: deny-all`: one token that may publish, one
 * that may only read, and nothing for anyone else.
 */
export const WRITER_TOKEN = "tk_writer00000000000000000000000";
export const READER_TOKEN = "tk_reader00000000000000000000000";

export interface FakeNtfy {
  url: string;
  /** Messages the server accepted, as JSON bodies. */
  published: Array<Record<string, unknown>>;
  /** Every request, with the Authorization header it carried. */
  requests: Array<{ method: string; path: string; auth: string | null }>;
  stop(): void;
}

const refusal = (http: 401 | 403 | 404, code: number, error: string) =>
  Response.json({ code, http, error, link: "https://ntfy.sh/docs/publish/#authentication" }, { status: http });

/** `other`: a web server that is not ntfy at all. */
export function startFakeNtfy(kind: "ntfy" | "other" = "ntfy"): FakeNtfy {
  const published: FakeNtfy["published"] = [];
  const requests: FakeNtfy["requests"] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization");
      requests.push({ method: req.method, path, auth });
      if (kind === "other") return new Response("<!doctype html><title>Not ntfy</title>", { status: 404, headers: { "Content-Type": "text/html" } });

      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (auth && token !== WRITER_TOKEN && token !== READER_TOKEN) return refusal(401, 40101, "unauthorized");
      if (path === "/v1/health") return Response.json({ healthy: true });
      // The real answer lists the account's tokens, which is why PPM never reads it.
      if (path === "/v1/account") return Response.json({ username: token ? "tester" : "*", tokens: [{ token: WRITER_TOKEN }] });
      if (req.method === "POST" && path === "/") {
        const body = (await req.json()) as Record<string, unknown>;
        if (token !== WRITER_TOKEN) return refusal(403, 40301, "forbidden");
        published.push(body);
        return Response.json({ id: "abc123", time: 1_700_000_000, event: "message", topic: body.topic });
      }
      return refusal(404, 40401, "page not found");
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, published, requests, stop: () => void server.stop(true) };
}
