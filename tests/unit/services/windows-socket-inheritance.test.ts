/**
 * A connection the server closes must reach the client as an EOF even while a child it
 * spawned is still running.
 *
 * On Windows Bun creates every socket inheritable and spawns with inheritance on, so a child
 * kept a copy of each open connection and the server's close sent no FIN until that child
 * exited. A browser then reused the dead keep-alive connection and a reload hung 30-60s.
 */
import { describe, it, expect } from "bun:test";
import net from "node:net";
import { spawn as cpSpawn } from "node:child_process";
import {
  clearInheritableHandles,
  installSpawnHandleGuard,
} from "../../../src/services/windows-socket-inheritance.ts";

const onWindows = process.platform === "win32";
/** How long the child outlives the connection: far beyond the EOF deadline below. */
const CHILD_LIFETIME_MS = 30_000;
const EOF_DEADLINE_MS = 8_000;

/** Open a keep-alive connection, complete one request on it, and resolve on its EOF. */
async function keepAliveConnection(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  const closed = new Promise<number>((resolve) => {
    socket.once("end", () => resolve(performance.now()));
    socket.once("close", () => resolve(performance.now()));
  });
  await new Promise<void>((resolve) => {
    socket.once("data", () => resolve());
    socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
  });
  return { socket, closed };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(!onWindows)("spawning with a connection open (Windows)", () => {
  for (const via of ["Bun.spawn", "node:child_process"] as const) {
    it(`the server's close reaches the client while a child started through ${via} runs`, async () => {
      expect(installSpawnHandleGuard()).toBe(true);
      // idleTimeout is the server-side close: the connection is idle once its one request is answered.
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 1, fetch: () => new Response("ok") });
      const conn = await keepAliveConnection(server.port);
      const args = ["-e", `setTimeout(() => {}, ${CHILD_LIFETIME_MS})`];
      const pid = via === "Bun.spawn"
        ? Bun.spawn([process.execPath, ...args], { stdio: ["ignore", "ignore", "ignore"] }).pid
        : cpSpawn(process.execPath, args, { stdio: "ignore" }).pid!;
      const start = performance.now();
      try {
        const deadline = new Promise<"none">((resolve) => setTimeout(() => resolve("none"), EOF_DEADLINE_MS));
        const eofAt = await Promise.race([conn.closed, deadline]);
        expect(eofAt).not.toBe("none");
        expect(alive(pid)).toBe(true);
        expect((eofAt as number) - start).toBeLessThan(EOF_DEADLINE_MS);
      } finally {
        try { process.kill(pid); } catch { /* already gone */ }
        conn.socket.destroy();
        server.stop(true);
      }
    }, EOF_DEADLINE_MS + 5_000);
  }
});

describe("off Windows", () => {
  it("does nothing", () => {
    expect(clearInheritableHandles("linux")).toBe(0);
    expect(installSpawnHandleGuard("darwin")).toBe(false);
  });
});
