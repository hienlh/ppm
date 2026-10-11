import { getPpmDir } from "../ppm-dir.ts";

/**
 * Environment an Assistant session's shell gets on top of the server's: `PPM_HOME` naming this
 * instance's folder, so a `ppm …` command the user approves reaches this PPM rather than
 * whatever `~/.ppm` holds. Without it, a dev or test server's Assistant ran the CLI against the
 * production folder (the providers set no `PPM_HOME` of their own).
 */
export function assistantShellEnv(): Record<string, string> {
  return { PPM_HOME: getPpmDir() };
}
