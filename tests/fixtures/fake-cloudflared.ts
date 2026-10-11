/**
 * A stand-in for cloudflared's quick tunnel: prints its URL to stderr the way cloudflared does
 * and runs until stopped. Never opens a tunnel or touches the network.
 *
 * Two ways to run it:
 *
 *   bun fake-cloudflared.ts <file> --config <file> tunnel --url <origin>
 *     The first argument is a file it writes `{ origin, pid }` to (origin: where `--url` pointed
 *     it), and it writes `<file>.stopped` when stopped with SIGTERM. Prints a fixed URL.
 *
 *   <PPM_HOME>/bin/cloudflared[.exe] --config <file> tunnel --url <origin>
 *     Compiled (`bun build --compile`) into the place PPM looks for cloudflared, so the real
 *     routes spawn it exactly as they would the real binary — and the delete route's image check
 *     (`cloudflared.exe`) accepts it. With no state file it prints `https://e2e-<pid>.trycloudflare.com`,
 *     unique per process so two forwards can be told apart.
 */
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
// cloudflared's own arguments always start with a flag; anything else is the state file.
const file = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
const args = file ? argv.slice(1) : argv;

process.on("SIGTERM", () => {
  if (file) writeFileSync(`${file}.stopped`, "stopped");
  process.exit(0);
});
if (file) writeFileSync(file, JSON.stringify({ origin: args[args.indexOf("--url") + 1], pid: process.pid }));
const url = file ? "https://example-quick.trycloudflare.com" : `https://e2e-${process.pid}.trycloudflare.com`;
process.stderr.write(`INF |  ${url}  |\n`);
// Leave on its own if nothing stops it, so a failed test cannot leave it running for good.
setTimeout(() => process.exit(0), 60_000);
