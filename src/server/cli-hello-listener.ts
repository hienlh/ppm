import { Hono } from "hono";
import { cliHelloRoutesFor } from "./routes/cli-hello.ts";
import { markEdgeForwardedPort } from "./routes/cli-hello-request-guard.ts";

/**
 * Where a supervised server answers the `ppm` CLI's identity check.
 *
 * Under the supervisor, the server's own port is the one the edge forwarder relays every network
 * client to (raw TCP, from loopback, adding no header), so a request on it cannot be told from the
 * CLI's. The proof is refused there, and answered instead on a second listener bound to
 * 127.0.0.1 that nothing forwards to. It serves the identity check and nothing else; the proof it
 * gives covers the main port, where the CLI then sends its requests.
 *
 * Returns the listener's port, or null when it could not bind (the CLI then cannot prove this
 * server and refuses to send it the token, which fails closed).
 */
export function startCliHelloListener(mainPort: number): number | null {
  markEdgeForwardedPort(mainPort);
  const app = new Hono().route("/api/cli", cliHelloRoutesFor(mainPort));
  try {
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => app.fetch(req, server) });
    return Number(listener.port) || null;
  } catch (e) {
    console.error(`[serve] Could not open the CLI's identity-check listener: ${(e as Error).message}`);
    return null;
  }
}
