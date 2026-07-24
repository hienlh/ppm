/**
 * Resolve the Claude Code CLI executable for a compiled PPM binary.
 *
 * The Claude Agent SDK spawns a native `claude` CLI that it normally finds via
 * its own `node_modules` optional dependency. A compiled binary has no
 * node_modules, so PPM must point the SDK at a CLI explicitly. This function is
 * PURE and fully param-driven (no reads of `process.*` / `os.*`) so the whole
 * platform matrix is unit-testable on any host — the caller injects the real
 * values.
 *
 * Resolution order:
 *   1. explicit override (env / config)
 *   2. `claude` on PATH
 *   3. common absolute install locations (probed even off PATH — a supervisor/
 *      systemd child often has a stripped PATH)
 *   4. shipped fallback beside the binary: `<execDir>/cli/claude(.exe)`
 *   5. undefined (caller surfaces a clear error)
 */

export interface ResolveClaudeCliInput {
  /** `process.platform` value, e.g. "win32" | "linux" | "darwin". */
  platform: string;
  /** `dirname(process.execPath)` — where the shipped `cli/` sits. */
  execDir: string;
  /** Raw `process.env.PATH` (may be undefined/empty). */
  pathEnv?: string;
  /** `os.homedir()`. */
  homeDir: string;
  /** Explicit override (env PPM_CLAUDE_CLI ?? config cli_command). */
  overridePath?: string;
  /** Existence+is-file probe (caller injects an fs-backed impl). */
  fsExists: (p: string) => boolean;
}

/** Join path segments with the separator of the TARGET platform, not the host. */
function joinFor(platform: string, ...parts: string[]): string {
  const sep = platform === "win32" ? "\\" : "/";
  return parts.join(sep);
}

/** Absolute locations to probe even when the dir isn't on PATH. */
function commonLocations(platform: string, homeDir: string): string[] {
  if (platform === "win32") {
    return [
      joinFor(platform, homeDir, ".claude", "local", "claude.exe"),
      joinFor(platform, homeDir, ".local", "bin", "claude.exe"),
    ];
  }
  return [
    joinFor(platform, homeDir, ".claude", "local", "claude"),
    joinFor(platform, homeDir, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
}

export function resolveClaudeCliPath(input: ResolveClaudeCliInput): string | undefined {
  const { platform, execDir, pathEnv, homeDir, overridePath, fsExists } = input;
  const isWin = platform === "win32";
  // Windows: only the native `claude.exe` — a `.cmd` shim (npm's global bin)
  // can't be CreateProcess'd directly by the SDK, and we ship a `claude.exe`
  // fallback, so an unmatched `.cmd` correctly falls through to the shipped exe.
  const execNames = isWin ? ["claude.exe"] : ["claude"];
  const pathSep = isWin ? ";" : ":";

  // 1. explicit override
  if (overridePath && fsExists(overridePath)) return overridePath;

  // 2. PATH
  if (pathEnv) {
    for (const dir of pathEnv.split(pathSep)) {
      if (!dir) continue;
      for (const name of execNames) {
        const candidate = joinFor(platform, dir, name);
        if (fsExists(candidate)) return candidate;
      }
    }
  }

  // 3. common absolute locations
  for (const loc of commonLocations(platform, homeDir)) {
    if (fsExists(loc)) return loc;
  }

  // 4. shipped fallback beside the binary
  const shipped = joinFor(platform, execDir, "cli", execNames[0]!);
  if (fsExists(shipped)) return shipped;

  // 5. nothing
  return undefined;
}
