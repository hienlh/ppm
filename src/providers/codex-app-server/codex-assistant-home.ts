/**
 * A CODEX_HOME of its own for every PPM Assistant app-server, sharing only the login and the
 * sessions folder with the account it runs on.
 *
 * Codex reads the user's global instructions from `$CODEX_HOME/AGENTS.md` (and
 * `AGENTS.override.md`), and no setting turns that off: measured on codex 0.161 and 0.162,
 * `project_doc_max_bytes = 0` and `instructions = ""` still list it in thread/start's
 * `instructionSources` and send it to the model. The same home holds the user's `config.toml`,
 * hooks, agents, plugins and skills. So an Assistant app-server runs on a home under the PPM dir
 * that holds none of them, with two links back to the account's home:
 *
 * - `auth.json` is a **hard link** to the account's file (a symlink where a hard link is refused).
 *   Codex saves auth.json by rewriting the file in place, so a token it refreshes from either
 *   home lands in the one file both names point at — measured: after a save through the linked
 *   name, both names still share an inode, and a symlink is still a symlink. A copy would fork the
 *   login instead: ChatGPT rotates the refresh token on every refresh, so whichever copy refreshed
 *   second would hold a token the server had already retired, and that account would read as
 *   signed out.
 * - `sessions` is a junction (Windows) or a directory symlink to the account's `sessions`, so the
 *   Assistant's rollouts are written where every PPM reader of Codex history already looks,
 *   and a resume finds them. Measured: a thread started through the link writes its rollout into
 *   the account's folder and resumes from it, and so does one the account's own app-server wrote.
 *
 * The links are checked on every spawn. One that no longer joins the two files (an auth.json
 * replaced rather than rewritten) is relinked; if the Assistant's side then holds the newer
 * login (`last_refresh`), that login is first written back into the account's file in place, so
 * no refreshed token is ever dropped. When the account has no auth.json — not signed in, or a
 * login kept in the OS keyring, which is keyed per home — nothing is linked and the caller runs
 * on the account's own home as before: losing the login is worse than loading AGENTS.md.
 *
 * Removing an account deletes its home at once (`removeAssistantCodexHome`); any home whose
 * account is gone some other way, or that was still busy then, is deleted on the next
 * preparation, so a removed account's tokens do not live on here.
 */
import { createHash } from "node:crypto";
import {
  existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getPpmDir } from "../../services/ppm-dir.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("codex");

/** Records which account home an Assistant home was made for, so it can be removed with it. */
const SOURCE_MARKER = ".ppm-source";

export type AssistantCodexHome = { home: string } | { home: null; reason: string };

/** Where the Assistant's homes live: inside the PPM dir, which every PPM file door already refuses. */
export function assistantCodexHomesRoot(): string {
  return join(getPpmDir(), "assistant", "codex-homes");
}

/** The home an app-server spawned with no CODEX_HOME of PPM's would use. */
export function ambientCodexHome(): string {
  return resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
}

/**
 * The CODEX_HOME an Assistant app-server should run on for `accountHome` (`undefined` = the
 * ambient login). Falls back to the account's own home, logged, when an isolated one cannot be
 * set up — so the session still runs, with the user's AGENTS.md and skills as before.
 */
export function assistantSpawnHome(accountHome: string | undefined): string | undefined {
  const prepared = prepareAssistantCodexHome(accountHome ?? ambientCodexHome());
  if (prepared.home !== null) return prepared.home;
  log.warn(`assistant session: running on the account's own CODEX_HOME (${prepared.reason}); its AGENTS.md reaches the session`);
  return accountHome;
}

/** Set up (or repair) the Assistant home for `sourceHome`. Never throws. */
export function prepareAssistantCodexHome(sourceHome: string, root: string = assistantCodexHomesRoot()): AssistantCodexHome {
  const source = resolve(sourceHome);
  try { sweepAssistantCodexHomes(root); } catch (e) { log.warn(`assistant home sweep failed: ${(e as Error).message}`); }
  const target = join(root, homeKey(source));
  const sourceAuth = join(source, "auth.json");
  try {
    if (!existsSync(sourceAuth)) {
      // A signed-out account must not stay signed in here through an old link.
      removeIfPresent(join(target, "auth.json"));
      return { home: null, reason: "the account keeps no auth.json" };
    }
    if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
    const marker = join(target, SOURCE_MARKER);
    if (!existsSync(marker) || readFileSync(marker, "utf8") !== source) writeFileSync(marker, source, { mode: 0o600 });
    if (!linkAuth(sourceAuth, join(target, "auth.json"))) return { home: null, reason: "auth.json could not be linked" };
    const sessions = linkSessions(join(source, "sessions"), join(target, "sessions"));
    if (sessions) return { home: null, reason: sessions };
    return { home: target };
  } catch (e) {
    return { home: null, reason: (e as Error).message };
  }
}

/** Delete every Assistant home whose account home no longer exists. */
export function sweepAssistantCodexHomes(root: string = assistantCodexHomesRoot()): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const marker = join(dir, SOURCE_MARKER);
    if (!existsSync(marker)) continue;
    const source = readFileSync(marker, "utf8").trim();
    if (!source || existsSync(source)) continue;
    try {
      removeAssistantHome(dir);
      log.info(`assistant home for a removed account deleted: ${name}`);
    } catch (e) {
      // An app-server still running on it holds its files open (EBUSY on Windows); the next
      // preparation tries again, and one busy home must not keep the others.
      log.warn(`assistant home ${name} not deleted yet: ${(e as Error).message}`);
    }
  }
}

/**
 * Delete the Assistant home made for `sourceHome`, if there is one. Called when that account is
 * removed: its auth.json is a hard link, so deleting the account's own file leaves the login
 * alive under this name until the next preparation's sweep. Call it while the account home
 * still exists — the links are taken out first either way, so nothing of the account's is
 * reached through them. Never throws; a home still held open by a running app-server is
 * logged and left to the sweep, which deletes it once its account is gone.
 */
export function removeAssistantCodexHome(sourceHome: string, root: string = assistantCodexHomesRoot()): boolean {
  const dir = join(root, homeKey(resolve(sourceHome)));
  if (!lstatExists(dir)) return true;
  try {
    removeAssistantHome(dir);
    log.info(`assistant home of a removed account deleted: ${basename(dir)}`);
    return true;
  } catch (e) {
    log.warn(`assistant home ${basename(dir)} not deleted yet: ${(e as Error).message}`);
    return false;
  }
}

/** Readable and collision-free: the account folder's name plus a hash of its full path. */
function homeKey(source: string): string {
  const name = basename(source).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "home";
  const spelling = process.platform === "win32" ? source.toLowerCase() : source;
  return `${name}-${createHash("sha256").update(spelling).digest("hex").slice(0, 10)}`;
}

/** Whether two paths name the same file (a hard link, or a symlink followed to its target). */
function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev;
  } catch { return false; }
}

function lastRefresh(path: string): number {
  try {
    const value = (JSON.parse(readFileSync(path, "utf8")) as { last_refresh?: unknown }).last_refresh;
    return typeof value === "string" ? Date.parse(value) : Number.NaN;
  } catch { return Number.NaN; }
}

/**
 * Make `target` the same file as `source`. A diverged target holding a strictly newer login is
 * written back into `source` first — in place, so any other name for that file keeps it too.
 */
function linkAuth(source: string, target: string): boolean {
  if (sameFile(source, target)) return true;
  if (lstatExists(target)) {
    const theirs = lastRefresh(target);
    const ours = lastRefresh(source);
    if (Number.isFinite(theirs) && Number.isFinite(ours) && theirs > ours) {
      writeFileSync(source, readFileSync(target));
      log.warn("assistant home held a newer Codex login than its account; written back before relinking");
    }
    unlinkSync(target);
  }
  try {
    linkSync(source, target);
  } catch (hardLinkError) {
    try {
      symlinkSync(source, target, "file");
    } catch {
      log.warn(`assistant home: auth.json link refused (${(hardLinkError as Error).message})`);
      return false;
    }
  }
  return sameFile(source, target);
}

/** Point `target` at `source`; null when done, otherwise why it could not be. */
function linkSessions(source: string, target: string): string | null {
  if (!existsSync(source)) mkdirSync(source, { recursive: true, mode: 0o700 });
  if (lstatExists(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      if (samePathReal(target, source)) return null;
      unlinkSync(target);
    } else if (stat.isDirectory() && readdirSync(target).length === 0) {
      rmdirSync(target);
    } else {
      // Rollouts written here would be invisible to PPM's history; never bury them.
      return "its sessions folder is not a link to the account's";
    }
  }
  symlinkSync(resolve(source), target, process.platform === "win32" ? "junction" : "dir");
  return samePathReal(target, source) ? null : "the sessions link does not reach the account's folder";
}

function samePathReal(a: string, b: string): boolean {
  try {
    const x = realpathSync(a);
    const y = realpathSync(b);
    return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch { return false; }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function removeIfPresent(path: string): void {
  if (lstatExists(path)) unlinkSync(path);
}

/**
 * Remove an Assistant home. The sessions link is unlinked on its own first, and a failure there
 * throws before anything else is touched: a recursive delete must never get the chance to walk
 * through the link into the account's rollouts. The login goes next, while the marker that lets
 * a later sweep retry is still there, so a delete that stops halfway never strands a token.
 */
function removeAssistantHome(dir: string): void {
  const sessions = join(dir, "sessions");
  if (lstatExists(sessions) && lstatSync(sessions).isSymbolicLink()) unlinkSync(sessions);
  removeIfPresent(join(dir, "auth.json"));
  rmSync(dir, { recursive: true, force: true });
}
