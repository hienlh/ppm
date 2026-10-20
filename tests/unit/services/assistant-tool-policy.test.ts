/**
 * The Assistant's Claude permission policy, at the level of single decisions: network paths
 * are judged from their text alone, credential stores ask even inside a registered project, and
 * a search asks when anything private lies below where it starts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { assistantToolDecision, cliPath } from "../../../src/services/assistant/assistant-tool-policy.ts";
import { assistantPrivateScope, isAssistantPrivatePath, privateRootWithin } from "../../../src/services/assistant/assistant-private-paths.ts";
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

const ctx = (projectRoots: string[]) => ({ cwd: project, projectRoots, home, env: {} });

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
    for (const file of ["notes/todo.md", "src/app.ts"]) {
      expect(assistantToolDecision("Read", { file_path: join(home, file) }, ctx([home]))).toBe("allow");
    }
  });

  it("are one list, which also holds PPM's own credential roots", () => {
    const scope = assistantPrivateScope({ projectRoots: [], home, env: {} });
    expect(isAssistantPrivatePath(join(home, ".ssh", "id_ed25519"), scope)).toBe(true);
    expect(isAssistantPrivatePath(join(getPpmDir(), "ppm.db"), scope)).toBe(true);
    expect(isAssistantPrivatePath(join(getPpmDir(), "codex-accounts", "a", "auth.json"), scope)).toBe(true);
    expect(isAssistantPrivatePath(join(home, "notes", "todo.md"), scope)).toBe(false);
    expect(privateRootWithin(home, scope)).not.toBeNull();
    expect(privateRootWithin(join(home, "src"), scope)).toBeNull();
    const relocated = assistantPrivateScope({ projectRoots: [], home, env: { CODEX_HOME: join(base, "codex-home") } });
    expect(isAssistantPrivatePath(join(base, "codex-home", "auth.json"), relocated)).toBe(true);
  });
});

describe("a project registered at the home folder or above", () => {
  /** Stores no fixed list names, each kept in the home folder's application-state area. */
  const STATE_FILES = [
    ".config/x", ".local/share/keyrings/login.keyring", ".zsh_history", ".pgpass", ".vault-token", ".password-store/a.gpg",
    ".mozilla/firefox/p/logins.json", ".config/google-chrome/Default/Login Data", ".claude/settings.json", ".codex/config.toml",
    "Library/Application Support/Google/Chrome/Default/Cookies",
  ];

  beforeAll(() => {
    for (const file of [...STATE_FILES, ".dotfiles/vimrc"]) {
      mkdirSync(dirname(join(home, file)), { recursive: true });
      writeFileSync(join(home, file), "x");
    }
  });

  it("asks before reading anything in the home folder's dot-entries and Library", () => {
    for (const file of [".ssh/id_ed25519", ...STATE_FILES]) {
      expect(assistantToolDecision("Read", { file_path: join(home, file) }, ctx([home]))).toBe("ask");
    }
    expect(assistantToolDecision("Grep", { pattern: "x", path: join(home, ".config") }, ctx([home]))).toBe("ask");
    expect(assistantToolDecision("Glob", { pattern: "*", path: join(home, ".local", "share") }, ctx([home]))).toBe("ask");
  });

  it("asks the same with the project at the filesystem root", () => {
    const fsRoot = isWindows ? `${home.slice(0, 3)}` : "/";
    for (const file of [".ssh/id_ed25519", ".config/x", ".local/share/keyrings/login.keyring", ".zsh_history"]) {
      expect(assistantToolDecision("Read", { file_path: join(home, file) }, ctx([fsRoot]))).toBe("ask");
    }
    expect(assistantToolDecision("Read", { file_path: join(home, "notes", "todo.md") }, ctx([fsRoot]))).toBe("allow");
  });

  it("asks for Windows' AppData only on Windows", () => {
    const appData = join(home, "AppData", "Local", "Google", "Chrome", "User Data", "Default", "Login Data");
    const scope = (platform: string) => assistantPrivateScope({ projectRoots: [home], home, env: {}, platform });
    expect(isAssistantPrivatePath(appData, scope("win32"))).toBe(true);
    expect(isAssistantPrivatePath(appData, scope("linux"))).toBe(false);
  });

  it("lets a project registered inside the home folder read its own tree", () => {
    const dotfiles = join(home, ".dotfiles");
    expect(assistantToolDecision("Read", { file_path: join(dotfiles, "vimrc") }, ctx([home, dotfiles]))).toBe("allow");
    expect(assistantToolDecision("Read", { file_path: join(dotfiles, "vimrc") }, ctx([dotfiles]))).toBe("allow");
    // A fixed credential store still asks inside one.
    const configProject = join(home, ".config");
    expect(assistantToolDecision("Read", { file_path: join(home, ".config", "gh", "hosts.yml") }, ctx([configProject]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: join(home, ".config", "x") }, ctx([configProject]))).toBe("allow");
  });

  it("does not mark a file no project holds as private: it is asked as outside every project", () => {
    const scope = assistantPrivateScope({ projectRoots: [project], home, env: {} });
    expect(isAssistantPrivatePath(join(home, ".zsh_history"), scope)).toBe(false);
    expect(assistantToolDecision("Read", { file_path: join(home, ".zsh_history") }, ctx([project]))).toBe("ask");
  });

  it("does not ask for a normal file inside a project away from home", () => {
    expect(assistantToolDecision("Read", { file_path: join(project, "src", "Main.ts") }, ctx([project]))).toBe("allow");
    expect(assistantToolDecision("Read", { file_path: join(project, "src", "Main.ts") }, ctx([project, home]))).toBe("allow");
  });
});

describe("the system's own pseudo-filesystems", () => {
  it("are private roots on Linux and macOS, named as such", () => {
    const linux = assistantPrivateScope({ projectRoots: ["/"], home, env: {}, platform: "linux" });
    for (const p of ["/proc/self/environ", "/proc/1/environ", "/sys/firmware/x", "/dev/mem"]) {
      expect(isAssistantPrivatePath(isWindows ? `C:${p.replace(/\//g, "\\")}` : p, linux)).toBe(true);
    }
    const mac = assistantPrivateScope({ projectRoots: ["/"], home, env: {}, platform: "darwin" });
    expect(isAssistantPrivatePath(isWindows ? "C:\\dev\\fd\\0" : "/dev/fd/0", mac)).toBe(true);
    expect(isAssistantPrivatePath(isWindows ? "C:\\proc\\self\\environ" : "/proc/self/environ", mac)).toBe(false);
  });

  it.if(process.platform === "linux")("ask for /proc even with a project registered at /", () => {
    expect(assistantToolDecision("Read", { file_path: "/proc/self/environ" }, ctx(["/"]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: `/proc/${process.pid}/environ` }, ctx(["/"]))).toBe("ask");
    expect(assistantToolDecision("Grep", { pattern: "x", path: "/sys" }, ctx(["/"]))).toBe("ask");
  });
});

describe("a target spelled the way the CLI reads it", () => {
  it("drops surrounding whitespace before judging", () => {
    expect(assistantToolDecision("Grep", { pattern: "x", path: ` ${join(home, ".ssh")}` }, ctx([project]))).toBe("ask");
    expect(assistantToolDecision("Glob", { pattern: "*", path: `${join(home, ".ssh")}\n` }, ctx([project]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: ` ${join(project, "src", "Main.ts")} ` }, ctx([project]))).toBe("allow");
    // Blank is no path: the working directory, which holds nothing private here.
    expect(assistantToolDecision("Grep", { pattern: "x", path: "   " }, ctx([project]))).toBe("allow");
    expect(assistantToolDecision("Read", { file_path: "   " }, ctx([project]))).toBe("ask");
  });

  it("expands ~ to the home folder", () => {
    expect(cliPath("~", home)).toBe(home);
    expect(cliPath(" ~/.ssh ", home)).toBe(join(home, ".ssh"));
    expect(assistantToolDecision("Grep", { pattern: "x", path: " ~/.ssh" }, ctx([project, home]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: "~/notes/todo.md" }, ctx([home]))).toBe("allow");
  });

  it("reads /c/… as drive C: on Windows only", () => {
    expect(cliPath("/c/Users/u/.ssh", home, "win32")).toBe("C:\\Users\\u\\.ssh");
    expect(cliPath("/c/Users/u/.ssh", home, "linux")).toBe("/c/Users/u/.ssh");
    expect(cliPath("/cc/x", home, "win32")).toBe("/cc/x");
  });

  it.if(isWindows)("judges a Git Bash spelling by the drive it names", () => {
    const bash = (p: string) => `/${p[0]!.toLowerCase()}/${p.slice(3).replace(/\\/g, "/")}`;
    expect(assistantToolDecision("Grep", { pattern: "x", path: bash(join(home, ".ssh")) }, ctx([project, home]))).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: bash(join(project, "src", "Main.ts")) }, ctx([project]))).toBe("allow");
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

describe("links below a Glob or Grep folder", () => {
  /** The Claude Code CLI the SDK ships for this machine (it embeds ripgrep), when installed. */
  function bundledCli(): string | null {
    try {
      const sdkDir = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk/package.json"));
      const exe = join(dirname(sdkDir), `claude-agent-sdk-${process.platform}-${process.arch}`, isWindows ? "claude.exe" : "claude");
      return fs.existsSync(exe) ? exe : null;
    } catch { return null; }
  }

  it("allow a search over a project whose links lead out, since neither tool follows them", () => {
    // `project/keys` is a link to the home's `.ssh`; ripgrep never walks into it.
    expect(assistantToolDecision("Grep", { pattern: "x", path: project }, ctx([project]))).toBe("allow");
    expect(assistantToolDecision("Glob", { pattern: "**/*", path: project }, ctx([project]))).toBe("allow");
    // Named directly, the link is judged by where it points.
    expect(assistantToolDecision("Grep", { pattern: "x", path: join(project, "keys") }, ctx([project]))).toBe("ask");
  });

  it("ask while a ripgrep config file is named, since it can turn following on", () => {
    const env = { RIPGREP_CONFIG_PATH: join(base, "ripgreprc") };
    expect(assistantToolDecision("Grep", { pattern: "x", path: join(project, "src") }, { ...ctx([project]), env })).toBe("ask");
    expect(assistantToolDecision("Glob", { pattern: "*.ts", path: join(project, "src") }, { ...ctx([project]), env })).toBe("ask");
    expect(assistantToolDecision("Read", { file_path: join(project, "src", "Main.ts") }, { ...ctx([project]), env })).toBe("allow");
    const unset = { RIPGREP_CONFIG_PATH: "" };
    expect(assistantToolDecision("Grep", { pattern: "x", path: join(project, "src") }, { ...ctx([project]), env: unset })).toBe("allow");
  });

  it("are not followed by the bundled CLI's Glob and Grep", () => {
    const cli = bundledCli();
    if (!cli) return; // no platform CLI installed here; the policy's comment records the measurement
    const binary = fs.readFileSync(cli);
    // Each tool's argument list, as the CLI builds it, carries no --follow / -L.
    for (const anchor of ['"--sort=modified"', '"--max-columns","500"']) {
      const at = binary.indexOf(anchor);
      expect(at).toBeGreaterThan(-1);
      const around = binary.subarray(Math.max(0, at - 700), at + 900).toString("latin1");
      expect(around).not.toContain('"--follow"');
      expect(around).not.toContain('"-L"');
    }
    // And its ripgrep, run with those lists, does not reach through a link out of the folder.
    const tree = join(base, "rg-tree");
    const outside = join(base, "rg-outside");
    mkdirSync(join(tree, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(tree, "src", "in.txt"), "MARKER\n");
    writeFileSync(join(outside, "out.txt"), "MARKER\n");
    linkDir(outside, join(tree, "dirlink"));
    const rg = (args: string[]) => spawnSync(cli, [...args, tree], { argv0: "rg", encoding: "utf8", env: { ...process.env, RIPGREP_CONFIG_PATH: "" } })
      .stdout.split(/[\0\n]/).filter(Boolean);
    const glob = rg(["--files", "--null", "--glob", "**/*.txt", "--sort=modified", "--no-ignore", "--hidden"]);
    const grep = rg(["--hidden", "--glob", "!.git", "--max-columns", "500", "-l", "--null", "MARKER"]);
    const followed = rg(["--hidden", "--follow", "-l", "--null", "MARKER"]);
    expect(glob).toEqual([join(tree, "src", "in.txt")]);
    expect(grep).toEqual([join(tree, "src", "in.txt")]);
    expect(followed.some((line) => line.includes("dirlink"))).toBe(true); // the link itself works
  });
});
