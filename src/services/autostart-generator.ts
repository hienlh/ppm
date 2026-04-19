import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AutoStartConfig {
  port: number;
  host: string;
  share: boolean;
  configPath?: string;
  profile?: string;
}

/** Detect whether running from compiled binary or bun runtime */
export function isCompiledBinary(): boolean {
  // Compiled Bun binaries don't have "bun" in execPath
  return !process.execPath.includes("bun");
}

/** Resolve the absolute path to the bun binary */
export function resolveBunPath(): string {
  // 1. Current process is bun itself
  if (process.execPath.includes("bun")) return process.execPath;

  // 2. Check ~/.bun/bin/bun
  const home = homedir();
  const bunHome = resolve(home, ".bun", "bin", "bun");
  try {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(bunHome)) return bunHome;
  } catch {}

  // 3. Check PATH via which/where
  try {
    const cmd = process.platform === "win32" ? ["where", "bun"] : ["which", "bun"];
    const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" });
    const path = result.stdout.toString().trim().split("\n")[0];
    if (path) return path;
  } catch {}

  throw new Error("Could not resolve bun binary. Install Bun or add it to PATH.");
}

/** Build the command array for the PPM supervisor process */
export function buildExecCommand(config: AutoStartConfig): string[] {
  if (isCompiledBinary()) {
    // Compiled binary: just run self with __supervise__ args
    const args = [process.execPath, "__supervise__", String(config.port), config.host];
    if (config.configPath) args.push(config.configPath);
    if (config.profile) args.push(config.profile);
    if (config.share) args.push("--share");
    return args;
  }

  // Bun runtime: bun run <script> __supervise__ <port> <host> [config] [profile]
  const bunPath = resolveBunPath();
  const scriptPath = resolve(import.meta.dir, "supervisor.ts");
  const args = [bunPath, "run", scriptPath, "__supervise__", String(config.port), config.host];
  if (config.configPath) args.push(config.configPath);
  else args.push(""); // placeholder
  if (config.profile) args.push(config.profile);
  else args.push(""); // placeholder
  if (config.share) args.push("--share");
  return args;
}

// ─── macOS launchd plist ────────────────────────────────────────────────

const PLIST_LABEL = "com.hienlh.ppm";

export function getPlistPath(): string {
  return resolve(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

/** Generate macOS launchd plist XML content */
export function generatePlist(config: AutoStartConfig): string {
  const cmd = buildExecCommand(config);
  const logPath = resolve(homedir(), ".ppm", "ppm-launchd.log");

  const programArgs = cmd
    .map((arg) => `        <string>${escapeXml(arg)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(resolve(homedir(), ".ppm"))}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
`;
}

// ─── Linux systemd service ──────────────────────────────────────────────

export function getServicePath(): string {
  return resolve(homedir(), ".config", "systemd", "user", "ppm.service");
}

/** Generate Linux systemd user service file content */
export function generateSystemdService(config: AutoStartConfig): string {
  const cmd = buildExecCommand(config);
  const execStart = cmd.map(shellEscape).join(" ");
  const bunDir = isCompiledBinary() ? "" : resolve(resolveBunPath(), "..");

  // Build PATH with bun directory prepended
  const envPath = bunDir
    ? `Environment="PATH=${bunDir}:/usr/local/bin:/usr/bin:/bin"`
    : "";

  return `[Unit]
Description=PPM - Personal Project Manager
Documentation=https://github.com/hienlh/ppm
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
KillMode=mixed
${envPath}
WorkingDirectory=${homedir()}/.ppm

[Install]
WantedBy=default.target
`;
}

// ─── Windows Registry Run key ───────────────────────────────────────────
// Uses HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run — no admin needed

const TASK_NAME = "PPM";
const WIN_REG_KEY = "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";

/** Generate Windows VBScript wrapper content to run PPM hidden */
export function generateVbsWrapper(config: AutoStartConfig): string {
  const cmd = buildExecCommand(config);
  const exe = cmd[0]!;
  const args = cmd.slice(1).join(" ");
  return `Set objShell = CreateObject("WScript.Shell")
objShell.Run """${exe.replace(/\\/g, "\\\\")}""` +
    ` ${args.replace(/"/g, '""')}", 0, False
`;
}

export function getVbsPath(): string {
  return resolve(homedir(), ".ppm", "run-ppm.vbs");
}

/** Build reg command to add PPM to Windows startup (no admin) */
export function buildRegAddCommand(vbsPath: string): string[] {
  return [
    "reg", "add", WIN_REG_KEY,
    "/v", TASK_NAME,
    "/t", "REG_SZ",
    "/d", `cscript.exe "${vbsPath}"`,
    "/f",
  ];
}

/** Build reg command to remove PPM from Windows startup */
export function buildRegDeleteCommand(): string[] {
  return [
    "reg", "delete", WIN_REG_KEY,
    "/v", TASK_NAME,
    "/f",
  ];
}

/** Build reg command to query PPM startup entry */
export function buildRegQueryCommand(): string[] {
  return [
    "reg", "query", WIN_REG_KEY,
    "/v", TASK_NAME,
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Escape special XML characters */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape a string for shell usage (wrap in quotes if contains spaces) */
function shellEscape(s: string): string {
  if (/["\s]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

export { PLIST_LABEL, TASK_NAME };
