import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { EGRESS_CANARY_HOST, startEgressGuard, type EgressGuard } from "../../src/services/web-browser/egress/egress-process.ts";
import { exchange, socksConnect } from "../helpers/socks5-test-client.ts";

/** The real `ppm __web_egress__` child, started and stopped the way the server will. */

let echo: Server;
let echoPort = 0;

beforeAll(async () => {
  echo = createServer((s) => { s.on("error", () => {}); s.pipe(s); });
  echoPort = await new Promise<number>((ok) => echo.listen(0, "127.0.0.1", () => ok((echo.address() as { port: number }).port)));
});
afterAll(() => new Promise<void>((ok) => echo.close(() => ok())));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

describe("egress guard process", () => {
  it("starts, enforces its config, reports blocks and the canary, and stops", async () => {
    const guard: EgressGuard = await startEgressGuard({ allowLocalhost: true, allowLan: true, blockedLocalPorts: [] });
    try {
      expect(guard.port).toBeGreaterThan(0);
      expect(alive(guard.pid)).toBe(true);

      const allowed = await socksConnect(guard.port, { ipv4: "127.0.0.1", port: echoPort });
      expect(allowed.code).toBe(0);
      expect(await exchange(allowed.socket, "through", 500)).toBe("through");
      allowed.socket.destroy();

      const blocked: unknown[] = [];
      const off = guard.onBlocked((e) => blocked.push(e));
      guard.update({ allowLocalhost: true, allowLan: true, blockedLocalPorts: [echoPort] });
      // The update travels over stdin: try again until the child has applied it.
      let code: number | string = 0;
      const deadline = Date.now() + 3000;
      while (code !== 2 && Date.now() < deadline) {
        const r = await socksConnect(guard.port, { ipv4: "127.0.0.1", port: echoPort });
        r.socket.destroy();
        code = r.code;
        if (code !== 2) await Bun.sleep(25);
      }
      expect(code).toBe(2);
      expect(await waitFor(() => blocked.length === 1)).toBe(true);
      expect(blocked[0]).toEqual({ host: "127.0.0.1", port: echoPort, reason: "own-port" });
      off();

      const metadata = await socksConnect(guard.port, { ipv4: "169.254.169.254", port: 80 });
      metadata.socket.destroy();
      expect(metadata.code).toBe(2);

      let canaries = 0;
      guard.onCanary(() => { canaries++; });
      const probe = await socksConnect(guard.port, { domain: EGRESS_CANARY_HOST, port: 80 });
      expect(probe.code).toBe(0);
      expect((await exchange(probe.socket, "GET / HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 204")).toBe(true);
      expect(await waitFor(() => canaries === 1)).toBe(true);
    } finally {
      await guard.stop();
    }
    expect(await guard.exited).not.toBeUndefined();
    expect(await waitFor(() => !alive(guard.pid))).toBe(true);
  }, 20_000);

  it("stops twice without complaint", async () => {
    const guard = await startEgressGuard({ allowLocalhost: false, allowLan: false, blockedLocalPorts: [1] });
    await guard.stop();
    await guard.stop();
    expect(alive(guard.pid)).toBe(false);
  }, 20_000);
});
