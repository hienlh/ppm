import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Represents a discovered Claude CLI installation.
 * Mirrors opcode's ClaudeInstallation struct.
 */
export interface ClaudeInstallation {
  path: string;
  version: string | null;
  source: string;
}

/**
 * Source preference score (lower = better).
 * Mirrors opcode's source_preference() function.
 */
function sourcePreference(source: string): number {
  const order: Record<string, number> = {
    "which": 1,
    "homebrew": 2,
    "system": 3,
    "nvm-active": 4,
    "local-bin": 6,
    "claude-local": 7,
    "npm-global": 8,
    "yarn": 9,
    "bun": 10,
    "node-modules": 11,
    "home-bin": 12,
    "PATH": 13,
  };
  if (source.startsWith("nvm")) return 5;
  return order[source] ?? 14;
}

/**
 * Try `which claude` (Unix) to find the binary.
 * Handles aliased output: "claude: aliased to /path/to/claude".
 */
function tryWhichCommand(): ClaudeInstallation | null {
  try {
    const result = Bun.spawnSync(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return null;

    let output = result.stdout.toString().trim();
    if (!output) return null;

    // Parse aliased output
    if (output.startsWith("claude:") && output.includes("aliased to")) {
      output = output.split("aliased to")[1]?.trim() ?? "";
    }
    if (!output || !existsSync(output)) return null;

    return { path: output, version: getClaudeVersion(output), source: "which" };
  } catch {
    return null;
  }
}

/**
 * Find Claude installations in NVM directories.
 * Checks NVM_BIN env var and all NVM node version bin directories.
 */
function findNvmInstallations(): ClaudeInstallation[] {
  const installations: ClaudeInstallation[] = [];
  const home = process.env.HOME;
  if (!home) return installations;

  // Check NVM_BIN (current active NVM)
  const nvmBin = process.env.NVM_BIN;
  if (nvmBin) {
    const claudePath = join(nvmBin, "claude");
    if (existsSync(claudePath)) {
      installations.push({
        path: claudePath,
        version: getClaudeVersion(claudePath),
        source: "nvm-active",
      });
    }
  }

  // Scan all NVM node versions
  const nvmDir = join(home, ".nvm", "versions", "node");
  try {
    for (const entry of readdirSync(nvmDir) as string[]) {
      const claudePath = join(nvmDir, entry, "bin", "claude");
      if (existsSync(claudePath) && statSync(claudePath).isFile()) {
        installations.push({
          path: claudePath,
          version: getClaudeVersion(claudePath),
          source: `nvm (${entry})`,
        });
      }
    }
  } catch {
    // NVM dir doesn't exist — skip
  }

  return installations;
}

/**
 * Check standard installation paths.
 * Mirrors opcode's find_standard_installations().
 */
function findStandardInstallations(): ClaudeInstallation[] {
  const installations: ClaudeInstallation[] = [];
  const home = process.env.HOME ?? "";

  const pathsToCheck: [string, string][] = [
    ["/usr/local/bin/claude", "system"],
    ["/opt/homebrew/bin/claude", "homebrew"],
    ["/usr/bin/claude", "system"],
    [join(home, ".claude/local/claude"), "claude-local"],
    [join(home, ".local/bin/claude"), "local-bin"],
    [join(home, ".npm-global/bin/claude"), "npm-global"],
    [join(home, ".yarn/bin/claude"), "yarn"],
    [join(home, ".bun/bin/claude"), "bun"],
    [join(home, "bin/claude"), "home-bin"],
    [join(home, "node_modules/.bin/claude"), "node-modules"],
    [join(home, ".config/yarn/global/node_modules/.bin/claude"), "yarn-global"],
  ];

  for (const [path, source] of pathsToCheck) {
    if (!path || !existsSync(path)) continue;
    installations.push({
      path,
      version: getClaudeVersion(path),
      source,
    });
  }

  return installations;
}

/**
 * Get Claude version by running `<path> --version`.
 * Extracts semver pattern from output.
 */
function getClaudeVersion(binaryPath: string): string | null {
  try {
    const result = Bun.spawnSync([binaryPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString();
    const match = output.match(/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare two semver strings. Returns -1, 0, or 1.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s) || 0);
  const pb = b.split(".").map((s) => parseInt(s) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/** Cached binary path — only discovered once per process */
let cachedBinaryPath: string | null = null;

/**
 * Find the best Claude CLI binary on the system.
 * Discovery chain (mirrors opcode):
 *   1. which claude
 *   2. NVM paths (active + all versions)
 *   3. Standard paths (homebrew, system, npm, yarn, bun, etc.)
 * Selects the installation with the highest version.
 */
export function findClaudeBinary(): string {
  if (cachedBinaryPath) return cachedBinaryPath;

  const installations: ClaudeInstallation[] = [];

  // 1. Try `which` command
  const whichResult = tryWhichCommand();
  if (whichResult) installations.push(whichResult);

  // 2. Check NVM paths
  installations.push(...findNvmInstallations());

  // 3. Check standard paths
  installations.push(...findStandardInstallations());

  // Deduplicate by path
  const seen = new Set<string>();
  const unique = installations.filter((i) => {
    if (seen.has(i.path)) return false;
    seen.add(i.path);
    return true;
  });

  if (unique.length === 0) {
    throw new Error(
      "Claude Code CLI not found. Install via: npm install -g @anthropic-ai/claude-code",
    );
  }

  // Select best: highest version, then source preference
  const best = unique.reduce((a, b) => {
    if (a.version && b.version) {
      const cmp = compareVersions(b.version, a.version);
      if (cmp !== 0) return cmp > 0 ? b : a;
    } else if (a.version && !b.version) return a;
    else if (!a.version && b.version) return b;
    return sourcePreference(a.source) <= sourcePreference(b.source) ? a : b;
  });

  cachedBinaryPath = best.path;
  return best.path;
}

/** Reset cached binary path (for testing) */
export function resetBinaryCache(): void {
  cachedBinaryPath = null;
}

/** Discover all installations (for UI display) */
export function discoverAllInstallations(): ClaudeInstallation[] {
  const installations: ClaudeInstallation[] = [];
  const whichResult = tryWhichCommand();
  if (whichResult) installations.push(whichResult);
  installations.push(...findNvmInstallations());
  installations.push(...findStandardInstallations());

  // Deduplicate and sort by version desc, then source preference
  const seen = new Set<string>();
  return installations
    .filter((i) => {
      if (seen.has(i.path)) return false;
      seen.add(i.path);
      return true;
    })
    .sort((a, b) => {
      if (a.version && b.version) {
        const cmp = compareVersions(b.version, a.version);
        if (cmp !== 0) return cmp;
      } else if (a.version && !b.version) return -1;
      else if (!a.version && b.version) return 1;
      return sourcePreference(a.source) - sourcePreference(b.source);
    });
}
