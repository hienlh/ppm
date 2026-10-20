import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";

// A supervisor-managed tunnel's URL lives in status.json and the supervisor
// rewrites it on its own (quick-URL regeneration, switching to a named
// hostname). The server must follow those rewrites instead of serving the
// first URL it ever read.
describe("tunnelService.getTunnelUrl follows status.json rewrites", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ppm-tunnel-sync-"));
    prevHome = process.env.PPM_HOME;
    process.env.PPM_HOME = home;
    // getPpmDir() keeps the first folder it resolved, and every test file shares one process.
    _resetPpmDir();
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.PPM_HOME; else process.env.PPM_HOME = prevHome;
    _resetPpmDir();
    rmSync(home, { recursive: true, force: true });
  });

  test("picks up a new shareUrl written by the supervisor", async () => {
    const { tunnelService } = await import("../../../src/services/tunnel.service.ts");
    const statusFile = join(home, "status.json");

    writeFileSync(statusFile, JSON.stringify({ shareUrl: "https://old-temp.trycloudflare.com", tunnelPid: 4242 }));
    expect(tunnelService.getTunnelUrl()).toBe("https://old-temp.trycloudflare.com");

    writeFileSync(statusFile, JSON.stringify({ shareUrl: "https://ppm.example.com", tunnelPid: 4343, tunnelMode: "named" }));
    expect(tunnelService.getTunnelUrl()).toBe("https://ppm.example.com");
    expect(tunnelService.getTunnelPid()).toBe(4343);
  });
});
