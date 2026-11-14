/**
 * The edge hands the public port over once its private bytes pass the limit at a quiet
 * moment. What has to hold: it waits while clients are connected, it releases the port so a
 * successor can bind the very same one, and the clients it still had are closed rather than
 * left half-alive on a process about to exit.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { startEdgeForwarder, type EdgeRecycleInfo } from "../../../src/services/edge-forwarder.ts";
import { _resetTargetCache } from "../../../src/services/edge-target-resolver.ts";
import { readNativeMemory } from "../../../src/services/memory-diagnostics-native.ts";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
let home: string;
const originalPpmHome = process.env.PPM_HOME;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ppm-edge-recycle-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
  _resetTargetCache();
  // A live origin, so connections through the edge are real pipes rather than retries.
  const origin = net.createServer({ allowHalfOpen: true }, (s) => s.on("error", () => s.destroy()));
  servers.push(origin);
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
  writeFileSync(join(home, ".server-port"), String((origin.address() as net.AddressInfo).port));
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) { try { s.close(); } catch {} }
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
});

const port = (s: net.Server) => (s.address() as net.AddressInfo).port;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(p: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port: p, host: "127.0.0.1" });
    sockets.push(s);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

/** Resolve true when a fresh server can listen on the port, i.e. the edge let it go. */
function canBind(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(p, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function startRecycling(readPrivateMB: () => Promise<number | undefined>, quietConnections = 0) {
  const recycled: EdgeRecycleInfo[] = [];
  const edge = await startEdgeForwarder({
    publicPort: 0,
    host: "127.0.0.1",
    recycle: { limitMB: 1536, readPrivateMB, onRecycle: (i) => recycled.push(i), checkIntervalMs: 20, quietConnections },
  });
  servers.push(edge);
  return { edge, recycled };
}

describe("edge recycle", () => {
  it("releases the port once over the limit with no clients, so a successor can bind it", async () => {
    const { edge, recycled } = await startRecycling(async () => 2000);
    const p = port(edge);
    for (let i = 0; i < 50 && recycled.length === 0; i++) await sleep(20);
    expect(recycled).toEqual([{ privateMB: 2000, limitMB: 1536, openConnections: 0 }]);
    expect(await canBind(p)).toBe(true);
  });

  it("stays put under the limit, and when memory cannot be read", async () => {
    const under = await startRecycling(async () => 1500);
    const unknown = await startRecycling(async () => undefined);
    await sleep(200);
    expect(under.recycled).toEqual([]);
    expect(unknown.recycled).toEqual([]);
    expect(await canBind(port(under.edge))).toBe(false);
  });

  it("waits while more clients are connected than the quiet count, then goes", async () => {
    const { edge, recycled } = await startRecycling(async () => 2000, 0);
    const client = await connect(port(edge));
    await sleep(200);
    expect(recycled).toEqual([]);

    client.destroy();
    for (let i = 0; i < 50 && recycled.length === 0; i++) await sleep(20);
    expect(recycled.length).toBe(1);
    expect(recycled[0]!.openConnections).toBe(0);
  });

  it("closes the clients it still had, so they reconnect to the successor", async () => {
    const { edge, recycled } = await startRecycling(async () => 2000, 1);
    const client = await connect(port(edge));
    const closed = new Promise<void>((r) => client.once("close", () => r()));
    client.on("error", () => {});
    for (let i = 0; i < 50 && recycled.length === 0; i++) await sleep(20);
    expect(recycled[0]!.openConnections).toBe(1);
    await closed;
  });

  it("recycles only once, however long the process takes to exit", async () => {
    const { recycled } = await startRecycling(async () => 2000);
    await sleep(300);
    expect(recycled.length).toBe(1);
  });

  it.if(process.platform === "win32")("acts on this process's real private bytes", async () => {
    // The real reader the edge uses, against a limit this test process is surely over.
    const recycled: EdgeRecycleInfo[] = [];
    const edge = await startEdgeForwarder({
      publicPort: 0,
      host: "127.0.0.1",
      recycle: {
        limitMB: 1,
        readPrivateMB: async () => (await readNativeMemory()).privateMB,
        onRecycle: (i) => recycled.push(i),
        checkIntervalMs: 20,
      },
    });
    servers.push(edge);
    for (let i = 0; i < 100 && recycled.length === 0; i++) await sleep(20);
    expect(recycled.length).toBe(1);
    expect(recycled[0]!.privateMB).toBeGreaterThan(1);
  });
});
