import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Source-level guards against the two ways a test run can reach the real
 * `~/.ppm` and destroy a production database.
 *
 * These are lint rules, not behaviour tests: the failure they prevent cannot be
 * caught by asserting on behaviour, because by the time a fixture has written
 * to the real database the damage is already done and the test itself still
 * passes. A production database was overwritten by a test fixture exactly this
 * way — the run reported success.
 */

const TESTS_ROOT = resolve(import.meta.dir, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "screenshots") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

const FILES = walk(TESTS_ROOT);

describe("PPM_HOME teardown discipline", () => {
  /**
   * The bunfig preload points `PPM_HOME` at a temp directory, and that single
   * variable is what keeps every test file in the process away from the real
   * `~/.ppm`. A teardown that *deletes* it instead of restoring the preload's
   * value silently re-points `getPpmDir()` at production for every test file
   * that runs afterwards.
   *
   * A guarded restore (`if (ORIGINAL === undefined) delete ...`) is correct and
   * allowed: it only unsets when the variable genuinely started out unset. A
   * file that must unset it unconditionally — because unset is the state under
   * test — opts out with the marker comment and takes responsibility for its
   * own `afterEach` restore.
   */
  test("no test unsets PPM_HOME without restoring the preload value", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Prose in a comment describing the rule is not a violation of it.
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
        if (!/delete\s+process\.env\.PPM_HOME/.test(line)) return;
        const guarded = /undefined/.test(line);
        // The marker may sit on the statement or in the comment immediately
        // above it, where the justification actually belongs.
        const exempt = lines
          .slice(Math.max(0, i - 3), i + 1)
          .some((l) => l.includes("ppm-home-unset-is-the-subject"));
        if (!guarded && !exempt) {
          offenders.push(`${relative(TESTS_ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("e2e access to the real PPM directory", () => {
  /**
   * The e2e scripts run outside the bunfig preload — they drive an already
   * running dev server and legitimately read the real config database to get
   * an auth token. Reading is fine; holding a writable handle to it is not,
   * because a stray statement in a debugging session then lands on production
   * data. Every such connection must be opened readonly.
   */
  test("every real-PPM database handle in tests/e2e is readonly", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (!file.includes(`${join("tests", "e2e")}`)) continue;
      const src = readFileSync(file, "utf8");
      // `new Database(...)` up to its closing paren, tolerating line breaks.
      for (const m of src.matchAll(/new Database\(([\s\S]*?)\)\s*[;,)]/g)) {
        const call = m[1] ?? "";
        const touchesRealPpmDir = /\.ppm"|\.ppm'|PPM_DIR|homedir\(\)/.test(call);
        if (!touchesRealPpmDir) continue;
        if (!/readonly:\s*true/.test(call)) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${relative(TESTS_ROOT, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("a test file names no one machine's checkout", () => {
  /**
   * An absolute path into somebody's home directory is not portable and does
   * not fail loudly. `mock.module("/home/<user>/Projects/ppm/src/…")` in a
   * different clone — or in a second worktree of the same clone — names a file
   * that is not the one under test, so the mock silently does nothing and the
   * real module is loaded instead. That is what happened here: the two
   * explorer prefetch tests passed in one directory and failed in another, on
   * a network call nobody made.
   *
   * The repository root is the only absolute path a test may compute, and it
   * computes it from `import.meta.dir`.
   */
  test("no test imports or mocks through an absolute home path", () => {
    const offenders: string[] = [];
    const HOME_PATH = /["'](?:\/(?:home|Users)\/[^"'\s]+|[A-Za-z]:[\\/]Users[\\/][^"'\s]+)["']/g;
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        const trimmed = line.trim();
        // Prose, including this rule's own example of the thing it forbids.
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
        // Only where it decides which module is loaded.
        if (!/\b(?:import|require|mock\.module)\s*\(/.test(line)) return;
        const hit = line.match(HOME_PATH);
        if (hit) offenders.push(`${relative(TESTS_ROOT, file)}:${i + 1} → ${hit[0]}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
