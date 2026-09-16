/**
 * Bounding ppm.log, and noticing that a writer's own stdout is already it.
 *
 * The rotation here truncates in place rather than renaming, and that is not a
 * stylistic choice: the supervisor and every child it spawns hold descriptors
 * opened on this inode with `O_APPEND`. A rename would leave all of them
 * writing into the renamed file forever — the log would appear to rotate once
 * and then never grow again. The test that matters is the one that writes
 * through a pre-existing descriptor *after* rotating.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync,
  openSync, closeSync, writeSync, statSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fdWritesTo, rotateIfOversized, stdioIsLogFile, consumeStdioIsLogEnv,
  resetRotateFailureWarning, STDIO_IS_LOG_ENV,
} from "../../../src/services/log-rotate.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ppm-log-rotate-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("does this descriptor already write to that file", () => {
  it("says yes for a descriptor opened on the file", () => {
    const p = join(dir, "ppm.log");
    writeFileSync(p, "x");
    const fd = openSync(p, "a");
    try {
      expect(fdWritesTo(fd, p)).toBe(true);
    } finally { closeSync(fd); }
  });

  it("says no for a descriptor on a different file", () => {
    const a = join(dir, "a.log");
    const b = join(dir, "b.log");
    writeFileSync(a, "x");
    writeFileSync(b, "x");
    const fd = openSync(a, "a");
    try {
      expect(fdWritesTo(fd, b)).toBe(false);
    } finally { closeSync(fd); }
  });

  it("says no rather than throwing when the file is not there", () => {
    const fd = openSync(join(dir, "a.log"), "a");
    try {
      expect(fdWritesTo(fd, join(dir, "nope.log"))).toBe(false);
    } finally { closeSync(fd); }
  });
});

/**
 * The Windows half of the same question.
 *
 * `fstat` reports an inode of 0 for most handles there, so the inode comparison above always
 * answers "different file" — and on the platform PPM is most often installed on, the duplicate
 * unredacted stdout copy this module exists to remove kept being written. Detection cannot be
 * fixed; the supervisor knows what it wired up, so it declares it.
 */
describe("the supervisor can say so outright", () => {
  it("believes the declaration even where no inode could confirm it", () => {
    const a = join(dir, "a.log");
    const b = join(dir, "b.log");
    writeFileSync(a, "x");
    writeFileSync(b, "x");
    const fd = openSync(a, "a");
    try {
      const env = { [STDIO_IS_LOG_ENV]: "1" } as NodeJS.ProcessEnv;
      expect(stdioIsLogFile(fd, b, env)).toBe(true);
      // Without it, still exactly the inode answer — a terminal started from a dev shell must
      // not lose its output.
      expect(stdioIsLogFile(fd, b, {})).toBe(false);
      expect(stdioIsLogFile(fd, a, {})).toBe(true);
    } finally { closeSync(fd); }
  });

  it("is consumed, so nothing the process spawns inherits it", () => {
    // PPM spawns terminals, SDK children and `ppm` CLI invocations with its own environment.
    // Any of them would otherwise start life believing its stdout is the log file — and drop it.
    const env = { [STDIO_IS_LOG_ENV]: "1" } as NodeJS.ProcessEnv;
    consumeStdioIsLogEnv(env);
    expect(STDIO_IS_LOG_ENV in env).toBe(false);
  });
});

describe("rotation", () => {
  it("leaves a log under its cap alone", () => {
    const p = join(dir, "ppm.log");
    writeFileSync(p, "small\n");
    expect(rotateIfOversized(p, 1024)).toBe(false);
    expect(readFileSync(p, "utf-8")).toBe("small\n");
    expect(existsSync(`${p}.1`)).toBe(false);
  });

  it("empties the log and keeps the contents as .1", () => {
    const p = join(dir, "ppm.log");
    writeFileSync(p, "a".repeat(2048) + "\n");
    expect(rotateIfOversized(p, 1024)).toBe(true);
    expect(statSync(p).size).toBe(0);
    expect(readFileSync(`${p}.1`, "utf-8")).toBe("a".repeat(2048) + "\n");
  });

  it("keeps writing to the same file through a descriptor opened before it", () => {
    // The whole reason rotation truncates instead of renaming. With a rename
    // this descriptor would be appending to ppm.log.1 for the rest of the
    // process's life, and ppm.log would sit empty while the server logged
    // normally — a failure with no error anywhere.
    const p = join(dir, "ppm.log");
    writeFileSync(p, "a".repeat(2048) + "\n");
    const fd = openSync(p, "a");
    try {
      expect(rotateIfOversized(p, 1024)).toBe(true);
      writeSync(fd, "after rotation\n");
      expect(readFileSync(p, "utf-8")).toBe("after rotation\n");
    } finally { closeSync(fd); }
  });

  it("shifts generations and drops the oldest", () => {
    const p = join(dir, "ppm.log");
    writeFileSync(`${p}.1`, "gen1");
    writeFileSync(`${p}.2`, "gen2");
    writeFileSync(`${p}.3`, "gen3");
    writeFileSync(p, "b".repeat(2048));

    expect(rotateIfOversized(p, 1024, 3)).toBe(true);

    expect(readFileSync(`${p}.1`, "utf-8")).toBe("b".repeat(2048)); // what was live
    expect(readFileSync(`${p}.2`, "utf-8")).toBe("gen1");
    expect(readFileSync(`${p}.3`, "utf-8")).toBe("gen2");
    expect(existsSync(`${p}.4`)).toBe(false);                        // gen3 is gone
  });

  it("says no rather than throwing when there is no log yet", () => {
    expect(rotateIfOversized(join(dir, "absent.log"), 1024)).toBe(false);
  });

  it("says so once when it cannot rotate, instead of silently leaving the log unbounded", () => {
    // On Windows `truncateSync` on a file the supervisor and the server child both hold open
    // fails with EBUSY, and the blanket catch made that indistinguishable from "nothing to do"
    // — the cap silently stops applying. A read-only directory is the portable way to make the
    // same catch run.
    if (process.platform === "win32") return; // chmod does not deny an admin here
    const p = join(dir, "ppm.log");
    writeFileSync(p, "a".repeat(2048));
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    chmodSync(dir, 0o555);
    resetRotateFailureWarning();
    try {
      expect(rotateIfOversized(p, 1024)).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("ppm.log");

      // Once per process: the caller is a one-minute timer, and the tenth failure says nothing
      // the first did not.
      expect(rotateIfOversized(p, 1024)).toBe(false);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = origWarn;
      chmodSync(dir, 0o755);
      resetRotateFailureWarning();
    }
  });
});
