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
  openSync, closeSync, writeSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fdWritesTo, rotateIfOversized } from "../../../src/services/log-rotate.ts";

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
});
