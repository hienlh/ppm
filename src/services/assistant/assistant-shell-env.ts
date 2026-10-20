import { getPpmDir } from "../ppm-dir.ts";
import { LIVE_PPM_HOME_ENV } from "../prod-db-guard.ts";

/**
 * Environment an Assistant session's shell gets on top of the server's: `PPM_HOME` naming this
 * instance's folder, so a `ppm …` command the user approves reaches this PPM rather than
 * whatever `~/.ppm` holds. Without it, a dev or test server's Assistant ran the CLI against the
 * production folder (the providers set no `PPM_HOME` of their own).
 *
 * `PPM_LIVE_HOME` names the same folder so `prod-db-guard` does not take that `PPM_HOME` as
 * isolation, wherever the folder is (`~/.ppm`, or `/srv/ppm` for an instance run with its own
 * `PPM_HOME`): a script started from this shell is refused this instance's database, as it
 * would be from any other shell. The `ppm` CLI itself is let through, and a script given a
 * scratch `PPM_HOME` of its own still runs.
 */
export function assistantShellEnv(): Record<string, string> {
  const dir = getPpmDir();
  return { PPM_HOME: dir, [LIVE_PPM_HOME_ENV]: dir };
}
