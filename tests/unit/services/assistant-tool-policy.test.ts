/**
 * The Assistant's Claude permission policy, at the level of single decisions: network paths
 * are judged from their text alone, credential stores ask even inside a registered project, and
 * a search asks when anything private lies below where it starts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { assistantToolDecision } from "../../../src/services/assistant/assistant-tool-policy.ts";
import { assistantPrivateRoots, isAssistantPrivatePath, privateRootWithin } from "../../../src/services/assistant/assistant-private-paths.ts";
import { designToolDecision, isWindowsNonDrivePath, patternLeavesRoot } from "../../../src/services/design/design-tool-policy.ts";

const isWindows = process.platform === "win32";
/** A directory link that needs no privilege on Windows. */
const linkDir = (target: string, path: string) => symlinkSync(target, path, isWindows ? "junction" : "dir");

let base: string;
let home: string;
let project: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ppm-asst-policy-"));
  home = join(base, "home");
  project = join(base, "project");
  for (const file of [
    ".ssh/id_ed25519", ".aws/credentials", ".npmrc", ".git-credentials", ".config/gh/hosts.yml", ".config/gcloud/credentials.db",
    ".kube/config", ".docker/config.json", ".claude/.credentials.json", ".claude/settings.json", ".claude.json", ".codex/auth.json",
    ".codex/config.toml", "notes/todo.md", "src/app.ts",
  ]) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), "x");
  }
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "Main.ts"), "x");
  linkDir(join(home, ".ssh"), join(project, "keys"));
  mkdirSync(getPpmDir(), { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const ctx = (projectRoots: string[]) => ({ cwd: project, projectRoots, home });

describe("network and device paths on Windows", () => {
  let realpaths: string[];
  let spy: ReturnType<typeof spyOn> | null = null;
  const watchRealpath = () => {
    realpaths = [];
    const original = fs.realpathSync.native;
    spy = spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      realpaths.push(String(p));
      return original(p, o as never);
    }) as typeof fs.realpathSync.native);
  };
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  it("classifies by text: anything not starting with a drive letter on Windows, nothing elsewhere", () => {
    for (const p of ["\\\\host\\share\\x", "//host/share/x", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "\\\\?\\UNC\\host\\share", "/etc/passwd"]) {
      expect(isWindowsNonDrivePath(p, "win32")).toBe(true);
    }
    for (const p of ["C:\\Users\\x", "d:/work", "Z:\\"]) expect(isWindowsNonDrivePath(p, "win32")).toBe(false);
    for (const p of ["//host/share/x", "\\\\host\\share"]) expect(isWindowsNonDrivePath(p, "linux")).toBe(false);
  });

  it.if(isWindows)("asks without ever resolving the path, the working directory or a project root", () => {
    watchRealpath();
    const unc = "\\\\ppm-test-host.invalid\\share";
    const started = performance.now();
    expect(assistantToolDecision("Read", { file_path: `${unc}\\secret.txt` }, ctx([project]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: "//ppm-test-host.invalid/share/secret.txt" }, ctx([project]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: "\\\\?\\UNC\\ppm-test-host.invalid\\share\\x" }, ctx([project]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: "\\\\.\\pipe\\x" }, ctx([project]))).toBe("ask");
    expect(assistantToolDecision("Grep", { pattern: "x", path: unc }, ctx([project]))).toBe("ask");
    expect(assistantToolDecision("Glob", { pattern: "*", path: unc }, ctx([project]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: "secret.txt" }, { cwd: unc, projectRoots: [project], home })).toBe("ask");
    // A project registered on a share is never resolved either.
    expect(assistantToolDecision("Read", { file_path: join(base, "elsewhere.txt") }, ctx([unc]))).toBe("ask");
    expect(designToolDecision("Read", { file_path: `${unc}\\x` }, project)).toBe("ask");
    expect(designToolDecision("Read", { file_path: "x" }, unc)).toBe("ask");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(realpaths.filter((p) => isWindowsNonDrivePath(p))).toEqual([]);
    expect(realpaths.length).toBeGreaterThan(0);
  });

  it("still resolves an ordinary local path: symlinks, case and the drive letter", () => {
    expect(assistantToolDecision("Read", { file_path: join(project, "src", "Main.ts") }, ctx([project]))).toBe("allow");
    expect(assistantToolDecision("Read", { file_path: "src/Main.ts" }, ctx([project]))).toBe("allow");
    // The link inside the project is judged by where it points.
    expect(assistantToolDecision("Read", { file_path: join(project, "keys", "id_ed25519") }, ctx([project]))).toBe("ask");
    if (isWindows || process.platform === "darwin") {
      const flipped = join(project, "src", "Main.ts").replace(/[a-z]/g, (c) => c.toUpperCase());
      expect(assistantToolDecision("Read", { file_path: flipped }, ctx([project.toLowerCase()]))).toBe("allow");
    }
  });
});

describe("credential stores under the home folder", () => {
  it("ask even when the home folder is a registered project", () => {
    for (const file of [
      ".ssh/id_ed25519", ".aws/credentials", ".npmrc", ".git-credentials", ".config/gh/hosts.yml", ".config/gcloud/credentials.db",
      ".kube/config", ".docker/config.json", ".claude/.credentials.json", ".claude.json", ".codex/auth.json",
    ]) {
      expect(assistantToolDecision("Read", { file_path: join(home, file) }, ctx([home]))).toBe("ask");
    }
    expect(assistantToolDecision("Read", { file_path: "~/.ssh/id_ed25519" }, ctx([home]))).toBe("ask");
  });

  it("leave the rest of the home project readable", () => {
    for (const file of ["notes/todo.md", "src/app.ts", ".claude/settings.json", ".codex/config.toml"]) {
      expect(assistantToolDecision("Read", { file_path: join(home, file) }, ctx([home]))).toBe("allow");
    }
  });

  it("are one list, which also holds PPM's own credential roots", () => {
    const roots = assistantPrivateRoots(home, {});
    expect(isAssistantPrivatePath(join(home, ".ssh", "id_ed25519"), roots)).toBe(true);
    expect(isAssistantPrivatePath(join(getPpmDir(), "ppm.db"), roots)).toBe(true);
    expect(isAssistantPrivatePath(join(getPpmDir(), "codex-accounts", "a", "auth.json"), roots)).toBe(true);
    expect(isAssistantPrivatePath(join(home, "notes", "todo.md"), roots)).toBe(false);
    expect(privateRootWithin(home, roots)).not.toBeNull();
    expect(privateRootWithin(join(home, "src"), roots)).toBeNull();
    const relocated = assistantPrivateRoots(home, { CODEX_HOME: join(base, "codex-home") });
    expect(isAssistantPrivatePath(join(base, "codex-home", "auth.json"), relocated)).toBe(true);
  });
});

describe("Glob and Grep reach everything below their folder", () => {
  it("ask when a credential store or the PPM dir lies below where they start", () => {
    expect(assistantToolDecision("Grep", { pattern: "token", path: home }, ctx([home]))).toBe("ask");
    expect(assistantToolDecision("Glob", { pattern: "**/*.md", path: home }, ctx([home]))).toBe("ask");
    expect(assistantToolDecision("Grep", { pattern: "token" }, { cwd: home, projectRoots: [home], home })).toBe("ask");
    // A project registered above the PPM dir.
    const above = dirname(getPpmDir());
    expect(assistantToolDecision("Grep", { pattern: "token", path: above }, ctx([above]))).toBe("ask");
  });

  it("allow a plain search inside a project that holds nothing private", () => {
    expect(assistantToolDecision("Grep", { pattern: "x", path: join(home, "src") }, ctx([home]))).toBe("allow");
    expect(assistantToolDecision("Glob", { pattern: "**/*.{ts,tsx}", path: join(project, "src") }, ctx([project]))).toBe("allow");
    expect(assistantToolDecision("Grep", { pattern: "x" }, ctx([project]))).toBe("allow");
  });

  it("ask for a pattern whose braces or `..` could spell a way out", () => {
    for (const pattern of ["{..,src}/**", ".{.,}/x", "{/etc,src}/*", "{~,src}/x", "{C:,a}/x", "src/{a,b/../..}/x", "src/{a", "a/../b"]) {
      expect(patternLeavesRoot(pattern)).toBe(true);
      expect(assistantToolDecision("Glob", { pattern, path: join(project, "src") }, ctx([project]))).toBe("ask");
    }
    for (const pattern of ["**/*.{ts,tsx}", "src/{a,b}/*.ts", "{a,{b,c}}/*", "..x/y", "*.ts"]) expect(patternLeavesRoot(pattern)).toBe(false);
  });
});
