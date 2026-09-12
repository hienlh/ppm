/**
 * Gatekeeper for the real (non-isolated) PPM database.
 *
 * `getDb()` opens `~/.ppm/ppm.db` lazily for whoever asks first, which put every
 * throwaway script, spike and agent worktree one import away from production
 * state: a proxy probe that booted the provider registry without loading config
 * once reset the whole `config` table and emptied `projects`, locking the user
 * out of their own instance.
 *
 * The rule enforced here: only a genuine PPM entrypoint may touch the real
 * database. Anything else must either point `PPM_HOME` at a scratch directory --
 * the isolation contract the test suite already uses -- or opt in loudly through
 * `PPM_ALLOW_PROD_DB=1`.
 */
import { sep } from "node:path";

/**
 * Entry scripts cleared to open the real database, matched as path suffixes so
 * they hold for a git checkout, a global npm install and a worktree alike.
 */
const ALLOWED_ENTRYPOINTS = [
  "src/index.ts", // ppm CLI -- package.json "bin"
  "src/server/index.ts", // HTTP server, and the __serve__ daemon child
  "src/services/supervisor.ts", // __supervise__
  "src/services/edge-forwarder.ts", // __edge__
];

/** Escape hatch for a deliberate one-off against production state. */
export const PROD_DB_OVERRIDE_ENV = "PPM_ALLOW_PROD_DB";

/**
 * Everything the decision depends on, gathered in one place so the rule can be
 * exercised without mutating process-wide state (tests that unset PPM_HOME leak
 * the real ~/.ppm into whatever runs next).
 */
export interface ProdDbGuardContext {
  ppmHome: string | undefined;
  override: string | undefined;
  execPath: string;
  /** Raw process.argv[1], separators not yet normalised. */
  entry: string;
}

/** Snapshot the live process into a guard context. */
export function currentProdDbGuardContext(): ProdDbGuardContext {
  return {
    ppmHome: process.env.PPM_HOME,
    override: process.env[PROD_DB_OVERRIDE_ENV],
    execPath: process.execPath,
    entry: process.argv[1] ?? "",
  };
}

/** Entry path with separators normalised, so Windows paths match the suffixes. */
function normaliseEntry(entry: string): string {
  return entry.split(sep).join("/");
}

/**
 * Whether the described process may open the real database.
 *
 * A set `PPM_HOME` already redirects the whole PPM directory elsewhere, so the
 * caller has isolated itself and there is nothing left to protect.
 */
export function isAllowedProdDbEntrypoint(
  ctx: ProdDbGuardContext = currentProdDbGuardContext(),
): boolean {
  if (ctx.ppmHome) return true;
  if (ctx.override === "1") return true;
  // A compiled binary carries its entry inside the executable, so argv[1] is not
  // a source path there. Same signal autostart-generator uses.
  if (!ctx.execPath.includes("bun")) return true;
  const entry = normaliseEntry(ctx.entry);
  // Anchored on a path boundary, so a stray ".../vendor-src/index.ts" cannot pose
  // as the CLI just by ending in the same characters.
  return ALLOWED_ENTRYPOINTS.some(
    (suffix) => entry === suffix || entry.endsWith("/" + suffix),
  );
}

/**
 * Throw unless the current process is allowed to open `dbPath`.
 * The message is written for whoever -- or whatever -- is driving the script.
 */
export function assertProdDbAccessAllowed(dbPath: string): void {
  const ctx = currentProdDbGuardContext();
  if (isAllowedProdDbEntrypoint(ctx)) return;
  const entry = normaliseEntry(ctx.entry) || "<unknown entry>";
  throw new Error(
    [
      `Refusing to open the real PPM database at ${dbPath} from "${entry}".`,
      "Only the ppm CLI, server, supervisor and edge forwarder may touch production state.",
      "Run this against a scratch database instead -- set PPM_HOME to a temp directory",
      `(the same isolation the test suite uses) -- or set ${PROD_DB_OVERRIDE_ENV}=1 if you`,
      "genuinely intend to write to ~/.ppm.",
    ].join(" "),
  );
}
