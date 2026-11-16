/**
 * The one path rule shared by the read-only command check and the Assistant's read tools: read
 * roots, private roots, links, recursion, Windows spellings refused from the text, and how PPM's
 * install folder becomes a read root.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getPpmDir } from "../../../../src/services/ppm-dir.ts";
import {
  assistantReadRoots, findPpmInstallRoot, judgeReadPath, judgeReadPaths, judgeWorkingDirectory, type ReadonlyShellContext,
} from "../../../../src/services/assistant/readonly-shell/readonly-path-check.ts";

const isWindows = process.platform === "win32";
let base: string;
let home: string;
let proj: string;
let ctx: ReadonlyShellContext;

const touch = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x");
};
const verdict = (raw: string, c: Partial<ReadonlyShellContext> = {}, recursive = false) => judgeReadPath(raw, { ...ctx, ...c }, { recursive }).verdict;

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ppm-ro-path-")));
  home = join(base, "home");
  proj = join(base, "proj");
  for (const f of [".ssh/id_rsa", ".bun/install/global/node_modules/@hienlh/ppm/src/index.ts", ".bun/other/secret", "notes/a.md"]) touch(join(home, f));
  for (const f of ["a.json", "src/b.ts", "we~ird.txt"]) touch(join(proj, f));
  symlinkSync(join(home, ".ssh"), join(proj, "keys"), isWindows ? "junction" : "dir");
  mkdirSync(getPpmDir(), { recursive: true });
  ctx = { projectRoots: [proj], home, env: {}, installRoot: null };
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("judgeReadPath", () => {
  it("reads unasked only inside a read root and outside every private root", () => {
    expect(verdict(join(proj, "a.json"))).toBe("readonly");
    expect(verdict(join(proj, "missing.txt"))).toBe("readonly");
    expect(verdict(join(home, "notes", "a.md"))).toBe("ask");
    expect(verdict(join(home, "notes", "a.md"), { projectRoots: [home] })).toBe("readonly");
    expect(verdict(join(home, ".ssh", "id_rsa"), { projectRoots: [home] })).toBe("ask");
    expect(verdict(join(getPpmDir(), "ppm.db"), { projectRoots: [dirname(getPpmDir())] })).toBe("ask");
  });

  it("asks for relative, blank and whitespace-padded paths", () => {
    for (const raw of ["a.json", "./a.json", "../proj/a.json", "", " ", ` ${join(proj, "a.json")}`, `${join(proj, "a.json")} `]) {
      expect(verdict(raw, { cwd: proj })).toBe("ask");
    }
  });

  it("expands ~ to the home folder, so a key under it asks", () => {
    expect(verdict("~/.ssh/id_rsa", { projectRoots: [home] })).toBe("ask");
    expect(verdict("~/notes/a.md", { projectRoots: [home] })).toBe("readonly");
    expect(verdict("~", { projectRoots: [home] })).toBe("readonly");
    expect(verdict("~", { projectRoots: [home] }, true)).toBe("ask");
  });

  it("judges a link by where it points: a junction into the home's keys asks", () => {
    expect(verdict(join(proj, "keys"))).toBe("ask");
    expect(verdict(join(proj, "keys", "id_rsa"))).toBe("ask");
  });

  it("asks for a folder that holds a private root only when it is walked", () => {
    expect(verdict(home, { projectRoots: [home] })).toBe("readonly");
    expect(verdict(home, { projectRoots: [home] }, true)).toBe("ask");
    expect(verdict(proj, {}, true)).toBe("readonly");
  });

  it("refuses Windows network, device, stream, drive-relative and 8.3 spellings from the text", () => {
    const win = { platform: "win32" };
    for (const raw of ["\\\\server\\share\\f", "//server/share/f", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "C:relative", "\\rooted", "C:\\x\\f.txt:secret",
      "C:\\x\\f.txt::$DATA", "C:\\Users\\PC\\PPM~1\\ppm.db", "~/PROGRA~1/x"]) {
      expect(verdict(raw, win)).toBe("ask");
    }
    expect(judgeReadPath("C:\\Users\\PC\\PPM~1\\ppm.db", { ...ctx, platform: "win32" }, { recursive: false }).reason).toContain("8.3");
  });

  it("treats a tilde inside a name as an ordinary character off Windows", () => {
    expect(verdict(join(proj, "we~ird.txt"), { platform: isWindows ? "linux" : process.platform })).toBe("readonly");
  });

  it.if(isWindows)("reads Git Bash's /c/… spelling as drive C:", () => {
    const gitBash = join(proj, "a.json").replace(/^([A-Za-z]):\\/, (_, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
    expect(verdict(gitBash)).toBe("readonly");
    expect(verdict("/etc/passwd")).toBe("ask");
  });
});

describe("judgeReadPaths and judgeWorkingDirectory", () => {
  it("asks when any path asks, and when the working directory is unknown or outside", () => {
    expect(judgeReadPaths([join(proj, "a.json"), join(proj, "src")], ctx, { recursive: true }).verdict).toBe("readonly");
    expect(judgeReadPaths([join(proj, "a.json"), join(proj, "keys")], ctx, { recursive: false }).verdict).toBe("ask");
    expect(judgeWorkingDirectory(ctx, { recursive: true }).verdict).toBe("ask");
    expect(judgeWorkingDirectory({ ...ctx, cwd: proj }, { recursive: true }).verdict).toBe("readonly");
    expect(judgeWorkingDirectory({ ...ctx, cwd: base }, { recursive: false }).verdict).toBe("ask");
  });
});

describe("PPM's install folder", () => {
  const installed = () => join(home, ".bun", "install", "global", "node_modules", "@hienlh", "ppm");

  it("is a read root, also while the only project is the home folder", () => {
    const withInstall = { projectRoots: [home], installRoot: installed() };
    expect(verdict(join(installed(), "src", "index.ts"), withInstall)).toBe("readonly");
    expect(verdict(join(installed(), "src"), withInstall, true)).toBe("readonly");
    expect(verdict(join(home, ".bun", "other", "secret"), withInstall)).toBe("ask");
    expect(verdict(join(installed(), "src", "index.ts"), { installRoot: installed() })).toBe("readonly");
    expect(assistantReadRoots([proj], { home, installRoot: installed() })).toEqual([proj, installed()]);
  });

  it("is dropped when it holds a private root or lies in one", () => {
    expect(assistantReadRoots([proj], { home, installRoot: home })).toEqual([proj]);
    expect(assistantReadRoots([proj], { home, installRoot: getPpmDir() })).toEqual([proj]);
    expect(assistantReadRoots([proj], { home, installRoot: null })).toEqual([proj]);
  });

  it("is found by walking up to PPM's package.json, only when it ships src/", () => {
    const pkg = join(base, "pkg");
    mkdirSync(join(pkg, "src", "services"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@hienlh/ppm" }));
    touch(join(pkg, "packages", "ext", "src", "x.ts"));
    writeFileSync(join(pkg, "packages", "ext", "package.json"), JSON.stringify({ name: "ext-other" }));
    expect(findPpmInstallRoot(join(pkg, "src", "services"))).toBe(pkg);
    expect(findPpmInstallRoot(join(pkg, "packages", "ext", "src"))).toBe(pkg);

    const compiled = join(base, "compiled");
    mkdirSync(join(compiled, "dist"), { recursive: true });
    writeFileSync(join(compiled, "package.json"), JSON.stringify({ name: "@hienlh/ppm" }));
    expect(findPpmInstallRoot(join(compiled, "dist"))).toBeNull();
    expect(findPpmInstallRoot(join(base, "proj"))).toBeNull();
  });

  it("is this checkout when PPM runs from source", () => {
    const checkout = resolve(import.meta.dir, "..", "..", "..", "..");
    expect(findPpmInstallRoot()).toBe(checkout);
    expect(verdict(join(checkout, "src", "services", "ppm-dir.ts"), { installRoot: undefined })).toBe("readonly");
  });
});
