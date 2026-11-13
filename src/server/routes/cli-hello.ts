import { Hono, type MiddlewareHandler } from "hono";
import { basename } from "node:path";
import { configService } from "../../services/config.service.ts";
import { getDbPath } from "../../services/db.service.ts";
import { serverInstanceId } from "../../services/server-instance-id.ts";
import { HELLO_NONCE_RE, helloProof } from "../../services/cli-hello-proof.ts";
import { cliHelloRefusal, requestArrivalPort } from "./cli-hello-request-guard.ts";
import { VERSION } from "../../version.ts";
import { ok, err } from "../../types/api.ts";

/**
 * `GET /api/cli/hello?nonce=…`, mounted before auth: the `ppm` CLI asks it before sending the
 * token anywhere. The answer proves this process holds the database's token without revealing it
 * (`cli-hello-proof.ts`), and names which server and which database it is.
 *
 * The proof is an HMAC keyed by the token, and a token can be a short password the user chose, so
 * one answer is enough to guess that password offline. It is therefore answered only to a direct
 * request from this machine (`cli-hello-request-guard.ts`): never to a page in a browser, never
 * through a tunnel or a proxy, and never on a port the edge forwarder relays the network to. Its
 * own `Access-Control-Allow-Origin: null` stands in for the app-wide `*`, so a page that reaches
 * it anyway cannot read what it says.
 *
 * `proofPort`: the port the CLI sends the token to, which the HMAC covers. Absent, it is the port
 * the request came in on (the CLI talks to the same server for both); a hello-only listener beside
 * a server passes that server's port.
 */
export function cliHelloRoutesFor(proofPort?: number): Hono {
  const routes = new Hono();
  routes.use("*", nullOrigin);
  routes.get("/hello", (c) => {
    const refusal = cliHelloRefusal(c.req.raw, c.env);
    if (refusal) return c.json(err(refusal), 403);
    const nonce = c.req.query("nonce") ?? "";
    if (!HELLO_NONCE_RE.test(nonce)) return c.json(err("nonce must be 16-128 characters of [A-Za-z0-9_-]"), 400);
    const port = proofPort ?? requestArrivalPort(c.env);
    if (!port) return c.json(err("This server cannot tell which port it answers on"), 403);
    const instanceId = serverInstanceId();
    const token = configService.get("auth").token ?? "";
    return c.json(ok({
      instanceId,
      dbFile: basename(getDbPath()),
      version: VERSION,
      proof: helloProof(token, nonce, instanceId, port),
    }));
  });
  return routes;
}

/** Set after the handler, so the app-wide CORS layer (which keeps a route's own value) leaves it. */
const nullOrigin: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Access-Control-Allow-Origin", "null");
};

export const cliHelloRoutes = cliHelloRoutesFor();
