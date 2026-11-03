import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ShareConnector, type ConnectorEvents, type ConnectorPlan } from "../../../../src/services/share-host/share-host-connector.ts";

/**
 * cloudflared is stood in for by bun running a one-line script: the connector spawns
 * `[bin, ...plan.args]` with stderr on its log, so `bin` = bun and args = `-e <script>` is a real
 * child process writing real log lines, on every platform.
 */
const script = (lines: string[], exitAfterMs: number | null, code = 0) =>
  `${lines.map((l) => `console.error(${JSON.stringify(l)});`).join("")}` +
  (exitAfterMs === null ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(${code}), ${exitAfterMs});`);

const plan = (label: string, lines: string[], exitAfterMs: number | null, url: string | null = null, code = 0): ConnectorPlan =>
  ({ label, args: ["-e", script(lines, exitAfterMs, code)], url });

let dir: string;
let connector: ShareConnector;

function recorder() {
  const events: Array<{ type: "ready"; pid: number; url: string } | { type: "down"; reason: string }> = [];
  const handlers: ConnectorEvents = {
    onReady: ({ pid, url }) => events.push({ type: "ready", pid, url }),
    onDown: (reason) => events.push({ type: "down", reason }),
  };
  return { events, handlers };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "ppm-share-connector-"));
  connector = new ShareConnector({
    cloudflared: async () => process.execPath,
    logPath: () => resolve(dir, "cloudflared-share.log"),
    readyTimeoutMs: 3000,
    backoffMs: () => 50,
  });
});
afterEach(() => {
  connector.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("ShareConnector", () => {
  it("reads a quick tunnel's address from its log", async () => {
    const r = recorder();
    connector.start(plan("quick", ["INF |  https://quiet-river-12.trycloudflare.com  |"], null), r.handlers);
    await until(() => r.events.length > 0);
    expect(r.events[0]).toMatchObject({ type: "ready", url: "https://quiet-river-12.trycloudflare.com" });
    expect(connector.pid).toBe((r.events[0] as { pid: number }).pid);
  });

  it("takes a named tunnel's address from the plan once a connection registers", async () => {
    const r = recorder();
    connector.start(plan("named share.example.com", ["INF Registered tunnel connection connIndex=0"], null, "https://share.example.com"), r.handlers);
    await until(() => r.events.length > 0);
    expect(r.events[0]).toMatchObject({ type: "ready", url: "https://share.example.com" });
  });

  it("reports an exit with cloudflared's last error, then starts it again", async () => {
    const r = recorder();
    connector.start(plan("named share.example.com", [
      "INF Registered tunnel connection connIndex=0",
      "2026-10-23T00:00:00Z ERR Unauthorized: Invalid tunnel secret",
    ], 200, "https://share.example.com", 3), r.handlers);
    await until(() => r.events.filter((e) => e.type === "ready").length >= 2);
    const down = r.events.find((e) => e.type === "down") as { reason: string };
    expect(down.reason).toBe("exited (code 3) — Unauthorized: Invalid tunnel secret");
  });

  it("gives up on a connector that never gets ready, and kills it", async () => {
    const quiet = new ShareConnector({
      cloudflared: async () => process.execPath,
      logPath: () => resolve(dir, "quiet.log"),
      readyTimeoutMs: 300,
      backoffMs: () => 60_000,
    });
    const r = recorder();
    quiet.start(plan("quick", ["INF still starting"], null), r.handlers);
    await until(() => r.events.length > 0);
    expect(r.events[0]!.type).toBe("down");
    expect((r.events[0] as { reason: string }).reason).toStartWith("did not connect");
    expect(quiet.pid).toBeNull();
    quiet.stop();
  });

  it("stops the child on stop(), with no event after it", async () => {
    const r = recorder();
    connector.start(plan("quick", ["INF https://a-b.trycloudflare.com"], null), r.handlers);
    await until(() => r.events.length > 0);
    const pid = connector.pid!;
    connector.stop();
    expect(connector.plan).toBeNull();
    await until(() => !alive(pid));
    await Bun.sleep(150);
    expect(r.events).toHaveLength(1);
  });

  it("replaces a running plan, killing the old child", async () => {
    const first = recorder();
    connector.start(plan("quick", ["INF https://first-one.trycloudflare.com"], null), first.handlers);
    await until(() => first.events.length > 0);
    const oldPid = connector.pid!;

    const second = recorder();
    connector.start(plan("named share.example.com", ["INF Registered tunnel connection"], null, "https://share.example.com"), second.handlers);
    await until(() => second.events.length > 0);
    expect(second.events[0]).toMatchObject({ type: "ready", url: "https://share.example.com" });
    expect(connector.plan?.label).toBe("named share.example.com");
    await until(() => !alive(oldPid));
    // The replaced loop says nothing more.
    expect(first.events).toHaveLength(1);
  });
});
