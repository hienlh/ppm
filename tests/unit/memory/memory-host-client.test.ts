/**
 * The memory host as a real process: the server talks to `ppm __memory__` (here from source, on
 * the test PPM_HOME the preload sets) over JSON lines. A host that dies is replaced, one that hangs
 * is killed after three missed deadlines, one that never starts fails its request, and a process
 * that used the host still exits on its own — a `ppm chat` CLI must not hang on it.
 */
import "../../test-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createMemoryHostClient, memoryHostCommand, processMemoryChannel, type MemoryHostClient,
} from "../../../src/services/memory/memory-host-client.ts";

const config = () => ({ ai: {}, codexHomes: [], projects: [] });
const clients: MemoryHostClient[] = [];
const client = (opts: Parameters<typeof processMemoryChannel>[0] = {}) => {
  const c = createMemoryHostClient({ channel: processMemoryChannel(opts), config });
  clients.push(c);
  return c;
};
afterEach(() => { for (const c of clients.splice(0)) c.stop(); });

const scripts = mkdtempSync(join(tmpdir(), "ppm-memory-host-fakes-"));
function fakeHost(name: string, body: string): string[] {
  const path = join(scripts, `${name}.ts`);
  writeFileSync(path, body);
  return [process.execPath, path];
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("the real memory host", () => {
  test("answers requests, sends events, and a killed host is replaced on the next request", async () => {
    const host = client();
    const events: unknown[] = [];
    host.setListener((e) => events.push(e));

    const status = await host.queueStatus();
    expect(status).toMatchObject({ model: null, running: false });
    const first = host.pid();
    expect(first).toBeGreaterThan(0);

    const written = await host.callTool(
      { sessionId: "s1", projectPath: null }, "memory_write",
      { name: "host test", description: "written through the host", type: "reference", body: "body", scope: "global" },
    );
    expect(JSON.stringify(written)).toContain("Created memory");
    expect(events.some((e: any) => e.kind === "changed")).toBe(true);

    process.kill(first!, "SIGKILL");
    for (let i = 0; i < 50 && host.pid() === first; i++) await Bun.sleep(20);
    const found = await host.callTool({ sessionId: "s1", projectPath: null }, "memory_search", { query: "host test", scope: "global" });
    expect(JSON.stringify(found)).toContain("host test");
    expect(host.pid()).not.toBe(first);
  }, 30_000);

  test("the command runs this checkout's entry in memory mode", () => {
    expect(memoryHostCommand(false)).toEqual([process.execPath, "run", resolve(import.meta.dir, "../../../src/index.ts"), "__memory__"]);
    expect(memoryHostCommand(true)).toEqual([process.execPath, "__memory__"]);
  });
});

describe("a host that misbehaves", () => {
  test("one that never says ready fails the request within the ready timeout", async () => {
    const host = client({ cmd: fakeHost("silent", "await Bun.sleep(60_000);\n"), readyTimeoutMs: 300 });
    const started = performance.now();
    await expect(host.queueStatus()).rejects.toThrow(/did not start/);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("one that cannot be started fails the request", async () => {
    const host = client({ cmd: [join(scripts, "no-such-binary")] });
    await expect(host.queueStatus()).rejects.toThrow(/memory host/);
  });

  test("one that stops answering is killed after three missed deadlines, and the next request gets a new one", async () => {
    // Says ready, answers `configure`, then ignores everything.
    const cmd = fakeHost("hung", `
      process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
      let buf = "";
      for await (const chunk of process.stdin) {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (msg.op === "configure") process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: null }) + "\\n");
        }
      }
    `);
    const channel = processMemoryChannel({ cmd });
    clients.push(createMemoryHostClient({ channel, config })); // for afterEach's stop()
    const ask = () => channel.request("queueStatus", {}, 150);
    expect(await channel.request("configure", config(), 5_000)).toBeNull(); // started, and it answers this one
    const pid = channel.pid()!;
    for (let i = 0; i < 2; i++) await expect(ask()).rejects.toThrow(/did not answer/);
    expect(alive(pid)).toBe(true);
    await expect(ask()).rejects.toThrow(/did not answer/);
    for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20);
    expect(alive(pid)).toBe(false);
    expect(channel.pid()).toBeNull();
    // The next request starts a new host.
    expect(await channel.request("configure", config(), 5_000)).toBeNull();
    expect(channel.pid()).not.toBe(pid);
  }, 30_000);

  test("a line that is not JSON is ignored, the answer after it still arrives", async () => {
    const cmd = fakeHost("noisy", `
      process.stdout.write("debug: hello\\n" + JSON.stringify({ ready: true }) + "\\n");
      let buf = "";
      for await (const chunk of process.stdin) {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          process.stdout.write("stray output\\n" + JSON.stringify({ id: msg.id, ok: true, result: msg.op === "queueStatus" ? { model: "m" } : null }) + "\\n");
        }
      }
    `);
    const host = client({ cmd });
    expect(await host.queueStatus()).toEqual({ model: "m" } as never);
  });
});

describe("a process that used the host", () => {
  test("exits on its own once its requests are answered, leaving no host behind", async () => {
    const script = join(scripts, "cli-user.ts");
    writeFileSync(script, `
      const { createMemoryHostClient } = await import(${JSON.stringify(resolve(import.meta.dir, "../../../src/services/memory/memory-host-client.ts"))});
      const host = createMemoryHostClient({ config: () => ({ ai: {}, codexHomes: [], projects: [] }) });
      await host.queueStatus();
      await host.queueStatus();
      console.log("PID=" + host.pid());
    `);
    const started = performance.now();
    const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit", env: process.env });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    expect(proc.signalCode).toBeNull();
    expect(performance.now() - started).toBeLessThan(15_000);
    const pid = Number(/PID=(\d+)/.exec(out)?.[1]);
    expect(pid).toBeGreaterThan(0);
    // The host sees its stdin close and exits.
    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20);
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
