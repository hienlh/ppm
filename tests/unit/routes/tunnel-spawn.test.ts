import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killLeftover, startForwardChild, type ForwardChild } from "../../helpers/forward-child.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

const FAKE_CLOUDFLARED = resolve(import.meta.dir, "../../fixtures/fake-cloudflared.ts");

/** Poll until `done()` holds, for at most `ms`. */
async function eventually(done: () => boolean, ms = 3000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(50)) if (done()) return true;
  return done();
}

/** What the fake cloudflared wrote: the origin it was pointed at, and its PID. */
const readFake = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { origin: string; pid: number };

describe("spawnTunnelProcess", () => {
  test("its hop serves the quick tunnel's URL, and answers 421 to any other host", async () => {
    const dev = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(`host=${req.headers.get("host")}`) });
    const dir = mkdtempSync(join(tmpdir(), "tunnel-hop-"));
    const file = join(dir, "cloudflared.json");
    let forward: ForwardChild | undefined;
    try {
      forward = await startForwardChild(["cloudflared", String(dev.port), FAKE_CLOUDFLARED, file]);
      expect(forward.url).toBe("https://example-quick.trycloudflare.com");
      // cloudflared passes the public Host through to its origin, the hop.
      const { origin } = readFake(file);
      const own = await fetch(origin, { headers: { host: "example-quick.trycloudflare.com" } });
      expect(await own.text()).toBe(`host=localhost:${dev.port}`);
      // A page whose own name resolves to 127.0.0.1 (DNS rebinding), open in a browser on the host.
      const rebound = await fetch(origin, { headers: { host: `rebind.example:${new URL(origin).port}` } });
      expect(rebound.status).toBe(421);
    } finally {
      await forward?.exit();
      if (existsSync(file)) killLeftover(readFake(file).pid);
      dev.stop(true);
      await rmRetrying(dir);
    }
  }, 15_000);
});

// Not on Windows: a Bun child sits in its parent's job object there, and dies with it.
describe.skipIf(process.platform === "win32")("registerTunnel", () => {
  test("a fatal exit stops every registered cloudflared, so no public URL is left pointing at the dead hop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tunnel-exit-"));
    const file = join(dir, "cloudflared.json");
    try {
      const forward = await startForwardChild(["cloudflared", "5173", FAKE_CLOUDFLARED, file]);
      expect(await forward.exit()).toBe(3);
      expect(await eventually(() => existsSync(`${file}.stopped`))).toBe(true);
    } finally {
      if (existsSync(file)) killLeftover(readFake(file).pid);
      await rmRetrying(dir);
    }
  }, 15_000);
});
