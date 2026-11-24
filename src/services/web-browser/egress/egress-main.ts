/**
 * The in-app browser's egress proxy process: `ppm __web_egress__`.
 *
 * It runs apart from the server so that every byte the browser downloads stays off PPM's event
 * loop, and so that a socket error here can never count towards the server's fatal-error limit.
 * It talks to its parent in JSON lines:
 * - stdin, from the server: `{"type":"config","allowLocalhost","allowLan","blockedLocalPorts"}`.
 *   Nothing listens until the first config arrives, so no connection is ever judged by a default.
 * - stdout, to the server: `{"type":"ready","port"}`, `{"type":"blocked","host","port","reason"}`,
 *   `{"type":"canary"}`.
 * It exits when stdin closes, which is how it learns that the server is gone. It never writes a
 * URL anywhere: a blocked event names the host and port only.
 */
import { createInterface } from "node:readline";
import { startSocks5Server, type EgressPolicy, type Socks5Server } from "./socks5-server.ts";

function send(message: Record<string, unknown>): void {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {}
}

/** The policy a config line carries, or null when any field is missing or malformed. */
export function parseEgressConfig(message: unknown): EgressPolicy | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.type !== "config" || typeof m.allowLocalhost !== "boolean" || typeof m.allowLan !== "boolean") return null;
  if (!Array.isArray(m.blockedLocalPorts)) return null;
  const ports = m.blockedLocalPorts.filter((p): p is number => Number.isInteger(p) && p > 0 && p <= 65535);
  if (ports.length !== m.blockedLocalPorts.length) return null;
  return { allowLocalhost: m.allowLocalhost, allowLan: m.allowLan, blockedLocalPorts: ports };
}

async function main(): Promise<void> {
  let policy: EgressPolicy | null = null;
  let server: Promise<Socks5Server> | null = null;
  let exiting = false;

  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    try { await (await server)?.close(); } catch {}
    process.exit(0);
  };

  process.stdout.on("error", () => void shutdown());
  // One bad connection must not take the browser's network down with it.
  process.on("uncaughtException", (error) => console.error(`[web-egress] ${error}`));
  process.on("unhandledRejection", (error) => console.error(`[web-egress] ${error}`));
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  const lines = createInterface({ input: process.stdin });
  lines.on("close", () => void shutdown());
  lines.on("line", (line) => {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    const next = parseEgressConfig(message);
    if (!next) return;
    policy = next;
    if (server) return;
    server = startSocks5Server({
      policy: () => policy as EgressPolicy,
      onBlocked: (event) => send({ type: "blocked", ...event }),
      onCanary: () => send({ type: "canary" }),
    });
    server.then(
      (s) => send({ type: "ready", port: s.port }),
      (error) => {
        console.error(`[web-egress] could not listen: ${error}`);
        process.exit(1);
      },
    );
  });
}

if (process.argv.includes("__web_egress__")) await main();
