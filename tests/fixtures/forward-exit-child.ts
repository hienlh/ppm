/**
 * Starts a forward the way PPM does and prints `forward-up {"urls":[…]}` once it is up (PPM's own
 * log lines share stdout). When its stdin closes it leaves the way PPM does after a fatal
 * error: `process.exit`, with no shutdown code run. In between a test can send the hop
 * requests, and after it can see what the transport did.
 *
 *   bun forward-exit-child.ts tailscale <dev port> <fake-tailscale.ts> <state.json>
 *   bun forward-exit-child.ts tailscale-pair <dev port>,<dev port> <fake-tailscale.ts> <state.json>
 *   bun forward-exit-child.ts cloudflared <dev port> <fake-cloudflared.ts> <its file>
 *
 * A process of its own rather than an import, because tunnel-registry-routes.test.ts mocks both
 * modules for every test file that runs after it in the same process. Exits with 3, so a test
 * can tell a forward that came up from a crash on the way there.
 */
import { defaultRunner, type RunResult } from "../../src/services/host-info/spawn-runner.ts";
import type { TailscaleCli } from "../../src/services/tailscale/tailscale-cli.ts";
import { startTailscaleForward } from "../../src/services/port-forward/tailscale-forward.ts";
import { registerTunnel, spawnTunnelProcess } from "../../src/server/routes/tunnel-spawn.ts";

const [mode, port, fake, file] = process.argv.slice(2) as [string, string, string, string];
const fakeArgv = [process.execPath, fake, file];

/**
 * Two Tailscale forwards started together. Another handler holds the second one's port, so the
 * next one up is the first one's, and both read `serve status` before either handler is up: the
 * second read is answered only once the first forward is up, with what tailscaled listed before.
 */
async function startTailscalePair(ports: string): Promise<string[]> {
  const [first, second] = ports.split(",").map(Number) as [number, number];
  const before: RunResult = { stdout: JSON.stringify({ TCP: { [second]: { HTTPS: true } } }), stderr: "", code: 0, timedOut: false };
  /** The fake, except a forward's first `serve status` (the one it picks its port from). */
  const cli = (answerOnce: Promise<unknown>): TailscaleCli => {
    let picked = false;
    return {
      argv: fakeArgv,
      runner: async (argv, timeoutMs) => {
        if (picked || argv.slice(fakeArgv.length).join(" ") !== "serve status --json") return defaultRunner(argv, timeoutMs);
        picked = true;
        await answerOnce;
        return before;
      },
    };
  };
  const firstUp = startTailscaleForward(first, cli(Promise.resolve()));
  const secondUp = startTailscaleForward(second, cli(firstUp));
  return (await Promise.all([firstUp, secondUp])).map((forward) => forward.url);
}

let urls: string[];
if (mode === "tailscale") {
  urls = [(await startTailscaleForward(Number(port), { argv: fakeArgv, runner: defaultRunner })).url];
} else if (mode === "tailscale-pair") {
  urls = await startTailscalePair(port);
} else if (mode === "cloudflared") {
  const tunnel = await spawnTunnelProcess(Number(port), fakeArgv);
  registerTunnel(Number(port), tunnel.process, tunnel.url, tunnel.hop);
  urls = [tunnel.url];
} else {
  throw new Error(`unknown mode ${mode}`);
}
process.stdout.write(`forward-up ${JSON.stringify({ urls })}\n`);
for await (const _chunk of Bun.stdin.stream()) { /* until the test closes it */ }
process.exit(3);
