import { Hono } from "hono";
import { basename } from "node:path";
import { configService } from "../../services/config.service.ts";
import { getDbPath } from "../../services/db.service.ts";
import { serverInstanceId } from "../../services/server-instance-id.ts";
import { HELLO_NONCE_RE, helloProof } from "../../services/cli-hello-proof.ts";
import { VERSION } from "../../version.ts";
import { ok, err } from "../../types/api.ts";

/**
 * `GET /api/cli/hello?nonce=…`, public: the `ppm` CLI asks it before sending the token anywhere.
 * The answer proves this process holds the database's token without revealing it
 * (`cli-hello-proof.ts`), and names which server and which database it is. Only the database's
 * file name is given out, never its path: this route answers anyone who can reach the port.
 */
export const cliHelloRoutes = new Hono();

cliHelloRoutes.get("/hello", (c) => {
  const nonce = c.req.query("nonce") ?? "";
  if (!HELLO_NONCE_RE.test(nonce)) return c.json(err("nonce must be 16-128 characters of [A-Za-z0-9_-]"), 400);
  const instanceId = serverInstanceId();
  const token = configService.get("auth").token ?? "";
  return c.json(ok({
    instanceId,
    dbFile: basename(getDbPath()),
    version: VERSION,
    proof: helloProof(token, nonce, instanceId),
  }));
});
