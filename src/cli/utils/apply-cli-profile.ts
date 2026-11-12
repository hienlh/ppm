import { extractProfileArgv, resolveCliProfile } from "./profile-argv.ts";

/**
 * Applies `ppm [--profile x] [--instance id] <command>` before the command tree is built: sets the
 * database profile and, for `--instance`, the server to talk to. Returns argv without those
 * tokens, for Commander. Exits on a bad profile name, since running the command against another
 * database than the one asked for is the one outcome to avoid.
 */
export async function applyCliProfile(argv: readonly string[]): Promise<string[]> {
  try {
    const scan = extractProfileArgv(argv);
    const profile = resolveCliProfile(scan.profile);
    if (profile) {
      const { setDbProfile } = await import("../../services/db.service.ts");
      setDbProfile(profile);
    }
    if (scan.instance !== undefined) {
      const { setStrictInstance } = await import("./ppm-server-client.ts");
      setStrictInstance(scan.instance);
    }
    return scan.argv;
  } catch (e) {
    console.error(`\x1b[31m✗\x1b[0m ${(e as Error).message}`);
    process.exit(1);
  }
}
