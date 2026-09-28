/**
 * Where this process's HTTP server actually listens, for URLs PPM hands to its own child
 * processes (the design MCP endpoint a Claude or Codex subprocess calls back into).
 *
 * The configured port is not good enough: the supervisor starts the server on port 0 and
 * the OS picks one, and a dev server runs on whatever port it was given — a URL built from
 * `configService.get("port")` then reaches another instance, or nothing. The server records
 * the bound port here once `Bun.serve` returns; a process that never serves (the CLI) has
 * none, and callers must treat that as "no callback available".
 */

let address: { port: number; hostname: string } | null = null;

export function setServerListenAddress(port: number, hostname: string): void {
  address = Number.isInteger(port) && port > 0 && port < 65536 ? { port, hostname } : null;
}

/** Base URL a local child process can reach this server on, or null when nothing listens. */
export function localServerBaseUrl(): string | null {
  if (!address) return null;
  const host = address.hostname;
  // A wildcard bind is reachable on loopback; a specific address only on itself.
  const reachable = !host || host === "0.0.0.0" || host === "::" || host === "localhost" ? "127.0.0.1" : host;
  return `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${address.port}`;
}
