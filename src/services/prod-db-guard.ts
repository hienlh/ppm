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
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

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
 * Names a running instance's own folder in the shells it starts (`assistantShellEnv`). Those
 * shells also get `PPM_HOME` set to that folder, so their `ppm` commands reach that instance; the
 * folder may be anywhere (`/srv/ppm`), so this marker is what says it is live and not scratch.
 */
export const LIVE_PPM_HOME_ENV = "PPM_LIVE_HOME";

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
  /** The real PPM folder (`~/.ppm`); defaults to the current user's. */
  realPpmDir?: string;
  /** `PPM_LIVE_HOME`: a running instance's folder, set in the shells that instance starts. */
  liveHome?: string;
}

/**
 * The real PPM folder. Deliberately the real home rather than `getPpmDir()`: the question is
 * whether `PPM_HOME` points somewhere else, so it cannot be answered through `PPM_HOME`.
 */
function realPpmDir(): string {
  return resolve(homedir(), ".ppm");
}

/** Snapshot the live process into a guard context. */
export function currentProdDbGuardContext(): ProdDbGuardContext {
  return {
    ppmHome: process.env.PPM_HOME,
    override: process.env[PROD_DB_OVERRIDE_ENV],
    execPath: process.execPath,
    entry: process.argv[1] ?? "",
    realPpmDir: realPpmDir(),
    liveHome: process.env[LIVE_PPM_HOME_ENV],
  };
}

function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Whether `PPM_HOME` moves the PPM folder away from every live one. A `PPM_HOME` naming the real
 * `~/.ppm`, or the folder of the instance whose shell this is (`PPM_LIVE_HOME`), isolates
 * nothing: a production Assistant session's shell has it set exactly so, and a script started
 * there inherits it. A scratch folder set over it (`PPM_HOME=$(mktemp -d)`) still isolates.
 */
function isolatesFromLiveDirs(ctx: ProdDbGuardContext): boolean {
  if (!ctx.ppmHome) return false;
  if (samePath(ctx.ppmHome, ctx.realPpmDir ?? realPpmDir())) return false;
  return !(ctx.liveHome && samePath(ctx.ppmHome, ctx.liveHome));
}

/** Entry path with separators normalised, so Windows paths match the suffixes. */
function normaliseEntry(entry: string): string {
  return entry.split(sep).join("/");
}

/**
 * Whether the described process may open the real database.
 *
 * A `PPM_HOME` naming another folder redirects the whole PPM directory
 * elsewhere, so the caller has isolated itself and there is nothing left to
 * protect. One naming the real folder, or a running instance's own, is no
 * isolation at all.
 */
export function isAllowedProdDbEntrypoint(
  ctx: ProdDbGuardContext = currentProdDbGuardContext(),
): boolean {
  if (isolatesFromLiveDirs(ctx)) return true;
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
