/**
 * A stand-in for cloudflared's quick tunnel: prints its URL to stderr the way cloudflared does
 * and runs until stopped. Its first argument is a file it writes `{ origin, pid }` to (origin:
 * where `--url` pointed it), and it writes `<file>.stopped` when stopped with SIGTERM.
 * cloudflared's own arguments follow.
 *
 *   bun fake-cloudflared.ts <file> --config <file> tunnel --url <origin>
 */
import { writeFileSync } from "node:fs";

const [file, ...args] = process.argv.slice(2) as [string, ...string[]];
process.on("SIGTERM", () => {
  writeFileSync(`${file}.stopped`, "stopped");
  process.exit(0);
});
writeFileSync(file, JSON.stringify({ origin: args[args.indexOf("--url") + 1], pid: process.pid }));
process.stderr.write("INF |  https://example-quick.trycloudflare.com  |\n");
// Leave on its own if nothing stops it, so a failed test cannot leave it running for good.
setTimeout(() => process.exit(0), 60_000);
