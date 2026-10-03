import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  BASELINE_MAX_BYTES,
  baselinesRoot,
  captureBaseline,
  deleteSessionBaselines,
  listBaselines,
  pruneSessionBaselines,
  readBaseline,
  recordBaseline,
} from "../../../src/services/session-file-baselines/session-file-baselines.service.ts";
import { _resetSessionFileHistory, observeFile } from "../../../src/services/session-file-baselines/session-file-history.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

// Restore, never delete: the bunfig preload's PPM_HOME shields later test files from ~/.ppm.
const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
const SESSION = "0b6c2f8e-5a3d-4c1e-9f7a-1d2e3f4a5b6c";

let ppmHome: string;
let work: string;

beforeEach(() => {
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-baselines-home-"));
  work = mkdtempSync(resolve(tmpdir(), "ppm-baselines-work-"));
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
});

afterEach(async () => {
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  await rmRetrying(ppmHome);
  await rmRetrying(work);
});

describe("session file baselines", () => {
  test("keeps the file as it was at the first capture, whatever happens after", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "original\n");
    await captureBaseline(SESSION, file);
    writeFileSync(file, "changed by the session\n");
    await captureBaseline(SESSION, file);
    recordBaseline(SESSION, file, "worked out later");

    const rec = readBaseline(SESSION, file);
    expect(rec).toMatchObject({ path: file, existed: true, content: "original\n" });
  });

  test("two captures racing for one file write one record holding the original", async () => {
    const file = join(work, "race.ts");
    writeFileSync(file, "before\n");
    await Promise.all([captureBaseline(SESSION, file), captureBaseline(SESSION, file)]);
    expect(listBaselines(SESSION)).toHaveLength(1);
    expect(readBaseline(SESSION, file)?.content).toBe("before\n");
    // No temp file is left behind beside the record.
    expect(readdirSync(join(baselinesRoot(), SESSION)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a file the session creates is recorded as absent", async () => {
    const file = join(work, "new.ts");
    await captureBaseline(SESSION, file);
    expect(readBaseline(SESSION, file)).toMatchObject({ existed: false });
    expect(readBaseline(SESSION, file)?.content).toBeUndefined();
  });

  test("binary and oversized files are listed without their bytes", async () => {
    const bin = join(work, "image.png");
    writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const big = join(work, "big.log");
    writeFileSync(big, Buffer.alloc(BASELINE_MAX_BYTES + 1, 0x61));
    await captureBaseline(SESSION, bin);
    await captureBaseline(SESSION, big);
    expect(readBaseline(SESSION, bin)).toMatchObject({ existed: true, binary: true });
    expect(readBaseline(SESSION, bin)?.content).toBeUndefined();
    expect(readBaseline(SESSION, big)).toMatchObject({ existed: true, tooLarge: true });
    expect(readBaseline(SESSION, big)?.content).toBeUndefined();
  });

  test("never copies a file from the PPM directory", async () => {
    const secret = join(ppmHome, "ppm.db");
    writeFileSync(secret, "credentials");
    await captureBaseline(SESSION, secret);
    recordBaseline(SESSION, secret, "credentials");
    expect(listBaselines(SESSION)).toEqual([]);
  });

  test("a session id that is not a plain name touches nothing", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "x");
    await captureBaseline("../escape", file);
    recordBaseline("a/b", file, "x");
    expect(listBaselines("../escape")).toEqual([]);
    expect(readdirSync(ppmHome)).toEqual([]);
  });

  test("a worked-out baseline is kept, with null meaning the file did not exist", () => {
    recordBaseline(SESSION, join(work, "patched.ts"), "line 1\n");
    recordBaseline(SESSION, join(work, "added.ts"), null);
    expect(readBaseline(SESSION, join(work, "patched.ts"))).toMatchObject({ existed: true, content: "line 1\n" });
    expect(readBaseline(SESSION, join(work, "added.ts"))).toMatchObject({ existed: false });
  });

  test("lists in capture order and deletes with the session", async () => {
    for (const name of ["one.ts", "two.ts", "three.ts"]) {
      writeFileSync(join(work, name), name);
      await captureBaseline(SESSION, join(work, name));
      await Bun.sleep(2);
    }
    expect(listBaselines(SESSION).map((b) => b.path)).toEqual(["one.ts", "two.ts", "three.ts"].map((n) => join(work, n)));
    deleteSessionBaselines(SESSION);
    expect(listBaselines(SESSION)).toEqual([]);
  });

  test("pruning drops sessions with no capture inside the retention window", () => {
    recordBaseline("old-session", join(work, "a.ts"), "a");
    recordBaseline("recent-session", join(work, "b.ts"), "b");
    const day = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - 40 * day);
    utimesSync(join(baselinesRoot(), "old-session"), old, old);
    mkdirSync(join(baselinesRoot(), "empty-recent"), { recursive: true });

    expect(pruneSessionBaselines(30)).toBe(1);
    expect(readdirSync(baselinesRoot()).sort()).toEqual(["empty-recent", "recent-session"]);
  });

  test("pruning keeps a session that still writes a file it captured long ago", async () => {
    _resetSessionFileHistory();
    const file = join(work, "a.ts");
    writeFileSync(file, "one\n");
    await captureBaseline(SESSION, file);
    await observeFile(SESSION, file, "toolu_1", "before");
    writeFileSync(file, "two\n");
    await observeFile(SESSION, file, "toolu_1", "after");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(join(baselinesRoot(), SESSION), old, old);

    // Today's edit of the same file: no new record, only its history grows.
    await observeFile(SESSION, file, "toolu_2", "before");
    writeFileSync(file, "three\n");
    await observeFile(SESSION, file, "toolu_2", "after");
    expect(pruneSessionBaselines(30)).toBe(0);
    expect(readBaseline(SESSION, file)?.content).toBe("one\n");
  });
});
