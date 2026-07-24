import { describe, it, expect } from "bun:test";
import { resolveClaudeCliPath } from "../../../src/services/claude-cli-resolver.ts";

/** Build input with a fake fs where `present` paths exist. */
function withFs(present: string[], over: Partial<Parameters<typeof resolveClaudeCliPath>[0]> = {}) {
  const set = new Set(present);
  return {
    platform: "linux",
    execDir: "/opt/ppm",
    pathEnv: "",
    homeDir: "/home/u",
    fsExists: (p: string) => set.has(p),
    ...over,
  };
}

describe("resolveClaudeCliPath — override", () => {
  it("returns override when it exists (wins over everything)", () => {
    const r = resolveClaudeCliPath(withFs(["/custom/claude", "/opt/ppm/cli/claude"], {
      overridePath: "/custom/claude",
      pathEnv: "/usr/bin",
    }));
    expect(r).toBe("/custom/claude");
  });
  it("falls through when override does not exist", () => {
    const r = resolveClaudeCliPath(withFs(["/opt/ppm/cli/claude"], { overridePath: "/missing/claude" }));
    expect(r).toBe("/opt/ppm/cli/claude");
  });
});

describe("resolveClaudeCliPath — PATH (unix)", () => {
  it("finds claude on a `:`-split PATH", () => {
    const r = resolveClaudeCliPath(withFs(["/usr/local/bin/claude"], {
      pathEnv: "/usr/bin:/usr/local/bin:/bin",
    }));
    expect(r).toBe("/usr/local/bin/claude");
  });
});

describe("resolveClaudeCliPath — PATH (win32)", () => {
  it("splits PATH on `;` and resolves claude.exe", () => {
    const r = resolveClaudeCliPath(withFs(["C:\\tools\\claude.exe"], {
      platform: "win32",
      execDir: "C:\\ppm",
      homeDir: "C:\\Users\\u",
      pathEnv: "C:\\win;C:\\tools",
    }));
    expect(r).toBe("C:\\tools\\claude.exe");
  });
  it("ignores a .cmd shim on PATH and falls through to the shipped .exe", () => {
    // npm's global `claude` on Windows is a .cmd shim the SDK can't spawn
    // directly → skip it and use the bundled claude.exe.
    const r = resolveClaudeCliPath(withFs(["C:\\tools\\claude.cmd", "C:\\ppm\\cli\\claude.exe"], {
      platform: "win32",
      execDir: "C:\\ppm",
      homeDir: "C:\\Users\\u",
      pathEnv: "C:\\tools",
    }));
    expect(r).toBe("C:\\ppm\\cli\\claude.exe");
  });
});

describe("resolveClaudeCliPath — common absolute locations", () => {
  it("finds ~/.claude/local/claude when PATH empty (unix)", () => {
    const r = resolveClaudeCliPath(withFs(["/home/u/.claude/local/claude"]));
    expect(r).toBe("/home/u/.claude/local/claude");
  });
  it("finds /usr/local/bin/claude", () => {
    const r = resolveClaudeCliPath(withFs(["/usr/local/bin/claude"]));
    expect(r).toBe("/usr/local/bin/claude");
  });
  it("finds /opt/homebrew/bin/claude (darwin)", () => {
    const r = resolveClaudeCliPath(withFs(["/opt/homebrew/bin/claude"], { platform: "darwin" }));
    expect(r).toBe("/opt/homebrew/bin/claude");
  });
});

describe("resolveClaudeCliPath — shipped fallback", () => {
  it("uses <execDir>/cli/claude when no system claude (unix)", () => {
    const r = resolveClaudeCliPath(withFs(["/opt/ppm/cli/claude"]));
    expect(r).toBe("/opt/ppm/cli/claude");
  });
  it("uses <execDir>\\cli\\claude.exe on win32", () => {
    const r = resolveClaudeCliPath(withFs(["C:\\ppm\\cli\\claude.exe"], {
      platform: "win32",
      execDir: "C:\\ppm",
      homeDir: "C:\\Users\\u",
    }));
    expect(r).toBe("C:\\ppm\\cli\\claude.exe");
  });
});

describe("resolveClaudeCliPath — nothing found", () => {
  it("returns undefined when no candidate exists", () => {
    expect(resolveClaudeCliPath(withFs([]))).toBeUndefined();
  });
  it("does not crash when pathEnv is undefined", () => {
    expect(resolveClaudeCliPath(withFs([], { pathEnv: undefined }))).toBeUndefined();
  });
});
