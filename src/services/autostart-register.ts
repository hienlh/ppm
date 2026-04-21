import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  type AutoStartConfig,
  PLIST_LABEL,
  TASK_NAME,
  generatePlist,
  getPlistPath,
  generateSystemdService,
  getServicePath,
  generateVbsWrapper,
  getVbsPath,
  buildRegAddCommand,
  buildRegDeleteCommand,
  buildRegQueryCommand,
} from "./autostart-generator.ts";

export interface AutoStartStatus {
  enabled: boolean;
  running: boolean;
  platform: string;
  servicePath: string | null;
  details: string;
}

const METADATA_FILE = resolve(homedir(), ".ppm", "autostart.json");

interface AutoStartMetadata {
  enabled: boolean;
  platform: string;
  servicePath: string;
  createdAt: string;
  config: AutoStartConfig;
}

/** Save autostart metadata to ~/.ppm/autostart.json */
function saveMetadata(meta: AutoStartMetadata): void {
  const dir = dirname(METADATA_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(METADATA_FILE, JSON.stringify(meta, null, 2));
}

/** Load autostart metadata */
function loadMetadata(): AutoStartMetadata | null {
  try {
    if (!existsSync(METADATA_FILE)) return null;
    return JSON.parse(readFileSync(METADATA_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** Remove autostart metadata file */
function removeMetadata(): void {
  try {
    if (existsSync(METADATA_FILE)) unlinkSync(METADATA_FILE);
  } catch {}
}

// ─── macOS ──────────────────────────────────────────────────────────────

async function enableMacOS(config: AutoStartConfig, opts?: { skipStart?: boolean }): Promise<string> {
  const plistPath = getPlistPath();
  const plistDir = dirname(plistPath);

  if (!existsSync(plistDir)) mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, generatePlist(config));

  // Skip loading if supervisor is already running from direct spawn
  if (!opts?.skipStart) {
    // Unload first if already loaded (ignore errors)
    Bun.spawnSync({
      cmd: ["launchctl", "bootout", `gui/${process.getuid!()}`, plistPath],
      stdout: "ignore", stderr: "ignore",
    });

    // Load the agent
    const result = Bun.spawnSync({
      cmd: ["launchctl", "bootstrap", `gui/${process.getuid!()}`, plistPath],
      stdout: "pipe", stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      // Fallback to legacy syntax
      const legacy = Bun.spawnSync({
        cmd: ["launchctl", "load", plistPath],
        stdout: "pipe", stderr: "pipe",
      });
      if (legacy.exitCode !== 0) {
        const err = legacy.stderr.toString().trim();
        throw new Error(`launchctl load failed: ${err}`);
      }
    }
  }

  saveMetadata({
    enabled: true,
    platform: "darwin",
    servicePath: plistPath,
    createdAt: new Date().toISOString(),
    config,
  });

  return plistPath;
}

async function disableMacOS(): Promise<void> {
  const plistPath = getPlistPath();

  // Unload
  Bun.spawnSync({
    cmd: ["launchctl", "bootout", `gui/${process.getuid!()}`, plistPath],
    stdout: "ignore", stderr: "ignore",
  });
  // Legacy fallback
  Bun.spawnSync({
    cmd: ["launchctl", "unload", plistPath],
    stdout: "ignore", stderr: "ignore",
  });

  // Remove plist file
  try { if (existsSync(plistPath)) unlinkSync(plistPath); } catch {}
  removeMetadata();
}

function statusMacOS(): AutoStartStatus {
  const plistPath = getPlistPath();
  const fileExists = existsSync(plistPath);

  // Check if loaded
  const result = Bun.spawnSync({
    cmd: ["launchctl", "list"],
    stdout: "pipe", stderr: "ignore",
  });
  const output = result.stdout.toString();
  const isLoaded = output.includes(PLIST_LABEL);

  return {
    enabled: fileExists && isLoaded,
    running: isLoaded,
    platform: "darwin (launchd)",
    servicePath: fileExists ? plistPath : null,
    details: fileExists
      ? isLoaded ? "Loaded and enabled" : "Plist exists but not loaded"
      : "Not configured",
  };
}

// ─── Linux ──────────────────────────────────────────────────────────────

async function enableLinux(config: AutoStartConfig, opts?: { skipStart?: boolean }): Promise<string> {
  const servicePath = getServicePath();
  const serviceDir = dirname(servicePath);

  if (!existsSync(serviceDir)) mkdirSync(serviceDir, { recursive: true });
  writeFileSync(servicePath, generateSystemdService(config));

  // Reload daemon
  const reload = Bun.spawnSync({
    cmd: ["systemctl", "--user", "daemon-reload"],
    stdout: "ignore", stderr: "pipe",
  });
  if (reload.exitCode !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr.toString().trim()}`);
  }

  // Enable
  const enable = Bun.spawnSync({
    cmd: ["systemctl", "--user", "enable", "ppm.service"],
    stdout: "pipe", stderr: "pipe",
  });
  if (enable.exitCode !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr.toString().trim()}`);
  }

  // Start (skip if supervisor is already running from direct spawn)
  if (!opts?.skipStart) {
    Bun.spawnSync({
      cmd: ["systemctl", "--user", "start", "ppm.service"],
      stdout: "ignore", stderr: "ignore",
    });
  }

  // Enable lingering so service runs at boot without login
  Bun.spawnSync({
    cmd: ["loginctl", "enable-linger", process.env.USER || ""],
    stdout: "ignore", stderr: "ignore",
  });

  saveMetadata({
    enabled: true,
    platform: "linux",
    servicePath,
    createdAt: new Date().toISOString(),
    config,
  });

  return servicePath;
}

async function disableLinux(): Promise<void> {
  // Stop + disable
  Bun.spawnSync({
    cmd: ["systemctl", "--user", "stop", "ppm.service"],
    stdout: "ignore", stderr: "ignore",
  });
  Bun.spawnSync({
    cmd: ["systemctl", "--user", "disable", "ppm.service"],
    stdout: "ignore", stderr: "ignore",
  });

  // Remove service file
  const servicePath = getServicePath();
  try { if (existsSync(servicePath)) unlinkSync(servicePath); } catch {}

  // Reload
  Bun.spawnSync({
    cmd: ["systemctl", "--user", "daemon-reload"],
    stdout: "ignore", stderr: "ignore",
  });

  removeMetadata();
}

function statusLinux(): AutoStartStatus {
  const servicePath = getServicePath();
  const fileExists = existsSync(servicePath);

  // Check enabled
  const enabled = Bun.spawnSync({
    cmd: ["systemctl", "--user", "is-enabled", "ppm.service"],
    stdout: "pipe", stderr: "ignore",
  });
  const isEnabled = enabled.stdout.toString().trim() === "enabled";

  // Check active
  const active = Bun.spawnSync({
    cmd: ["systemctl", "--user", "is-active", "ppm.service"],
    stdout: "pipe", stderr: "ignore",
  });
  const isActive = active.stdout.toString().trim() === "active";

  return {
    enabled: isEnabled,
    running: isActive,
    platform: "linux (systemd)",
    servicePath: fileExists ? servicePath : null,
    details: !fileExists
      ? "Not configured"
      : isEnabled && isActive ? "Enabled and running"
      : isEnabled ? "Enabled but not running"
      : "Service file exists but not enabled",
  };
}

// ─── Windows ────────────────────────────────────────────────────────────

async function enableWindows(config: AutoStartConfig): Promise<string> {
  const vbsPath = getVbsPath();
  const vbsDir = dirname(vbsPath);

  if (!existsSync(vbsDir)) mkdirSync(vbsDir, { recursive: true });
  writeFileSync(vbsPath, generateVbsWrapper(config));

  // Add to HKCU Run key (no admin required)
  const cmd = buildRegAddCommand(vbsPath);
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) {
    const err = result.stderr.toString().trim();
    throw new Error(`Registry add failed: ${err}`);
  }

  saveMetadata({
    enabled: true,
    platform: "win32",
    servicePath: vbsPath,
    createdAt: new Date().toISOString(),
    config,
  });

  return vbsPath;
}

async function disableWindows(): Promise<void> {
  // Remove from registry
  const cmd = buildRegDeleteCommand();
  Bun.spawnSync({ cmd, stdout: "ignore", stderr: "ignore" });

  // Remove VBS wrapper
  const vbsPath = getVbsPath();
  try { if (existsSync(vbsPath)) unlinkSync(vbsPath); } catch {}

  removeMetadata();
}

function statusWindows(): AutoStartStatus {
  const vbsPath = getVbsPath();
  const fileExists = existsSync(vbsPath);

  // Check if registry entry exists
  const cmd = buildRegQueryCommand();
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" });
  const regExists = result.exitCode === 0 && result.stdout.toString().includes(TASK_NAME);

  return {
    enabled: regExists,
    running: false, // Can't detect running state from registry
    platform: "windows (Registry Run)",
    servicePath: fileExists ? vbsPath : null,
    details: regExists
      ? "Registered (will run at next logon)"
      : "Not configured",
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

/** Enable auto-start for the current platform. skipStart=true registers without starting (when supervisor is already running). */
export async function enableAutoStart(config: AutoStartConfig, opts?: { skipStart?: boolean }): Promise<string> {
  const platform = process.platform;
  if (platform === "darwin") return enableMacOS(config, opts);
  if (platform === "linux") return enableLinux(config, opts);
  if (platform === "win32") return enableWindows(config);
  throw new Error(`Auto-start not supported on ${platform}`);
}

/** Disable auto-start for the current platform */
export async function disableAutoStart(): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") return disableMacOS();
  if (platform === "linux") return disableLinux();
  if (platform === "win32") return disableWindows();
  throw new Error(`Auto-start not supported on ${platform}`);
}

/** Get auto-start status for the current platform */
export function getAutoStartStatus(): AutoStartStatus {
  const platform = process.platform;
  if (platform === "darwin") return statusMacOS();
  if (platform === "linux") return statusLinux();
  if (platform === "win32") return statusWindows();
  return {
    enabled: false,
    running: false,
    platform: `${platform} (unsupported)`,
    servicePath: null,
    details: `Auto-start not supported on ${platform}`,
  };
}

/**
 * Detect whether an existing systemd unit file is outdated and needs
 * regeneration. Currently flags units missing Type=notify (introduced to fix
 * the WSL/systemd upgrade-kill bug). Linux-only; returns false elsewhere.
 */
export function isAutoStartUnitStale(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const path = getServicePath();
    if (!existsSync(path)) return false;
    const content = readFileSync(path, "utf-8");
    return !content.includes("Type=notify");
  } catch {
    return false;
  }
}

export { loadMetadata, METADATA_FILE };
