import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { trashPath, type TrashRunner } from "../../../../src/services/fs-ops/fs-ops-trash.service.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-trash-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const okRunner: TrashRunner = async () => ({ exitCode: 0, stderr: "" });

describe("trashPath", () => {
  it("hands an absolute path to the platform backend", async () => {
    const file = join(dir, "gone.txt");
    writeFileSync(file, "x");
    let seen: string[] = [];
    const spy: TrashRunner = async (cmd) => {
      seen = cmd;
      return { exitCode: 0, stderr: "" };
    };
    const result = await trashPath(file, { run: spy });
    expect(result.trashed).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.join(" ")).toContain("gone.txt");
    // The runner is a stub, so the file is still there — the point is that the
    // service never deletes anything itself when the backend is in charge.
    expect(existsSync(file)).toBe(true);
  });

  it("reports NO_TRASH when the backend exits non-zero", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    const failing: TrashRunner = async () => ({ exitCode: 1, stderr: "no recycle bin here" });
    await expect(trashPath(file, { run: failing })).rejects.toMatchObject({
      code: "NO_TRASH",
      status: 409,
    });
  });

  it("reports NO_TRASH when the backend cannot be spawned", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    const throwing: TrashRunner = async () => {
      throw new Error("spawn ENOENT");
    };
    await expect(trashPath(file, { run: throwing })).rejects.toMatchObject({ code: "NO_TRASH" });
  });

  it("never deletes permanently as a fallback", async () => {
    const file = join(dir, "keep.txt");
    writeFileSync(file, "x");
    const failing: TrashRunner = async () => ({ exitCode: 2, stderr: "" });
    await expect(trashPath(file, { run: failing })).rejects.toThrow();
    expect(existsSync(file)).toBe(true);
  });

  it("refuses a protected root", async () => {
    await expect(trashPath(homedir(), { run: okRunner })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a missing path", async () => {
    await expect(trashPath(join(dir, "ghost"), { run: okRunner })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
