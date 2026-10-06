/**
 * Finding and calling the `tailscale` CLI. PPM never talks to tailscaled's LocalAPI
 * directly: the socket, its authentication and its path differ on every OS (a unix socket
 * with peer credentials on Linux, the GUI app's port and token on macOS, a named pipe on
 * Windows), and the CLI already knows all three.
 */
import { existsSync } from "node:fs";
import { defaultRunner, type Runner } from "../host-info/spawn-runner.ts";

const MAC_CANDIDATES = [
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  // The standalone and App Store apps ship the CLI inside the bundle.
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
const WINDOWS_CANDIDATES = ["C:\\Program Files\\Tailscale\\tailscale.exe"];

/** The tailscale CLI, also where a launchd- or service-started PPM's PATH would not find it. */
export function tailscaleBinary(): string | null {
  const onPath = Bun.which("tailscale");
  if (onPath) return onPath;
  const candidates = process.platform === "darwin" ? MAC_CANDIDATES : process.platform === "win32" ? WINDOWS_CANDIDATES : [];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** How PPM runs the CLI: the host's binary, or in tests a fake run through bun. */
export interface TailscaleCli {
  /** The command as an argv prefix, or null when Tailscale is not installed. */
  argv: string[] | null;
  runner: Runner;
}

export function hostCli(): TailscaleCli {
  const bin = tailscaleBinary();
  return { argv: bin ? [bin] : null, runner: defaultRunner };
}

/** Run a CLI command that prints JSON; throws with the CLI's own message when it fails. */
export async function runJson(runner: Runner, argv: string[], timeoutMs = 4000): Promise<unknown> {
  const result = await runner(argv, timeoutMs);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${argv.slice(1).join(" ")} failed`);
  return JSON.parse(result.stdout);
}

/** tailscaled refuses a change from a user who is neither root nor its operator (Linux). */
export function isAccessDenied(output: string): boolean {
  return /access denied|permission denied|not allowed/i.test(output);
}
