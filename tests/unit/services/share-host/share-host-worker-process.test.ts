import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Subprocess } from "bun";

/**
 * The worker as the supervisor runs it — `<entry> __share_host__ <port>`, its own process, its
 * own PPM_HOME — in front of a stand-in for PPM. Passed `env` explicitly: a child gets the
 * environment the test process started with otherwise, not the PPM_HOME set here.
 */
const ENTRY = resolve(import.meta.dir, "../../../../src/index.ts");

let home: string;
let upstream: ReturnType<typeof Bun.serve>;
const children: Subprocess[] = [];

async function waitFor<T>(read: () => T | null, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

const portFile = () => resolve(home, ".share-host-port");
const readPort = () => (existsSync(portFile()) ? parseInt(readFileSync(portFile(), "utf8"), 10) || null : null);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "ppm-share-worker-"));
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => Response.json({
      path: new URL(req.url).pathname, host: req.headers.get("host"), auth: req.headers.get("authorization"),
    }),
  });
  writeFileSync(resolve(home, ".server-port"), String(upstream.port));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch {}
  }
  upstream.stop(true);
  rmSync(home, { recursive: true, force: true });
});

describe("share host worker process", () => {
  it("listens on loopback, publishes its port, and lets only the review pages through", async () => {
    const child = Bun.spawn([process.execPath, ENTRY, "__share_host__", "0"], {
      env: { ...process.env, PPM_HOME: home }, stdout: "ignore", stderr: "ignore",
    });
    children.push(child);
    const port = await waitFor(readPort);

    const page = await fetch(`http://127.0.0.1:${port}/s/abc123?n=1`, {
      headers: { Host: "share.example.com", Authorization: "Bearer stolen" },
    });
    expect(await page.json()).toEqual({ path: "/s/abc123", host: "share.example.com", auth: null });

    for (const path of ["/", "/api/projects", "/api/auth/check", "/ws/global", "/assets/index-a1.js"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("There is nothing at this address.");
    }
  });

  it("takes the port it is asked for, so a respawn keeps the connector pointing at it", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const wanted = probe.port;
    probe.stop(true);
    const child = Bun.spawn([process.execPath, ENTRY, "__share_host__", String(wanted)], {
      env: { ...process.env, PPM_HOME: home }, stdout: "ignore", stderr: "ignore",
    });
    children.push(child);
    expect(await waitFor(readPort)).toBe(wanted);
  });

  it.skipIf(process.platform === "win32")("exits once the process that started it is gone", async () => {
    // A stand-in supervisor: starts the worker, prints its pid, and exits.
    const parent = Bun.spawn([
      process.execPath, "-e",
      `const c = Bun.spawn([process.execPath, ${JSON.stringify(ENTRY)}, "__share_host__", "0"], { env: process.env, stdout: "ignore", stderr: "ignore" });
       console.log(c.pid); setTimeout(() => process.exit(0), 1500);`,
    ], { env: { ...process.env, PPM_HOME: home }, stdout: "pipe", stderr: "ignore" });
    const workerPid = parseInt((await new Response(parent.stdout).text()).trim(), 10);
    expect(workerPid).toBeGreaterThan(0);
    children.push({ kill: (s?: number | NodeJS.Signals) => process.kill(workerPid, s) } as unknown as Subprocess);
    await waitFor(readPort);
    expect(alive(workerPid)).toBe(true);
    // The parent check runs every 5 s.
    await waitFor(() => (alive(workerPid) ? null : true), 9000);
  }, 15_000);

  it("refuses a port that is not one", async () => {
    const child = Bun.spawn([process.execPath, ENTRY, "__share_host__", "70000"], {
      env: { ...process.env, PPM_HOME: home }, stdout: "ignore", stderr: "ignore",
    });
    children.push(child);
    expect(await child.exited).toBe(2);
    expect(existsSync(portFile())).toBe(false);
  });
});
