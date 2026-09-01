import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { startEdgeForwarder } from "../../../src/services/edge-forwarder.ts";
import {
  resolveTargetPort,
  _resetTargetCache,
} from "../../../src/services/edge-target-resolver.ts";

const tempDirs: string[] = [];
const openServers: net.Server[] = [];
let home: string;

function setServerPort(port: unknown): void {
  writeFileSync(join(home, ".server-port"), String(port));
  _resetTargetCache();
}

/** Origin that upper-cases whatever it receives, so both directions are proven. */
function startEchoOrigin(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer({ allowHalfOpen: true }, (sock) => {
      sock.on("error", () => sock.destroy());
      sock.on("data", (buf) => sock.write(buf.toString().toUpperCase()));
    });
    openServers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

function listenPort(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

/**
 * Send one line through the edge and resolve with the first reply.
 *
 * Rejects as soon as the connection closes without a reply, not just on the
 * timeout — otherwise "the edge gave up promptly" and "the edge hung" both look
 * identical, and the give-up tests would pass for the wrong reason.
 */
function roundTrip(port: number, payload: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);
    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      action();
    }
    sock.on("error", (e) => finish(() => reject(e)));
    sock.on("close", () => finish(() => reject(new Error("closed without reply"))));
    sock.on("data", (buf) => finish(() => resolve(buf.toString())));
    sock.on("connect", () => sock.write(payload));
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-edge-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  _resetPpmDir();
  _resetTargetCache();
});

afterEach(() => {
  for (const s of openServers.splice(0)) { try { s.close(); } catch {} }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("resolveTargetPort", () => {
  it("returns the recorded server port", () => {
    setServerPort(4321);
    expect(resolveTargetPort()).toBe(4321);
  });

  it("returns null when the file does not exist yet", () => {
    expect(resolveTargetPort()).toBeNull();
  });

  it("rejects values that are not plausible ports", () => {
    // The port file is a traffic-redirect primitive if trusted blindly.
    for (const bad of [0, -1, 70000, "", "not-a-port", "  "]) {
      setServerPort(bad);
      expect(resolveTargetPort()).toBeNull();
    }
  });

  it("caches a hit but re-reads once the window passes", () => {
    setServerPort(4321);
    const t0 = 1_000_000;
    expect(resolveTargetPort(t0)).toBe(4321);

    // Written without clearing the cache — the stale value must still win.
    writeFileSync(join(home, ".server-port"), "5555");
    expect(resolveTargetPort(t0 + 500)).toBe(4321);
    expect(resolveTargetPort(t0 + 1500)).toBe(5555);
  });

  it("does not cache a miss, so startup retries stay responsive", () => {
    const t0 = 2_000_000;
    expect(resolveTargetPort(t0)).toBeNull();
    writeFileSync(join(home, ".server-port"), "6161");
    expect(resolveTargetPort(t0 + 1)).toBe(6161);
  });
});

describe("startEdgeForwarder", () => {
  it("pipes bytes in both directions", async () => {
    const origin = await startEchoOrigin();
    setServerPort(origin.port);

    const edge = await startEdgeForwarder({ publicPort: 0, host: "127.0.0.1" });
    openServers.push(edge);

    expect(await roundTrip(listenPort(edge), "hello")).toBe("HELLO");
  });

  it("follows a server port change without restarting", async () => {
    const first = await startEchoOrigin();
    setServerPort(first.port);

    const edge = await startEdgeForwarder({ publicPort: 0, host: "127.0.0.1" });
    openServers.push(edge);
    expect(await roundTrip(listenPort(edge), "one")).toBe("ONE");

    // Server restarts on a different OS-assigned port — the whole point of
    // dropping the server to an ephemeral port.
    first.server.close();
    const second = await startEchoOrigin();
    setServerPort(second.port);

    expect(await roundTrip(listenPort(edge), "two")).toBe("TWO");
  });

  it("closes the client when no server appears, without dying", async () => {
    const dead = await startEchoOrigin();
    const deadPort = dead.port;
    await new Promise<void>((r) => dead.server.close(() => r()));
    setServerPort(deadPort);

    const edge = await startEdgeForwarder({
      publicPort: 0,
      host: "127.0.0.1",
      connectWindowMs: 400,
    });
    openServers.push(edge);

    await expect(roundTrip(listenPort(edge), "nobody-home")).rejects.toThrow();

    // The edge must still be serving: a dead target is not a fatal condition.
    const revived = await startEchoOrigin();
    setServerPort(revived.port);
    expect(await roundTrip(listenPort(edge), "back")).toBe("BACK");
  });

  it("survives an upstream reset mid-connection", async () => {
    // Origin that accepts then abruptly resets — the ECONNRESET path that
    // would otherwise raise an unhandled 'error' and take the port down.
    const rude = net.createServer((sock) => sock.resetAndDestroy());
    openServers.push(rude);
    await new Promise<void>((r) => rude.listen(0, "127.0.0.1", () => r()));
    setServerPort(listenPort(rude));

    const edge = await startEdgeForwarder({
      publicPort: 0,
      host: "127.0.0.1",
      connectWindowMs: 400,
    });
    openServers.push(edge);

    await roundTrip(listenPort(edge), "boom").catch(() => {});

    const healthy = await startEchoOrigin();
    setServerPort(healthy.port);
    expect(await roundTrip(listenPort(edge), "still-up")).toBe("STILL-UP");
  });
});
