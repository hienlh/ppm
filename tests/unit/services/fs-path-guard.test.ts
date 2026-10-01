import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isAllowedPath,
  isPpmDirPath,
  isProtectedRoot,
  assertNotProtected,
  assertNotPpmDir,
  isChatUploadPath,
  isCodexGeneratedImagePath,
  isCredentialPath,
  mapFsError,
  resolvePath,
} from "../../../src/services/fs-path-guard.service.ts";
import { _resetPpmDir, getPpmDir } from "../../../src/services/ppm-dir.ts";
import { getBackupsDir } from "../../../src/services/db-backup/db-backup-paths.ts";
import { assertReadPermitted } from "../../../src/services/fs-ops/fs-ops-read-write.service.ts";

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

  it("rejects a UNC path that mimics the SDK output layout", () => {
    // Allowing it would turn a read into an outbound SMB fetch to a host the
    // caller picked, which can hang the request or leak credentials.
    expect(
      isAllowedPath("\\\\attacker\\claude\\proj\\sess\\tasks\\payload.output"),
    ).toBe(false);
  });

  it.if(isWin)("rejects the forward-slash UNC spelling too", () => {
    // On POSIX a leading `//` is just an absolute path, so this only applies
    // where `\\host\share` semantics exist.
    expect(isAllowedPath("//attacker/claude/proj/sess/tasks/payload.output")).toBe(false);
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

  it("does not expand a bare ~ prefix that is part of a name", () => {
    // `~foo` is user-home shorthand this code does not implement; slicing two
    // characters off it would silently resolve to `$HOME/oo`.
    expect(resolvePath("~foo")).toBe(resolve("~foo"));
    expect(resolvePath("~foo")).not.toBe(resolve(homedir(), "oo"));
  });

  it("expands a bare ~ to the home directory", () => {
    expect(resolvePath("~")).toBe(homedir());
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

  it("still allows chat attachments, which live inside the ppm dir", () => {
    expect(() => assertNotPpmDir(resolve(getPpmDir(), "uploads", "abc123-image.png"))).not.toThrow();
    expect(isChatUploadPath(resolve(getPpmDir(), "uploads", "abc123-image.png"))).toBe(true);
  });

  it("does not let a name that merely starts with uploads escape the refusal", () => {
    expect(isChatUploadPath(resolve(getPpmDir(), "uploads-secret", "ppm.db"))).toBe(false);
    expect(() => assertNotPpmDir(resolve(getPpmDir(), "uploads-secret", "ppm.db"))).toThrow(
      "Access denied",
    );
  });
});

describe.if(!isWin)("a PPM directory reached through a symlink", () => {
  // How PPM_HOME under /tmp or /var looks on a Mac: both are links into /private.
  const prevPpmHome = process.env.PPM_HOME;
  let base = "";
  let real = "";
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ppm-guard-link-")));
    real = join(base, "real-home");
    mkdirSync(real);
    symlinkSync(real, join(base, "linked-home"));
    process.env.PPM_HOME = join(base, "linked-home");
    _resetPpmDir();
  });
  afterAll(() => {
    if (prevPpmHome === undefined) delete process.env.PPM_HOME; else process.env.PPM_HOME = prevPpmHome;
    _resetPpmDir();
    rmSync(base, { recursive: true, force: true });
  });

  it("is refused by its real path, which is what every door checks second", () => {
    expect(isCredentialPath(join(real, "ppm.db"))).toBe(true);
    expect(() => assertNotPpmDir(join(real, "ppm.db"))).toThrow("Access denied");
    // And as configured, as before.
    expect(isPpmDirPath(join(base, "linked-home", "ppm.db"))).toBe(true);
  });

  it("keeps its two read-only exceptions under the real path too", () => {
    expect(() => assertNotPpmDir(join(real, "uploads", "abc123-image.png"))).not.toThrow();
    expect(isCodexGeneratedImagePath(join(real, "codex-accounts", "acc", "generated_images", "a.png"))).toBe(true);
    expect(() => assertNotPpmDir(join(real, "codex-accounts", "acc", "auth.json"))).toThrow("Access denied");
  });

  it("does not reach past the directory it names", () => {
    expect(isCredentialPath(join(base, "real-home-2", "ppm.db"))).toBe(false);
  });
});

describe.if(!isWin)("an exception directory replaced by a symlink", () => {
  // The two read-only exceptions are holes in the PPM-dir refusal. A link in place
  // of either directory must not carry the hole to wherever it points.
  const prevPpmHome = process.env.PPM_HOME;
  let base = "";
  const useHome = (name: string) => {
    const home = join(base, name);
    mkdirSync(home);
    process.env.PPM_HOME = home;
    _resetPpmDir();
    return home;
  };
  // What every read door does: the requested path, then the path it resolves to.
  const read = (requested: string) => () => assertReadPermitted(requested, realpathSync(requested));
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ppm-guard-redirect-")));
  });
  afterAll(() => {
    if (prevPpmHome === undefined) delete process.env.PPM_HOME; else process.env.PPM_HOME = prevPpmHome;
    _resetPpmDir();
    rmSync(base, { recursive: true, force: true });
  });

  it("does not serve a snapshot through an uploads link to the backups directory", () => {
    const home = useHome("uploads-to-backups");
    mkdirSync(getBackupsDir());
    writeFileSync(join(getBackupsDir(), "ppm-20261001T000000Z-hourly.db"), "snapshot");
    symlinkSync(getBackupsDir(), join(home, "uploads"));
    expect(read(join(home, "uploads", "ppm-20261001T000000Z-hourly.db"))).toThrow("Access denied");
  });

  it("does not serve ppm.db through an uploads link to the PPM directory", () => {
    const home = useHome("uploads-to-home");
    writeFileSync(join(home, "ppm.db"), "config");
    symlinkSync(home, join(home, "uploads"));
    expect(read(join(home, "uploads", "ppm.db"))).toThrow("Access denied");
  });

  it("does not move the generated-images exception with a codex-accounts link", () => {
    const home = useHome("codex-accounts-to-home");
    mkdirSync(join(home, "acct", "generated_images"), { recursive: true });
    writeFileSync(join(home, "acct", "generated_images", "auth.json"), "{}");
    symlinkSync(home, join(home, "codex-accounts"));
    expect(read(join(home, "codex-accounts", "acct", "generated_images", "auth.json"))).toThrow("Access denied");
  });

  it("still serves a real upload and a real generated image", () => {
    const home = useHome("plain");
    mkdirSync(join(home, "uploads"));
    writeFileSync(join(home, "uploads", "abc123-image.png"), "png");
    mkdirSync(join(home, "codex-accounts", "acct", "generated_images"), { recursive: true });
    writeFileSync(join(home, "codex-accounts", "acct", "generated_images", "a.png"), "png");
    expect(read(join(home, "uploads", "abc123-image.png"))).not.toThrow();
    expect(read(join(home, "codex-accounts", "acct", "generated_images", "a.png"))).not.toThrow();
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
