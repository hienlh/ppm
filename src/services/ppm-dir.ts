import { resolve } from "node:path";
import { homedir } from "node:os";

let _dir: string | undefined;

/** Centralized PPM directory resolution. Respects PPM_HOME env var for test isolation. */
export function getPpmDir(): string {
  return (_dir ??= resolve(process.env.PPM_HOME || resolve(homedir(), ".ppm")));
}

/** Reset cached dir (for test teardown if needed) */
export function _resetPpmDir(): void {
  _dir = undefined;
}

/**
 * True when PPM_HOME points somewhere other than the real `~/.ppm` — i.e. an
 * isolated run, in practice an integration test.
 *
 * Service-manager artifacts (launchd plist, systemd unit) deliberately resolve
 * against the real `$HOME` and are machine-global, so PPM_HOME does NOT isolate
 * them. Anything that registers, boots out, or sweeps processes machine-wide
 * must bail out here — otherwise an "isolated" test running `ppm stop` tears
 * down the user's live autostart job and production supervisor.
 */
export function isIsolatedPpmHome(): boolean {
  const override = process.env.PPM_HOME;
  if (!override) return false;
  return resolve(override) !== resolve(homedir(), ".ppm");
}
