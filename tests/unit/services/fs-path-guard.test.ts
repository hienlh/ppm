import { describe, it, expect } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  isAllowedPath,
  isPpmDirPath,
  isProtectedRoot,
  assertNotProtected,
  assertNotPpmDir,
  mapFsError,
  resolvePath,
} from "../../../src/services/fs-path-guard.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

const isWin = process.platform === "win32";
const abs = (posix: string, win: string) => (isWin ? win : posix);

describe("isAllowedPath — whole-disk scope", () => {
  it("allows a system directory outside the home tree", () => {
    expect(isAllowedPath(abs("/etc", "C:\\Windows"))).toBe(true);
  });

  it("allows the home directory", () => {
    expect(isAllowedPath(homedir())).toBe(true);
  });

  it("rejects a relative path", () => {
    expect(isAllowedPath("etc/passwd")).toBe(false);
  });

  it.if(isWin)("rejects UNC shares, which are unsupported", () => {
    expect(isAllowedPath("\\\\server\\share\\file.txt")).toBe(false);
  });

  it("keeps allowing SDK background-command output files", () => {
    expect(
      isAllowedPath("/private/tmp/claude-501/-Users-x-app/3ef19f1d/tasks/b1fel903t.output"),
    ).toBe(true);
    expect(
      isAllowedPath("Z:\\Other\\Temp\\claude\\C--Users-x-app\\sess\\tasks\\bs3.output"),
    ).toBe(true);
  });
});

describe("resolvePath", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(resolvePath("~/sub")).toBe(resolve(homedir(), "sub"));
  });

  it("normalizes traversal segments", () => {
    expect(resolvePath(abs("/tmp/a/../b", "C:\\tmp\\a\\..\\b"))).toBe(
      resolve(abs("/tmp/b", "C:\\tmp\\b")),
    );
  });
});

describe("PPM directory shield", () => {
  it("recognizes the ppm dir and its subtree", () => {
    expect(isPpmDirPath(getPpmDir())).toBe(true);
    expect(isPpmDirPath(resolve(getPpmDir(), "ppm.db"))).toBe(true);
  });

  it("does not flag unrelated paths", () => {
    expect(isPpmDirPath(resolve(homedir(), "Documents"))).toBe(false);
  });

  it("refuses reads inside the ppm dir", () => {
    expect(() => assertNotPpmDir(resolve(getPpmDir(), "ppm.db"))).toThrow("Access denied");
  });
});

describe("isProtectedRoot", () => {
  it("protects the home directory and the ppm dir", () => {
    expect(isProtectedRoot(homedir())).toBe(true);
    expect(isProtectedRoot(getPpmDir())).toBe(true);
  });

  it("protects the filesystem root", () => {
    expect(isProtectedRoot(abs("/", "C:\\"))).toBe(true);
  });

  it("leaves ordinary directories alone", () => {
    expect(isProtectedRoot(resolve(homedir(), "Documents"))).toBe(false);
  });

  it("rejects a protected path through assertNotProtected", async () => {
    await expect(assertNotProtected(homedir())).rejects.toThrow("protected path");
  });

  it("allows a normal path through assertNotProtected", async () => {
    await expect(assertNotProtected(resolve(homedir(), "some-file.txt"))).resolves.toBeUndefined();
  });
});

describe("mapFsError", () => {
  it("maps ENOENT to 404", () => {
    expect(mapFsError({ code: "ENOENT", message: "missing" }).status).toBe(404);
  });

  it("maps EEXIST to 409 with a client-readable code", () => {
    const info = mapFsError({ code: "EEXIST", message: "exists" });
    expect(info.status).toBe(409);
    expect(info.code).toBe("EEXIST");
  });

  it("maps EPERM to 403 with a hint", () => {
    const info = mapFsError({ code: "EPERM", message: "denied" });
    expect(info.status).toBe(403);
    expect(info.hint).toBeTruthy();
  });

  it("passes through an explicit status carried by guard errors", () => {
    expect(mapFsError({ status: 409, code: "NO_TRASH", message: "no backend" }).status).toBe(409);
  });

  it("falls back to 500 for unknown failures", () => {
    expect(mapFsError(new Error("boom")).status).toBe(500);
  });
});
