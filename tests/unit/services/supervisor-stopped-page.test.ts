import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type net from "node:net";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  startStoppedPage,
  stopStoppedPage,
} from "../../../src/services/supervisor-stopped-page.ts";
import { startEdgeForwarder } from "../../../src/services/edge-forwarder.ts";
import { _resetTargetCache } from "../../../src/services/edge-target-resolver.ts";

const tempDirs: string[] = [];
const openServers: net.Server[] = [];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-stopped-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  _resetPpmDir();
  _resetTargetCache();
});

afterEach(() => {
  stopStoppedPage();
  for (const s of openServers.splice(0)) { try { s.close(); } catch {} }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("stopped page", () => {
  it("binds an OS-assigned loopback port and publishes it", () => {
    startStoppedPage(0, "127.0.0.1");

    const file = join(home, ".server-port");
    expect(existsSync(file)).toBe(true);
    const port = parseInt(readFileSync(file, "utf-8").trim(), 10);
    // 0 would mean it published the requested port instead of the bound one —
    // the edge would then have nowhere to send traffic.
    expect(port).toBeGreaterThan(0);
  });

  it("is reachable through the edge, so the public URL keeps serving", async () => {
    // This is the reason the page exists: a soft-stopped PPM must still answer
    // on the tunnel URL. It used to bind the public port directly; now the edge
    // owns that port, so the page has to be reachable via the forwarder.
    startStoppedPage(0, "127.0.0.1");
    _resetTargetCache();

    const edge = await startEdgeForwarder({ publicPort: 0, host: "127.0.0.1" });
    openServers.push(edge);
    const publicPort = (edge.address() as net.AddressInfo).port;

    const health = await fetch(`http://127.0.0.1:${publicPort}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "stopped" });

    const page = await fetch(`http://127.0.0.1:${publicPort}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("PPM Server Stopped");
  });
});
