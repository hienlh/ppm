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
      for (const call of databaseCalls(src)) {
        if (!touchesRealPpmDir(call.args)) continue;
        if (!/readonly:\s*true/.test(call.args)) {
          offenders.push(`${relative(TESTS_ROOT, file)}:${src.slice(0, call.index).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("and the rule can tell the difference", () => {
    // It could not. The argument list was matched with a non-greedy `([\s\S]*?)\)`, which
    // stops at the *first* closing paren — for the call this rule exists to catch that is
    // `homedir()`'s, so it captured `join(homedir(`, which matches neither the real-PPM test
    // nor the readonly one. A writable handle on the production database walked straight past
    // it. Parens are balanced now, and these three fixtures say so.
    const writable = `const db = new Database(join(homedir(), ".ppm", "ppm.db"));`;
    const readonly = `const db = new Database(join(homedir(), ".ppm", "ppm.db"), { readonly: true });`;
    const elsewhere = `const db = new Database(join(tmp, "scratch.db"));`;

    expect(databaseCalls(writable).map((c) => touchesRealPpmDir(c.args))).toEqual([true]);
    expect(/readonly:\s*true/.test(databaseCalls(writable)[0]!.args)).toBe(false);
    expect(/readonly:\s*true/.test(databaseCalls(readonly)[0]!.args)).toBe(true);
    expect(databaseCalls(elsewhere).map((c) => touchesRealPpmDir(c.args))).toEqual([false]);
  });
});

/** Every `new Database(...)` in `src`, with its argument list taken by counting parens.
 *  A regex cannot do this: the arguments routinely contain calls of their own. */
function databaseCalls(src: string): { index: number; args: string }[] {
  const calls: { index: number; args: string }[] = [];
  for (const m of src.matchAll(/new Database\s*\(/g)) {
    const open = src.indexOf("(", m.index);
    let depth = 0;
    let end = src.length;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) { end = i; break; }
    }
    calls.push({ index: m.index, args: src.slice(open + 1, end) });
  }
  return calls;
}

function touchesRealPpmDir(args: string): boolean {
  return /\.ppm"|\.ppm'|PPM_DIR|homedir\(\)/.test(args);
}

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
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const hit of homePathSpecifiers(src)) {
        offenders.push(`${relative(TESTS_ROOT, file)}:${src.slice(0, hit.index).split("\n").length} → ${hit.path}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("and it survives a formatter and a Windows path", () => {
    // Two holes, both silent. The rule required the call token and the string on one physical
    // line, so a wrapped `await import(\n  "/home/…"\n)` — which is what a printer produces for
    // a long specifier — walked past it. And `[A-Za-z]:[\\/]Users[\\/]` never matched a Windows
    // path as it is actually written in TypeScript, where every separator is escaped.
    const wrapped = `const m = await import(\n  "/home/someone/Projects/ppm/src/x.ts"\n);`;
    const windows = `mock.module("C:\\\\Users\\\\someone\\\\ppm\\\\src\\\\x.ts", () => ({}));`;
    const relativeSpecifier = `const m = await import("../../../src/web/stores/file-store.ts");`;
    const dataNotASpecifier = `const fixture = { path: "/home/someone/Projects/ppm" };`;

    expect(homePathSpecifiers(wrapped)).toHaveLength(1);
    expect(homePathSpecifiers(windows)).toHaveLength(1);
    expect(homePathSpecifiers(relativeSpecifier)).toEqual([]);
    // Still no false positive on a path held as data: it decides no module.
    expect(homePathSpecifiers(dataNotASpecifier)).toEqual([]);
    // And still none on prose — this file is full of it, including the examples above.
    expect(homePathSpecifiers(`// see /home/someone/Projects/ppm\nimport x from "./y.ts";`)).toEqual([]);
  });
});

/**
 * Absolute home paths used as a module specifier.
 *
 * Matched against the file text rather than line by line, with a lookback window for the call
 * token, so a wrapped call is caught; `\s*$` is what tolerates the newline a formatter leaves
 * between the paren and the string. Windows separators are allowed doubled, because that is how
 * `C:\\Users\\…` is written in a TypeScript string.
 */
function homePathSpecifiers(src: string): { index: number; path: string }[] {
  const HOME_PATH = /["'](?:\/(?:home|Users)\/[^"'\s]+|[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^"'\s]+)["']/g;
  const CALL_BEFORE = /\b(?:import|require|mock\.module)\s*\(\s*$/;
  const hits: { index: number; path: string }[] = [];
  for (const m of src.matchAll(HOME_PATH)) {
    const before = src.slice(Math.max(0, m.index - 120), m.index);
    if (!CALL_BEFORE.test(before)) continue;
    // Prose, including this rule's own examples of the thing it forbids.
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const line = src.slice(lineStart, m.index).trim();
    if (line.startsWith("*") || line.startsWith("//") || line.startsWith("/*")) continue;
    hits.push({ index: m.index, path: m[0] });
  }
  return hits;
}
